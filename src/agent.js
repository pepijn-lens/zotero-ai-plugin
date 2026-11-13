// Owns the claude child process for the current chat.
Buddy.Agent = class {
	constructor(handlers) {
		this.h = handlers;
		this.proc = null;
		this.procModel = null;
		this.busy = false;
		this.newSession();
	}

	newSession() {
		this.sessionID = null;
		this.hasSession = false;
	}

	/** Points the agent at a saved chat's Claude session, or at a fresh one when it can't be resumed. */
	restore(sessionID, resumable) {
		this.sessionID = resumable ? sessionID : null;
		this.hasSession = !!resumable;
	}

	/** Claude runs from the home folder, as an ordinary session would. */
	get workdir() {
		return Services.dirsvc.get("Home", Ci.nsIFile).path;
	}

	/** Whether Claude still has the transcript for this session (it keeps them per working directory). */
	async sessionExists(sessionID) {
		if (!sessionID) return false;
		const config = Services.env.get("CLAUDE_CONFIG_DIR")
			|| PathUtils.join(Services.dirsvc.get("Home", Ci.nsIFile).path, ".claude");
		const folder = this.workdir.replace(/[^A-Za-z0-9]/g, "-");
		return IOUtils.exists(PathUtils.join(config, "projects", folder, `${sessionID}.jsonl`));
	}

	/** Sends a message, starting or replacing the process when the model has changed. */
	async send(text, model, images = []) {
		if (this.busy) throw new Error("Still answering the previous message.");
		this.busy = true;
		try {
			if (this.proc && this.procModel !== model) await this._terminate();
			if (!this.proc) await this._start(model);
			await this.proc.stdin.write(JSON.stringify({
				type: "user",
				message: {
					role: "user",
					content: images.length
						? [
							...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mediaType, data: i.data } })),
							{ type: "text", text },
						]
						: text,
				},
			}) + "\n");
		}
		catch (e) {
			this.busy = false;
			throw e;
		}
	}

	/** Ends the current turn and process. */
	async kill() {
		this.busy = false;
		await this._terminate();
	}

	async _terminate() {
		const proc = this.proc;
		if (!proc) return;
		this.proc = null;
		await this._removeConfig();
		try {
			await proc.kill();
		}
		catch (e) {
			Zotero.debug(`[Research Buddy] kill failed: ${e}`);
		}
	}

	async _claudePath() {
		const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
		const configured = Zotero.Prefs.get("extensions.researchbuddy.claudePath", true);
		const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
		for (const path of [configured, PathUtils.join(home, ".local", "bin", "claude")]) {
			if (path && await IOUtils.exists(path)) return path;
		}
		try {
			return await Subprocess.pathSearch("claude");
		}
		catch (e) {
			throw new Error("Couldn't find the claude command. Set its full path in the extensions.researchbuddy.claudePath preference.");
		}
	}

	async _start(model) {
		const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
		const command = await this._claudePath();
		const configDir = PathUtils.join(PathUtils.profileDir, "research-buddy");
		await IOUtils.makeDirectory(configDir, { ignoreExisting: true, permissions: 0o700 });

		const uuid = () => Services.uuid.generateUUID().toString().slice(1, -1);
		const token = uuid().replaceAll("-", "") + uuid().replaceAll("-", "");
		this.configPath = PathUtils.join(configDir, `mcp-${uuid()}.json`);
		await IOUtils.writeUTF8(this.configPath, JSON.stringify({
			mcpServers: { zotero: { type: "http", url: Buddy.MCP.url, headers: { Authorization: `Bearer ${token}` } } },
		}));
		await IOUtils.setPermissions(this.configPath, 0o600);
		this.token = token;
		Buddy.MCP.tokens.set(token, this.owner);

		const args = [
			"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
			"--include-partial-messages", "--model", model, "--append-system-prompt", Buddy.systemPrompt,
			"--mcp-config", this.configPath, "--allowedTools", "mcp__zotero",
			// Permission requests arrive on stdout as control_request events and are answered on stdin.
			"--permission-prompts", "host", "--permission-prompt-tool", "stdio",
		];
		if (this.hasSession) {
			args.push("--resume", this.sessionID);
		}
		else {
			this.sessionID = uuid();
			args.push("--session-id", this.sessionID);
		}

		const proc = await Subprocess.call({ command, arguments: args, workdir: this.workdir, stderr: "pipe" });
		this.proc = proc;
		this.procModel = model;
		this.stderrTail = "";
		this.lastCost = 0;
		this.sawDelta = false;
		this._readStderr(proc);
		this._readStdout(proc);
	}

	async _removeConfig() {
		const path = this.configPath;
		this.configPath = null;
		if (this.token) Buddy.MCP.tokens.delete(this.token);
		this.token = null;
		if (path) await IOUtils.remove(path, { ignoreAbsent: true });
	}

	async _readStderr(proc) {
		try {
			let chunk;
			while ((chunk = await proc.stderr.readString())) {
				this.stderrTail = (this.stderrTail + chunk).slice(-1500);
			}
		}
		catch (e) {}
	}

	async _readStdout(proc) {
		let buffer = "";
		try {
			let chunk;
			while ((chunk = await proc.stdout.readString())) {
				buffer += chunk;
				let end;
				while ((end = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, end).trim();
					buffer = buffer.slice(end + 1);
					if (line && this.proc === proc) this._event(JSON.parse(line));
				}
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
		if (this.proc !== proc) return;

		// The process ended without kill() being called.
		this.proc = null;
		const { exitCode } = await proc.wait();
		await this._removeConfig();
		if (this.busy) {
			this.busy = false;
			this.h.onError(`Claude stopped unexpectedly (exit code ${exitCode}).\n${this.stderrTail.trim()}`.trim());
		}
	}

	_event(ev) {
		if (ev.type === "system" && ev.subtype === "init") {
			this.h.onInit(ev.model);
		}
		else if (ev.type === "stream_event") {
			const e = ev.event;
			if (e.type === "message_start") {
				this.sawDelta = false;
				this.h.onMessageStart();
			}
			else if (e.type === "content_block_start" && e.content_block?.type === "tool_use") {
				this.h.onTool(e.content_block.name.replace(/^mcp__zotero__/, ""));
			}
			else if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
				this.sawDelta = true;
				this.h.onText(e.delta.text);
			}
		}
		else if (ev.type === "control_request") {
			this._controlRequest(ev);
		}
		else if (ev.type === "control_cancel_request") {
			this.h.onPermissionCancel(ev.request_id);
		}
		else if (ev.type === "result") {
			this.busy = false;
			if (ev.is_error) {
				this.h.onError(String(ev.result || ev.errors?.join("\n") || "Claude reported an error."));
				this.kill();
			}
			else {
				this.hasSession = true;
				this._reportUsage(ev);
				this.h.onDone();
			}
		}
	}

	_controlRequest({ request_id: requestId, request }) {
		if (request?.subtype === "can_use_tool") {
			this.h.onPermission({ requestId, tool: request.tool_name, input: request.input || {} });
		}
		else {
			this._controlResponse({ subtype: "error", request_id: requestId, error: `Unsupported request: ${request?.subtype}` });
		}
	}

	/** Answers a permission request with { behavior: "allow", updatedInput } or { behavior: "deny", message }. */
	respondToPermission(requestId, response) {
		return this._controlResponse({ subtype: "success", request_id: requestId, response });
	}

	async _controlResponse(response) {
		try {
			await this.proc?.stdin.write(JSON.stringify({ type: "control_response", response }) + "\n");
		}
		catch (e) {
			Zotero.logError(e);
		}
	}

	/** The total cost Claude reports is cumulative for the process, so each turn's share is the difference. */
	_reportUsage(ev) {
		const usage = ev.usage || {};
		const last = usage.iterations?.at(-1) || usage;
		const total = typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : this.lastCost;
		const cost = Math.max(0, total - this.lastCost);
		this.lastCost = total;
		this.h.onUsage({
			cost,
			output: usage.output_tokens || 0,
			context: (last.input_tokens || 0) + (last.cache_read_input_tokens || 0) + (last.cache_creation_input_tokens || 0),
		});
	}
};

// MCP over HTTP with plain JSON responses, hosted on Zotero's localhost server.
Buddy.MCP = {
	PATH: "/research-buddy/mcp",
	// One token per running Claude process, mapped to the chat it belongs to.
	tokens: new Map(),
	_addedCodes: [],

	register() {
		// Zotero's status table lacks the codes MCP uses.
		for (const [code, text] of [[202, "Accepted"], [401, "Unauthorized"], [405, "Method Not Allowed"]]) {
			if (!Zotero.Server.responseCodes[code]) {
				Zotero.Server.responseCodes[code] = text;
				this._addedCodes.push(code);
			}
		}
		const Endpoint = function () {};
		Endpoint.prototype = {
			supportedDataTypes: ["application/json"],
			// Zotero picks the calling convention from the arity, so this must take one parameter.
			init: (request) => Buddy.MCP._handle(request),
		};
		Zotero.Server.Endpoints[this.PATH] = Endpoint;
	},

	unregister() {
		delete Zotero.Server.Endpoints[this.PATH];
		for (const code of this._addedCodes) delete Zotero.Server.responseCodes[code];
		this._addedCodes = [];
		this.tokens.clear();
	},

	get url() {
		return `http://127.0.0.1:${Zotero.Prefs.get("httpServer.port")}${this.PATH}`;
	},

	async _handle({ method, headers, data }) {
		const token = /^Bearer (.+)$/.exec(headers.authorization || "")?.[1];
		if (!token || !this.tokens.has(token)) return [401, "text/plain", "Unauthorized\n"];
		const session = this.tokens.get(token);
		if (method !== "POST") return [405, "text/plain", "POST only\n"];
		if (!data || typeof data !== "object") return [400, "text/plain", "Expected JSON-RPC\n"];
		if (data.id === undefined) return 202;

		const reply = (body) => [200, "application/json", JSON.stringify({ jsonrpc: "2.0", id: data.id, ...body })];
		try {
			switch (data.method) {
				case "initialize":
					return reply({
						result: {
							protocolVersion: data.params?.protocolVersion || "2025-06-18",
							capabilities: { tools: {} },
							serverInfo: { name: "zotero", version: Buddy.version },
						},
					});
				case "ping":
					return reply({ result: {} });
				case "tools/list":
					return reply({
						result: { tools: Buddy.Tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
					});
				case "tools/call":
					return reply({ result: await this._call(data.params, { session }) });
				default:
					return reply({ error: { code: -32601, message: `Unknown method ${data.method}` } });
			}
		}
		catch (e) {
			Zotero.logError(e);
			return reply({ error: { code: -32603, message: String(e.message || e) } });
		}
	},

	async _call({ name, arguments: args }, context) {
		const tool = Buddy.Tools.find((t) => t.name === name);
		if (!tool) return { isError: true, content: [{ type: "text", text: `Unknown tool ${name}` }] };
		try {
			const result = await tool.run(args || {}, context);
			return { content: [{ type: "text", text: JSON.stringify(result) }] };
		}
		catch (e) {
			Zotero.debug(`[Research Buddy] ${name} failed: ${e}`);
			return { isError: true, content: [{ type: "text", text: String(e.message || e) }] };
		}
	},
};

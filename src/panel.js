// Shared chat state, and the views of it shown in each item pane.
{
	const XHTML = "http://www.w3.org/1999/xhtml";
	const MODEL_PREF = "extensions.researchbuddy.model";
	const DEFAULT_MODEL = "haiku";
	const MODELS = [["haiku", "Haiku"], ["sonnet", "Sonnet"], ["opus", "Opus"], ["fable", "Fable"]];
	const DESTINATION_PREF = "extensions.researchbuddy.destination";
	const GEOMETRY_PREF = "extensions.researchbuddy.geometry";
	const TEXT_SIZE_PREF = "extensions.researchbuddy.textSize";
	const TEXT_SIZES = [80, 90, 100, 110, 125, 140, 160, 180, 200];
	const CUSTOM = "__custom__";
	// A model ID is passed as a process argument, so it must not look like a flag.
	const VALID_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]*$/;
	const ACTIVITY = {
		get_current_context: "Checking what's open…",
		read_pages: "Reading the paper…",
		find_in_paper: "Searching the paper…",
		get_item: "Looking up the item…",
		search_library: "Searching your library…",
		scout_search: "Searching the literature…",
		scout_related: "Following citations…",
		propose_paper: "Preparing a suggestion…",
	};

	const freshUsage = () => ({ cost: 0, output: 0, context: 0, turns: 0 });
	const tokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

	const STATUS_LABEL = {
		running: "Working",
		unread: "New reply",
		error: "Something went wrong",
		idle: "",
	};
	const BADGE_PRIORITY = ["waiting", "error", "running", "unread"];

	const modelLabel = (id) => MODELS.find(([m]) => m === id)?.[1] || id;

	const markdownActions = {
		citationLabel: (key, page) => Buddy.citationLabel(key, page),
		openCitation: (key, page, quote) => Buddy.openCitation(key, page, quote).then((found) => {
			if (!found) Buddy.Chat.pushStatus(`Couldn't find the exact passage, so page ${page} was opened instead.`);
		}).catch((e) => Buddy.Chat.pushError(e.message)),
		openURL: (url) => Zotero.launchURL(url),
	};

	const uuid = () => Services.uuid.generateUUID().toString().slice(1, -1);

	const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;
	const PERMISSION_OUTCOMES = {
		allowed: "Allowed",
		denied: "Denied",
		expired: "Denied automatically: no answer within 5 minutes",
		cancelled: "No longer needed",
	};

	/** Exactly what will run, never the model's own description of it. */
	const permissionDetail = (tool, input) => (tool === "Bash" && input.command ? input.command : JSON.stringify(input, null, 2));

	/** One conversation with its own Claude process, so several can run at once. */
	class Session {
		constructor(id = uuid()) {
			this.id = id;
			this.created = Date.now();
			this.messages = [];
			this.replay = false;
			this.sending = false;
			this.anchor = null;
			this.usage = freshUsage();
			this.mentions = [];
			this.images = [];
			this.draft = "";
			this.activity = "";
			this.current = null;
			this.breakBeforeText = false;
			this.unread = false;
			this._shownStatus = null;
			this.permissions = new Map();
			this.agent = new Buddy.Agent({
				onInit: () => {},
				onMessageStart: () => {
					if (this.current?.text) this.breakBeforeText = true;
				},
				onText: (text) => this._appendText(text),
				onTool: (name) => this._setActivity(ACTIVITY[name] || "Working…"),
				onPermission: (request) => this._askPermission(request),
				onPermissionCancel: (requestId) => {
					this._closePermission(requestId, "cancelled");
					this._setActivity(this._waitingText());
				},
				onUsage: ({ cost, output, context }) => {
					this.usage.cost += cost;
					this.usage.output += output;
					this.usage.context = context;
					this.usage.turns++;
				},
				onDone: () => {
					this.replay = false;
					if (!this.active) this.unread = true;
					this._finishTurn();
				},
				onError: (message) => {
					this._finishTurn();
					this.pushError(message);
				},
			});
			this.agent.owner = this;
		}

		get active() {
			return Buddy.Chat.active === this;
		}

		get model() {
			return Zotero.Prefs.get(MODEL_PREF, true) || DEFAULT_MODEL;
		}

		get busy() {
			return this.agent.busy;
		}

		/** running, unread (a reply arrived while you were elsewhere), error, or idle. */
		get status() {
			if (this.permissions.size) return "unread";
			if (this.agent.busy || this.sending) return "running";
			const last = [...this.messages].reverse().find((m) => m.role !== "status");
			if (last?.role === "error") return "error";
			if (this.unread) return "unread";
			return "idle";
		}

		_push(message) {
			this.messages.push(message);
			this._notify(message);
			if (message.role !== "assistant") this._save();
			return message;
		}

		/** Saves the chat. Nothing is saved until the first question has been asked. */
		_save() {
			const first = this.messages.find((m) => m.role === "user");
			if (!first) return;
			const title = first.text.replace(/\s+/g, " ").trim();
			Buddy.History.save({
				id: this.id,
				title: title.length > 70 ? `${title.slice(0, 70)}…` : title,
				created: this.created,
				updated: Date.now(),
				model: this.model,
				anchor: this.anchor ? { ...this.anchor, pending: undefined } : null,
				usage: this.usage,
				sessionID: this.agent.sessionID,
				hasSession: this.agent.hasSession,
				messages: this.messages,
			}).then(() => Buddy.Chat.sidebarChanged());
		}

		/** The text of the conversation so far, for when Claude's own copy of it is gone. */
		_transcript() {
			const lines = this.messages
				.filter((m) => m.role === "user" || m.role === "assistant")
				.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}${m.images?.length ? " [image attached]" : ""}`);
			return lines.join("\n\n").slice(-30000);
		}

		_notify(message) {
			if (!this.active) return;
			for (const view of Buddy.Chat.views) view.update(message);
		}

		_refreshControls() {
			if (this.active) for (const view of Buddy.Chat.views) view.refreshControls();
			if (this.status !== this._shownStatus) {
				this._shownStatus = this.status;
				Buddy.Chat.sidebarChanged();
			}
		}

		_setActivity(text) {
			this.activity = text;
			this._refreshControls();
		}

		_appendText(text) {
			if (!this.current) this.current = this._push({ role: "assistant", text: "" });
			if (this.breakBeforeText) {
				this.current.text += "\n\n";
				this.breakBeforeText = false;
			}
			this.current.text += text;
			this._setActivity("");
			this._notify(this.current);
		}

		_waitingText() {
			return this.permissions.size ? "Waiting for your approval…" : "Working…";
		}

		_askPermission({ requestId, tool, input }) {
			if (Buddy.Chat.skipPermissions) {
				this.agent.respondToPermission(requestId, { behavior: "allow", updatedInput: input });
				return;
			}
			this.current = null;
			this.breakBeforeText = false;
			const message = this._push({ role: "permission", requestId, tool, detail: permissionDetail(tool, input), state: "pending" });
			const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
			timer.initWithCallback({ notify: () => this.answerPermission(message, "expired") }, PERMISSION_TIMEOUT_MS, Ci.nsITimer.TYPE_ONE_SHOT);
			this.permissions.set(requestId, { message, timer, input });
			this._setActivity(this._waitingText());
			Buddy.UI.reveal();
		}

		/** Records the outcome on the card. Returns the request's details, or nothing if it was already closed. */
		_closePermission(requestId, state) {
			const entry = this.permissions.get(requestId);
			if (!entry) return null;
			entry.timer.cancel();
			this.permissions.delete(requestId);
			entry.message.state = state;
			this._notify(entry.message);
			this._save();
			return entry;
		}

		/** state is "allowed", "denied" or "expired". */
		answerPermission(message, state) {
			const entry = this._closePermission(message.requestId, state);
			if (!entry) return;
			this.agent.respondToPermission(message.requestId, state === "allowed"
				? { behavior: "allow", updatedInput: entry.input }
				: {
					behavior: "deny",
					message: state === "expired"
						? "The user did not answer within 5 minutes, so this was denied. Do not retry it. Tell the user it timed out."
						: "The user declined this action. Do not retry it.",
				});
			this._setActivity(this._waitingText());
		}

		closeAllPermissions() {
			for (const requestId of [...this.permissions.keys()]) this._closePermission(requestId, "cancelled");
		}

		_finishTurn() {
			this.closeAllPermissions();
			this.current = null;
			this.breakBeforeText = false;
			this._setActivity("");
			this._save();
			// Only the chat in front keeps a Claude process around. The others resume when you return to them.
			if (!this.active) this.agent.kill();
			Buddy.Chat.sidebarChanged();
		}

		/** Creates the highlight a thread hangs on. This waits until the first question, so asking and walking away leaves nothing behind. */
		async _saveAnchor() {
			const a = this.anchor;
			const attachment = Zotero.Items.getByLibraryAndKey(a.libraryID, a.attachmentKey);
			await Zotero.Annotations.saveFromJSON(attachment, a.pending);
			delete a.pending;
		}

		pushError(text) {
			this._push({ role: "error", text });
		}

		pushStatus(text) {
			this._push({ role: "status", text });
		}

		async send(text) {
			text = text.trim();
			const images = this.images;
			if ((!text && !images.length) || this.busy || this.sending) return false;
			if (!text) text = "(see the attached image)";
			this.sending = true;
			let tagged;
			try {
				if (this.anchor?.pending) await this._saveAnchor();
				tagged = await Buddy.Attach.mentionContext(this.mentions.filter((m) => text.includes(m.token)));
			}
			catch (e) {
				this.sending = false;
				this.pushError(`Couldn't send: ${e.message || e}`);
				return false;
			}
			const earlier = this.replay ? this._transcript() : "";
			const message = { role: "user", text };
			if (images.length) message.images = images.map((i) => i.thumb);
			this.unread = false;
			this._push(message);
			this.draft = "";
			this.images = [];
			this.mentions = [];
			this._setActivity("Thinking…");
			const prefix = earlier
				? `Earlier in this conversation (restored from a saved chat):\n\n${earlier}\n\nNow the user says:\n\n`
				: "";
			const promise = this.agent.send(`${Buddy.contextLine(this.anchor)}\n\n${tagged}${prefix}${text}`, this.model, images);
			this.sending = false;
			this._refreshControls();
			try {
				await promise;
			}
			catch (e) {
				this._finishTurn();
				this.pushError(e.message);
			}
			this._refreshControls();
			return true;
		}

		async addImage(win, blob) {
			if (this.images.length >= Buddy.Attach.MAX_IMAGES) {
				this.pushError(`You can attach at most ${Buddy.Attach.MAX_IMAGES} images per message.`);
				return;
			}
			try {
				this.images.push(await Buddy.Attach.image(win, blob));
			}
			catch (e) {
				this.pushError(e.message || String(e));
			}
			this._refreshControls();
		}

		removeImage(image) {
			this.images = this.images.filter((i) => i !== image);
			this._refreshControls();
		}

		async stop() {
			await this.agent.kill();
			this._finishTurn();
			this._push({ role: "status", text: "Stopped." });
			this._refreshControls();
		}

		addProposal({ doi, title, reason, destination }) {
			this.current = null;
			this.breakBeforeText = false;
			this._push({ role: "proposal", doi, title, reason, destination, suggested: destination, state: "idle" });
			this._refreshControls();
		}

		async acceptProposal(message) {
			if (message.state === "adding" || message.state === "added") return;
			const destination = message.destination || Buddy.Chat.defaultDestination();
			message.state = "adding";
			message.note = "";
			this._notify(message);
			try {
				message.note = await Buddy.Scout.addToLibrary(message.doi, destination);
				message.state = "added";
				Zotero.Prefs.set(DESTINATION_PREF, destination, true);
			}
			catch (e) {
				message.state = "failed";
				message.note = `Couldn't add this paper: ${e.message || e}`;
			}
			this._notify(message);
			this._save();
			this._refreshControls();
		}
	}

	/** All sessions, and the one shown in the chat window. The views read the active session through this. */
	Buddy.Chat = {
		views: new Set(),
		sessions: new Map(),
		// Deliberately not saved: every Zotero start goes back to asking.
		skipPermissions: false,
		active: null,
		_sidebarTimer: null,

		init() {
			this.active = this._add(new Session());
		},

		_add(session) {
			this.sessions.set(session.id, session);
			return session;
		},

		get messages() { return this.active.messages; },
		get images() { return this.active.images; },
		get mentions() { return this.active.mentions; },
		get anchor() { return this.active.anchor; },
		get usage() { return this.active.usage; },
		get activity() { return this.active.activity; },
		get busy() { return this.active.busy; },
		get model() { return this.active.model; },
		get draft() { return this.active.draft; },
		set draft(value) { this.active.draft = value; },

		send: (text) => Buddy.Chat.active.send(text),
		stop: () => Buddy.Chat.active.stop(),
		addImage: (win, blob) => Buddy.Chat.active.addImage(win, blob),
		removeImage: (image) => Buddy.Chat.active.removeImage(image),
		pushError: (text) => Buddy.Chat.active.pushError(text),
		pushStatus: (text) => Buddy.Chat.active.pushStatus(text),
		acceptProposal: (message) => Buddy.Chat.active.acceptProposal(message),

		/** Applies to every chat, from the next tool request on. Cards already showing still wait for an answer. */
		toggleSkipPermissions() {
			this.skipPermissions = !this.skipPermissions;
			for (const view of this.views) view.refreshControls();
		},

		sidebarChanged() {
			if (this._sidebarTimer) return;
			this._sidebarTimer = Zotero.getMainWindow()?.setTimeout(() => {
				this._sidebarTimer = null;
				for (const view of this.views) view.renderSidebar();
			}, 60);
		},

		/** Brings a session to the front. Running sessions carry on in the background; idle ones give up their process. */
		activate(session) {
			const previous = this.active;
			if (previous === session) return;
			this.active = session;
			session.unread = false;
			if (previous) {
				if (!previous.messages.length && !previous.busy) this.sessions.delete(previous.id);
				else if (!previous.busy) previous.agent.kill();
			}
			for (const view of this.views) view.reload();
			session._refreshControls();
			this.sidebarChanged();
		},

		/** A fresh chat. An empty one that's already open is reused. */
		newChat() {
			if (!this.active.messages.length && !this.active.busy) {
				this.active.anchor = null;
				for (const view of this.views) view.reload();
				return this.active;
			}
			const session = this._add(new Session());
			this.activate(session);
			return session;
		},

		/** Opens a saved chat, or switches to it if it's already loaded. */
		async openChat(id) {
			let session = this.sessions.get(id);
			if (!session) {
				const chat = await Buddy.History.read(id);
				if (!chat) {
					this.pushError("Couldn't open that chat.");
					return;
				}
				session = new Session(chat.id);
				const resumable = chat.hasSession && await session.agent.sessionExists(chat.sessionID);
				session.agent.restore(chat.sessionID, resumable);
				session.replay = !resumable;
				session.created = chat.created;
				session.anchor = chat.anchor || null;
				session.usage = chat.usage || freshUsage();
				session.messages = chat.messages.map((m) => {
					if (m.state === "adding") return { ...m, state: "idle" };
					return m.state === "pending" ? { ...m, state: "cancelled" } : m;
				});
				if (!this.sessions.has(id)) this._add(session);
				else session = this.sessions.get(id);
			}
			this.activate(session);
		},

		async deleteChat(id) {
			const session = this.sessions.get(id);
			if (session) {
				session.messages = [];
				await session.agent.kill();
				this.sessions.delete(id);
				if (this.active === session) this.activate(this._add(new Session()));
			}
			await Buddy.History.remove(id);
			this.sidebarChanged();
		},

		/** The chat's text size as a percentage, shared by every view. */
		get textSize() {
			const size = Zotero.Prefs.get(TEXT_SIZE_PREF, true);
			return TEXT_SIZES.includes(size) ? size : 100;
		},

		/** Steps the text size up (+1) or down (-1), or back to 100% with 0. */
		stepTextSize(direction) {
			const index = TEXT_SIZES.indexOf(this.textSize);
			const size = direction === 0 ? 100 : TEXT_SIZES[Math.max(0, Math.min(TEXT_SIZES.length - 1, index + direction))];
			Zotero.Prefs.set(TEXT_SIZE_PREF, size, true);
			for (const view of this.views) view.applyTextSize();
		},

		/** Saves the model. The next message uses it, so a reply in progress is never cut off. */
		setModel(model) {
			const session = this.active;
			if (!VALID_MODEL.test(model)) {
				session.pushError(`"${model}" isn't a valid model ID.`);
				session._refreshControls();
				return;
			}
			if (model === session.model) return;
			Zotero.Prefs.set(MODEL_PREF, model, true);
			if (session.messages.length) {
				session._push({ role: "status", text: `Switched to ${modelLabel(model)}${session.busy ? " for your next message" : ""}.` });
			}
			session._refreshControls();
		},

		/** Starts a chat attached to a highlighted passage. The highlight itself is created on the first question. */
		startThread(reader, annotation) {
			const attachment = Zotero.Items.get(reader.itemID);
			const text = (annotation.text || "").trim().replace(/\s*\n\s*/g, " ");
			const session = this.newChat();
			if (attachment && text && annotation.position && annotation.sortIndex !== undefined) {
				const pageIndex = annotation.position.pageIndex;
				const key = Zotero.DataObjectUtilities.generateKey();
				session.anchor = {
					libraryID: attachment.libraryID,
					attachmentKey: attachment.key,
					annotationKey: key,
					text,
					page: Number.isInteger(pageIndex) ? pageIndex + 1 : undefined,
					pending: {
						key,
						type: "highlight",
						text: annotation.text,
						comment: "",
						color: annotation.color || "#ffd400",
						pageLabel: annotation.pageLabel || "",
						sortIndex: annotation.sortIndex,
						position: annotation.position,
					},
				};
				session.draft = "";
			}
			else {
				session.draft = `> ${text}\n\n`;
			}
			for (const view of this.views) view.reload();
		},

		/** Also checks open chats, because the sidebar redraws when a new highlight is saved, before its chat is on disk. */
		hasThread(annotationKey) {
			return !!Buddy.History.byAnnotation(annotationKey) || !!this._openThreadSession(annotationKey);
		},

		_openThreadSession(annotationKey) {
			return [...this.sessions.values()].find((s) => s.anchor?.annotationKey === annotationKey && (s.sending || s.messages.length));
		},

		/** A highlight that exists for its chat: it has a thread and no comment of the user's to edit. */
		isThreadHighlight(reader, annotationKey) {
			const attachment = Zotero.Items.get(reader.itemID);
			const item = Zotero.Items.getByLibraryAndKey(attachment.libraryID, annotationKey);
			return !!item && item.annotationType === "highlight" && !item.annotationComment && this.hasThread(annotationKey);
		},

		/** Opens the thread on an existing highlight, or starts one on it. */
		async openThread(reader, annotationKey) {
			const open = this._openThreadSession(annotationKey);
			if (open) {
				this.activate(open);
				return;
			}
			const attachment = Zotero.Items.get(reader.itemID);
			await Buddy.History.ensureLoaded();
			const existing = Buddy.History.byAnnotation(annotationKey);
			if (existing) {
				await this.openChat(existing.id);
				return;
			}
			const item = Zotero.Items.getByLibraryAndKey(attachment.libraryID, annotationKey);
			if (!item) return;
			const session = this.newChat();
			let pageIndex;
			try {
				pageIndex = JSON.parse(item.annotationPosition).pageIndex;
			}
			catch (e) {}
			session.anchor = {
				libraryID: attachment.libraryID,
				attachmentKey: attachment.key,
				annotationKey,
				text: item.annotationText || item.annotationComment || "",
				page: Number.isInteger(pageIndex) ? pageIndex + 1 : undefined,
			};
			for (const view of this.views) view.reload();
		},

		/** Everywhere a paper can be saved: each writable library and its folders, nested. */
		destinations() {
			return Buddy.writableLibraries().map((library) => ({
				name: library.name,
				options: [
					{ value: `L${library.libraryID}`, label: `${library.name} (no folder)` },
					...Zotero.Collections.getByLibrary(library.libraryID, true).map((c) => ({
						value: `C${c.id}`,
						label: `${"  ".repeat(c.level)}${c.name}`,
					})),
				],
			}));
		},

		/** The last folder used if it still exists, else the folder selected in Zotero, else My Library. */
		defaultDestination() {
			const valid = new Set(this.destinations().flatMap((g) => g.options.map((o) => o.value)));
			const last = Zotero.Prefs.get(DESTINATION_PREF, true);
			if (last && valid.has(last)) return last;
			const collection = Zotero.getActiveZoteroPane()?.getSelectedCollection();
			if (collection && valid.has(`C${collection.id}`)) return `C${collection.id}`;
			return `L${Zotero.Libraries.userLibraryID}`;
		},

		rememberDestination(destination) {
			Zotero.Prefs.set(DESTINATION_PREF, destination, true);
		},

		shutdown() {
			for (const session of this.sessions.values()) {
				session.closeAllPermissions();
				session.agent.kill();
			}
			this.sessions.clear();
			this.views.clear();
			if (this._sidebarTimer) Zotero.getMainWindow()?.clearTimeout(this._sidebarTimer);
		},
	};
	Buddy.Chat.init();

	class View {
		constructor(body, doc) {
			this.doc = doc;
			this.nodes = new Map();
			this.dirty = new Set();
			// Which tool calls are unfolded, so answering one doesn't fold it back up.
			this.unfolded = new WeakSet();
			this.timer = null;
			this.root = this._el("div", "buddy-root");

			const bar = this._el("div", "buddy-bar");
			this.bar = bar;
			this.select = this._el("select");
			this.select.title = "Model";
			this.select.addEventListener("change", () => this._onSelect());
			this.custom = this._el("input", "buddy-custom");
			this.custom.placeholder = "Model ID";
			this.custom.hidden = true;
			this.custom.addEventListener("change", () => {
				const value = this.custom.value.trim();
				if (value) Buddy.Chat.setModel(value);
			});
			const newChat = this._el("button", "buddy-btn");
			newChat.textContent = "New chat";
			newChat.addEventListener("click", () => {
				this.closeChats();
				Buddy.Chat.newChat();
			});
			this.chatsButton = this._el("button", "buddy-btn buddy-chats-button");
			this.chatsButton.textContent = "Search chats";
			this.chatsButton.title = "Find and open your chats";
			this.chatsButton.addEventListener("click", () => this.openChats());
			// While the list is closed, this is what shows that another chat needs attention.
			this.chatsBadge = this._el("span", "buddy-dot");
			this.chatsBadge.hidden = true;
			this.chatsButton.append(this.chatsBadge);
			bar.append(this.chatsButton, newChat);

			const closeOnEscape = (e) => {
				if (e.key !== "Escape") return;
				this.closeChats();
				this.input.focus();
			};
			this.search = this._el("input", "buddy-side-search");
			this.search.type = "search";
			this.search.placeholder = "Search chats\u2026";
			this.search.addEventListener("input", () => this.renderSidebar());
			this.search.addEventListener("keydown", (e) => {
				closeOnEscape(e);
				e.stopPropagation();
			});
			const closeChats = this._el("button");
			closeChats.textContent = "Close";
			closeChats.title = "Back to the chat";
			closeChats.addEventListener("click", () => {
				this.closeChats();
				this.input.focus();
			});
			const chatsHead = this._el("div", "buddy-chats-head");
			chatsHead.append(this.search, closeChats);
			this.sideList = this._el("div", "buddy-side-list");
			this.chatsView = this._el("div", "buddy-chats-view");
			this.chatsView.hidden = true;
			this.chatsView.append(chatsHead, this.sideList);
			this.chatsView.addEventListener("keydown", closeOnEscape);

			this.anchorBar = this._el("div", "buddy-anchor buddy-chatonly");
			this.anchorBar.hidden = true;
			this.anchorBar.title = "Show this highlight in the paper";
			this.anchorBar.addEventListener("click", () => {
				if (Buddy.Chat.anchor) Buddy.revealAnchor(Buddy.Chat.anchor).catch((e) => Buddy.Chat.pushError(e.message));
			});

			this.log = this._el("div", "buddy-log buddy-chatonly");
			this.empty = this._el("div", "buddy-empty");
			this.empty.textContent = "Ask about this paper, your library, or related literature.";
			this.activity = this._el("div", "buddy-activity buddy-chatonly");
			this.usageEl = this._el("div", "buddy-usage buddy-chatonly");
			this.usageEl.title = "Context is the size of the last request. Cost is an API-equivalent estimate from Claude Code; "
				+ "a subscription isn't billed per token.";
			this.usageEl.hidden = true;

			this.mentionBox = this._el("div", "buddy-mentions buddy-chatonly");
			this.mentionBox.hidden = true;
			this.mention = { results: [], index: 0, start: 0, end: 0, seq: 0 };

			this.strip = this._el("div", "buddy-strip buddy-chatonly");
			this.strip.hidden = true;

			const composer = this._el("div", "buddy-composer buddy-chatonly");
			const attach = this._el("button", "buddy-btn buddy-attach");
			this.attachButton = attach;
			attach.textContent = "\ud83d\udcce";
			attach.title = "Attach images (you can also paste or drop them)";
			attach.addEventListener("click", () => this._pickImages());
			this.input = this._el("textarea", "buddy-input");
			this.input.placeholder = "Ask Research Buddy…";
			this.input.value = Buddy.Chat.draft;
			this.input.addEventListener("input", () => {
				Buddy.Chat.draft = this.input.value;
				this._updateMentions();
			});
			this.input.addEventListener("blur", () => this._closeMentions());
			this.input.addEventListener("paste", (e) => {
				const files = [...(e.clipboardData?.files || [])].filter((f) => Buddy.Attach.isImage(f.type));
				if (!files.length) return;
				e.preventDefault();
				this._addImages(files);
			});
			this.input.addEventListener("keydown", (e) => {
				e.stopPropagation();
				if (!this.mentionBox.hidden && this._mentionKey(e)) return;
				if (e.key === "Enter" && !e.shiftKey) {
					e.preventDefault();
					this._submit();
				}
			});
			this.action = this._el("button", "buddy-btn buddy-send");
			this.action.addEventListener("click", () => (Buddy.Chat.busy ? Buddy.Chat.stop() : this._submit()));
			composer.append(attach, this.input, this.select, this.custom, this.action);

			this.permissionMode = this._el("div", "buddy-permission-mode buddy-chatonly");
			// Capturing, because the text box stops its own key events from travelling further.
			this.root.addEventListener("keydown", (e) => {
				if (e.key !== "Tab" || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
				e.preventDefault();
				e.stopPropagation();
				Buddy.Chat.toggleSkipPermissions();
			}, true);

			// Zotero's shortcuts act on the selected library item, so the window has to catch these first.
			this.chatClicked = false;
			this._onWindowPointer = (e) => {
				this.chatClicked = this.root.contains(e.target);
			};
			this._onCopyKey = (e) => {
				this._copySelection(e);
				this._textSizeKey(e);
			};
			doc.defaultView.addEventListener("pointerdown", this._onWindowPointer, true);
			doc.defaultView.addEventListener("keydown", this._onCopyKey, true);

			const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
			this.root.addEventListener("dragover", (e) => {
				if (hasFiles(e)) e.preventDefault();
			});
			this.root.addEventListener("drop", (e) => {
				const files = [...(e.dataTransfer?.files || [])].filter((f) => Buddy.Attach.isImage(f.type));
				if (!files.length) return;
				e.preventDefault();
				this._addImages(files);
			});

			const stage = this._el("div", "buddy-stage");
			stage.append(this.anchorBar, this.log, this.activity, this.usageEl, this.mentionBox, this.strip, composer, this.permissionMode);
			this.root.append(bar, stage, this.chatsView);
			this.applyTextSize();
			body.append(this.root);
			for (const message of Buddy.Chat.messages) this.update(message);
			this._flush();
			this.refreshControls();
			this.renderSidebar();
			Buddy.Chat.views.add(this);
		}

		_el(tag, cls) {
			const node = this.doc.createElementNS(XHTML, tag);
			if (cls) node.className = cls;
			return node;
		}

		destroy() {
			Buddy.Chat.views.delete(this);
			const win = this.doc.defaultView;
			if (this.timer) win?.clearTimeout(this.timer);
			win?.removeEventListener("pointerdown", this._onWindowPointer, true);
			win?.removeEventListener("keydown", this._onCopyKey, true);
		}

		/** Ctrl+C or Ctrl+Shift+C copies text selected in the chat, as long as the chat was the last thing clicked. */
		_copySelection(e) {
			const accel = Zotero.isMac ? e.metaKey : e.ctrlKey;
			if (!this.chatClicked || !accel || e.altKey || e.key.toLowerCase() !== "c") return;
			// A text box with its own selection copies that by itself.
			if (e.target.selectionStart !== e.target.selectionEnd) return;
			const selection = this.doc.defaultView.getSelection();
			if (!selection || selection.isCollapsed || !this.root.contains(selection.anchorNode)) return;
			e.preventDefault();
			e.stopPropagation();
			Zotero.Utilities.Internal.copyTextToClipboard(selection.toString());
		}

		applyTextSize() {
			const size = Buddy.Chat.textSize;
			this.root.style.setProperty("--buddy-zoom", size / 100);
		}

		/** Ctrl and +, \u2212 or 0 resize the chat's text instead of Zotero's, as long as the chat was the last thing clicked. */
		_textSizeKey(e) {
			const accel = Zotero.isMac ? e.metaKey : e.ctrlKey;
			if (!this.chatClicked || !accel || e.altKey) return;
			const direction = { "+": 1, "=": 1, "-": -1, "_": -1, "0": 0 }[e.key];
			if (direction === undefined) return;
			e.preventDefault();
			e.stopPropagation();
			Buddy.Chat.stepTextSize(direction);
		}

		async _submit() {
			const text = this.input.value;
			if (await Buddy.Chat.send(text)) this._syncDraft();
		}

		_addImages(files) {
			for (const file of files) Buddy.Chat.addImage(this.doc.defaultView, file);
		}

		async _pickImages() {
			try {
				const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
				const win = this.doc.defaultView;
				const picker = new FilePicker();
				picker.init(win, "Attach images", picker.modeOpenMultiple);
				picker.appendFilters(picker.filterImages);
				if (await picker.show() !== picker.returnOK) return;
				for (const path of picker.files) {
					const type = Buddy.Attach.mimeFromPath(path);
					if (!type) continue;
					await Buddy.Chat.addImage(win, new win.Blob([await IOUtils.read(path)], { type }));
				}
			}
			catch (e) {
				Buddy.Chat.pushError(e.message || String(e));
			}
		}

		renderAttachments() {
			const images = Buddy.Chat.images;
			this.strip.hidden = !images.length;
			this.strip.replaceChildren(...images.map((image) => {
				const wrap = this._el("div", "buddy-thumbwrap");
				const img = this._el("img", "buddy-thumb");
				img.src = image.thumb;
				const remove = this._el("button", "buddy-thumbx");
				remove.textContent = "\u00d7";
				remove.title = "Remove";
				remove.addEventListener("click", () => Buddy.Chat.removeImage(image));
				wrap.append(img, remove);
				return wrap;
			}));
		}

		/** Looks for an "@word" just before the cursor and offers matching folders and papers. */
		async _updateMentions() {
			const caret = this.input.selectionStart;
			const found = /(^|\s)@([^\s@]*)$/.exec(this.input.value.slice(0, caret));
			const seq = ++this.mention.seq;
			if (!found) {
				this._closeMentions();
				return;
			}
			const results = await Buddy.Attach.searchMentions(found[2]);
			if (seq !== this.mention.seq) return;
			Object.assign(this.mention, { results, index: 0, start: caret - found[2].length - 1, end: caret });
			if (!results.length) {
				this._closeMentions();
				return;
			}
			this._renderMentions();
		}

		_renderMentions() {
			this.mentionBox.hidden = false;
			this.mentionBox.replaceChildren(...this.mention.results.map((m, i) => {
				const row = this._el("div", `buddy-mrow${i === this.mention.index ? " buddy-msel" : ""}`);
				const label = this._el("span", "buddy-mlabel");
				label.textContent = `${m.kind === "collection" ? "\ud83d\udcc1" : "\ud83d\udcc4"} ${m.label}`;
				const sub = this._el("span", "buddy-card-meta");
				sub.textContent = m.sub || "";
				row.append(label, sub);
				row.addEventListener("mousedown", (e) => {
					e.preventDefault();
					this._pickMention(i);
				});
				return row;
			}));
			this.mentionBox.children[this.mention.index]?.scrollIntoView({ block: "nearest" });
		}

		_closeMentions() {
			this.mention.seq++;
			this.mentionBox.hidden = true;
		}

		/** Returns true when the key was used by the popup. */
		_mentionKey(e) {
			const m = this.mention;
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				m.index = (m.index + (e.key === "ArrowDown" ? 1 : m.results.length - 1)) % m.results.length;
				this._renderMentions();
			}
			else if (e.key === "Enter" || e.key === "Tab") {
				this._pickMention(m.index);
			}
			else if (e.key === "Escape") {
				this._closeMentions();
			}
			else {
				return false;
			}
			e.preventDefault();
			return true;
		}

		_pickMention(i) {
			const { results, start, end } = this.mention;
			const picked = results[i];
			if (!picked) return;
			const token = Buddy.Attach.token(picked);
			const value = this.input.value;
			this.input.value = `${value.slice(0, start)}${token} ${value.slice(end)}`;
			const caret = start + token.length + 1;
			this.input.setSelectionRange(caret, caret);
			Buddy.Chat.draft = this.input.value;
			Buddy.Chat.mentions.push({ kind: picked.kind, libraryID: picked.libraryID, key: picked.key, label: picked.label, token });
			this._closeMentions();
			this.input.focus();
		}

		_syncDraft() {
			for (const view of Buddy.Chat.views) view.input.value = Buddy.Chat.draft;
		}

		_onSelect() {
			if (this.select.value === CUSTOM) {
				this.custom.hidden = false;
				this.custom.focus();
				return;
			}
			this.custom.hidden = true;
			Buddy.Chat.setModel(this.select.value);
		}

		refreshControls() {
			const model = Buddy.Chat.model;
			const known = MODELS.some(([id]) => id === model);
			const options = [...MODELS, ...(known ? [] : [[model, model]]), [CUSTOM, "Custom…"]];
			if (this.select.options.length !== options.length || !known) {
				this.select.replaceChildren(...options.map(([id, label]) => {
					const option = this._el("option");
					option.value = id;
					option.textContent = label;
					return option;
				}));
			}
			if (this.select.value !== CUSTOM || this.custom.hidden || model === this.custom.value.trim()) {
				this.select.value = model;
				if (model === this.custom.value.trim()) this.custom.hidden = true;
			}
			this.activity.textContent = Buddy.Chat.activity;
			this.renderAttachments();
			const { anchor, usage } = Buddy.Chat;
			this.anchorBar.hidden = !anchor;
			if (anchor) {
				const quote = anchor.text.length > 110 ? `${anchor.text.slice(0, 110)}\u2026` : anchor.text;
				this.anchorBar.textContent = `Highlight${anchor.page ? `, p. ${anchor.page}` : ""}: \u201c${quote}\u201d`;
			}
			this.usageEl.hidden = !usage.turns;
			if (usage.turns) {
				this.usageEl.textContent = `Context ${tokens(usage.context)} \u00b7 ${tokens(usage.output)} output \u00b7 ~$${usage.cost.toFixed(usage.cost < 0.1 ? 4 : 2)}`;
			}
			this.action.textContent = Buddy.Chat.busy ? "Stop" : "Send";
			this.permissionMode.textContent = `${Buddy.Chat.skipPermissions ? "Skip permissions" : "Ask for permissions"} · Shift+Tab to switch`;
			this.permissionMode.classList.toggle("buddy-skip", Buddy.Chat.skipPermissions);
			this.empty.hidden = Buddy.Chat.messages.length > 0;
			if (!Buddy.Chat.messages.length && !this.empty.parentNode) this.log.append(this.empty);
			if (Buddy.Chat.messages.length) this.empty.remove();
		}

		openChats() {
			this.chatsView.hidden = false;
			this.search.value = "";
			this.renderSidebar();
			this.search.focus();
		}

		closeChats() {
			this.chatsView.hidden = true;
		}

		_updateChatsBadge() {
			const others = [...Buddy.Chat.sessions.values()].filter((s) => s !== Buddy.Chat.active).map((s) => s.status);
			const status = BADGE_PRIORITY.find((s) => others.includes(s));
			this.chatsBadge.hidden = !status;
			if (!status) return;
			this.chatsBadge.className = `buddy-dot buddy-dot-${status}`;
			this.chatsBadge.title = STATUS_LABEL[status];
		}

		async renderSidebar() {
			this._updateChatsBadge();
			if (this.chatsView.hidden) return;
			const token = (this._sideToken = (this._sideToken || 0) + 1);
			const results = await Buddy.History.search(this.search.value);
			if (token !== this._sideToken) return;
			if (!results.length) {
				const none = this._el("div", "buddy-side-empty");
				none.textContent = this.search.value.trim() ? "No chats match." : "Your chats will appear here.";
				this.sideList.replaceChildren(none);
				return;
			}
			this.sideList.replaceChildren(...results.map((entry) => this._sideRow(entry)));
		}

		_sideRow(entry) {
			const session = Buddy.Chat.sessions.get(entry.id);
			const status = session ? session.status : (entry.flag || "idle");
			const row = this._el("div", `buddy-srow${entry.id === Buddy.Chat.active.id ? " buddy-scurrent" : ""}`);
			const dot = this._el("span", `buddy-dot buddy-dot-${status}`);
			dot.title = STATUS_LABEL[status];
			const main = this._el("div", "buddy-smain");
			main.setAttribute("role", "button");
			main.tabIndex = 0;
			const open = () => {
				this.closeChats();
				Buddy.Chat.openChat(entry.id);
			};
			main.addEventListener("click", open);
			main.addEventListener("keydown", (e) => {
				if (e.key === "Enter") open();
			});
			const title = this._el("div", "buddy-stitle");
			title.textContent = entry.title;
			const meta = this._el("div", "buddy-card-meta");
			if (status === "running") {
				meta.textContent = session.activity || (session.current ? "Writing\u2026" : "Thinking\u2026");
			}
			else {
				const when = new Date(entry.updated);
				const parts = [when.toLocaleDateString(), STATUS_LABEL[status]];
				if (entry.anchor) parts.push(`highlight${entry.anchor.page ? ` p. ${entry.anchor.page}` : ""}`);
				meta.textContent = parts.filter(Boolean).join(" \u00b7 ");
			}
			main.append(title, meta);
			if (entry.snippet) {
				const snippet = this._el("div", "buddy-card-meta");
				snippet.textContent = entry.snippet;
				main.append(snippet);
			}
			const del = this._el("button", "buddy-sdelete");
			del.textContent = "\u00d7";
			del.title = "Delete this chat";
			let armed = null;
			del.addEventListener("click", () => {
				if (armed) {
					this.doc.defaultView.clearTimeout(armed);
					Buddy.Chat.deleteChat(entry.id);
					return;
				}
				del.textContent = "Sure?";
				armed = this.doc.defaultView.setTimeout(() => {
					armed = null;
					del.textContent = "\u00d7";
				}, 3000);
			});
			row.append(dot, main, del);
			return row;
		}

		/** Re-renders the whole conversation, after another chat has been opened. */
		reload() {
			this.input.value = Buddy.Chat.draft;
			this.clearLog();
			for (const message of Buddy.Chat.messages) this.update(message);
			this._flush();
			this.refreshControls();
		}

		clearLog() {
			this.nodes.clear();
			this.dirty.clear();
			this.log.replaceChildren();
		}

		update(message) {
			this.dirty.add(message);
			if (!this.timer) {
				this.timer = this.doc.defaultView.setTimeout(() => this._flush(), 40);
			}
		}

		_flush() {
			this.timer = null;
			const atBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 40;
			for (const message of this.dirty) this._render(message);
			this.dirty.clear();
			if (atBottom) this.log.scrollTop = this.log.scrollHeight;
		}

		_render(message) {
			let node = this.nodes.get(message);
			if (!node) {
				node = this._el("div", `buddy-msg buddy-${message.role === "proposal" || message.role === "permission" ? "card" : message.role}`);
				this.nodes.set(message, node);
				this.log.append(node);
			}
			if (message.role === "assistant") {
				node.replaceChildren();
				Buddy.renderMarkdown(this.doc, message.text.replace(/\[\[[^\]\n]*\]?$/, ""), node, markdownActions);
			}
			else if (message.role === "proposal") {
				this._renderProposal(node, message);
			}
			else if (message.role === "permission") {
				this._renderPermission(node, message);
			}
			else if (message.role === "user" && message.images?.length) {
				const text = this._el("div");
				text.textContent = message.text;
				node.replaceChildren(...message.images.map((src) => {
					const img = this._el("img", "buddy-thumb");
					img.src = src;
					return img;
				}), text);
			}
			else {
				node.textContent = message.text;
			}
		}

		_renderPermission(node, message) {
			const pending = message.state === "pending";
			const title = this._el("span", "buddy-card-title");
			title.textContent = pending ? `Allow ${message.tool}?` : message.tool;
			const preview = this._el("span", "buddy-tool-preview");
			preview.textContent = message.detail.replace(/\s+/g, " ").slice(0, 200);
			const summary = this._el("summary", "buddy-tool-summary");
			summary.append(title, preview);
			const detail = this._el("pre", "buddy-permission-detail");
			detail.textContent = message.detail;
			const fold = this._el("details", "buddy-tool");
			fold.open = this.unfolded.has(message);
			fold.addEventListener("toggle", () => {
				if (fold.open) this.unfolded.add(message);
				else this.unfolded.delete(message);
			});
			fold.append(summary, detail);
			const children = [fold];
			if (pending) {
				const actions = this._el("div", "buddy-card-actions");
				for (const [label, state] of [["Allow", "allowed"], ["Deny", "denied"]]) {
					const button = this._el("button");
					button.textContent = label;
					button.addEventListener("click", () => Buddy.Chat.active.answerPermission(message, state));
					actions.append(button);
				}
				children.push(actions);
			}
			else {
				const outcome = this._el("div", "buddy-card-meta");
				outcome.textContent = PERMISSION_OUTCOMES[message.state] || "";
				children.push(outcome);
			}
			node.replaceChildren(...children);
		}

		_renderProposal(node, message) {
			const title = this._el("div", "buddy-card-title");
			title.textContent = message.title;
			const reason = this._el("div");
			reason.textContent = message.reason;
			const meta = this._el("div", "buddy-card-meta");
			const url = `https://doi.org/${encodeURIComponent(message.doi)}`;
			const doi = this._el("a", "buddy-link");
			doi.textContent = message.doi;
			doi.title = "Open this paper in your browser";
			doi.addEventListener("click", () => Zotero.launchURL(url));
			meta.append("DOI: ", doi);
			const children = [title, reason, meta];
			if (message.state !== "added") {
				const actions = this._el("div", "buddy-card-actions");
				const folder = this._el("select");
				folder.title = "Where to save this paper";
				folder.disabled = message.state === "adding";
				for (const group of Buddy.Chat.destinations()) {
					const optgroup = this._el("optgroup");
					optgroup.label = group.name;
					for (const { value, label } of group.options) {
						const option = this._el("option");
						option.value = value;
						option.textContent = value === message.suggested ? `${label} (suggested)` : label;
						optgroup.append(option);
					}
					folder.append(optgroup);
				}
				folder.value = message.destination || Buddy.Chat.defaultDestination();
				folder.addEventListener("change", () => {
					message.destination = folder.value;
				});
				const add = this._el("button");
				add.textContent = message.state === "adding" ? "Adding\u2026" : "Add to Zotero";
				add.disabled = message.state === "adding";
				add.addEventListener("click", () => {
					message.destination = folder.value;
					Buddy.Chat.acceptProposal(message);
				});
				actions.append(folder, add);
				children.push(actions);
			}
			if (message.note) {
				const note = this._el("div", "buddy-card-meta");
				note.textContent = message.note;
				children.push(note);
			}
			node.replaceChildren(...children);
		}
	}

	const MIN_WIDTH = 350;
	const MIN_HEIGHT = 320;
	const GRIPS = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
	const clamp = (value, low, high) => Math.max(low, Math.min(value, Math.max(low, high)));

	/** The floating chat window inside one Zotero window. */
	class Card {
		constructor(win) {
			this.win = win;
			const doc = win.document;
			const make = (tag, cls) => {
				const node = doc.createElementNS(XHTML, tag);
				node.className = cls;
				return node;
			};

			this.node = make("div", "buddy-float");
			this.node.id = "research-buddy-card";
			this.node.hidden = true;

			const head = make("div", "buddy-float-head");
			const icon = make("img", "");
			icon.src = "chrome://researchbuddy/content/claude.svg";
			const title = make("span", "buddy-float-title");
			title.textContent = "Research Buddy";
			const info = make("button", "buddy-float-info");
			info.textContent = "i";
			info.title = "Take the Research Buddy tour";
			info.addEventListener("click", () => Buddy.Tour.start(win));
			const close = make("button", "buddy-float-close");
			close.textContent = "×";
			close.title = "Hide (your chat is kept)";
			close.addEventListener("click", () => this.hide());
			head.append(icon, title, info, close);

			const body = make("div", "buddy-float-body");
			this.node.append(head, body);
			this.view = new View(body, doc);

			this._track(head, (dx, dy, start) => ({ ...start, x: start.x + dx, y: start.y + dy }));
			for (const dir of GRIPS) {
				const grip = make("div", `buddy-grip buddy-grip-${dir}`);
				this.node.append(grip);
				this._track(grip, (dx, dy, start) => this._resized(dir, dx, dy, start));
			}

			doc.documentElement.append(this.node);
			this.geometry = this._load();
			this._onResize = () => this._apply(this.geometry);
			win.addEventListener("resize", this._onResize);
			this._apply(this.geometry);
		}

		_load() {
			try {
				const saved = JSON.parse(Zotero.Prefs.get(GEOMETRY_PREF, true) || "null");
				if (saved) return saved;
			}
			catch (e) {}
			const w = 430;
			const h = Math.min(680, this.win.innerHeight - 110);
			return { x: this.win.innerWidth - w - 24, y: 76, w, h };
		}

		/** Keeps the card entirely inside the window. */
		_apply({ x, y, w, h }) {
			const { innerWidth: vw, innerHeight: vh } = this.win;
			w = clamp(w, MIN_WIDTH, vw);
			h = clamp(h, MIN_HEIGHT, vh);
			this.geometry = { x: clamp(x, 0, vw - w), y: clamp(y, 0, vh - h), w, h };
			const { style } = this.node;
			style.left = `${this.geometry.x}px`;
			style.top = `${this.geometry.y}px`;
			style.width = `${this.geometry.w}px`;
			style.height = `${this.geometry.h}px`;
		}

		_resized(dir, dx, dy, start) {
			const next = { ...start };
			if (dir.includes("e")) next.w = start.w + dx;
			if (dir.includes("s")) next.h = start.h + dy;
			if (dir.includes("w")) {
				next.w = clamp(start.w - dx, MIN_WIDTH, start.x + start.w);
				next.x = start.x + start.w - next.w;
			}
			if (dir.includes("n")) {
				next.h = clamp(start.h - dy, MIN_HEIGHT, start.y + start.h);
				next.y = start.y + start.h - next.h;
			}
			return next;
		}

		/** Pointer capture keeps the drag alive while the cursor crosses the PDF's iframe. */
		_track(handle, compute) {
			handle.addEventListener("pointerdown", (down) => {
				if (down.button !== 0 || down.target.closest("button")) return;
				down.preventDefault();
				handle.setPointerCapture(down.pointerId);
				const start = this.geometry;
				const move = (e) => this._apply(compute(e.clientX - down.clientX, e.clientY - down.clientY, start));
				const finish = () => {
					handle.removeEventListener("pointermove", move);
					handle.removeEventListener("pointerup", finish);
					handle.removeEventListener("pointercancel", finish);
					Zotero.Prefs.set(GEOMETRY_PREF, JSON.stringify(this.geometry), true);
				};
				handle.addEventListener("pointermove", move);
				handle.addEventListener("pointerup", finish);
				handle.addEventListener("pointercancel", finish);
			});
		}

		get visible() {
			return !this.node.hidden;
		}

		show() {
			this.node.hidden = false;
			this._apply(this.geometry);
			this.view.closeChats();
			this.view.input.focus();
		}

		hide() {
			this.node.hidden = true;
		}

		destroy() {
			this.win.removeEventListener("resize", this._onResize);
			this.view.destroy();
			this.node.remove();
		}
	}

	/** Opens the paper at a thread's highlight. */
	Buddy.revealAnchor = async (anchor) => {
		const attachment = Zotero.Items.getByLibraryAndKey(anchor.libraryID, anchor.attachmentKey);
		if (!attachment) throw new Error("The paper for this highlight is no longer in your library.");
		const saved = !anchor.pending && Zotero.Items.getByLibraryAndKey(anchor.libraryID, anchor.annotationKey);
		if (saved) await Zotero.Reader.open(attachment.id, { annotationID: anchor.annotationKey });
		else await Zotero.Reader.open(attachment.id, anchor.page ? { pageIndex: anchor.page - 1 } : undefined);
	};

	Buddy.UI = {
		cards: new Map(),
		buttons: new Map(),
		infoButtons: new Map(),

		register() {
			this._onPopup = (event) => this._renderPopupButton(event);
			this._onMenu = (event) => this._renderMenuItem(event);
			this._onHeader = (event) => this._renderHeaderButton(event);
			Zotero.Reader.registerEventListener("renderTextSelectionPopup", this._onPopup, Buddy.id);
			Zotero.Reader.registerEventListener("createAnnotationContextMenu", this._onMenu, Buddy.id);
			Zotero.Reader.registerEventListener("renderSidebarAnnotationHeader", this._onHeader, Buddy.id);
			// The toolbar is the first thing every reader renders, whether in a tab or its own window.
			this._onToolbar = ({ reader }) => this._watchReader(reader);
			Zotero.Reader.registerEventListener("renderToolbar", this._onToolbar, Buddy.id);
			for (const reader of Zotero.Reader._readers) this._watchReader(reader);
			Buddy.History.ensureLoaded();
		},

		unregister() {
			Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", this._onPopup);
			Zotero.Reader.unregisterEventListener("createAnnotationContextMenu", this._onMenu);
			Zotero.Reader.unregisterEventListener("renderSidebarAnnotationHeader", this._onHeader);
			Zotero.Reader.unregisterEventListener("renderToolbar", this._onToolbar);
			// The hook is an own property shadowing the reader's method, so deleting it restores the original.
			for (const reader of Zotero.Reader._readers) {
				if (reader._internalReader) delete reader._internalReader.setSelectedAnnotations;
			}
		},

		_watchReader(reader) {
			reader._initPromise.then(() => this._hookHighlightClicks(reader), () => {});
		},

		/**
		 * Zotero has no event for clicking an annotation. Every click in the page goes through this reader method,
		 * while the sidebar holds its own bound copy, so replacing it changes clicks on the page only.
		 */
		_hookHighlightClicks(reader) {
			const internal = reader._internalReader;
			if (Object.hasOwn(internal, "setSelectedAnnotations")) return;
			const original = internal.setSelectedAnnotations;
			internal.setSelectedAnnotations = Components.utils.exportFunction((ids, fromView, event) => {
				if (this._isThreadClick(reader, ids, fromView, event)) {
					// Selecting nothing is what keeps the comment popup closed.
					original.call(internal, [], fromView, event);
					this._openThreadOnRelease(reader, ids[0], event);
					return;
				}
				original.call(internal, ids, fromView, event);
			}, reader._iframeWindow);
		},

		/** Only a plain left click. Right-click and modifier clicks keep Zotero's behaviour, so the highlight can still be edited. */
		_isThreadClick(reader, ids, fromView, event) {
			try {
				return !!fromView && ids.length === 1 && event?.button === 0
					&& !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
					&& Buddy.Chat.isThreadHighlight(reader, ids[0]);
			}
			catch (e) {
				Zotero.logError(e);
				return false;
			}
		},

		/** The reader selects on press, so wait for the release to tell a click from a drag. */
		_openThreadOnRelease(reader, key, event) {
			if (event.type === "pointerup") {
				this.openThread(reader, key);
				return;
			}
			const win = event.view;
			const { screenX, screenY } = event;
			const finish = (e) => {
				win.removeEventListener("pointerup", finish, true);
				win.removeEventListener("pointercancel", finish, true);
				if (e.type === "pointerup" && Math.hypot(e.screenX - screenX, e.screenY - screenY) <= 5) this.openThread(reader, key);
			};
			win.addEventListener("pointerup", finish, true);
			win.addEventListener("pointercancel", finish, true);
		},

		/** The tab bar stays visible in the library and in every reader tab. */
		addToWindow(win) {
			if (this.buttons.has(win)) return;
			const doc = win.document;
			const button = doc.createXULElement("toolbarbutton");
			button.id = "research-buddy-tb";
			button.className = "zotero-tb-button buddy-tb";
			button.setAttribute("label", "Research Buddy");
			button.setAttribute("tooltiptext", "Open or hide the Research Buddy chat");
			button.setAttribute("tabindex", "-1");
			button.addEventListener("command", () => this.toggle(win));
			const info = doc.createXULElement("toolbarbutton");
			info.id = "research-buddy-info";
			info.className = "zotero-tb-button buddy-tb";
			info.setAttribute("tooltiptext", "Research Buddy tour: see everything it can do");
			info.setAttribute("tabindex", "-1");
			// Draws attention until the tour has been seen once.
			if (!Buddy.Tour.seen) info.setAttribute("buddy-new", "true");
			info.addEventListener("command", () => Buddy.Tour.start(win));
			doc.getElementById("zotero-tb-sync").before(button, info);
			this.buttons.set(win, button);
			this.infoButtons.set(win, info);
		},

		removeFromWindow(win) {
			this.buttons.get(win)?.remove();
			this.buttons.delete(win);
			this.infoButtons.get(win)?.remove();
			this.infoButtons.delete(win);
			this.cards.get(win)?.destroy();
			this.cards.delete(win);
		},

		_card(win) {
			if (!this.cards.has(win)) this.cards.set(win, new Card(win));
			return this.cards.get(win);
		},

		/** Brings the chat window back when something needs the user's answer. */
		reveal() {
			const win = Zotero.getMainWindow();
			if (!win) return;
			const card = this._card(win);
			if (!card.visible) card.show();
		},

		toggle(win) {
			const card = this._card(win);
			if (card.visible) card.hide();
			else card.show();
		},

		_renderPopupButton({ reader, doc, params, append }) {
			const button = doc.createElement("button");
			button.textContent = "\u2733 Ask buddy";
			button.title = "Ask Research Buddy about this passage";
			button.style.cssText = "cursor:pointer;padding:4px 10px;border:none;border-radius:6px;background:#D97757;color:#fff;"
				+ "font-weight:600;box-shadow:0 1px 3px rgba(0,0,0,.25);";
			button.addEventListener("click", () => this.askAbout(reader, params.annotation));
			append(button);
		},

		/** Right-clicking a highlight in the sidebar can open or start its thread. */
		_renderMenuItem({ reader, params, append }) {
			if (params.ids?.length !== 1) return;
			const key = params.ids[0];
			append({
				label: Buddy.Chat.hasThread(key) ? "Continue Research Buddy thread" : "Ask Research Buddy about this",
				onCommand: () => this.openThread(reader, key),
			});
		},

		/** Highlights that already have a thread get a button in the sidebar. */
		_renderHeaderButton({ reader, doc, params, append }) {
			const key = params.annotation?.id;
			if (!key || !Buddy.Chat.hasThread(key)) return;
			const button = doc.createElement("button");
			button.textContent = "Buddy thread";
			button.title = "Continue this conversation with Research Buddy";
			button.style.cssText = "cursor:pointer;padding:1px 7px;font-size:11px;margin-inline-start:6px;border:none;border-radius:5px;"
				+ "background:#D97757;color:#fff;font-weight:600;";
			button.addEventListener("click", (e) => {
				e.stopPropagation();
				this.openThread(reader, key);
			});
			append(button);
		},

		async openThread(reader, key) {
			try {
				await Buddy.Chat.openThread(reader, key);
				this._card(Zotero.getMainWindow()).show();
			}
			catch (e) {
				Zotero.logError(e);
			}
		},

		/** Saves the selection as a highlight on the first question and opens a chat attached to it. */
		async askAbout(reader, annotation) {
			try {
				await Buddy.Chat.startThread(reader, annotation);
				const card = this._card(Zotero.getMainWindow());
				card.show();
				const input = card.view.input;
				input.setSelectionRange(input.value.length, input.value.length);
			}
			catch (e) {
				Zotero.logError(e);
			}
		},
	};
}

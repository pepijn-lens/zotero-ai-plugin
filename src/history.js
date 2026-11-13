// Saved chats: one JSON file per chat in the profile, plus an in-memory index for searching.
Buddy.History = {
	ID: /^[0-9a-f-]{36}$/,
	index: new Map(),
	loaded: null,
	queue: Promise.resolve(),

	get dir() {
		return PathUtils.join(PathUtils.profileDir, "research-buddy", "chats");
	},

	_path(id) {
		if (!this.ID.test(id)) throw new Error("Invalid chat ID.");
		return PathUtils.join(this.dir, `${id}.json`);
	},

	_entry(chat) {
		const text = [chat.title, chat.anchor?.text || "", ...chat.messages.filter((m) => m.role === "user" || m.role === "assistant").map((m) => m.text)]
			.join("\n").toLowerCase();
		const last = [...chat.messages].reverse().find((m) => m.role !== "status");
		const flag = last?.role === "error" ? "error" : null;
		return {
			flag,
			id: chat.id,
			title: chat.title,
			created: chat.created,
			updated: chat.updated,
			count: chat.messages.filter((m) => m.role === "user").length,
			anchor: chat.anchor ? { annotationKey: chat.anchor.annotationKey, text: chat.anchor.text, page: chat.anchor.page } : null,
			text,
		};
	},

	/** Reads every saved chat into the index, once. */
	ensureLoaded() {
		if (!this.loaded) {
			this.loaded = (async () => {
				let files = [];
				try {
					files = await IOUtils.getChildren(this.dir);
				}
				catch (e) {}
				for (const path of files) {
					if (!path.endsWith(".json")) continue;
					try {
						const chat = await IOUtils.readJSON(path);
						if (this.ID.test(chat.id) && Array.isArray(chat.messages)) this.index.set(chat.id, this._entry(chat));
					}
					catch (e) {
						Zotero.debug(`[Research Buddy] Skipped unreadable chat ${path}: ${e}`);
					}
				}
			})();
		}
		return this.loaded;
	},

	/** Writes happen one after another so a slow save can never overwrite a newer one. */
	save(chat) {
		const snapshot = JSON.parse(JSON.stringify(chat));
		const run = async () => {
			await this.ensureLoaded();
			await IOUtils.makeDirectory(this.dir, { ignoreExisting: true, createAncestors: true, permissions: 0o700 });
			const path = this._path(snapshot.id);
			await IOUtils.writeJSON(path, snapshot, { tmpPath: `${path}.tmp` });
			this.index.set(snapshot.id, this._entry(snapshot));
		};
		this.queue = this.queue.then(run).catch((e) => Zotero.logError(e));
		return this.queue;
	},

	remove(id) {
		const run = async () => {
			await this.ensureLoaded();
			await IOUtils.remove(this._path(id), { ignoreAbsent: true });
			this.index.delete(id);
		};
		this.queue = this.queue.then(run).catch((e) => Zotero.logError(e));
		return this.queue;
	},

	async read(id) {
		try {
			return await IOUtils.readJSON(this._path(id));
		}
		catch (e) {
			return null;
		}
	},

	/** The most recently used chat attached to a highlight, if any. Only knows chats once the index has loaded. */
	byAnnotation(key) {
		return [...this.index.values()]
			.filter((entry) => entry.anchor?.annotationKey === key)
			.sort((a, b) => b.updated - a.updated)[0] || null;
	},

	/** Chats whose title or text contains every word of the query, newest first. */
	async search(query) {
		await this.ensureLoaded();
		await this.queue;
		const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
		return [...this.index.values()]
			.filter((entry) => terms.every((term) => entry.text.includes(term)))
			.sort((a, b) => b.updated - a.updated)
			.map((entry) => {
				let snippet = "";
				if (terms.length && !entry.title.toLowerCase().includes(terms[0])) {
					const at = entry.text.indexOf(terms[0]);
					const from = Math.max(0, at - 30);
					snippet = (from ? "…" : "") + entry.text.slice(from, at + 70).replace(/\s+/g, " ") + "…";
				}
				return { ...entry, snippet };
			});
	},
};

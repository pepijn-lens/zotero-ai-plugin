// The Zotero tools, which run without an approval prompt. All read-only: propose_paper merely draws a card.
{
	const MAX_PAGES = 15;

	function findItem(key) {
		for (const library of Zotero.Libraries.getAll()) {
			const item = Zotero.Items.getByLibraryAndKey(library.libraryID, String(key).trim());
			if (item) return item;
		}
		throw new Error(`No item with key ${key}.`);
	}

	async function resolveAttachment(key) {
		const item = findItem(key);
		if (item.isAttachment()) return item;
		const attachment = item.isRegularItem() ? await item.getBestAttachment() : null;
		if (!attachment) throw new Error(`Item ${key} has no readable attachment.`);
		return attachment;
	}

	function summary(item) {
		const year = Zotero.Date.strToDate(item.getField("date") || "").year;
		return {
			itemKey: item.key,
			title: item.getDisplayTitle(),
			authors: item.getField("firstCreator") || undefined,
			year: year || undefined,
			doi: item.getField("DOI") || undefined,
		};
	}

	const topLevel = (item) => (item.isAttachment() || item.isNote() || item.isAnnotation())
		? (item.topLevelItem || item) : item;

	function activeReader() {
		const win = Zotero.getMainWindow();
		return win && Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
	}

	function readerPage(reader, attachment) {
		let index;
		try {
			index = reader._internalReader._state.primaryViewStats.pageIndex;
		}
		catch (e) {}
		if (!Number.isInteger(index)) index = attachment.getAttachmentLastPageIndex();
		return Number.isInteger(index) ? index + 1 : undefined;
	}

	function findCollection(key) {
		for (const library of Zotero.Libraries.getAll()) {
			const collection = Zotero.Collections.getByLibraryAndKey(library.libraryID, String(key).trim());
			if (collection) return collection;
		}
		throw new Error(`No collection with key ${key}.`);
	}

	/** Every top-level item in a collection and its subcollections. */
	async function collectionItems(collection) {
		const search = new Zotero.Search();
		search.libraryID = collection.libraryID;
		search.addCondition("collection", "is", collection.key);
		search.addCondition("recursive", "true");
		search.addCondition("noChildren", "true");
		const items = await Zotero.Items.getAsync(await search.search());
		return items.filter((i) => i.isRegularItem() && !i.deleted);
	}

	Buddy.readableLibraries = () => Zotero.Libraries.getAll().filter((l) => l.libraryType !== "feed");

	/** One-line description of what's open, added to each user message. */
	Buddy.contextLine = function (anchor) {
		if (anchor) {
			return `[Zotero context: the user is asking about a passage they highlighted${anchor.page ? ` on page ${anchor.page}` : ""} `
				+ `of attachmentKey ${anchor.attachmentKey}. The passage: "${anchor.text}"]`;
		}
		const reader = activeReader();
		if (reader) {
			const attachment = Zotero.Items.get(reader.itemID);
			const parent = topLevel(attachment);
			const page = readerPage(reader, attachment);
			return `[Zotero context: reading "${parent.getDisplayTitle()}", attachmentKey ${attachment.key}`
				+ `${page ? `, currently on page ${page}` : ""}]`;
		}
		const selected = Zotero.getActiveZoteroPane()?.getSelectedItems() || [];
		if (selected.length) {
			const item = topLevel(selected[0]);
			return `[Zotero context: library view, selected "${item.getDisplayTitle()}", itemKey ${item.key}]`;
		}
		return "[Zotero context: library view, nothing selected]";
	};

	/** Text for a citation link: "Smith 2020, p. 7", or "p. 7" when the item can't be found. */
	Buddy.citationLabel = function (key, page) {
		try {
			const parent = topLevel(findItem(key));
			const year = Zotero.Date.strToDate(parent.getField("date") || "").year;
			const who = [parent.getField("firstCreator"), year].filter(Boolean).join(" ");
			return who ? `${who}, p. ${page}` : `p. ${page}`;
		}
		catch (e) {
			return `p. ${page}`;
		}
	};

	/** Zotero.Reader.open() returns nothing when it wakes an unloaded tab, whose reader appears shortly after. */
	async function wokenTabReader(itemID) {
		const tabID = Zotero.getMainWindow().Zotero_Tabs.getTabIDByItemID(itemID);
		for (let waited = 0; waited < 10000; waited += 50) {
			const reader = Zotero.Reader.getByTabID(tabID);
			if (reader) return reader;
			await Zotero.Promise.delay(50);
		}
		return null;
	}

	Buddy.openCitation = async function (key, page, quote) {
		const attachment = await resolveAttachment(key);
		if (!attachment.isPDFAttachment()) {
			await Zotero.Reader.open(attachment.id);
			return true;
		}
		const pageIndex = page - 1;
		const opened = await Zotero.Reader.open(attachment.id, { pageIndex });
		if (!quote) return true;
		const reader = opened || await wokenTabReader(attachment.id);
		return !!reader && Buddy.Locate.reveal(reader, pageIndex, quote);
	};

	Buddy.writableLibraries = () => Zotero.Libraries.getAll().filter((l) => l.libraryType !== "feed" && l.editable);

	async function librarySearchIDs(query, libraryID) {
		const run = async (value) => {
			const search = new Zotero.Search();
			search.libraryID = libraryID;
			search.addCondition("quicksearch-everything", "contains", value);
			return search.search();
		};
		const all = await run(query);
		const terms = query.split(/\s+/).filter((t) => t.length > 2);
		if (all.length || terms.length < 2) return all;
		// Nothing matches every term, so rank items by how many of the terms they contain.
		const score = new Map();
		for (const term of terms) {
			for (const id of await run(term)) score.set(id, (score.get(id) || 0) + 1);
		}
		return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
	}

	const str = (description) => ({ type: "string", description });
	const int = (description) => ({ type: "integer", description });
	const schema = (properties, required = []) => ({ type: "object", properties, required });

	Buddy.Tools = [
		{
			name: "get_current_context",
			description: "What the user has open now: the paper, its attachmentKey and current page, or the items selected in the library.",
			inputSchema: schema({}),
			async run() {
				const reader = activeReader();
				if (reader) {
					const attachment = Zotero.Items.get(reader.itemID);
					const pages = await Buddy.PDFText.pages(attachment);
					return {
						view: "reader",
						...summary(topLevel(attachment)),
						attachmentKey: attachment.key,
						currentPage: readerPage(reader, attachment),
						totalPages: pages.length,
						hasTextLayer: Buddy.PDFText.hasText(pages),
					};
				}
				const selected = Zotero.getActiveZoteroPane()?.getSelectedItems() || [];
				return { view: "library", selected: selected.slice(0, 10).map((i) => summary(topLevel(i))) };
			},
		},
		{
			name: "read_pages",
			description: `Read the text of pages of a paper, up to ${MAX_PAGES} pages per call.`,
			inputSchema: schema({
				itemKey: str("Item key or attachmentKey"),
				from: int("First page, starting at 1"),
				to: int("Last page, inclusive"),
			}, ["itemKey", "from", "to"]),
			async run({ itemKey, from, to }) {
				const attachment = await resolveAttachment(itemKey);
				const pages = await Buddy.PDFText.pages(attachment);
				if (!Buddy.PDFText.hasText(pages)) {
					return { error: "This attachment has no text layer, so it cannot be read.", totalPages: pages.length };
				}
				const first = Math.max(1, from);
				const last = Math.min(pages.length, to, first + MAX_PAGES - 1);
				return {
					attachmentKey: attachment.key,
					totalPages: pages.length,
					pages: pages.slice(first - 1, last).map((text, i) => ({ page: first + i, text })),
				};
			},
		},
		{
			name: "find_in_paper",
			description: "Find the pages of one paper that mention a phrase or set of keywords.",
			inputSchema: schema({ itemKey: str("Item key or attachmentKey"), query: str("Phrase or keywords") },
				["itemKey", "query"]),
			async run({ itemKey, query }) {
				const attachment = await resolveAttachment(itemKey);
				const pages = await Buddy.PDFText.pages(attachment);
				if (!Buddy.PDFText.hasText(pages)) return { error: "This attachment has no text layer." };
				return { attachmentKey: attachment.key, totalPages: pages.length, matches: Buddy.PDFText.find(pages, query) };
			},
		},
		{
			name: "get_item",
			description: "Metadata, abstract, tags, attachments and the user's annotations for a library item.",
			inputSchema: schema({ itemKey: str("Item key or attachmentKey") }, ["itemKey"]),
			async run({ itemKey }) {
				const item = topLevel(findItem(itemKey));
				const attachments = item.isRegularItem() ? Zotero.Items.get(item.getAttachments()) : [item];
				return {
					...summary(item),
					publication: item.getField("publicationTitle") || undefined,
					abstract: item.getField("abstractNote") || undefined,
					tags: item.getTags().map((t) => t.tag),
					attachments: attachments.map((a) => ({ attachmentKey: a.key, title: a.getDisplayTitle(), type: a.attachmentContentType })),
					annotations: attachments.filter((a) => a.isFileAttachment()).flatMap((a) => a.getAnnotations().map((n) => ({
						attachmentKey: a.key,
						type: n.annotationType,
						page: n.annotationPageLabel,
						text: n.annotationText || undefined,
						comment: n.annotationComment || undefined,
					}))),
				};
			},
		},
		{
			name: "search_library",
			description: "Search titles, authors, notes and full text across the user's library, or within one collection when collectionKey is given. Use a few distinctive keywords. Returns items with matching pages.",
			inputSchema: schema({
				query: str("Keywords"),
				limit: int("Maximum items, default 8, at most 20"),
				collectionKey: str("Only search this collection and its subcollections"),
			}, ["query"]),
			async run({ query, limit = 8, collectionKey }) {
				const collection = collectionKey ? findCollection(collectionKey) : null;
				const scope = collection ? new Set((await collectionItems(collection)).map((i) => i.id)) : null;
				const seen = new Map();
				for (const id of await librarySearchIDs(query, collection ? collection.libraryID : Zotero.Libraries.userLibraryID)) {
					const item = Zotero.Items.get(id);
					if (item.deleted) continue;
					const top = topLevel(item);
					if (scope && !scope.has(top.id)) continue;
					if (top.isRegularItem() && !seen.has(top.id)) seen.set(top.id, top);
				}
				const results = [];
				for (const item of [...seen.values()].slice(0, Math.min(limit, 20))) {
					const row = summary(item);
					const attachment = await item.getBestAttachment();
					if (attachment) {
						row.attachmentKey = attachment.key;
						try {
							row.matches = Buddy.PDFText.find(await Buddy.PDFText.pages(attachment), query, 3);
						}
						catch (e) {
							row.note = e.message;
						}
					}
					if (!row.matches?.length) row.abstract = (item.getField("abstractNote") || "").slice(0, 400) || undefined;
					results.push(row);
				}
				return { totalMatches: seen.size, results };
			},
		},
		{
			name: "get_collection",
			description: "List the papers in a collection (folder), including its subcollections, with item and attachment keys. Use it to answer questions about several papers at once.",
			inputSchema: schema({ collectionKey: str("collectionKey") }, ["collectionKey"]),
			async run({ collectionKey }) {
				const collection = findCollection(collectionKey);
				const items = await collectionItems(collection);
				const rows = [];
				for (const item of items.slice(0, 100)) {
					const row = summary(item);
					const attachment = await item.getBestAttachment();
					if (attachment) row.attachmentKey = attachment.key;
					rows.push(row);
				}
				return { collection: collection.name, collectionKey: collection.key, totalItems: items.length, items: rows };
			},
		},
		{
			name: "list_collections",
			description: "List every folder (collection) the user can save papers into, per library, with collectionKey, nesting path and paper count. Use it to pick the folder for propose_paper.",
			inputSchema: schema({}),
			async run() {
				return Buddy.writableLibraries().map((library) => ({
					library: library.name,
					collections: Zotero.Collections.getByLibrary(library.libraryID, true).map((c) => {
						const path = [c.name];
						for (let p = c.parentID && Zotero.Collections.get(c.parentID); p; p = p.parentID && Zotero.Collections.get(p.parentID)) {
							path.unshift(p.name);
						}
						return { collectionKey: c.key, path: path.join(" / "), papers: c.getChildItems(true).length };
					}),
				}));
			},
		},
		{
			name: "scout_search",
			description: "Search scholarly literature outside the library (OpenAlex). Results say whether the user already owns each paper.",
			inputSchema: schema({ query: str("Search terms"), fromYear: int("Only papers from this year onward") }, ["query"]),
			run: ({ query, fromYear }) => Buddy.Scout.search(query, fromYear),
		},
		{
			name: "scout_related",
			description: "Papers that cite a given DOI, and papers it references (OpenAlex).",
			inputSchema: schema({ doi: str("DOI") }, ["doi"]),
			run: ({ doi }) => Buddy.Scout.related(doi),
		},
		{
			name: "propose_paper",
			description: "Show the user a card suggesting a paper, with the folder it should go in preselected. Only the user can add it to their library.",
			inputSchema: schema({
				doi: str("DOI from a scout result"),
				title: str("Paper title"),
				reason: str("One sentence on why it's relevant"),
				collectionKey: str("Key of the folder that best fits this paper, from list_collections. Use an empty string only when no folder fits."),
			}, ["doi", "title", "reason", "collectionKey"]),
			async run({ doi, title, reason, collectionKey }, { session }) {
				const clean = Zotero.Utilities.cleanDOI(doi);
				if (!clean) throw new Error(`Not a valid DOI: ${doi}`);
				let collection = null;
				if (collectionKey && collectionKey.trim()) {
					collection = findCollection(collectionKey);
					if (!Zotero.Libraries.get(collection.libraryID).editable) {
						throw new Error(`Folder ${collectionKey} is read-only. Pick another with list_collections.`);
					}
				}
				if (await Buddy.Scout.findByDOI(clean)) return { shown: false, note: "Already in the library." };
				session.addProposal({ doi: clean, title, reason, destination: collection ? `C${collection.id}` : `L${Zotero.Libraries.userLibraryID}` });
				return {
					shown: true,
					folder: collection ? collection.name : "no folder",
					note: "Card shown with this folder preselected. The user decides whether to add it.",
				};
			},
		},
	];
}

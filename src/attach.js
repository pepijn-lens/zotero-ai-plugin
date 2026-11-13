// Things the user can attach to a message: images, and @-tagged items and collections.
{
	const XHTML = "http://www.w3.org/1999/xhtml";
	const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
	const MAX_EDGE = 1568;
	const MAX_BYTES = 3 * 1024 * 1024;

	const toBase64 = (win, blob) => new Promise((resolve, reject) => {
		const reader = new win.FileReader();
		reader.onload = () => resolve(String(reader.result).split(",")[1]);
		reader.onerror = () => reject(new Error("Couldn't read the image."));
		reader.readAsDataURL(blob);
	});

	Buddy.Attach = {
		MAX_IMAGES: 5,

		mimeFromPath(path) {
			return MIME[path.split(".").pop().toLowerCase()] || null;
		},

		isImage(type) {
			return Object.values(MIME).includes(type);
		},

		/**
		 * Prepares an image for Claude. Small images are sent as they are; big ones are shrunk, because
		 * the API rejects very large images. A small thumbnail is kept for showing in the chat.
		 */
		async image(win, blob) {
			if (!this.isImage(blob.type)) throw new Error("Only PNG, JPEG, GIF and WebP images can be attached.");
			const bitmap = await win.createImageBitmap(blob);
			const draw = (edge, type, quality) => {
				const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
				const canvas = win.document.createElementNS(XHTML, "canvas");
				canvas.width = Math.max(1, Math.round(bitmap.width * scale));
				canvas.height = Math.max(1, Math.round(bitmap.height * scale));
				const ctx = canvas.getContext("2d");
				if (type === "image/jpeg") {
					ctx.fillStyle = "#fff";
					ctx.fillRect(0, 0, canvas.width, canvas.height);
				}
				ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
				return canvas.toDataURL(type, quality);
			};

			let mediaType = blob.type;
			let data;
			if (blob.size <= MAX_BYTES && Math.max(bitmap.width, bitmap.height) <= MAX_EDGE) {
				data = await toBase64(win, blob);
			}
			else {
				mediaType = "image/jpeg";
				for (const edge of [MAX_EDGE, 1100, 700]) {
					data = draw(edge, mediaType, 0.85).split(",")[1];
					if (data.length * 0.75 <= MAX_BYTES) break;
				}
			}
			const thumb = draw(240, "image/jpeg", 0.7);
			bitmap.close();
			return { mediaType, data, thumb };
		},

		/** Collections and items matching what was typed after "@". */
		async searchMentions(query) {
			query = query.trim().toLowerCase();
			const libraries = Buddy.readableLibraries();
			const results = [];

			for (const library of libraries) {
				for (const c of Zotero.Collections.getByLibrary(library.libraryID, true)) {
					if (!query || c.name.toLowerCase().includes(query)) {
						results.push({
							kind: "collection",
							libraryID: library.libraryID,
							key: c.key,
							label: c.name,
							sub: libraries.length > 1 ? library.name : "Folder",
						});
					}
				}
			}
			const collections = results.slice(0, 6);

			const items = [];
			if (query) {
				for (const library of libraries) {
					const search = new Zotero.Search();
					search.libraryID = library.libraryID;
					search.addCondition("quicksearch-titleCreatorYear", "contains", query);
					search.addCondition("noChildren", "true");
					for (const item of await Zotero.Items.getAsync(await search.search())) {
						if (!item.isRegularItem() || item.deleted) continue;
						const year = Zotero.Date.strToDate(item.getField("date") || "").year;
						items.push({
							kind: "item",
							libraryID: library.libraryID,
							key: item.key,
							label: item.getDisplayTitle(),
							sub: [item.getField("firstCreator"), year].filter(Boolean).join(" "),
						});
						if (items.length >= 8) break;
					}
				}
			}
			return [...collections, ...items.slice(0, 8)];
		},

		/** The token inserted into the message text for a tagged item or collection. */
		token(mention) {
			const label = mention.label.replace(/\s+/g, " ").trim();
			return `@${label.length > 40 ? `${label.slice(0, 40).trim()}…` : label}`;
		},

		/** A line telling the agent what each @tag in the message refers to. */
		async mentionContext(mentions) {
			const lines = [];
			for (const m of mentions) {
				if (m.kind === "collection") {
					const collection = Zotero.Collections.getByLibraryAndKey(m.libraryID, m.key);
					if (!collection) continue;
					lines.push(`- "${m.token}" is the collection "${collection.name}" (collectionKey ${collection.key}). `
						+ "List its papers with get_collection, or pass the collectionKey to search_library.");
				}
				else {
					const item = Zotero.Items.getByLibraryAndKey(m.libraryID, m.key);
					if (!item) continue;
					const attachment = item.isRegularItem() ? await item.getBestAttachment() : item;
					lines.push(`- "${m.token}" is the item "${item.getDisplayTitle()}" (itemKey ${item.key}`
						+ `${attachment ? `, attachmentKey ${attachment.key}` : ", no readable attachment"}).`);
				}
			}
			return lines.length ? `[The user tagged these with @:\n${lines.join("\n")}]\n\n` : "";
		},
	};
}

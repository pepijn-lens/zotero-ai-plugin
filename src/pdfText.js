// Page-level text for attachments, kept in a small in-memory cache keyed by file path and mtime.
Buddy.PDFText = {
	MAX_CACHED: 40,
	cache: new Map(),

	async pages(attachment) {
		const path = await attachment.getFilePathAsync();
		if (!path) throw new Error("The file for this attachment is not on this computer.");
		const { lastModified } = await IOUtils.stat(path);
		const key = `${path}:${lastModified}`;
		const hit = this.cache.get(key);
		if (hit) return hit;

		let pages;
		if (attachment.isPDFAttachment()) {
			pages = await this._pdftotext(path);
		}
		else {
			pages = [(await attachment.attachmentText) || ""];
		}
		this.cache.set(key, pages);
		if (this.cache.size > this.MAX_CACHED) this.cache.delete(this.cache.keys().next().value);
		return pages;
	},

	hasText(pages) {
		return pages.join("").trim().length >= 100;
	},

	/**
	 * Extracts each page separately. Splitting one big output on form feeds isn't safe, because
	 * figure text in some PDFs contains stray form feeds, which would shift every page number.
	 */
	async _pdftotext(path) {
		const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
		const run = Zotero.Utilities.Internal.subprocess.bind(Zotero.Utilities.Internal);
		const info = await run(await Subprocess.pathSearch("pdfinfo"), [path]);
		const count = parseInt(info.match(/^Pages:\s+(\d+)/m)?.[1]);
		if (!count) return [""];

		const exe = await Subprocess.pathSearch("pdftotext");
		const pages = new Array(count);
		let next = 1;
		const worker = async () => {
			while (next <= count) {
				const page = next++;
				const text = await run(exe, ["-enc", "UTF-8", "-q", "-f", String(page), "-l", String(page), path, "-"]);
				pages[page - 1] = text.replace(/[\u0000-\u0008\u000b-\u001f]/g, " ");
			}
		};
		await Promise.all(Array.from({ length: 6 }, worker));
		return pages;
	},

	/** Pages with the exact phrase first, then pages by how many keywords they contain, with a snippet each. */
	find(pages, query, maxPages = 10) {
		const phrase = query.trim().toLowerCase();
		const terms = phrase.split(/\s+/).filter((t) => t.length > 1);
		const hits = [];
		pages.forEach((text, i) => {
			const lower = text.toLowerCase();
			const found = terms.filter((t) => lower.includes(t));
			const phraseAt = lower.indexOf(phrase);
			if (phraseAt < 0 && !found.length) return;
			const at = phraseAt >= 0 ? phraseAt : lower.indexOf(found[0]);
			hits.push({
				page: i + 1,
				score: phraseAt >= 0 ? terms.length + 1 : found.length,
				snippet: text.slice(Math.max(0, at - 150), at + 200).replace(/\s+/g, " ").trim(),
			});
		});
		return hits
			.sort((a, b) => b.score - a.score || a.page - b.page)
			.slice(0, maxPages)
			.map(({ page, snippet }) => ({ page, snippet }));
	},
};

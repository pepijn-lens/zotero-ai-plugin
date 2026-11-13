// Finds a quoted passage in the reader's own character data and highlights it. Going through the
// reader's coordinates means the highlight lands exactly on the rendered text.
Buddy.Locate = {
	HOLD_MS: 10000,
	MIN_WINDOW_WORDS: 4,
	_generation: 0,

	/** Lowercased letters and digits only, so line-break hyphens and ligatures can't break a match. */
	_normalize(text) {
		return [...text.normalize("NFKC").toLowerCase()].filter((c) => /[\p{L}\p{N}]/u.test(c)).join("");
	},

	/** The page's searchable text, with a map from each of its positions back to a character index. */
	_index(chars) {
		let text = "";
		const map = [];
		chars.forEach((char, i) => {
			if (char.ignorable) return;
			const piece = this._normalize(char.u || char.c || "");
			text += piece;
			for (let n = 0; n < piece.length; n++) map.push(i);
		});
		return { text, map };
	},

	/** [first, last] character indexes of the quote, or of its longest run of words on the page. */
	_match(chars, quote) {
		const { text, map } = this._index(chars);
		const range = (needle) => {
			const at = needle ? text.indexOf(needle) : -1;
			return at < 0 ? null : [map[at], map[at + needle.length - 1]];
		};
		const whole = range(this._normalize(quote));
		if (whole) return whole;
		const words = quote.split(/\s+/).filter(Boolean);
		for (let size = words.length - 1; size >= this.MIN_WINDOW_WORDS; size--) {
			for (let start = 0; start + size <= words.length; start++) {
				const found = range(this._normalize(words.slice(start, start + size).join(" ")));
				if (found) return found;
			}
		}
		return null;
	},

	/** One rectangle per line of text, in the reader's page coordinates. */
	_rects(chars) {
		const rects = [];
		let line = null;
		for (const { inlineRect: r, lineBreakAfter } of chars) {
			line = line ? [Math.min(line[0], r[0]), Math.min(line[1], r[1]), Math.max(line[2], r[2]), Math.max(line[3], r[3])] : [...r];
			if (lineBreakAfter) {
				rects.push(line);
				line = null;
			}
		}
		if (line) rects.push(line);
		return rects;
	},

	async _position(view, pageIndex, quote) {
		const total = view._iframeWindow.PDFViewerApplication.pagesCount;
		// Check neighbouring pages too, in case a passage straddles a page boundary.
		for (const index of [pageIndex, pageIndex + 1, pageIndex - 1]) {
			if (index < 0 || index >= total) continue;
			await view._ensureBasicPageData(index);
			const chars = view._pdfPages[index]?.chars;
			const found = chars && this._match(chars, quote);
			if (found) return { pageIndex: index, rects: this._rects(chars.slice(found[0], found[1] + 1)) };
		}
		return null;
	},

	async _readyView(reader) {
		await reader._initPromise;
		const internal = reader._internalReader;
		await internal._primaryView.initializedPromise;
		await internal._primaryView._iframeWindow.PDFViewerApplication.initializedPromise;
		await internal._primaryView._iframeWindow.PDFViewerApplication.pdfViewer.pagesPromise;
		return internal._primaryView;
	},

	/** Scrolls to the quote and highlights it. Returns false if the text couldn't be found. */
	async reveal(reader, pageIndex, quote) {
		const view = await this._readyView(reader);
		const position = await this._position(view, pageIndex, quote);
		if (!position) return false;
		await reader.navigate(position.rects.length ? { position } : { pageIndex });
		this._hold(reader, reader._internalReader._lastView, position);
		return true;
	},

	/** The reader clears its highlight after 2 seconds, which is too quick to find the passage. */
	_hold(reader, view, position) {
		const generation = ++this._generation;
		const win = reader._iframeWindow;
		const render = (value) => {
			view._highlightedPosition = value;
			view._render();
		};
		win.setTimeout(() => {
			if (generation === this._generation) render(Components.utils.cloneInto(position, win));
		}, 2100);
		win.setTimeout(() => {
			if (generation === this._generation) render(null);
		}, this.HOLD_MS);
	},
};

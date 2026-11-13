// A guided tour of Research Buddy. It opens by itself the first time, and again from the ⓘ button.
// Steps point at the real controls and, when the library has papers, use one of them so everything can be tried for real.
// The dimming never blocks clicks: the user does each step themselves, and the tour notices and moves on.
{
	const XHTML = "http://www.w3.org/1999/xhtml";
	const DONE_PREF = "extensions.researchbuddy.tourDone";
	const TICK_MS = 200;
	const GAP = 12;
	const POPOVER_WIDTH = 360;

	/** "**bold**" and "`key`" in step text. Everything else is plain text. */
	const rich = (doc, text) => {
		const frag = doc.createDocumentFragment();
		for (const part of text.split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
			if (!part) continue;
			let node;
			if (part.startsWith("**")) {
				node = doc.createElementNS(XHTML, "b");
				node.textContent = part.slice(2, -2);
			}
			else if (part.startsWith("`")) {
				node = doc.createElementNS(XHTML, "kbd");
				node.textContent = part.slice(1, -1);
			}
			else {
				node = doc.createTextNode(part);
			}
			frag.append(node);
		}
		return frag;
	};

	const shorten = (text, n = 60) => (text.length > n ? `${text.slice(0, n).trim()}…` : text);

	/** A paper to demonstrate with: one with a PDF if possible, and preferably with a DOI for the citation graph. */
	async function findPapers() {
		const result = { count: 0, pdf: null, any: null, collections: 0 };
		try {
			const libraryID = Zotero.Libraries.userLibraryID;
			result.collections = Zotero.Collections.getByLibrary(libraryID, true).length;
			const items = (await Zotero.Items.getAll(libraryID, true, false))
				.filter((item) => item.isRegularItem() && !item.deleted)
				.sort((a, b) => (b.dateAdded > a.dateAdded ? 1 : -1));
			result.count = items.length;
			const hasDOI = (item) => !!Zotero.Utilities.cleanDOI(item.getField("DOI") || "");
			// The demo paper of choice: Mamba, then any other Albert Gu paper, then the newest papers.
			const rank = (item) => {
				if (/^mamba\b/i.test(item.getField("title") || "")) return 0;
				const byGu = item.getCreators().some((c) => c.lastName === "Gu" && /^Albert/.test(c.firstName || ""));
				return byGu ? 1 : 2;
			};
			items.sort((a, b) => rank(a) - rank(b));
			result.any = items.find(hasDOI) || items[0] || null;
			let fallback = null;
			for (const item of items.slice(0, 150)) {
				const attachment = await item.getBestAttachment();
				if (!attachment?.isPDFAttachment?.() || !(await attachment.fileExists())) continue;
				const entry = { item, attachment, title: item.getDisplayTitle() };
				if (hasDOI(item)) {
					result.pdf = entry;
					break;
				}
				fallback = fallback || entry;
			}
			result.pdf = result.pdf || fallback;
		}
		catch (e) {
			Zotero.logError(e);
		}
		return result;
	}

	/** The words someone would type after "@" to find this paper. */
	const mentionQuery = (title) => (title.split(/\s+/).find((w) => w.replace(/\W/g, "").length >= 5) || title.split(/\s+/)[0] || "").replace(/[^\p{L}\p{N}-]/gu, "");

	/** The newest question in the chat in front, which changes whenever the user sends one, in any chat. */
	const lastQuestion = () => [...Buddy.Chat.messages].reverse().find((m) => m.role === "user") || null;

	const readerOpen = (win) => {
		try {
			return !!Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
		}
		catch (e) {
			return false;
		}
	};

	/**
	 * Every step: chapter, title, body (lines, or a function of the context returning lines),
	 * and optionally target (element to spotlight), enter (setup), task + done (something the user does, checked as they go),
	 * actions (buttons that do the step for them), skip (leave the step out), dim (false keeps the window bright).
	 */
	const STEPS = [
		{
			id: "welcome",
			chapter: "Welcome",
			title: "Research Buddy",
			body: (c) => [
				"An AI research assistant for your papers, powered by Claude Code.",
				c.papers.pdf ? `We'll try it on **“${shorten(c.papers.pdf.title, 50)}”**.` : "",
			],
			chapters: true,
		},
		{
			id: "button",
			chapter: "Welcome",
			title: "Open the chat",
			enter: (c) => c.card()?.hide(),
			target: (c) => c.doc.getElementById("research-buddy-tb"),
			body: [],
			task: "Click the button",
			done: (c) => c.card()?.visible,
		},
		{
			id: "mention",
			chapter: "Chat",
			title: "Tag papers with @",
			enter: (c) => {
				c.showCard();
				c.mark.mentions = Buddy.Chat.mentions.length;
			},
			target: (c) => c.view()?.input,
			body: [],
			task: (c) => (c.papers.pdf ? `Type @${mentionQuery(c.papers.pdf.title)} and pick it` : "Type @ and pick one"),
			done: (c) => Buddy.Chat.mentions.length > c.mark.mentions,
			actions: [{
				label: "Show me",
				when: (c) => c.papers.count || c.papers.collections,
				run: (c) => c.typeInChat(`@${c.papers.pdf ? mentionQuery(c.papers.pdf.title) : ""}`),
			}],
		},
		{
			id: "try",
			chapter: "Chat",
			title: "Ask a question",
			skip: (c) => !c.papers.pdf,
			enter: (c) => {
				c.showCard();
				c.mark.sent = lastQuestion();
			},
			target: (c) => c.view()?.input,
			body: [],
			task: "Send a question",
			done: (c) => !!lastQuestion() && lastQuestion() !== c.mark.sent,
			actions: [{
				label: "Write one for me",
				run: (c) => c.prefillQuestion(c.papers.pdf.item, (token) => `What are the three key takeaways of ${token}?`),
			}],
		},
		{
			id: "citations",
			chapter: "Chat",
			title: "Click citations to verify",
			enter: (c) => c.showCard(),
			target: (c) => c.view()?.log,
			body: [{ chip: "Smith 2021, p. 7" }, "Opens the PDF at the exact sentence."],
		},
		{
			id: "chats",
			chapter: "Chat",
			title: "Chats are saved",
			enter: (c) => c.showCard(),
			target: (c) => c.view()?.bar,
			body: [],
		},
		{
			id: "open-paper",
			chapter: "Reading",
			title: "Open a paper",
			skip: (c) => !c.papers.pdf,
			body: [],
			task: "Open the paper",
			done: (c) => readerOpen(c.win),
			actions: [{ label: "Open it", run: (c) => Zotero.Reader.open(c.papers.pdf.attachment.id) }],
		},
		{
			id: "ask-buddy",
			chapter: "Reading",
			title: "Ask about a passage",
			dim: false,
			corner: true,
			enter: (c) => {
				c.mark.anchor = Buddy.Chat.anchor;
			},
			body: [],
			task: "Select text, then click Ask buddy",
			done: (c) => !!Buddy.Chat.anchor && Buddy.Chat.anchor !== c.mark.anchor,
		},
		{
			id: "graph",
			chapter: "Citations",
			title: "Visualize citations",
			enter: async (c) => {
				c.mark.graphs = Buddy.CiteGraph.windows.size;
				if (c.papers.any) await c.selectInLibrary(c.papers.any);
			},
			target: (c) => (c.papers.any ? c.doc.getElementById("zotero-items-tree") || c.doc.getElementById("zotero-items-pane") : null),
			body: (c) => (c.papers.any ? [] : ["Right-click a paper → **Visualize citations**"]),
			task: (c) => (c.papers.any ? "Right-click the paper → Visualize citations" : ""),
			done: (c) => Buddy.CiteGraph.windows.size > c.mark.graphs,
			actions: [{
				label: "Open it",
				when: (c) => c.papers.any,
				run: (c) => Buddy.CiteGraph.open(c.win, { item: c.papers.any }),
			}],
		},
		{
			id: "scout",
			chapter: "Citations",
			title: "Find new papers",
			enter: (c) => {
				c.tipGraphWindow();
				c.showCard();
			},
			target: (c) => c.view()?.input,
			body: [],
			actions: [{
				label: "Try it",
				run: (c) => (c.papers.pdf
					? c.prefillQuestion(c.papers.pdf.item, (token) => `Find recent papers that build on ${token}.`)
					: c.prefill("Find recent papers on my research topic.")),
			}],
		},
		{
			id: "done",
			chapter: "Done",
			title: "Replay anytime",
			target: (c) => c.doc.getElementById("research-buddy-info"),
			body: [],
		},
	];

	const CHAPTERS = [...new Set(STEPS.map((s) => s.chapter))].filter((name) => name !== "Welcome" && name !== "Done");

	class Tour {
		constructor(win, papers) {
			this.win = win;
			this.doc = win.document;
			this.papers = papers;
			this.mark = {};
			this.steps = STEPS.filter((s) => !s.skip?.(this));
			this.index = -1;
			this.completed = false;

			const make = (tag, cls) => {
				const node = this.doc.createElementNS(XHTML, tag);
				if (cls) node.className = cls;
				return node;
			};
			this.make = make;
			this.root = make("div", "buddy-tour");
			this.shade = make("div", "buddy-tour-shade");
			this.spot = make("div", "buddy-tour-spot");
			this.pop = make("div", "buddy-tour-pop");
			this.pop.setAttribute("role", "dialog");
			this.root.append(this.shade, this.spot, this.pop);
			this.doc.documentElement.append(this.root);

			this._onKey = (e) => this._key(e);
			win.addEventListener("keydown", this._onKey, true);
			this._onResize = () => this._place();
			win.addEventListener("resize", this._onResize);
			this.timer = win.setInterval(() => this._tick(), TICK_MS);
		}

		// ---- Helpers the steps use ----

		card() {
			return Buddy.UI.cards.get(this.win);
		}

		view() {
			return this.card()?.view;
		}

		showCard() {
			const card = Buddy.UI._card(this.win);
			if (!card.visible) card.show();
			card.view.closeChats();
		}

		/** Types into the chat box as if the user had, so the @ list opens with real results. */
		typeInChat(text) {
			this.showCard();
			const { input } = this.view();
			const before = input.value && !/\s$/.test(input.value) ? `${input.value} ` : input.value;
			input.value = before + text;
			input.focus();
			input.setSelectionRange(input.value.length, input.value.length);
			input.dispatchEvent(new this.win.Event("input", { bubbles: true }));
		}

		prefill(text) {
			this.showCard();
			if (Buddy.Chat.messages.length || Buddy.Chat.busy) Buddy.Chat.newChat();
			const view = this.view();
			Buddy.Chat.draft = text;
			for (const v of Buddy.Chat.views) v.input.value = text;
			view.input.focus();
			view.input.setSelectionRange(text.length, text.length);
		}

		/** Writes a question that tags the paper, exactly as picking it from the @ list would. */
		prefillQuestion(item, write) {
			const mention = { kind: "item", libraryID: item.libraryID, key: item.key, label: item.getDisplayTitle() };
			const token = Buddy.Attach.token(mention);
			this.prefill(write(token));
			Buddy.Chat.mentions.push({ ...mention, token });
		}

		async selectInLibrary(item) {
			try {
				this.win.Zotero_Tabs?.select("zotero-pane");
				await this.win.ZoteroPane.selectItem(item.id);
			}
			catch (e) {
				Zotero.logError(e);
			}
		}

		/** Puts a short guide in the newest citation graph window, which is a separate window the overlay can't reach. */
		tipGraphWindow() {
			const graph = [...Buddy.CiteGraph.windows].pop();
			if (!graph || graph.closed) return;
			const add = () => {
				const doc = graph.document;
				if (!doc?.body || doc.getElementById("buddy-graph-tip")) return;
				const tip = doc.createElementNS(XHTML, "div");
				tip.id = "buddy-graph-tip";
				tip.style.cssText = "position:fixed;left:16px;top:64px;z-index:100;max-width:300px;padding:12px 14px;border-radius:10px;"
					+ "background:#D97757;color:#fff;font:13px/1.45 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.3);";
				const title = doc.createElementNS(XHTML, "div");
				title.style.cssText = "font-weight:700;margin-bottom:6px;";
				title.textContent = "Tip";
				const list = doc.createElementNS(XHTML, "ul");
				list.style.cssText = "margin:0 0 10px;padding-inline-start:18px;";
				for (const line of ["Hover a paper for details", "Click to explore its citations"]) {
					const li = doc.createElementNS(XHTML, "li");
					li.textContent = line;
					list.append(li);
				}
				const back = doc.createElementNS(XHTML, "button");
				back.textContent = "Back to tour";
				back.style.cssText = "border:none;border-radius:6px;padding:5px 10px;background:#fff;color:#a4492c;font-weight:600;cursor:pointer;";
				back.addEventListener("click", () => {
					tip.remove();
					this.win.focus();
				});
				const close = doc.createElementNS(XHTML, "button");
				close.textContent = "Hide";
				close.style.cssText = "margin-inline-start:6px;border:1px solid rgba(255,255,255,.7);border-radius:6px;padding:5px 10px;background:none;color:#fff;cursor:pointer;";
				close.addEventListener("click", () => tip.remove());
				tip.append(title, list, back, close);
				doc.body.append(tip);
			};
			if (graph.document?.readyState === "complete") add();
			else graph.addEventListener("load", () => graph.setTimeout(add, 50), { once: true });
		}

		// ---- Running the tour ----

		async go(index) {
			if (index < 0 || index >= this.steps.length) return;
			this.index = index;
			const step = this.steps[index];
			this.taskDone = false;
			this.advanceTimer && this.win.clearTimeout(this.advanceTimer);
			this.advanceTimer = null;
			try {
				await step.enter?.(this);
			}
			catch (e) {
				Zotero.logError(e);
			}
			if (this.index !== index) return;
			this._render();
			this._place();
		}

		next() {
			if (this.index >= this.steps.length - 1) this.finish();
			else this.go(this.index + 1);
		}

		back() {
			if (this.index > 0) this.go(this.index - 1);
		}

		jump(chapter) {
			const i = this.steps.findIndex((s) => s.chapter === chapter);
			if (i >= 0) this.go(i);
		}

		finish() {
			Zotero.Prefs.set(DONE_PREF, true, true);
			this.completed = true;
			Buddy.Tour.stop();
		}

		destroy() {
			this.win.clearInterval(this.timer);
			if (this.advanceTimer) this.win.clearTimeout(this.advanceTimer);
			this.win.removeEventListener("keydown", this._onKey, true);
			this.win.removeEventListener("resize", this._onResize);
			this.root.remove();
			// Leaving early still counts as seen, so it doesn't pop up again on every start. The ⓘ button brings it back.
			Zotero.Prefs.set(DONE_PREF, true, true);
			for (const button of Buddy.UI.infoButtons?.values() || []) button.removeAttribute("buddy-new");
		}

		_key(e) {
			if (e.defaultPrevented) return;
			const typing = e.target?.closest?.("input, textarea, select, [contenteditable]");
			if (e.key === "Escape" && !typing) {
				e.preventDefault();
				Buddy.Tour.stop();
			}
			else if (!typing && e.key === "ArrowRight") {
				e.preventDefault();
				this.next();
			}
			else if (!typing && e.key === "ArrowLeft") {
				e.preventDefault();
				this.back();
			}
		}

		_tick() {
			const step = this.steps[this.index];
			if (!step) return;
			this._place();
			if (step.done && !this.taskDone) {
				let done = false;
				try {
					done = !!step.done(this);
				}
				catch (e) {}
				if (done) {
					this.taskDone = true;
					this._render();
					const index = this.index;
					this.advanceTimer = this.win.setTimeout(() => {
						if (this.index === index) this.next();
					}, 1100);
				}
			}
		}

		_text(value) {
			return typeof value === "function" ? value(this) : value;
		}

		_render() {
			const step = this.steps[this.index];
			const { make } = this;
			const head = make("div", "buddy-tour-head");
			const chapter = make("span", "buddy-tour-chapter");
			const chapterIndex = CHAPTERS.indexOf(step.chapter);
			chapter.textContent = chapterIndex >= 0 ? `${chapterIndex + 1}/${CHAPTERS.length} · ${step.chapter}` : step.chapter;
			const close = make("button", "buddy-tour-x");
			close.textContent = "×";
			close.title = "Close the tour (Esc)";
			close.addEventListener("click", () => Buddy.Tour.stop());
			head.append(chapter, close);

			const title = make("div", "buddy-tour-title");
			title.textContent = step.title;
			const body = make("div", "buddy-tour-body");
			for (const line of this._text(step.body) || []) {
				if (!line) continue;
				if (line.chip) {
					const chip = make("span", "buddy-cite");
					chip.textContent = line.chip;
					const p = make("p");
					p.append(chip);
					body.append(p);
					continue;
				}
				const p = make("p");
				p.append(rich(this.doc, line));
				body.append(p);
			}
			const parts = [head, title, body];

			if (step.chapters) {
				const list = make("div", "buddy-tour-chapters");
				CHAPTERS.forEach((name, i) => {
					const b = make("button", "buddy-tour-chapterbtn");
					b.textContent = `${i + 1}. ${name}`;
					b.addEventListener("click", () => this.jump(name));
					list.append(b);
				});
				parts.push(list);
			}

			const task = this._text(step.task);
			if (task) {
				const row = make("div", `buddy-tour-task${this.taskDone ? " buddy-tour-done" : ""}`);
				const box = make("span", "buddy-tour-check");
				box.textContent = this.taskDone ? "✓" : "";
				const label = make("span");
				label.textContent = this.taskDone ? "Done!" : task;
				row.append(box, label);
				parts.push(row);
			}

			const actions = (step.actions || []).filter((a) => !a.when || a.when(this));
			if (actions.length && !this.taskDone) {
				const row = make("div", "buddy-tour-actions");
				for (const action of actions) {
					const b = make("button", "buddy-tour-secondary");
					b.textContent = action.label;
					b.addEventListener("click", async () => {
						try {
							await action.run(this);
						}
						catch (e) {
							Zotero.logError(e);
						}
					});
					row.append(b);
				}
				parts.push(row);
			}

			const foot = make("div", "buddy-tour-foot");
			const progress = make("div", "buddy-tour-progress");
			const bar = make("div", "buddy-tour-progress-fill");
			bar.style.width = `${((this.index + 1) / this.steps.length) * 100}%`;
			progress.append(bar);
			const count = make("span", "buddy-tour-count");
			count.textContent = `${this.index + 1} of ${this.steps.length}`;
			const nav = make("div", "buddy-tour-nav");
			if (this.index > 0) {
				const back = make("button", "buddy-tour-secondary");
				back.textContent = "Back";
				back.addEventListener("click", () => this.back());
				nav.append(back);
			}
			const last = this.index === this.steps.length - 1;
			const next = make("button", "buddy-tour-primary");
			next.textContent = last ? "Finish" : this.index === 0 ? "Start" : task && !this.taskDone ? "Skip" : "Next";
			next.addEventListener("click", () => this.next());
			nav.append(next);
			foot.append(count, nav);
			parts.push(progress, foot);

			this.pop.replaceChildren(...parts);
			this.root.classList.toggle("buddy-tour-bright", step.dim === false);
		}

		/** Spotlights the step's target and puts the bubble beside it, inside the window. */
		_place() {
			const step = this.steps[this.index];
			if (!step) return;
			let target = null;
			try {
				target = step.target?.(this) || null;
			}
			catch (e) {}
			const { innerWidth: vw, innerHeight: vh } = this.win;
			const rect = target && target.isConnected ? target.getBoundingClientRect() : null;
			const visible = rect && rect.width > 0 && rect.height > 0;
			this.root.classList.toggle("buddy-tour-has-spot", !!visible);

			const pop = this.pop;
			const w = Math.min(POPOVER_WIDTH, vw - 2 * GAP);
			pop.style.width = `${w}px`;
			const h = pop.offsetHeight;
			let x, y;
			if (visible) {
				const pad = 5;
				Object.assign(this.spot.style, {
					left: `${rect.left - pad}px`,
					top: `${rect.top - pad}px`,
					width: `${rect.width + 2 * pad}px`,
					height: `${rect.height + 2 * pad}px`,
				});
				const room = {
					below: vh - rect.bottom,
					above: rect.top,
					left: rect.left,
					right: vw - rect.right,
				};
				if (room.below >= h + 2 * GAP) {
					x = rect.left + rect.width / 2 - w / 2;
					y = rect.bottom + GAP;
				}
				else if (room.above >= h + 2 * GAP) {
					x = rect.left + rect.width / 2 - w / 2;
					y = rect.top - GAP - h;
				}
				else if (room.left >= w + 2 * GAP) {
					x = rect.left - GAP - w;
					y = rect.top + rect.height / 2 - h / 2;
				}
				else if (room.right >= w + 2 * GAP) {
					x = rect.right + GAP;
					y = rect.top + rect.height / 2 - h / 2;
				}
				else {
					// The target fills the window (like the chat): sit inside it, at the side with more room.
					x = room.left > room.right ? GAP : vw - w - GAP;
					y = vh - h - GAP;
				}
			}
			else if (step.corner) {
				x = GAP * 2;
				y = vh - h - GAP * 2;
			}
			else {
				x = (vw - w) / 2;
				y = (vh - h) / 2;
			}
			pop.style.left = `${Math.max(GAP, Math.min(x, vw - w - GAP))}px`;
			pop.style.top = `${Math.max(GAP, Math.min(y, vh - h - GAP))}px`;
		}
	}

	Buddy.Tour = {
		current: null,

		get seen() {
			return !!Zotero.Prefs.get(DONE_PREF, true);
		},

		async start(win = Zotero.getMainWindow()) {
			if (!win) return;
			if (this.current) {
				this.current.go(0);
				return;
			}
			this._starting = true;
			const papers = await findPapers();
			this._starting = false;
			if (this.current || win.closed) return;
			this.current = new Tour(win, papers);
			this.current.go(0);
		},

		stop() {
			const tour = this.current;
			this.current = null;
			tour?.destroy();
		},

		/** Ends the tour if it is running in a window that is closing. */
		stopIn(win) {
			if (this.current?.win === win) this.stop();
		},

		/** The first time Research Buddy runs, the tour opens by itself once Zotero has settled. */
		maybeAutoStart() {
			if (this.seen) return;
			const win = Zotero.getMainWindow();
			win?.setTimeout(() => {
				if (!this.seen && !this.current && !this._starting && !win.closed) this.start(win);
			}, 1500);
		},
	};
}

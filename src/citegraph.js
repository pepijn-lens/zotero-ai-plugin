// "Visualize citations": a window with one paper in the middle and the papers that cite it, or that it cites,
// around it. Edges between the surrounding papers show how they cite each other. Data comes from OpenAlex.
{
	const XHTML = "http://www.w3.org/1999/xhtml";
	const SVG = "http://www.w3.org/2000/svg";
	const MENU_ID = "research-buddy-citegraph-menu";
	const SEP_ID = "research-buddy-citegraph-sep";
	const LIMIT_PREF = "extensions.researchbuddy.graphLimit";
	const LAYOUT_PREF = "extensions.researchbuddy.graphLayout";
	const LINKS_PREF = "extensions.researchbuddy.graphLinks";
	const FIELDS = "id,doi,title,publication_year,authorships,cited_by_count,abstract_inverted_index,referenced_works,primary_location";

	const normTitle = (t) => (t || "").toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\p{L}\p{N}]+/gu, "");
	const shortID = (url) => (url || "").split("/").pop();

	/** The item a menu click is about: the parent when an attachment or note is selected. */
	const topLevel = (item) => (item && !item.isRegularItem() && item.parentItem ? item.parentItem : item);

	Buddy.CiteGraph = {
		windows: new Set(),

		addToWindow(win) {
			const doc = win.document;
			const popup = doc.getElementById("zotero-itemmenu");
			if (!popup || doc.getElementById(MENU_ID)) return;
			const sep = doc.createXULElement("menuseparator");
			sep.id = SEP_ID;
			const item = doc.createXULElement("menuitem");
			item.id = MENU_ID;
			item.setAttribute("label", "Visualize citations (Research Buddy)");
			item.setAttribute("class", "menuitem-iconic");
			item.setAttribute("image", "chrome://researchbuddy/content/claude.svg");
			item.addEventListener("command", () => {
				const selected = topLevel(win.ZoteroPane.getSelectedItems()[0]);
				if (selected) this.open(win, { item: selected });
			});
			this._onShowing = this._onShowing || new WeakMap();
			const onShowing = (event) => {
				if (event.target !== popup) return;
				const items = win.ZoteroPane.getSelectedItems();
				const show = items.length === 1 && topLevel(items[0])?.isRegularItem();
				item.hidden = sep.hidden = !show;
			};
			popup.addEventListener("popupshowing", onShowing);
			this._onShowing.set(win, onShowing);
			popup.append(sep, item);
		},

		removeFromWindow(win) {
			const doc = win.document;
			const popup = doc.getElementById("zotero-itemmenu");
			const onShowing = this._onShowing?.get(win);
			if (popup && onShowing) popup.removeEventListener("popupshowing", onShowing);
			doc.getElementById(MENU_ID)?.remove();
			doc.getElementById(SEP_ID)?.remove();
		},

		open(opener, seed) {
			const win = opener.openDialog(
				`chrome://researchbuddy/content/citegraph.xhtml?${Buddy.loadedAt}`, "",
				"chrome,dialog=no,resizable,centerscreen,width=1180,height=800",
			);
			this.windows.add(win);
			win.addEventListener("load", () => {
				try {
					new GraphWindow(win, seed);
				}
				catch (e) {
					Zotero.logError(e);
				}
			}, { once: true });
			win.addEventListener("unload", () => this.windows.delete(win), { once: true });
		},

		closeAll() {
			for (const win of this.windows) win.close();
			this.windows.clear();
		},

		// ---- Data ----

		/** Every DOI and title in the user's (non-feed) libraries, to mark papers they already have. */
		async libraryIndex() {
			const rows = await Zotero.DB.queryAsync(
				`SELECT I.itemID AS itemID, F.fieldName AS field, V.value AS value
				FROM items I
				JOIN libraries L ON L.libraryID = I.libraryID
				JOIN itemData D ON D.itemID = I.itemID
				JOIN itemDataValues V ON V.valueID = D.valueID
				JOIN fields F ON F.fieldID = D.fieldID
				WHERE F.fieldName IN ('DOI', 'title') AND L.type != 'feed'
					AND I.itemID NOT IN (SELECT itemID FROM deletedItems)`,
			);
			const dois = new Map();
			const titles = new Map();
			for (const { itemID, field, value } of rows) {
				if (field === "DOI") {
					const doi = Zotero.Utilities.cleanDOI(value);
					if (doi) dois.set(doi.toLowerCase(), itemID);
				}
				else {
					// Short titles ("Full Text PDF", "Introduction") would match the wrong papers.
					const t = normTitle(value);
					if (t.length >= 20 && !titles.has(t)) titles.set(t, itemID);
				}
			}
			return {
				find(doi, title) {
					const id = (doi && dois.get(doi.toLowerCase())) || titles.get(normTitle(title));
					return id ? topLevel(Zotero.Items.get(id)) : null;
				},
			};
		},

		async _get(path, params) {
			const url = `${Buddy.Scout.HOST}${path}${params ? `?${new URLSearchParams(params)}` : ""}`;
			const xhr = await Zotero.HTTP.request("GET", url, { responseType: "json", timeout: 30000 });
			return xhr.response;
		},

		/** The OpenAlex work for a Zotero item: by DOI, else by an exact title match. */
		async workForItem(item) {
			let doi = Zotero.Utilities.cleanDOI(item.getField("DOI") || "");
			if (!doi) doi = Zotero.Utilities.cleanDOI((item.getField("extra") || "").match(/^DOI:\s*(\S+)/im)?.[1] || "");
			if (doi) {
				try {
					return await this._get(`/works/doi:${encodeURIComponent(doi)}`, { select: FIELDS });
				}
				catch (e) {
					if (e.status !== 404) throw e;
				}
			}
			const title = item.getField("title");
			if (!title) throw new Error("This item has no DOI or title to look up.");
			const found = await this._get("/works", { search: title, "per-page": 10, select: FIELDS });
			const want = normTitle(title);
			const match = found.results.find((w) => normTitle(w.title) === want);
			if (!match) throw new Error(`Couldn't find “${title}” in OpenAlex${doi ? "" : ", and it has no DOI"}.`);
			return match;
		},

		/**
		 * The center paper plus up to `limit` neighbours. direction "to" = papers citing it,
		 * "from" = papers it cites. Edges are every citation among all the papers shown.
		 */
		async graph(seed, direction, limit, sort) {
			const center = seed.item
				? await this.workForItem(seed.item)
				: await this._get(`/works/${encodeURIComponent(seed.id)}`, { select: FIELDS });
			const centerID = shortID(center.id);
			const order = sort === "newest" ? "publication_date:desc" : "cited_by_count:desc";
			let neighbours;
			let total;
			if (direction === "to") {
				const page = await this._get("/works", {
					filter: `cites:${centerID}`, sort: order, "per-page": limit, select: FIELDS,
				});
				neighbours = page.results;
				total = page.meta?.count ?? neighbours.length;
			}
			else {
				const ids = [...new Set((center.referenced_works || []).map(shortID))];
				total = ids.length;
				const chunks = [];
				for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
				const pages = await Promise.all(chunks.map((chunk) => this._get("/works", {
					filter: `openalex:${chunk.join("|")}`, "per-page": 50, select: FIELDS,
				})));
				neighbours = pages.flatMap((p) => p.results);
				const key = sort === "newest" ? (w) => w.publication_year || 0 : (w) => w.cited_by_count || 0;
				neighbours.sort((a, b) => key(b) - key(a));
				neighbours = neighbours.slice(0, limit);
			}

			const index = await this.libraryIndex();
			const toNode = (w, isCenter) => {
				const doi = w.doi ? Zotero.Utilities.cleanDOI(w.doi) : null;
				const owned = index.find(doi, w.title);
				const names = (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean);
				return {
					id: shortID(w.id),
					center: isCenter,
					doi,
					title: (w.title || "Untitled").replace(/<[^>]+>/g, ""),
					authors: names,
					label: `${(names[0] || "").split(" ").pop() || "?"}${w.publication_year ? ` ${w.publication_year}` : ""}`,
					year: w.publication_year,
					venue: w.primary_location?.source?.display_name || "",
					citedBy: w.cited_by_count || 0,
					abstract: Buddy.Scout._abstract(w.abstract_inverted_index, 4000),
					url: doi ? `https://doi.org/${doi}` : w.id,
					itemID: owned?.id || null,
					refs: (w.referenced_works || []).map(shortID),
				};
			};
			const nodes = [toNode(center, true)];
			const seen = new Set([nodes[0].id]);
			for (const w of neighbours) {
				const id = shortID(w.id);
				if (seen.has(id)) continue;
				seen.add(id);
				nodes.push(toNode(w, false));
			}
			const edges = [];
			for (const a of nodes) {
				for (const r of a.refs) {
					if (r !== a.id && seen.has(r)) edges.push({ source: a.id, target: r, inter: !a.center && r !== centerID });
				}
			}
			// A neighbour whose citation of the center paper OpenAlex doesn't list still belongs to it.
			for (const n of nodes) {
				if (n.center) continue;
				const [s, t] = direction === "to" ? [n.id, centerID] : [centerID, n.id];
				if (!edges.some((e) => e.source === s && e.target === t)) edges.push({ source: s, target: t, inter: false });
			}
			return { nodes, edges, total, direction };
		},
	};

	/**
	 * A dropdown built from plain HTML. A native <select> can't open its list in a plugin window, because Firefox
	 * draws that list with a popup only the main window has.
	 */
	class Dropdown {
		constructor(owner, { title, groups, value, onChange, className }) {
			this.owner = owner;
			this.groups = groups;
			this.onChange = onChange;
			this.button = owner._el("button", `cg-dd${className ? ` ${className}` : ""}`);
			this.button.title = title;
			this.button.setAttribute("aria-haspopup", "listbox");
			this.labelNode = owner._el("span", "cg-dd-label");
			this.button.append(this.labelNode, owner._el("span", "cg-dd-caret", "▾"));
			this.button.addEventListener("click", () => (this.list ? this.close() : this.open()));
			this.value = value;
		}

		get options() {
			return this.groups.flatMap((g) => g.options);
		}

		get value() {
			return this._value;
		}

		set value(v) {
			const option = this.options.find((o) => o.value === v) || this.options[0];
			this._value = option?.value;
			this.labelNode.textContent = option ? option.label.trim() : "";
		}

		open() {
			const { owner } = this;
			owner.openDropdown?.close();
			owner.openDropdown = this;
			const list = (this.list = owner._el("div", "cg-dd-list"));
			list.setAttribute("role", "listbox");
			this.items = [];
			for (const group of this.groups) {
				if (group.name && this.groups.length > 1) list.append(owner._el("div", "cg-dd-group", group.name));
				for (const option of group.options) {
					const item = owner._el("div", "cg-dd-item");
					item.setAttribute("role", "option");
					const label = option.label.trimStart();
					// Folder labels are indented with spaces by nesting level.
					item.style.paddingInlineStart = `${10 + (option.label.length - label.length) * 6}px`;
					item.textContent = label;
					if (option.value === this._value) item.classList.add("cg-dd-selected");
					item.addEventListener("click", () => this._pick(option));
					item.addEventListener("mousemove", () => this._highlight(this.items.indexOf(entry)));
					const entry = { item, option };
					this.items.push(entry);
					list.append(item);
				}
			}
			owner.doc.body.append(list);
			const rect = this.button.getBoundingClientRect();
			const win = owner.win;
			const below = win.innerHeight - rect.bottom - 8;
			list.style.minWidth = `${rect.width}px`;
			list.style.maxHeight = `${Math.max(120, Math.min(420, below))}px`;
			list.style.top = `${rect.bottom + 3}px`;
			const left = Math.min(rect.left, win.innerWidth - list.offsetWidth - 8);
			list.style.left = `${Math.max(8, left)}px`;
			this._highlight(this.items.findIndex((e) => e.option.value === this._value));
			this.items[this.active]?.item.scrollIntoView({ block: "nearest" });

			this._onDown = (e) => {
				if (!list.contains(e.target) && !this.button.contains(e.target)) this.close();
			};
			this._onKey = (e) => this._key(e);
			this._onBlur = () => this.close();
			owner.doc.addEventListener("pointerdown", this._onDown, true);
			owner.doc.addEventListener("keydown", this._onKey, true);
			win.addEventListener("blur", this._onBlur);
			win.addEventListener("resize", this._onBlur);
		}

		close() {
			if (!this.list) return;
			const { owner } = this;
			this.list.remove();
			this.list = null;
			if (owner.openDropdown === this) owner.openDropdown = null;
			owner.doc.removeEventListener("pointerdown", this._onDown, true);
			owner.doc.removeEventListener("keydown", this._onKey, true);
			owner.win.removeEventListener("blur", this._onBlur);
			owner.win.removeEventListener("resize", this._onBlur);
		}

		_highlight(i) {
			if (i < 0 || i >= this.items.length) return;
			this.items[this.active]?.item.classList.remove("cg-dd-active");
			this.active = i;
			this.items[i].item.classList.add("cg-dd-active");
		}

		_key(e) {
			const moves = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8 };
			if (e.key in moves) {
				const i = Math.max(0, Math.min(this.items.length - 1, (this.active ?? -1) + moves[e.key]));
				this._highlight(i);
				this.items[i].item.scrollIntoView({ block: "nearest" });
			}
			else if (e.key === "Enter" || e.key === " ") {
				if (this.items[this.active]) this._pick(this.items[this.active].option);
			}
			else if (e.key === "Escape" || e.key === "Tab") {
				this.close();
				if (e.key === "Tab") return;
			}
			else return;
			e.preventDefault();
			e.stopPropagation();
		}

		_pick(option) {
			this.close();
			this.button.focus();
			if (option.value === this._value) return;
			this.value = option.value;
			this.onChange?.(option.value);
		}
	}

	// ---- The window ----

	class GraphWindow {
		constructor(win, seed) {
			this.win = win;
			this.doc = win.document;
			this.history = [];
			this.seed = seed;
			this.direction = "to";
			this.sort = "cited";
			this.limit = parseInt(Zotero.Prefs.get(LIMIT_PREF, true)) || 50;
			this.layout = Zotero.Prefs.get(LAYOUT_PREF, true) === "free" ? "free" : "rings";
			this.links = Zotero.Prefs.get(LINKS_PREF, true) === "hover" ? "hover" : "all";
			this.view = { x: 0, y: 0, k: 1 };
			this.userMoved = false;
			this.nodes = [];
			this.edges = [];
			this._frame = null;
			this._hideTimer = null;
			this._build();
			this.load();
		}

		_el(tag, cls, text) {
			const node = this.doc.createElementNS(XHTML, tag);
			if (cls) node.className = cls;
			if (text != null) node.textContent = text;
			return node;
		}

		_svg(tag, attrs = {}) {
			const node = this.doc.createElementNS(SVG, tag);
			for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
			return node;
		}

		_build() {
			const { doc } = this;
			const link = this._el("link");
			link.rel = "stylesheet";
			link.href = `chrome://researchbuddy/content/citegraph.css?${Buddy.loadedAt}`;
			doc.head.append(link);
			doc.documentElement.setAttribute("lang", "en");

			const bar = this._el("div", "cg-bar");
			this.back = this._el("button", "cg-back", "←");
			this.back.title = "Back to the previous paper";
			this.back.disabled = true;
			this.back.addEventListener("click", () => this.goBack());

			const toggle = this._el("div", "cg-toggle");
			toggle.setAttribute("role", "group");
			this.dirButtons = {};
			for (const [dir, label, tip] of [
				["to", "To", "Papers that cite this paper"],
				["from", "From", "Papers this paper cites"],
			]) {
				const b = this._el("button", "", label);
				b.title = tip;
				b.addEventListener("click", () => {
					if (this.direction === dir) return;
					this.direction = dir;
					this.load();
				});
				this.dirButtons[dir] = b;
				toggle.append(b);
			}

			const layout = new Dropdown(this, {
				title: "How to arrange the papers",
				groups: [{ options: [
					{ value: "rings", label: "Year rings" },
					{ value: "free", label: "Free layout" },
				] }],
				value: this.layout,
				onChange: (v) => {
					this.layout = v;
					Zotero.Prefs.set(LAYOUT_PREF, v, true);
					if (this.data) this._show(this.data);
				},
			});

			const links = new Dropdown(this, {
				title: "Which citations to draw",
				groups: [{ options: [
					{ value: "all", label: "All links" },
					{ value: "hover", label: "Links on hover" },
				] }],
				value: this.links,
				onChange: (v) => {
					this.links = v;
					Zotero.Prefs.set(LINKS_PREF, v, true);
					this.svg.classList.toggle("cg-hover-links", v === "hover");
				},
			});

			const sort = new Dropdown(this, {
				title: "Which papers to show when there are more than fit",
				groups: [{ options: [{ value: "cited", label: "Most cited" }, { value: "newest", label: "Newest" }] }],
				value: this.sort,
				onChange: (v) => {
					this.sort = v;
					this.load();
				},
			});

			const limit = new Dropdown(this, {
				title: "How many papers to show",
				groups: [{ options: [25, 50, 100].map((n) => ({ value: String(n), label: `${n} papers` })) }],
				value: String([25, 50, 100].includes(this.limit) ? this.limit : 50),
				onChange: (v) => {
					this.limit = parseInt(v);
					Zotero.Prefs.set(LIMIT_PREF, v, true);
					this.load();
				},
			});

			this.titleNode = this._el("div", "cg-title");

			const folderWrap = this._el("div", "cg-folder", "Add to ");
			this.folder = new Dropdown(this, {
				title: "Where “Add to Zotero” saves papers",
				groups: Buddy.Chat.destinations(),
				value: Buddy.Chat.defaultDestination(),
				className: "cg-dd-folder",
			});
			folderWrap.append(this.folder.button);

			bar.append(this.back, toggle, layout.button, links.button, sort.button, limit.button, this.titleNode, folderWrap);

			this.stage = this._el("div", "cg-stage");
			this.svg = this._svg("svg", { class: `cg-svg${this.links === "hover" ? " cg-hover-links" : ""}` });
			const defs = this._svg("defs");
			for (const [id, cls] of [["cg-arrow", "cg-arrow"], ["cg-arrow-inter", "cg-arrow cg-arrow-inter"], ["cg-arrow-lit", "cg-arrow cg-arrow-lit"]]) {
				const marker = this._svg("marker", {
					id, viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7",
					orient: "auto-start-reverse", markerUnits: "userSpaceOnUse",
				});
				marker.append(this._svg("path", { d: "M0,1 L10,5 L0,9 z", class: cls }));
				defs.append(marker);
			}
			this.world = this._svg("g");
			this.guideLayer = this._svg("g");
			this.edgeLayer = this._svg("g");
			this.nodeLayer = this._svg("g");
			this.world.append(this.guideLayer, this.edgeLayer, this.nodeLayer);
			this.svg.append(defs, this.world);

			this.status = this._el("div", "cg-status");
			this.card = this._el("div", "cg-card");
			this.card.hidden = true;
			this.card.addEventListener("mouseenter", () => this._cancelHide());
			this.card.addEventListener("mouseleave", () => this._scheduleHide());

			const legend = this._el("div", "cg-legend");
			const swatch = (cls, text) => {
				const row = this._el("div", "cg-legend-row");
				row.append(this._el("span", `cg-swatch ${cls}`), text);
				return row;
			};
			this.legendText = this._el("div", "cg-legend-note");
			legend.append(
				swatch("cg-swatch-owned", "In your library"),
				swatch("cg-swatch-other", "Not in your library"),
				swatch("cg-swatch-inter", "Citation between surrounding papers"),
				this._el("div", "cg-legend-note", "Size = times cited · arrow points to the cited paper"),
				(this.layoutNote = this._el("div", "cg-legend-note")),
				this.legendText,
			);
			this.stage.append(this.svg, legend, this.status, this.card);
			this.doc.body.append(bar, this.stage);
			this._bindPanZoom();
			this.win.addEventListener("resize", () => this._applyView());
			this.win.addEventListener("keydown", (e) => {
				if (this.openDropdown) return;
				if (e.key === "Escape") this.card.hidden = true;
				if (e.key === "Backspace" && !this.openDropdown) this.goBack();
			});
		}

		_setStatus(text, isError) {
			this.status.textContent = text || "";
			this.status.hidden = !text;
			this.status.classList.toggle("cg-error", !!isError);
		}

		async load() {
			for (const [dir, b] of Object.entries(this.dirButtons)) b.classList.toggle("cg-on", dir === this.direction);
			this.back.disabled = !this.history.length;
			this.card.hidden = true;
			const token = (this._token = {});
			this._setStatus(this.direction === "to" ? "Finding papers that cite this one…" : "Finding the papers this one cites…");
			try {
				const data = await Buddy.CiteGraph.graph(this.seed, this.direction, this.limit, this.sort);
				if (token !== this._token) return;
				this.data = data;
				this._show(data);
			}
			catch (e) {
				if (token !== this._token) return;
				Zotero.logError(e);
				this._setStatus(`Couldn't load the citation graph: ${e.message || e}`, true);
			}
		}

		goBack() {
			const prev = this.history.pop();
			if (!prev) return;
			Object.assign(this, prev);
			this.load();
		}

		recenter(node) {
			if (node.center) return;
			this.history.push({ seed: this.seed, direction: this.direction });
			this.seed = { id: node.id };
			this.load();
		}

		_show({ nodes, edges, total, direction }) {
			const center = nodes[0];
			this.win.document.title = `Citations: ${center.title}`;
			this.titleNode.textContent = center.title;
			this.titleNode.title = center.title;
			const shown = nodes.length - 1;
			const what = direction === "to" ? "papers citing this one" : "papers this one cites";
			const inter = edges.filter((e) => e.inter).length;
			// The more links there are, the fainter each one, so dense clusters don't turn into a solid block.
			this.svg.style.setProperty("--cg-inter-opacity", Math.min(0.75, Math.max(0.22, 6 / Math.sqrt(inter || 1))).toFixed(2));
			this.legendText.textContent = `Showing ${shown} of ${total} ${what}, with ${inter} citation${inter === 1 ? "" : "s"} between them.`;
			if (!shown) {
				this._setStatus(direction === "to"
					? "OpenAlex knows of no papers citing this one yet."
					: "OpenAlex has no reference list for this paper.");
			}
			else this._setStatus("");

			const byID = new Map(nodes.map((n) => [n.id, n]));
			this.nodes = nodes;
			this.edges = edges.map((e) => ({ ...e, s: byID.get(e.source), t: byID.get(e.target) }));
			for (const n of nodes) {
				n.links = new Set();
				n.r = n.center ? 24 : Math.min(22, 5 + 2.6 * Math.log10(n.citedBy + 1) ** 1.25);
			}
			for (const e of this.edges) {
				e.s.links.add(e.t);
				e.t.links.add(e.s);
			}

			center.x = center.y = center.vx = center.vy = 0;
			center.fixed = true;
			this.svg.classList.toggle("cg-rings", this.layout === "rings");
			this.layoutNote.textContent = this.layout === "rings"
				? "Rings = publication year, further out = further in time from the center paper · each wedge is a group of papers that cite each other"
				: "";
			this.layoutNote.hidden = this.layout !== "rings";
			if (this.layout === "rings") this._ringLayout(center);
			else this._freeStart();

			this._draw();
			this.userMoved = false;
			this.alpha = 1;
			this._fit();
			this._run();
		}

		_draw() {
			this.edgeLayer.replaceChildren();
			this.nodeLayer.replaceChildren();
			this._drawGuides();
			for (const e of this.edges) {
				e.el = this._svg("path", {
					class: e.inter ? "cg-edge cg-edge-inter" : "cg-edge",
					"marker-end": `url(#${e.inter ? "cg-arrow-inter" : "cg-arrow"})`,
				});
				this.edgeLayer.append(e.el);
			}
			// Bigger nodes underneath, so small ones stay hoverable.
			for (const n of [...this.nodes].sort((a, b) => b.r - a.r)) {
				const g = this._svg("g", {
					class: `cg-node${n.center ? " cg-center" : ""}${n.itemID ? " cg-owned" : ""}`,
					tabindex: "0",
				});
				g.append(this._svg("circle", { r: n.r }));
				const label = this._svg("text", { y: n.r + 11, class: "cg-label" });
				label.textContent = n.label;
				g.append(label);
				g.addEventListener("mouseenter", () => this._hover(n));
				g.addEventListener("mouseleave", () => {
					this._unfocus();
					this._scheduleHide();
				});
				g.addEventListener("focus", () => this._hover(n));
				g.addEventListener("keydown", (ev) => {
					if (ev.key === "Enter") this.recenter(n);
				});
				this._bindNodeDrag(g, n);
				n.el = g;
				this.nodeLayer.append(g);
			}
			this._position();
		}

		// ---- Layout ----

		/** The free layout starts on a ring ordered by year and lets the forces settle it. */
		_freeStart() {
			this.rings = [];
			const ring = this.nodes.slice(1).sort((a, b) => (a.year || 0) - (b.year || 0));
			const R = 140 + ring.length * 4;
			ring.forEach((n, i) => {
				const a = (i / ring.length) * 2 * Math.PI - Math.PI / 2;
				n.x = Math.cos(a) * R;
				n.y = Math.sin(a) * R;
				n.vx = n.vy = 0;
				n.tx = n.ty = null;
			});
		}

		/**
		 * Groups of papers that cite each other, by label propagation: each paper repeatedly takes the group most of
		 * its neighbours belong to. Papers with no links to the others come back as one separate group.
		 */
		_clusters(others) {
			const peers = new Map(others.map((n) => [n, [...n.links].filter((m) => !m.center)]));
			const label = new Map(others.map((n, i) => [n, i]));
			for (let round = 0; round < 20; round++) {
				let changed = false;
				for (const n of others) {
					const ns = peers.get(n);
					if (!ns.length) continue;
					const count = new Map();
					for (const m of ns) count.set(label.get(m), (count.get(label.get(m)) || 0) + 1);
					let best = label.get(n);
					let bestCount = (count.get(best) || 0) + 0.5;
					for (const [l, c] of count) {
						if (c > bestCount || (c === bestCount && l < best)) {
							best = l;
							bestCount = c;
						}
					}
					if (best !== label.get(n)) {
						label.set(n, best);
						changed = true;
					}
				}
				if (!changed) break;
			}
			const groups = new Map();
			const loners = [];
			for (const n of others) {
				if (!peers.get(n).length) {
					loners.push(n);
					continue;
				}
				const l = label.get(n);
				if (!groups.has(l)) groups.set(l, []);
				groups.get(l).push(n);
			}
			return { groups: [...groups.values()], loners, peers, label };
		}

		/**
		 * Year rings: each group of papers that cite each other gets its own wedge of the circle, and distance from the
		 * middle is how far a paper's year is from the center paper's.
		 */
		_ringLayout(center) {
			const others = this.nodes.slice(1);
			if (!others.length) {
				this.rings = [];
				return;
			}
			const { groups, loners, peers } = this._clusters(others);
			groups.sort((a, b) => b.length - a.length);

			// Put groups that cite each other a lot next to each other.
			const groupOf = new Map();
			groups.forEach((g, i) => g.forEach((n) => groupOf.set(n, i)));
			const between = (i, j) => groups[i].reduce((sum, n) => sum + peers.get(n).filter((m) => groupOf.get(m) === j).length, 0);
			const order = groups.length ? [0] : [];
			const left = new Set(groups.map((_, i) => i).slice(1));
			while (left.size) {
				const last = order[order.length - 1];
				let best = null;
				let bestScore = -1;
				for (const j of left) {
					const score = between(last, j) * 1000 + groups[j].length;
					if (score > bestScore) {
						best = j;
						bestScore = score;
					}
				}
				order.push(best);
				left.delete(best);
			}

			// Within a group the most connected papers go in the middle of its wedge.
			const wedges = [];
			for (const i of order) {
				const byDegree = [...groups[i]].sort((a, b) => peers.get(b).length - peers.get(a).length || b.citedBy - a.citedBy);
				const arranged = [];
				byDegree.forEach((n, k) => (k % 2 ? arranged.unshift(n) : arranged.push(n)));
				wedges.push(arranged);
			}
			if (loners.length) wedges.push([...loners].sort((a, b) => (a.year || 0) - (b.year || 0)));

			// Rings are bands of years, ordered by distance in time from the center paper. A band never splits a year,
			// and bands hold about the same number of papers, so a busy year doesn't crowd one thin ring.
			const cy = center.year;
			const distance = (y) => (y && cy ? Math.abs(y - cy) : Infinity);
			const dated = others.filter((n) => n.year).sort((a, b) => distance(a.year) - distance(b.year) || a.year - b.year);
			const yearCount = new Set(dated.map((n) => n.year)).size;
			const bandCount = Math.min(yearCount, 8, Math.max(3, Math.round(Math.sqrt(dated.length))));
			const bands = [];
			// Outer rings are longer, so they take more papers: band i gets a share proportional to i + 2.
			const shares = Array.from({ length: bandCount }, (_, i) => i + 2);
			const shareTotal = shares.reduce((t, x) => t + x, 0);
			const quota = (i) => (dated.length * shares[Math.min(i, bandCount - 1)]) / shareTotal;
			for (const n of dated) {
				let band = bands[bands.length - 1];
				const sameYear = band && band.years.has(n.year);
				if (!band || (!sameYear && band.nodes.length >= quota(bands.length - 1) && bands.length < bandCount)) {
					band = { years: new Set(), nodes: [] };
					bands.push(band);
				}
				band.years.add(n.year);
				band.nodes.push(n);
			}
			const undated = others.filter((n) => !n.year);
			if (undated.length) bands.push({ years: new Set(), nodes: undated, unknown: true });
			bands.forEach((band, i) => band.nodes.forEach((n) => (n.bandIndex = i)));

			// Each wedge is a sector, and each band's papers spread across the whole sector at that band's ring.
			// Papers in different rings can share an angle, so a sector is only as wide as its busiest ring needs.
			const width = (n) => 2 * n.r + 10;
			const avgDiameter = others.reduce((sum, n) => sum + 2 * n.r, 0) / others.length;
			let R0 = center.r + 80;
			let step = Math.max(58, avgDiameter * 2.4);
			const GAP = wedges.length > 1 ? 0.07 : 0;
			// Ring labels sit at the top of each ring, so no papers go there.
			const LABEL_GAP = 0.16;
			const room = 2 * Math.PI - LABEL_GAP;
			const need = (scale) => wedges.map((wedge) => Math.max(...bands.map((_, b) => {
				const sum = wedge.filter((n) => n.bandIndex === b).reduce((t, n) => t + width(n), 0);
				return sum / ((R0 + b * step) * scale);
			})));
			// Grow every ring together until all sectors fit around the circle with a little room to spare.
			let scale = 1;
			let needs = need(scale);
			const total = () => needs.reduce((t, x) => t + x, 0) + GAP * wedges.length;
			if (total() > room * 0.92) {
				scale = total() / (room * 0.92);
				needs = need(scale);
			}
			R0 *= scale;
			step *= scale;
			// Share out what's left of the circle in proportion, so sectors fill it.
			const stretch = (room - GAP * Math.max(0, wedges.length - 1)) / needs.reduce((t, x) => t + x, 0);

			let angle = -Math.PI / 2 + LABEL_GAP / 2;
			wedges.forEach((wedge, w) => {
				const span = needs[w] * stretch;
				bands.forEach((_, b) => {
					const row = wedge.filter((n) => n.bandIndex === b);
					// Spread the row over the whole sector, each paper getting room in proportion to its size.
					const sum = row.reduce((t, n) => t + width(n), 0);
					let before = 0;
					for (const n of row) {
						n.angle = angle + (span * (before + width(n) / 2)) / sum;
						before += width(n);
					}
				});
				angle += span + GAP;
			});

			this.rings = bands.map((band, i) => {
				const ys = [...band.years].sort((a, b) => a - b);
				const label = band.unknown ? "year unknown"
					: ys.length === 1 ? String(ys[0]) : `${ys[0]}–${ys[ys.length - 1]}`;
				return { r: R0 + i * step, label };
			});

			for (const n of others) {
				const r = R0 + n.bandIndex * step;
				n.tx = Math.cos(n.angle) * r;
				n.ty = Math.sin(n.angle) * r;
				n.x = n.tx;
				n.y = n.ty;
				n.vx = n.vy = 0;
			}
		}

		_drawGuides() {
			this.guideLayer.replaceChildren();
			const rings = this.layout === "rings" ? this.rings || [] : [];
			// Too many labels would pile up; label an even subset, always including the innermost and outermost.
			const every = Math.max(1, Math.ceil(rings.length / 9));
			rings.forEach((ring, i) => {
				this.guideLayer.append(this._svg("circle", { r: ring.r.toFixed(1), class: "cg-ring" }));
				if (i % every && i !== rings.length - 1) return;
				const text = this._svg("text", { x: 0, y: (-ring.r - 4).toFixed(1), class: "cg-ring-label" });
				text.textContent = ring.label;
				this.guideLayer.append(text);
			});
		}

		_tick() {
			if (this.layout === "rings") this._ringTick();
			else this._freeTick();
			this.alpha *= 0.985;
		}

		/** Year rings: every paper is pulled to its spot, and only pushed away by papers it overlaps. */
		_ringTick() {
			const nodes = this.nodes;
			const n = nodes.length;
			for (let i = 1; i < n; i++) {
				const a = nodes[i];
				for (let j = i + 1; j < n; j++) {
					const b = nodes[j];
					const dx = b.x - a.x;
					const dy = b.y - a.y;
					const min = a.r + b.r + 6;
					if (Math.abs(dx) > min || Math.abs(dy) > min) continue;
					const d = Math.sqrt(dx * dx + dy * dy) || 0.1;
					if (d >= min) continue;
					const push = (min - d) * 0.3;
					const fx = (dx / d) * push;
					const fy = (dy / d) * push;
					a.vx -= fx; a.vy -= fy;
					b.vx += fx; b.vy += fy;
				}
			}
			for (const node of nodes) {
				if (node.fixed) {
					node.vx = node.vy = 0;
					continue;
				}
				node.vx += (node.tx - node.x) * 0.08;
				node.vy += (node.ty - node.y) * 0.08;
				node.vx *= 0.55;
				node.vy *= 0.55;
				node.x += Math.max(-30, Math.min(30, node.vx));
				node.y += Math.max(-30, Math.min(30, node.vy));
			}
		}

		_freeTick() {
			const nodes = this.nodes;
			const alpha = this.alpha;
			const n = nodes.length;
			for (let i = 0; i < n; i++) {
				const a = nodes[i];
				for (let j = i + 1; j < n; j++) {
					const b = nodes[j];
					let dx = b.x - a.x;
					let dy = b.y - a.y;
					let d2 = dx * dx + dy * dy;
					if (d2 < 0.01) {
						dx = Math.random() - 0.5;
						dy = Math.random() - 0.5;
						d2 = dx * dx + dy * dy;
					}
					const d = Math.sqrt(d2);
					let f = (2600 * alpha) / d2;
					const overlap = a.r + b.r + 10 - d;
					if (overlap > 0) f += overlap * 0.25;
					const fx = (dx / d) * f;
					const fy = (dy / d) * f;
					a.vx -= fx; a.vy -= fy;
					b.vx += fx; b.vy += fy;
				}
			}
			const ringLength = 150 + n * 3.2;
			for (const e of this.edges) {
				const { s, t } = e;
				const dx = t.x - s.x;
				const dy = t.y - s.y;
				const d = Math.sqrt(dx * dx + dy * dy) || 1;
				const [len, k] = e.inter ? [90, 0.025] : [ringLength, 0.03];
				const f = (d - len) * k * alpha;
				const fx = (dx / d) * f;
				const fy = (dy / d) * f;
				s.vx += fx; s.vy += fy;
				t.vx -= fx; t.vy -= fy;
			}
			for (const node of nodes) {
				if (node.fixed) {
					node.vx = node.vy = 0;
					continue;
				}
				node.vx *= 0.6;
				node.vy *= 0.6;
				node.x += Math.max(-30, Math.min(30, node.vx));
				node.y += Math.max(-30, Math.min(30, node.vy));
			}
		}

		_run() {
			if (this._frame) return;
			const step = () => {
				this._frame = null;
				for (let i = 0; i < 2; i++) this._tick();
				this._position();
				if (!this.userMoved) this._fit();
				if (this.alpha > 0.01 || this.dragging) this._frame = this.win.requestAnimationFrame(step);
			};
			this._frame = this.win.requestAnimationFrame(step);
		}

		_position() {
			for (const n of this.nodes) n.el.setAttribute("transform", `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`);
			const rings = this.layout === "rings";
			const unit = (x, y) => {
				const d = Math.sqrt(x * x + y * y) || 1;
				return [x / d, y / d];
			};
			for (const e of this.edges) {
				const { s, t } = e;
				// In year rings, links between papers bend toward the empty middle instead of crossing other papers.
				const curved = rings && e.inter;
				const k = curved ? 0.6 : 1;
				const cx = ((s.x + t.x) / 2) * k;
				const cy = ((s.y + t.y) / 2) * k;
				let [ux, uy] = unit(cx - s.x, cy - s.y);
				const sx = s.x + ux * s.r;
				const sy = s.y + uy * s.r;
				[ux, uy] = unit(t.x - cx, t.y - cy);
				const ex = t.x - ux * (t.r + 2);
				const ey = t.y - uy * (t.r + 2);
				const f = (v) => v.toFixed(1);
				e.el.setAttribute("d", curved
					? `M${f(sx)},${f(sy)} Q${f(cx)},${f(cy)} ${f(ex)},${f(ey)}`
					: `M${f(sx)},${f(sy)} L${f(ex)},${f(ey)}`);
			}
		}

		// ---- View: pan, zoom, fit ----

		_fit() {
			if (!this.nodes.length) return;
			const { width, height } = this.svg.getBoundingClientRect();
			if (!width || !height) return;
			let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
			for (const n of this.nodes) {
				minX = Math.min(minX, n.x - n.r);
				maxX = Math.max(maxX, n.x + n.r);
				minY = Math.min(minY, n.y - n.r);
				maxY = Math.max(maxY, n.y + n.r + 14);
			}
			const pad = 40;
			const k = Math.min(1.6, (width - 2 * pad) / (maxX - minX || 1), (height - 2 * pad) / (maxY - minY || 1));
			this.view = {
				k,
				x: width / 2 - ((minX + maxX) / 2) * k,
				y: height / 2 - ((minY + maxY) / 2) * k,
			};
			this._applyView();
		}

		_applyView() {
			const { x, y, k } = this.view;
			this.world.setAttribute("transform", `translate(${x},${y}) scale(${k})`);
		}

		_toWorld(ev) {
			const rect = this.svg.getBoundingClientRect();
			return {
				x: (ev.clientX - rect.left - this.view.x) / this.view.k,
				y: (ev.clientY - rect.top - this.view.y) / this.view.k,
			};
		}

		_bindPanZoom() {
			this.svg.addEventListener("wheel", (ev) => {
				ev.preventDefault();
				this.userMoved = true;
				const rect = this.svg.getBoundingClientRect();
				const px = ev.clientX - rect.left;
				const py = ev.clientY - rect.top;
				const factor = Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.0015));
				const k = Math.max(0.15, Math.min(6, this.view.k * factor));
				const f = k / this.view.k;
				this.view = { k, x: px - (px - this.view.x) * f, y: py - (py - this.view.y) * f };
				this._applyView();
				this.card.hidden = true;
			}, { passive: false });

			this.svg.addEventListener("pointerdown", (ev) => {
				if (ev.button !== 0 || ev.target.closest(".cg-node")) return;
				const start = { x: ev.clientX, y: ev.clientY, vx: this.view.x, vy: this.view.y };
				this.svg.setPointerCapture(ev.pointerId);
				this.svg.classList.add("cg-panning");
				this.card.hidden = true;
				const move = (e) => {
					this.userMoved = true;
					this.view.x = start.vx + e.clientX - start.x;
					this.view.y = start.vy + e.clientY - start.y;
					this._applyView();
				};
				const up = () => {
					this.svg.classList.remove("cg-panning");
					this.svg.removeEventListener("pointermove", move);
					this.svg.removeEventListener("pointerup", up);
					this.svg.removeEventListener("pointercancel", up);
				};
				this.svg.addEventListener("pointermove", move);
				this.svg.addEventListener("pointerup", up);
				this.svg.addEventListener("pointercancel", up);
			});
			this.svg.addEventListener("dblclick", (ev) => {
				if (ev.target.closest(".cg-node")) return;
				this.userMoved = false;
				this._fit();
			});
		}

		/** Dragging moves a paper; a click without moving centers the graph on it. */
		_bindNodeDrag(g, n) {
			g.addEventListener("pointerdown", (ev) => {
				if (ev.button !== 0) return;
				ev.stopPropagation();
				g.setPointerCapture(ev.pointerId);
				const sx = ev.clientX;
				const sy = ev.clientY;
				let moved = false;
				const wasFixed = n.fixed;
				const move = (e) => {
					if (!moved && Math.hypot(e.clientX - sx, e.clientY - sy) < 4) return;
					if (!moved) {
						moved = true;
						this.dragging = true;
						this.userMoved = true;
						this.card.hidden = true;
						n.fixed = true;
					}
					const p = this._toWorld(e);
					n.x = p.x;
					n.y = p.y;
					this.alpha = Math.max(this.alpha, 0.3);
					this._run();
				};
				const up = () => {
					g.removeEventListener("pointermove", move);
					g.removeEventListener("pointerup", up);
					g.removeEventListener("pointercancel", up);
					this.dragging = false;
					if (moved) {
						n.fixed = wasFixed || n.center;
						// In year rings a dropped paper stays where it was put.
						n.tx = n.x;
						n.ty = n.y;
					}
					else this.recenter(n);
				};
				g.addEventListener("pointermove", move);
				g.addEventListener("pointerup", up);
				g.addEventListener("pointercancel", up);
			});
		}

		// ---- Hover ----

		_hover(n) {
			if (this.dragging) return;
			this.svg.classList.add("cg-focus");
			for (const m of this.nodes) m.el.classList.toggle("cg-lit", m === n || n.links.has(m));
			for (const e of this.edges) {
				const lit = e.s === n || e.t === n;
				e.el.classList.toggle("cg-lit", lit);
				e.el.setAttribute("marker-end", `url(#${lit ? "cg-arrow-lit" : e.inter ? "cg-arrow-inter" : "cg-arrow"})`);
			}
			this._cancelHide();
			this._fillCard(n);
			this._placeCard(n);
		}

		_unfocus() {
			this.svg.classList.remove("cg-focus");
			for (const m of this.nodes) m.el.classList.remove("cg-lit");
			for (const e of this.edges) {
				e.el.classList.remove("cg-lit");
				e.el.setAttribute("marker-end", `url(#${e.inter ? "cg-arrow-inter" : "cg-arrow"})`);
			}
		}

		_scheduleHide() {
			this._cancelHide();
			this._hideTimer = this.win.setTimeout(() => {
				this.card.hidden = true;
			}, 350);
		}

		_cancelHide() {
			if (this._hideTimer) this.win.clearTimeout(this._hideTimer);
			this._hideTimer = null;
		}

		_fillCard(n) {
			const card = this.card;
			card.replaceChildren();
			const title = this._el("div", "cg-card-title", n.title);
			const authors = n.authors.length > 4 ? `${n.authors.slice(0, 3).join(", ")} et al.` : n.authors.join(", ");
			const meta = this._el("div", "cg-card-meta",
				[authors, n.venue, n.year, `cited ${n.citedBy.toLocaleString()}×`].filter(Boolean).join(" · "));
			card.append(title, meta);

			const among = [...n.links].filter((m) => !m.center).length;
			if (!n.center && among) {
				card.append(this._el("div", "cg-card-links",
					`Linked to ${among} other paper${among === 1 ? "" : "s"} in this graph`));
			}
			const abstract = this._el("div", `cg-card-abstract${n.abstract ? "" : " cg-muted"}`, n.abstract || "No abstract available.");
			card.append(abstract);

			const actions = this._el("div", "cg-card-actions");
			const open = this._el("button", "", "Open link ↗");
			open.title = n.url;
			open.addEventListener("click", () => Zotero.launchURL(n.url));
			actions.append(open);

			if (n.itemID) {
				const show = this._el("button", "cg-primary", "Show in Zotero");
				show.addEventListener("click", () => this._showInZotero(n));
				actions.append(show);
			}
			else if (n.doi) {
				const add = this._el("button", "cg-primary", n.adding ? "Adding…" : "Add to Zotero");
				add.disabled = !!n.adding;
				add.addEventListener("click", () => this._add(n));
				actions.append(add);
			}
			if (!n.center) {
				const focus = this._el("button", "", "Center on this");
				focus.title = "Show this paper's citations (or click the circle)";
				focus.addEventListener("click", () => this.recenter(n));
				actions.append(focus);
			}
			card.append(actions);
			if (n.note) card.append(this._el("div", `cg-card-note${n.noteError ? " cg-error" : ""}`, n.note));
			else if (!n.itemID && !n.doi) card.append(this._el("div", "cg-card-note", "No DOI, so it can't be added automatically."));
			card.hidden = false;
			this._cardNode = n;
		}

		_placeCard(n) {
			const card = this.card;
			const stage = this.stage.getBoundingClientRect();
			const sx = n.x * this.view.k + this.view.x;
			const sy = n.y * this.view.k + this.view.y;
			const r = n.r * this.view.k;
			const w = card.offsetWidth;
			const h = card.offsetHeight;
			let left = sx + r + 14;
			if (left + w > stage.width - 8) left = sx - r - 14 - w;
			left = Math.max(8, Math.min(left, stage.width - w - 8));
			const top = Math.max(8, Math.min(sy - 40, stage.height - h - 8));
			card.style.left = `${left}px`;
			card.style.top = `${top}px`;
		}

		async _add(n) {
			if (n.adding) return;
			n.adding = true;
			n.note = "";
			if (this._cardNode === n && !this.card.hidden) this._fillCard(n);
			const destination = this.folder.value;
			try {
				n.note = await Buddy.Scout.addToLibrary(n.doi, destination);
				n.noteError = false;
				Buddy.Chat.rememberDestination(destination);
				const item = await Buddy.Scout.findByDOI(n.doi);
				if (item) {
					n.itemID = item.id;
					n.el.classList.add("cg-owned");
				}
			}
			catch (e) {
				n.note = `Couldn't add this paper: ${e.message || e}`;
				n.noteError = true;
			}
			n.adding = false;
			if (this._cardNode === n && !this.card.hidden) this._fillCard(n);
		}

		async _showInZotero(n) {
			const main = Zotero.getMainWindow();
			if (!main) return;
			main.focus();
			main.Zotero_Tabs?.select("zotero-pane");
			await main.ZoteroPane.selectItem(n.itemID);
		}
	}
}

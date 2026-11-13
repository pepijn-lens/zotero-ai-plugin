// Renders a safe Markdown subset as DOM nodes. Text only ever becomes text nodes, because model
// output can quote untrusted paper content. The one exception is math, which KaTeX turns into
// MathML with its trust option off, so a formula can't produce links, images or scripts.
{
	const XHTML = "http://www.w3.org/1999/xhtml";
	// The rules on the delimiters keep prices like "$5 and $10" from being read as math.
	const DOLLAR = String.raw`(?<![\\$])\$(?![\s$])(?<dollar>(?:\\.|[^$\n\\])+?)(?<!\s)\$(?![\d$])`;
	const INLINE = new RegExp([
		String.raw`\[\[(?<key>[A-Za-z0-9]{8}):(?<page>\d+)(?::(?<quote>(?:(?!\]\]).)+))?\]\]`,
		String.raw`${"`"}(?<code>[^${"`"}\n]+)${"`"}`,
		String.raw`\$\$(?<blockDollar>[^\n]+?)\$\$`,
		String.raw`\\\[(?<blockBracket>[^\n]+?)\\\]`,
		String.raw`\\\((?<paren>[^\n]+?)\\\)`,
		DOLLAR,
		String.raw`(?<price>\\\$)`,
		String.raw`\*\*(?<bold>[^\n]+?)\*\*`,
		String.raw`~~(?<strike>[^\n]+?)~~`,
		// Math is skipped as a unit, so a "*" inside a formula can't close the emphasis.
		String.raw`(?<![\w*])\*(?<em>(?!\s)(?:\$[^$\n]*\$|[^*$\n])+)\*`,
		String.raw`\[(?<label>[^\]\n]+)\]\((?<url>https?:\/\/[^\s)]+)\)`,
	].join("|"), "g");
	const CELL_BREAK = new RegExp(String.raw`${"`"}[^${"`"}\n]+${"`"}|\$\$.+?\$\$|${DOLLAR}|\\\(.+?\\\)|\\\||\|`, "g");
	const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
	const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
	const MATH_START = /^\s*(\$\$|\\\[)/;
	const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
	const NUMERIC = /^[~≈<>≤≥±+\-−]*\s*[\d.,]+\s*[%×xkKMBG]?\s*(?:±\s*[\d.,]+\s*[%kKMBG]?)?$/;
	const MAX_CACHED_FORMULAS = 500;
	const formulas = new WeakMap();

	function el(doc, tag, cls) {
		const node = doc.createElementNS(XHTML, tag);
		if (cls) node.className = cls;
		return node;
	}

	function link(doc, label, cls, title, onActivate) {
		const node = el(doc, "span", cls);
		node.textContent = label;
		node.title = title;
		node.setAttribute("role", "link");
		node.tabIndex = 0;
		node.addEventListener("click", onActivate);
		node.addEventListener("keydown", (e) => {
			if (e.key === "Enter") onActivate(e);
		});
		return node;
	}

	/** A message is redrawn many times while it streams, so each formula is only typeset once. */
	function typeset(doc, tex, display) {
		if (!formulas.has(doc)) formulas.set(doc, new Map());
		const cache = formulas.get(doc);
		const key = `${display ? "block" : "inline"}:${tex}`;
		if (!cache.has(key)) {
			let math = null;
			try {
				const markup = Buddy.katex.renderToString(tex, {
					output: "mathml",
					displayMode: display,
					throwOnError: true,
					strict: "ignore",
					trust: false,
					maxSize: 20,
					maxExpand: 1000,
				});
				math = new doc.defaultView.DOMParser().parseFromString(markup, "text/html").querySelector("math");
			}
			catch (e) {}
			if (cache.size >= MAX_CACHED_FORMULAS) cache.clear();
			cache.set(key, math);
		}
		const math = cache.get(key);
		return math && doc.importNode(math, true);
	}

	/** Formulas that don't parse stay readable as their source. */
	function formula(doc, tex, display) {
		const math = typeset(doc, tex.trim(), display);
		if (!display && math) return math;
		const node = el(doc, display ? "div" : "code", display ? "buddy-math" : "buddy-math-error");
		if (math) {
			node.append(math);
		}
		else if (display) {
			const source = el(doc, "code", "buddy-math-error");
			source.textContent = tex.trim();
			node.append(source);
		}
		else {
			node.textContent = tex.trim();
		}
		return node;
	}

	function inline(doc, text, parent, actions) {
		let last = 0;
		for (const m of text.matchAll(INLINE)) {
			const g = m.groups;
			if (m.index > last) parent.append(doc.createTextNode(text.slice(last, m.index)));
			last = m.index + m[0].length;
			if (g.key) {
				const page = parseInt(g.page);
				const quote = g.quote?.trim();
				parent.append(link(doc, actions.citationLabel(g.key, page), "buddy-link buddy-cite",
					quote ? `Page ${page}: “${quote}”` : `Open page ${page}`,
					() => actions.openCitation(g.key, page, quote)));
			}
			else if (g.code) {
				const code = el(doc, "code");
				code.textContent = g.code;
				parent.append(code);
			}
			else if (g.blockDollar || g.blockBracket) {
				parent.append(formula(doc, g.blockDollar || g.blockBracket, true));
			}
			else if (g.paren || g.dollar) {
				parent.append(formula(doc, g.paren || g.dollar, false));
			}
			else if (g.price) {
				parent.append(doc.createTextNode("$"));
			}
			else if (g.bold || g.strike || g.em) {
				const node = el(doc, g.bold ? "strong" : g.strike ? "s" : "em");
				inline(doc, g.bold || g.strike || g.em, node, actions);
				parent.append(node);
			}
			else {
				parent.append(link(doc, g.label, "buddy-link", g.url, () => actions.openURL(g.url)));
			}
		}
		if (last < text.length) parent.append(doc.createTextNode(text.slice(last)));
	}

	/** Splits on the pipes between cells, leaving alone those inside code and math, as in $|x|$. */
	function splitRow(line) {
		const row = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
		const cells = [];
		let cell = "";
		let last = 0;
		for (const m of row.matchAll(CELL_BREAK)) {
			if (m[0] === "|") {
				cells.push(cell + row.slice(last, m.index));
				cell = "";
				last = m.index + 1;
			}
			else if (m[0] === "\\|") {
				cell += `${row.slice(last, m.index)}|`;
				last = m.index + 2;
			}
		}
		cells.push(cell + row.slice(last));
		return cells.map((c) => c.trim());
	}

	function isTableStart(lines, i) {
		return lines[i].includes("|") && i + 1 < lines.length && lines[i + 1].includes("-")
			&& TABLE_RULE.test(lines[i + 1]);
	}

	function startsBlock(lines, i) {
		const l = lines[i];
		return /^```/.test(l) || /^#{1,6}\s/.test(l) || /^>/.test(l) || LIST.test(l) || RULE.test(l)
			|| MATH_START.test(l) || isTableStart(lines, i);
	}

	/** Reads a $$ or \[ block starting at line i. A block with no end yet is still being streamed. */
	function mathBlock(lines, i) {
		const open = lines[i].match(MATH_START);
		if (!open) return null;
		const close = open[1] === "$$" ? "$$" : "\\]";
		const first = lines[i].slice(open[0].length);
		const end = first.indexOf(close);
		if (end >= 0) {
			// Text after the closing delimiter makes this a paragraph that starts with a formula.
			if (first.slice(end + close.length).trim()) return null;
			return { tex: first.slice(0, end), next: i + 1, closed: true };
		}
		const body = [first];
		for (let j = i + 1; j < lines.length; j++) {
			const at = lines[j].indexOf(close);
			if (at >= 0) {
				body.push(lines[j].slice(0, at));
				return { tex: body.join("\n"), next: j + 1, closed: true };
			}
			body.push(lines[j]);
		}
		return { tex: body.join("\n"), next: lines.length, closed: false };
	}

	/** Uses the alignment the table asks for, and otherwise right-aligns columns of numbers. */
	function columnAlignments(rule, rows) {
		return splitRow(rule).map((spec, column) => {
			const left = spec.startsWith(":");
			const right = spec.endsWith(":");
			if (left && right) return "center";
			if (right) return "right";
			if (left) return "left";
			const values = rows.map((r) => (r[column] || "").replace(/\*/g, "").trim()).filter(Boolean);
			return values.length && values.every((v) => NUMERIC.test(v)) ? "right" : "";
		});
	}

	function renderTable(doc, lines, i, root, actions) {
		const head = splitRow(lines[i]);
		const rows = [];
		let next = i + 2;
		for (; next < lines.length && lines[next].includes("|"); next++) rows.push(splitRow(lines[next]));
		const aligns = columnAlignments(lines[i + 1], rows);
		const wrap = el(doc, "div", "buddy-tablewrap");
		const table = el(doc, "table");
		const addRow = (cells, tag) => {
			const tr = el(doc, "tr");
			cells.forEach((cell, column) => {
				const td = el(doc, tag);
				if (aligns[column]) td.style.textAlign = aligns[column];
				if (aligns[column] === "right") td.style.whiteSpace = "nowrap";
				inline(doc, cell, td, actions);
				tr.append(td);
			});
			table.append(tr);
		};
		addRow(head, "th");
		for (const row of rows) addRow(row, "td");
		wrap.append(table);
		root.append(wrap);
		return next;
	}

	function indentOf(space) {
		return space.replace(/\t/g, "    ").length;
	}

	function renderList(doc, lines, i, root, actions) {
		const stack = [];
		const open = (parent, indent, ordered, marker) => {
			const list = el(doc, ordered ? "ol" : "ul");
			if (ordered && parseInt(marker) !== 1) list.setAttribute("start", parseInt(marker));
			parent.append(list);
			stack.push({ list, indent, ordered, item: null });
		};
		for (; i < lines.length; i++) {
			const line = lines[i];
			const m = RULE.test(line) ? null : line.match(LIST);
			if (!m) {
				if (!line.trim() && i + 1 < lines.length && LIST.test(lines[i + 1]) && !RULE.test(lines[i + 1])) continue;
				const top = stack[stack.length - 1];
				if (line.trim() && /^\s/.test(line) && top.item) {
					inline(doc, ` ${line.trim()}`, top.item, actions);
					continue;
				}
				break;
			}
			const indent = indentOf(m[1]);
			const ordered = /\d/.test(m[2]);
			while (stack.length > 1 && indent < stack[stack.length - 1].indent) stack.pop();
			let top = stack[stack.length - 1];
			if (!top) {
				open(root, indent, ordered, m[2]);
			}
			else if (indent >= top.indent + 2 && top.item) {
				open(top.item, indent, ordered, m[2]);
			}
			else if (ordered !== top.ordered && stack.length === 1) {
				break;
			}
			top = stack[stack.length - 1];
			top.item = el(doc, "li");
			inline(doc, m[3], top.item, actions);
			top.list.append(top.item);
		}
		return i;
	}

	Buddy.renderMarkdown = function (doc, text, root, actions) {
		const lines = text.split("\n");
		let i = 0;
		while (i < lines.length) {
			const line = lines[i];
			const math = mathBlock(lines, i);
			if (!line.trim()) {
				i++;
			}
			else if (math?.closed) {
				root.append(formula(doc, math.tex, true));
				i = math.next;
			}
			else if (math) {
				const pending = el(doc, "pre", "buddy-math-pending");
				pending.textContent = math.tex.trim();
				root.append(pending);
				i = math.next;
			}
			else if (/^```/.test(line)) {
				const body = [];
				for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
				i++;
				const pre = el(doc, "pre");
				const code = el(doc, "code");
				code.textContent = body.join("\n");
				pre.append(code);
				root.append(pre);
			}
			else if (/^#{1,6}\s/.test(line)) {
				const level = Math.min(line.match(/^#+/)[0].length, 4);
				const h = el(doc, "div", `buddy-heading buddy-h${level}`);
				inline(doc, line.replace(/^#+\s+/, ""), h, actions);
				root.append(h);
				i++;
			}
			else if (RULE.test(line)) {
				root.append(el(doc, "hr"));
				i++;
			}
			else if (isTableStart(lines, i)) {
				i = renderTable(doc, lines, i, root, actions);
			}
			else if (/^>/.test(line)) {
				const quote = el(doc, "blockquote");
				const body = [];
				for (; i < lines.length && /^>/.test(lines[i]); i++) body.push(lines[i].replace(/^>\s?/, ""));
				Buddy.renderMarkdown(doc, body.join("\n"), quote, actions);
				root.append(quote);
			}
			else if (LIST.test(line)) {
				i = renderList(doc, lines, i, root, actions);
			}
			else {
				const body = [line];
				for (i++; i < lines.length && lines[i].trim() && !startsBlock(lines, i); i++) body.push(lines[i]);
				const p = el(doc, "p");
				inline(doc, body.join("\n"), p, actions);
				root.append(p);
			}
		}
	};
}

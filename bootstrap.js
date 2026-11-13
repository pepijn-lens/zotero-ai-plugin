var Buddy;
var chromeHandle;

const STYLE_ID = "research-buddy-style";
const SOURCES = ["markdown", "pdfText", "locate", "scout", "citegraph", "tools", "mcp", "attach", "agent", "history", "panel", "tour"];

function install() {}
function uninstall() {}

async function startup({ id, version, rootURI }) {
	const aomStartup = Cc["@mozilla.org/addons/addon-manager-startup;1"]
		.getService(Ci.amIAddonManagerStartup);
	chromeHandle = aomStartup.registerChrome(
		Services.io.newURI(rootURI + "manifest.json"),
		[["content", "researchbuddy", "content/"]]
	);

	Buddy = { id, version, rootURI, loadedAt: Date.now() };
	Zotero.ResearchBuddy = Buddy;
	// KaTeX's loader attaches itself to whatever "self" is, so it gets a scope of its own.
	const katexScope = {};
	katexScope.self = katexScope;
	Services.scriptloader.loadSubScriptWithOptions(`${rootURI}src/vendor/katex.min.js`, {
		target: katexScope,
		ignoreCache: true,
	});
	Buddy.katex = katexScope.katex;
	for (const name of SOURCES) {
		Services.scriptloader.loadSubScriptWithOptions(`${rootURI}src/${name}.js`, {
			target: globalThis,
			ignoreCache: true,
		});
	}

	Buddy.systemPrompt = await (await fetch(rootURI + "prompts/system.md")).text()
		+ `\nThe user's Zotero data folder is ${Zotero.DataDirectory.dir}.\n`;
	Buddy.MCP.register();
	Buddy.UI.register();
	for (const window of Zotero.getMainWindows()) {
		onMainWindowLoad({ window });
	}
	Buddy.Tour.maybeAutoStart();
}

function onMainWindowLoad({ window }) {
	const doc = window.document;
	if (!doc.getElementById(STYLE_ID)) {
		const link = doc.createElementNS("http://www.w3.org/1999/xhtml", "link");
		link.id = STYLE_ID;
		link.rel = "stylesheet";
		// Zotero caches stylesheets by URL until it restarts, so an update would otherwise keep the old styles.
		link.href = `chrome://researchbuddy/content/panel.css?${Buddy.loadedAt}`;
		doc.documentElement.appendChild(link);
	}
	Buddy.UI.addToWindow(window);
	Buddy.CiteGraph.addToWindow(window);
}

function onMainWindowUnload({ window }) {
	Buddy.Tour.stopIn(window);
	Buddy.UI.removeFromWindow(window);
	Buddy.CiteGraph.removeFromWindow(window);
	window.document.getElementById(STYLE_ID)?.remove();
}

function shutdown() {
	if (!Buddy) return;
	Buddy.Tour.stop();
	Buddy.Chat.shutdown();
	Buddy.CiteGraph.closeAll();
	Buddy.UI.unregister();
	Buddy.MCP.unregister();
	for (const window of Zotero.getMainWindows()) {
		onMainWindowUnload({ window });
	}
	delete Zotero.ResearchBuddy;
	Buddy = null;
	chromeHandle?.destruct();
	chromeHandle = null;
}

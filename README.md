# Research Buddy

An AI research agent that sits beside your PDFs in Zotero. It runs on your local [Claude Code](https://claude.com/claude-code) install. Ask questions about a paper, compare several papers, or find new literature. Every claim it makes from a paper links back to the exact sentence on the page.

## Features

- **Chat in Zotero.** A chat pane opens next to your library and the reader. Chats are saved, and you can search them and pick them up again later.
- **Verifiable citations.** Answers cite papers as clickable chips such as *Smith 2021, p. 7*. Clicking one opens the PDF, scrolls to the quoted passage and highlights it.
- **Tag papers and collections with `@`.** Type `@` to pull specific papers or whole folders into the conversation.
- **Ask about a passage.** Select text in the reader and click **Ask buddy**. This starts a thread tied to that highlight, and clicking the highlight later reopens the thread.
- **Literature scouting.** The agent searches [OpenAlex](https://openalex.org) for related work and follows citations in both directions. It tells you which papers you already own and suggests additions as cards, with a folder already picked. Nothing is added to your library unless you click to add it.
- **Citation graph.** Right-click a paper and choose **Visualize citations (Research Buddy)** to see its citing or cited papers, and how those papers cite each other.
- **Images.** Attach figures, screenshots or photos of pages (up to 5 per message).
- **Math and tables.** Answers render TeX through KaTeX, and tables render as tables.
- **Model picker.** Choose Haiku (the default), Sonnet, Opus or Fable, or enter any model ID.
- **Guided tour.** A tour runs the first time you start the plugin and tries each feature on a paper from your own library. Run it again any time with the ⓘ button.

## Requirements

- **Zotero 10**
- **Claude Code**, installed and logged in. The plugin looks for `claude` in this order: the `extensions.researchbuddy.claudePath` preference, then `~/.local/bin/claude`, then your `PATH`.
- **Poppler utilities** (`pdftotext` and `pdfinfo`) on your `PATH`, for reading PDF text.
  - Debian/Ubuntu: `sudo apt install poppler-utils`
  - macOS: `brew install poppler`

## Installation

1. Download `dist/research-buddy.xpi`, or build it yourself (see below).
2. In Zotero, open **Tools → Plugins**, click the gear icon and choose **Install Plugin From File…**.
3. Select the `.xpi` file and restart Zotero if it asks you to.

Click the **Research Buddy** toolbar button to open the chat.

## How it works

```
Zotero ──spawns──▶ claude -p (stream-json)  ◀── chat UI in the item pane
   ▲                     │
   └── MCP over HTTP ◀───┘   (Zotero's local server, per-process bearer token)
```

- For each chat, the plugin starts a `claude` process that talks over stream-json. A chat resumes its Claude session when the transcript still exists.
- The Zotero tools are served as an MCP server at `/research-buddy/mcp` on Zotero's built-in local HTTP server. Each process gets its own random bearer token, written to a config file with `0600` permissions in the Zotero profile.
- Zotero tools (`mcp__zotero__*`) run without asking, because they are read-only. `propose_paper` only draws a card.
- Claude Code's other tools (Bash, Read and so on) are available too, so the agent can do things like query `zotero.sqlite` read-only. Each use asks for your approval with an **Allow / Deny** prompt in the chat.
- The agent's instructions are in [`prompts/system.md`](prompts/system.md).

### Zotero tools

| Tool | Purpose |
|---|---|
| `get_current_context` | What's open: the paper, its attachment key and page, or the selected items |
| `read_pages` | Text of up to 15 pages of a paper |
| `find_in_paper` | Pages that mention a phrase or keywords |
| `get_item` | Metadata, abstract, tags, attachments and annotations |
| `search_library` | Full-text search across the library or one collection |
| `get_collection` / `list_collections` | Browse folders and their papers |
| `scout_search` / `scout_related` | Search OpenAlex, and follow citations and references |
| `propose_paper` | Suggest a paper to add, with a destination folder |

## Configuration

Settings are Zotero preferences. Change them in **Settings → Advanced → Config Editor**. Most of them are also set from the UI.

| Preference | Default | Meaning |
|---|---|---|
| `extensions.researchbuddy.claudePath` | auto | Full path to the `claude` binary |
| `extensions.researchbuddy.model` | `haiku` | Model for new messages (set from the picker) |
| `extensions.researchbuddy.graphLimit` | `50` | Maximum number of papers in the citation graph |
| `extensions.researchbuddy.graphLayout` | `rings` | Graph layout: `rings` or `free` |
| `extensions.researchbuddy.graphLinks` | `all` | Show graph edges always (`all`) or on `hover` |
| `extensions.researchbuddy.tourDone` | `false` | Set to `false` to run the tour again on startup |

Saved chats are stored as JSON in `<Zotero profile>/research-buddy/chats/`.

## Keyboard shortcuts

These work when the chat was the last thing you clicked.

| Keys | Action |
|---|---|
| `Enter` / `Shift+Enter` | Send / new line |
| `@` then `↑` `↓` `Enter` | Tag a paper or collection |
| `Ctrl/Cmd +`, `−`, `0` | Make chat text bigger, smaller, or reset it |
| `Ctrl/Cmd+C` | Copy the selected chat text |

## Development

```bash
./scripts/build.sh      # writes dist/research-buddy.xpi
```

Project layout:

```
bootstrap.js        plugin lifecycle; loads src/ in order
manifest.json       plugin metadata
prompts/system.md   instructions added to Claude's system prompt
src/agent.js        the claude child process and the stream-json protocol
src/mcp.js          MCP endpoint on Zotero's HTTP server
src/tools.js        the Zotero tools
src/panel.js        chat state and UI
src/markdown.js     safe Markdown and KaTeX renderer (output only ever becomes text nodes)
src/locate.js       finds a quoted passage in the reader and highlights it
src/pdfText.js      per-page PDF text through pdftotext, with a cache
src/scout.js        OpenAlex search and adding papers to the library
src/citegraph.js    citation graph window
src/attach.js       image and @-tag attachments
src/history.js      saved chats
src/tour.js         guided tour
content/            stylesheets, icons, graph window
```

To iterate quickly, point Zotero at the source folder instead of installing the `.xpi`. Create a file named `research-buddy@local.zotero` in your Zotero profile's `extensions/` folder, containing the absolute path to this repository, then restart Zotero. Scripts load with `ignoreCache`, so disabling and re-enabling the plugin picks up most changes.

## Privacy

Paper text, your questions and any attached images go to Anthropic through your own Claude Code account. Literature searches send search terms and DOIs to the OpenAlex API. Nothing else leaves your machine. The plugin never writes to `zotero.sqlite`, and papers are added to your library only when you click a suggestion card.

## Third-party

- [KaTeX](https://katex.org), MIT License. See [`src/vendor/katex.LICENSE`](src/vendor/katex.LICENSE).

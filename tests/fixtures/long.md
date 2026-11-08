# MD Viewer

A small markdown viewer and editor that runs in Edge (or Chrome) as an installed app.
It opens `.md` files with a double-click, shows them rendered, lets you edit the source
and saves the file back in place. No server, no install rights, no build step;
files never leave the machine.

## Use

| Action | How |
|---|---|
| Open | double-click a `.md` (once installed), drag a file onto the window, or `Ctrl+O` |
| View / Split / Edit | buttons in the bar; `Ctrl+E` toggles View and Edit |
| Save | `Ctrl+S` (writes the same file); `Ctrl+Shift+S` saves as |
| Dark / light | button in the bar or `Ctrl+Shift+L`; remembered |
| Unsaved changes | pink dot next to the file name, `*` in the window title, warning on close |

Saving keeps the file's original line endings (CRLF or LF) and UTF-8 BOM.

## Install as the default `.md` app (Edge)

1. Open the hosted page in Edge.
2. Click the "App available" icon in the address bar (or `...` > Apps > Install this site as an app).
3. Edge asks whether the app may open markdown files; allow it.
4. Right-click any `.md` file > Open with > Choose another app > **MD Viewer** > **Always**.
5. The first save to each file asks for permission to edit it; choose "Allow on every visit"
   if Edge offers it.

After the first visit the app works offline (a service worker caches it).

## Managed PC

The same steps work on a managed PC. What can block them:

- an Edge policy that disables web app installs (then use the page in a normal tab:
  `Ctrl+O`, edit, `Ctrl+S` still saves in place, just no double-click);
- a proxy that blocks the hosting domain (host the folder somewhere else instead;
  it is plain static files).

## Limits

- Relative links and images inside the markdown don't resolve: the app only has access
  to the one file it was given, not its folder.
- Editing is plain source text; there is no rich-text editing of the rendered view.
- No Mermaid diagrams or maths (could be added by vendoring the libraries).

## Files

- `index.html`, `style.css`, `app.js` - the app
- `manifest.webmanifest` - install metadata, including the `.md` file handler
- `sw.js` - offline cache (bump `VERSION` when the file list changes)
- `vendor/` - pinned copies: marked 18.1.3, DOMPurify 3.4.17, highlight.js 11.12.0
- `icons/` - `icon.svg` is the source; `python tools/make_icons.py` renders the PNGs
- `tests/smoke.py` - drives the app in headless Chromium: render, sanitising, CRLF/BOM
  round-trip, edit + save through a fake file handle, themes. `python tests/smoke.py`

Run locally: `python -m http.server 8765 --bind 127.0.0.1` in this folder, then open
`http://127.0.0.1:8765/`.

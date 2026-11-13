# Windows verification checklist

Most of what used to be on this list now runs on every push in CI, against the real
`tcb.exe` on Windows WebView2 (`windows-latest`): `tests/windows/e2e.test.mjs`, in the
`bundle-windows` job of `.github/workflows/ci.yml`. CI builds a test variant of the app
whose only difference is a WebView2 DevTools port (`src-tauri/tauri.e2e.conf.json`, kept
in sync by a unit test) and drives it over the Chrome DevTools Protocol.

## Verified automatically on Windows (CI)

| Area | What the suite checks |
|---|---|
| Open | `test.md` opens from argv and renders through the Rust command; a missing file shows the welcome page; a non-text file reports "not valid UTF-8" in an alert and the current document stays |
| Text formats | CRLF, UTF-8 BOM + CRLF and UTF-16 LE are reported in the status bar; saving each keeps the BOM and CRLF on disk, with only the edit added |
| Rendering | raw HTML stays literal text (no `<b>`, no script, no double escaping); pagebreak `<hr>`; KaTeX; GFM flavor badges (`pagebreaks` allowed; `math`, `wikilinks`, `heading-attrs`, `definitions`, `frontmatter` flagged) |
| Images | relative and absolute local images are inlined and decode; `../` escapes and web images are left alone |
| Window | native title `name.md — TCB, M.D.`, with a leading `•` when dirty; `Ctrl+E` and dirty tracking |
| Zoom | `Ctrl+=` changes the WebView2 zoom; the level is stored and restored after a relaunch; `Ctrl+0` resets |
| Second instance | `tcb.exe rel.md` started from another folder hands off and the running window opens that file |
| Links | `#heading` scrolls; `sub/b.md#details` opens and scrolls; a missing `.md` reports an error; image and `file:` links do nothing; `openUrl` is permitted by `opener:default` |
| History | a file in a git subfolder shows its commit count; restore with "Backup current first" adds one listed snapshot; three rapid saves outside git keep three snapshots (the 200-snapshot cap is a unit test, also run on Windows) |
| Installer | the shipped NSIS setup installs silently (`/S`); `.md` is registered with an open command that runs the installed `tcb.exe`; opening a `.md` file through the shell starts it on that file |

## Still manual (native UI the WebView cannot drive)

- [ ] `Ctrl+O` and the 📂 button open the native file picker (filtered to `.md`, `.markdown`).
- [ ] New document → `Ctrl+S` prompts Save As; `Ctrl+Shift+S` prompts with the current path
      pre-filled; cancelling either leaves the document dirty.
- [ ] With unsaved edits, the window **X** asks for confirmation; **No** keeps the window open,
      **Yes** closes it. Without edits it closes immediately.
- [ ] Dragging a `.md` file from Explorer onto the window opens it (with the unsaved-edits
      prompt first when dirty).
- [ ] Clicking a web link in the preview opens the default browser, and a `mailto:` link the
      default mail client; middle-click and `Ctrl`+click do nothing.
- [ ] `Ctrl+P` opens the native print dialog; `Ctrl+Shift+P` opens Print View.
- [ ] `Ctrl`+mouse-wheel and a touchpad pinch zoom one step per gesture, with no extra
      WebView2 zoom step.
- [ ] The `.msi` installs and uninstalls cleanly (the NSIS installer is checked in CI), and an
      interactive (non-silent) NSIS install shows the expected pages.

## Auto-update (`tauri-plugin-updater`, `release.yml`)

v0.2.2 is the first release built with updater signatures; v0.2.3 adds the GitHub release
manifest as a second endpoint. Both releases' installer signatures were verified against
`plugins.updater.pubkey` in `tauri.conf.json`.

- [ ] `illumignoti.gnomatix.com` has **no DNS record** (checked 2026-11-13 via dns.google:
      NOERROR, empty answer), so 0.2.0–0.2.2, which list only that endpoint, cannot find any
      update. Create the record and serve (or redirect to) the latest GitHub `latest.json`
      there, or update those installs by hand.
- [ ] Install v0.2.3, publish any later release, and confirm the update is offered through the
      GitHub fallback endpoint, downloads, and installs in passive mode.

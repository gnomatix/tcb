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
| Zoom | `Ctrl+=` changes the WebView2 zoom in the order pressed; the level is stored and restored after a relaunch; `Ctrl+0` resets; `Ctrl`+wheel deltas zoom one step per 50 units with no extra WebView2 zoom on top |
| Second instance | `tcb.exe rel.md` started from another folder hands off and the running window opens that file |
| Links | `#heading` scrolls; `sub/b.md#details` opens and scrolls; a missing `.md` reports an error; image and `file:` links do nothing; clicking a web link starts the default browser with that URL; a real middle-click or `Ctrl`+click on it starts nothing, opens no second WebView2 window and does not navigate; a `mailto:` link is handed to the Windows shell (on the runner, which has no default mail app, the shell raises its app picker, as `Start-Process mailto:` does) |
| History | a file in a git subfolder shows its commit count; restore with "Backup current first" adds one listed snapshot; three rapid saves outside git keep three snapshots (the 200-snapshot cap is a unit test, also run on Windows) |
| Dialogs | closing a window with unsaved edits (WM_CLOSE, as the X button sends) raises "Unsaved changes"; **No** keeps the window and the edits, **Yes** closes it; a clean window closes without a prompt; picking a file in the `Ctrl+O` Open dialog opens it; entering a new path in the `Ctrl+Shift+S` Save As dialog writes the file there with its CRLF kept; that dialog offers the current file name, and Cancel leaves the document dirty and the file unchanged; on a new document `Ctrl+S` offers `untitled.md`, Cancel keeps it dirty, and a typed path saves it; `Ctrl+P` raises Print; `Ctrl+Shift+P` Print View paginates with paged.js (one page per `<!-- pagebreak -->`) and its close button leaves it |
| Installer | the shipped NSIS setup installs silently (`/S`); `.md` is registered with an open command that runs the installed `tcb.exe`; opening a `.md` file through the shell starts it on that file; its `uninstall.exe /S` removes `tcb.exe`. The `.msi` installs silently (`/qn`) to the `INSTALLDIR` its log reports and `msiexec /x` removes it |

## Still manual (choices inside native dialogs, and real input)

GitHub's Windows runner gives native dialogs no focus or keyboard input; CI answers them with
window messages (`tests/windows/win32.ps1`): the file name is typed with `WM_CHAR` (the Save
dialog ignores `WM_SETTEXT`), and prompts are answered with `TDM_CLICK_BUTTON` or `WM_COMMAND`.

- [ ] Dragging a `.md` file from Explorer onto the window opens it (with the unsaved-edits
      prompt first when dirty).
- [ ] With a default mail app chosen, a `mailto:` link opens it with the address (CI checks the
      hand-off to the shell only).
- [ ] Printing from the print dialog produces the expected pages on paper or PDF.
- [ ] A touchpad pinch zooms one step per gesture (CI checks synthetic `Ctrl`+wheel deltas).
- [ ] An interactive (non-silent) NSIS or MSI install shows the expected pages, and the MSI
      default install folder on a machine that never had the NSIS build (CI reported
      `%LOCALAPPDATA%\tcb\` after the NSIS build had been installed and removed).

## Auto-update (`tauri-plugin-updater`, `release.yml`)

v0.2.2 is the first release built with updater signatures; v0.2.3 adds the GitHub release
manifest as a second endpoint. The signatures of every release since were verified against
`plugins.updater.pubkey` in `tauri.conf.json` (v0.2.5: both installers, and the fallback
endpoint serves its `latest.json`).

Until 0.2.5 nothing in the app called the updater, so **0.2.0–0.2.4 never look for updates**:
each of those installs has to get 0.2.5 by hand once. From 0.2.5 on, the app checks 5 s after
start-up (the prompt and its conditions are covered by `tests/ui/tauri-host.test.js`).

- [ ] `illumignoti.gnomatix.com` has a TXT record (`peer-auth=…`) but no A, AAAA, CNAME or
      HTTPS record (re-checked 2026-11-16 via dns.google), so that endpoint cannot connect and
      the updater moves on to the GitHub manifest.
- [ ] With 0.2.5 installed, publish a later release and confirm the "Update available" prompt
      appears after start-up, and that accepting it downloads and installs in passive mode.
- [ ] With 0.2.5 installed, opening and saving files shows no console window flash (git now
      runs with `CREATE_NO_WINDOW`).

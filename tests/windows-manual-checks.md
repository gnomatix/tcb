# Windows manual verification checklist

Automated coverage stops at the Tauri IPC boundary: `cargo test --lib` exercises the
Rust logic (also on `windows-latest` via `.github/workflows/ci.yml`) and `tests/ui/`
drives the front end in headless Chromium with a mock host. Everything below needs a
real `tcb.exe` on Windows 11 (`mise run dev` or `mise run build`). Tick items off per
release; each maps to a specific change so a failure points at its cause.

## Open / save round-trip (`textfile.rs`, `save_file`, `app.js` state.format)

- [ ] Open a file saved by Notepad with **CRLF** line endings; status bar reads `CRLF · UTF-8`.
      Edit one line, `Ctrl+S`, then `git diff` / `fc /b` the file: only that line changed, no
      line-ending churn.
- [ ] Open a **UTF-8 with BOM** file; status bar reads `CRLF · UTF-8 BOM` (or `LF …`). Save; the
      first three bytes are still `EF BB BF` and the preview does not show a stray `ï»¿`.
- [ ] Open a **UTF-16 LE** file (Notepad → Save As → Encoding "UTF-16 LE"). It opens, status bar
      shows `UTF-16 LE`; save it and reopen in Notepad — still UTF-16 LE, text intact.
- [ ] Open a non-text file renamed to `.md` (e.g. a PNG). A dialog says it could not be opened and
      why; the previous document stays loaded.
- [ ] Launch `tcb.exe missing-file.md` from a shell: no crash, window shows the welcome page.
- [ ] New document → `Ctrl+S` prompts Save As; `Ctrl+Shift+S` on an existing file prompts with
      the current path pre-filled; cancelling either leaves the document dirty.

## Shortcuts and window behaviour (`app.js`, `tauri.conf.json`, `capabilities/default.json`)

- [ ] `Ctrl+E` toggles edit/view; `Ctrl+O` opens the native file picker (filtered to `.md`,
      `.markdown`); the 📂 toolbar button does the same.
- [ ] Native title bar reads `name.md — TCB, M.D.` and gains a leading `•` when dirty.
- [ ] With unsaved edits, click the window **X**: a confirmation appears; **No** keeps the window
      open and editable; **Yes** closes it. With no edits the window closes immediately.
      (Requires `core:window:allow-destroy`; if the X does nothing, that permission is the suspect.)
- [ ] Drag a `.md` file from Explorer onto the window: it opens; with unsaved edits a confirmation
      appears first.
- [ ] With the app running, launch `tcb.exe other.md` from a **different** folder using a
      **relative** path (`cd C:\docs && "C:\Program Files\…\tcb.exe" notes.md`): the existing
      window is focused and `C:\docs\notes.md` opens.
- [ ] Zoom: `Ctrl+=` / `Ctrl+-` / `Ctrl+0` and `Ctrl`+mouse-wheel change the zoom and the title
      flashes the percentage; the WebView's own zoom must **not** also fire (no double step).
      Quit and relaunch: the zoom level is restored.
- [ ] `Ctrl+P` still opens the native print dialog; `Ctrl+Shift+P` still opens Print View.

## Links in the preview (`app.js` classifyLink, `tauri-plugin-opener`, `opener:default`)

- [ ] Open a document containing `[web](https://example.com)` and `[mail](mailto:x@example.com)`.
      Clicking the web link opens `example.com` in the **default browser**; the app window
      is unchanged (still shows the document, not the web page). The mail link opens the
      default mail client. Middle-click and `Ctrl`+click on the web link do nothing.
      (If nothing opens, suspect `opener:default` in `capabilities/default.json`.)
- [ ] In `C:\docs\a.md` add `[b](sub/b.md#details)` where `C:\docs\sub\b.md` has a
      `## Details` heading far down. Click it: `b.md` opens in the app (title bar updates)
      and the view is scrolled to **Details**. With unsaved edits in `a.md` the
      unsaved-changes confirmation appears first; **No** keeps `a.md`.
- [ ] Click `[missing](nope.md)`: a "Could not open file" dialog appears and the current
      document stays loaded. Click `[img](pic.png)` and `[f](file:///C:/x.md)`: nothing happens.
- [ ] Click a `[toc](#some-heading)` link in a long document: the preview scrolls to that
      heading; the address does not change and the document stays loaded.

## History (`lib.rs` git helpers, snapshots)

- [ ] Open a file **in a subdirectory** of a git repo (e.g. `docs\guide.md`): status bar shows
      `git: <branch> · clean · N commits` with N > 0, and `Ctrl+H` lists those commits.
      (Pre-fix behaviour was `0 commits` / empty list for anything below the repo root.)
- [ ] In that git file, select a past version, tick **Backup current first**, Restore. Reopen
      `Ctrl+H`: a `snapshot` entry now appears in the list alongside the commits and the status
      bar shows `… · 1 snapshot`. Selecting it shows a diff; restoring it works.
- [ ] Open a file **outside** any git repo, save three times quickly (`Ctrl+S` ×3 within one
      second with an edit between): `Ctrl+H` lists three distinct snapshots, none overwritten.
- [ ] Snapshot directory (`%APPDATA%\com.gnomatix.tcb\snapshots\<hash>\`) never exceeds
      200 files for one document after many saves (oldest are pruned).

## Rendering (`markdown.rs`)

- [ ] Open `test.md` from the repo root: the "Raw HTML" section shows the literal text
      `<b>not bold</b>` (not `&lt;b&gt;`), nothing is bold, and no script runs.
- [ ] Feature badges for `test.md` with flavor **GitHub (GFM)**: `pagebreaks` is **not** flagged
      red; `math`, `wikilinks`, `heading-attrs`, `definitions`, `frontmatter` are.

## Packaging (unchanged by this branch, but re-verify after capability changes)

- [ ] `mise run build` succeeds; the NSIS installer and `.msi` are produced; double-clicking a
      `.md` file in Explorer opens it in TCB, M.D.

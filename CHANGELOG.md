# Changelog

All notable changes to TCB, M.D. Versions follow semver; the Windows installer and
`tcb.exe` for each tag are attached to the GitHub Release produced by `release.yml`.

## 0.2.0 — 2026-11-05

### Fixed
- Saving a file with Windows (CRLF) line endings no longer rewrites every line to LF.
  Line endings, a UTF-8 BOM and UTF-16 (LE/BE, with BOM) are detected on open, shown
  in the status bar, and written back unchanged.
- Opening a file that is not readable text now reports why instead of silently
  showing the welcome page.
- Version history was empty ("0 commits") for any file below the root of its git
  repository; git is now run from the repository toplevel.
- Raw HTML in a document was double-escaped, so the preview showed `&lt;b&gt;` instead
  of the literal `<b>`. Raw HTML is still never rendered or executed.
- "Backup current first" wrote snapshots that were never listed for git-tracked files;
  snapshots now appear in the version bar alongside commits and can be restored.
- Two saves inside the same second no longer overwrite the same snapshot.
- A second `tcb.exe` instance started with a relative path from another folder opened
  the wrong location; the path is now resolved against that instance's directory.
- The `pagebreaks` badge (an HTML comment) was flagged as unsupported by every flavor.
- Feature badges (and the Save-time flavor warning) were raised by syntax that only
  appeared inside fenced code blocks or inline code, e.g. `$PATH` in a shell sample
  reported `math`, `[[ ... ]]` reported `wikilinks`, a YAML `---` or `| a |` line
  reported `tables`. Detection now ignores code, and a `<!-- pagebreak -->` marker
  inside code stays literal text instead of becoming a page break.
- The unsaved-changes dot was drawn even when hidden.
- Clicking a link in the preview navigated the app's own WebView: an `https://` link
  replaced the UI with the web page and a relative `other.md` link showed a 404. Links are
  now routed: `http`/`https`/`mailto` open in the default browser or mail client, relative
  `.md`/`.markdown` links open that file in the app (with the usual unsaved-edits prompt),
  `#heading` links scroll to the heading (headings get GitHub-style ids), and anything
  else is ignored.
- Images referenced by a relative path (`![](images/fig.png)`, `![](./a.jpg)`) never
  displayed, because the WebView's origin is the app rather than the document's folder.
  Local images (relative to the document, or absolute) are now inlined as `data:` URIs at
  render time: png, jpg, gif, webp, svg, bmp, ico and avif up to 8 MiB each. Paths that
  escape the document's folder via `..` are refused; `http(s):` URLs are left as they are.

### Added
- `Ctrl+E` toggles edit mode (documented before, now bound), `Ctrl+Shift+S` Save As,
  `Ctrl+O` and a toolbar button to open a file, drag-and-drop a file onto the window.
- Confirmation before closing the window or opening another file with unsaved edits.
- Zoom with `Ctrl+=` / `Ctrl+-` / `Ctrl+0` / `Ctrl`+wheel, remembered across launches.
- Native window title follows the document name and dirty state.
- Status bar shows the detected line ending and encoding.
- Feature badges and flavor warnings update while typing (debounced).
- Snapshot history is capped at 200 entries per document.
- Rust unit tests (`cargo test --lib`) and headless-Chromium smoke tests (`tests/ui/`).
- CI on every push: Windows `cargo test` + debug build, an unsigned Windows installer
  artifact, and the UI smoke tests.

### Changed
- `release.yml` builds an unsigned draft release when the updater signing key secret is
  missing instead of failing after the compile; a signed build with `latest.json` is
  produced when the secret is present.
- Native WebView zoom hotkeys are disabled in favour of the app-owned, persisted zoom.

## 0.1.0 — 2026-06-22

Initial MVP: Markdown view/edit, KaTeX math, flavor badges, Print View (paged.js),
pandoc + typst PDF export, git/snapshot history, About dialog, auto-updater wiring.

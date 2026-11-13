# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->


## Build & Test

```bash
# Build (Windows 11 target; see README "Building from source" for toolchain setup)
mise run build                 # = cargo tauri build (installer + tcb.exe)
mise run dev                   # = cargo tauri dev   (debug, live reload)

# Tests
(cd src-tauri && cargo test --lib)        # Rust unit tests: markdown.rs, textfile.rs, lib.rs git/snapshot helpers
node --test "tests/ui/*.test.js"          # Front-end smoke tests (headless Chromium, mock host) — needs playwright
node --test "tests/windows/*.test.mjs"    # Windows only: real tcb.exe on WebView2 over CDP (CI job bundle-windows)
```

On Linux CI/agent hosts the Rust tests need `libwebkit2gtk-4.1-dev` + `libgtk-3-dev` to
link the Tauri crate; the logic under test itself is platform-neutral. Tauri IPC and WebView2
behaviour is covered on Windows by the CI e2e suite, which drives an e2e build of tcb.exe
(`TAURI_CONFIG` from `src-tauri/tauri.e2e.conf.json`, adding only a DevTools port). WebDriver
does not work for this app: wry always sets WebView2's browser arguments, so the
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` variable msedgedriver relies on is ignored. Native
dialogs, file associations, the installer and auto-update still need a person on Windows; say
so explicitly in handoffs rather than implying it was run.

## Architecture Overview

- `src-tauri/src/lib.rs` — Tauri 2 shell: window/plugin setup and the `#[tauri::command]`
  surface (`open_path`, `save_file`, `render_markdown`, versions/snapshots, file meta,
  pandoc+typst export). Git access is via subprocess, always run from the repo toplevel.
- `src-tauri/src/markdown.rs` — pure rendering (pulldown-cmark, all extensions, raw HTML
  demoted to text, `<!-- pagebreak -->` → `<hr class="mdview-pagebreak">`) + feature detection.
- `src-tauri/src/textfile.rs` — pure text-format plumbing: UTF-8/UTF-16 + BOM decoding,
  CRLF/LF detection and round-trip (`TextFormat`), launch-path resolution, version merging.
- `WebAssets/` — static front end (no bundler). `app.js` talks to a *host* abstraction:
  `makeTauriHost()` in the app, `makeMockHost()` when opened in a plain browser (used by
  `tests/ui/`). `index.html` + `app.css` + `print.css`; vendored markdown-it, KaTeX, paged.js.
- `src-tauri/capabilities/default.json` — every Tauri permission the front end relies on.

## Conventions & Patterns

- Keep logic that can be unit-tested out of `lib.rs` command bodies and in a Tauri-free module.
- Editor text is always LF-normalized; the on-disk format lives in `state.format` / `TextFormat`
  and is re-applied by `save_file`. Never write editor text to disk without it.
- The `TODO(you)` markers that shipped in `app.js` have been resolved; document decisions in a
  short comment where the choice was made rather than reopening them.
- Shortcut changes must update three places: the `keydown` map in `app.js`, button `title`
  attributes in `index.html`, and the README "Keyboard shortcuts" table.
- Feature labels emitted by `markdown::detect_features` must stay in sync with
  `FLAVOR_SUPPORT` in `app.js`.

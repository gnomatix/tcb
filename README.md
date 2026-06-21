<p align="center">
  <img src="assets/images/tcb-md-buckle.png" alt="TCB, M.D." width="640">
</p>

# TCB, M.D.

**A fast, native Windows Markdown viewer & editor.** Taking Care of Business.

TCB, M.D. is a lightweight desktop Markdown app for Windows 11, built on **Tauri 2
and Rust** with a native WebView front end — no bundled browser engine. It opens
`.md` files instantly, renders them cleanly, lets you edit and save in place, and
can typeset a polished PDF.

---

## Features

<p align="center">
  <img src="assets/images/tcb-md-hero-panel.png" alt="TCB, M.D. — Markdown, handled." width="720">
</p>

- **Open & preview Markdown** — clean CommonMark rendering, instant on launch.
- **Edit in place** — toggle edit mode (`Ctrl+E`), save with `Ctrl+S`.
- **Math** — inline and display math via KaTeX.
- **Flavor-aware** — pick a target Markdown flavor; Save warns if your document
  uses features the chosen flavor doesn't support.
- **Print View** (`Ctrl+Shift+P`) — paginated preview with optional serif
  typography (Crimson Pro, justified text, drop caps); print with `Ctrl+P`.
- **Typeset PDF export** — high-quality PDF via `pandoc` + `typst` (when both are
  on your `PATH`).

## Why it's fast

Native by design — there's no Electron/Chromium payload; the UI runs in the
system WebView and the core is Rust. The release build is tuned for quick cold
start: size-optimized (`opt-level = "s"`), link-time optimization, a single
codegen unit, and a stripped binary.

> Benchmarked startup/footprint numbers will be published here once measured on a
> release build — this README won't quote figures that haven't been measured.

## Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Toggle edit mode | `Ctrl+E` |
| Save | `Ctrl+S` |
| Print View | `Ctrl+Shift+P` |
| Print | `Ctrl+P` |

## Status

Early MVP. Windows 11 desktop (Tauri 2). The focus right now is a rock-solid
Markdown view/edit experience.

## Running

**Zero setup on Windows 11.** TCB, M.D. is a single native executable. It uses the
**WebView2** runtime that already ships with Windows 11 — no bundled browser
engine, no installer, nothing to configure. Get the `.exe` and run it.

(The optional **Typeset PDF export** feature shells out to `pandoc` and `typst`
when they're on your `PATH`; everything else works with nothing installed.)

## Building from source

Only needed if you're working on TCB itself — end users don't build anything.

### First-time Windows setup

A nicer terminal (optional but recommended):

```powershell
winget install Microsoft.WindowsTerminal
```

A package manager makes installing dev tools painless. `winget` is built into
Windows 11; you may also want one of:

```powershell
# Chocolatey
winget install Chocolatey.Chocolatey
# Scoop (per-user, no admin)
Invoke-RestMethod -Uri https://get.scoop.sh | Invoke-Expression
```

[UniGetUI](https://github.com/devolutions/unigetui) is a friendly GUI that drives
winget / Scoop / Chocolatey from one window if you prefer not to use the CLI.

Install the **Rust toolchain** (provides `cargo`). On Windows, `rustup` will guide
you through installing the MSVC C++ build tools if they're missing:

```powershell
winget install Rustlang.Rustup
```

**Recommended:** [`mise`](https://mise.jdx.dev/) to manage toolchains/versions —
installable straight from cargo (or via winget):

```powershell
cargo install mise          # recommended
# or:
winget install jdx.mise
```

### Build

```sh
# from src-tauri/
cargo build --release        # produces the native tcb.exe
# or, with the Tauri CLI, for development:
cargo tauri dev
```

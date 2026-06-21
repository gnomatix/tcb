---
title: Test Document
author: Brett
date: 2026-05-24
---

# Test Document

This file exercises many markdown-flavor features so the badges have something to detect.

## GitHub Alerts (GFM)

> [!NOTE]
> This is a GitHub-style note callout.

> [!WARNING]
> And a warning. These render only when `ENABLE_GFM` is on.

## Tables (GFM)

| Tool        | Version  | Verified |
|-------------|----------|----------|
| tauri       | 2.11.2   | yes      |
| pulldown    | 0.12.2   | yes      |
| markdown-it | 14.2.0   | yes      |

## Task lists (GFM)

- [x] Render markdown
- [x] Detect features
- [ ] Lossy conversion (deliberately skipped — see chat)
- [ ] Persist zoom across launches

## Strikethrough (GFM)

This was ~~previously a WinUI 3 plan~~ now a Tauri app.

## Footnotes

The pivot reflex is the failure mode `did-you-rtfm` exists to interrupt[^1].

[^1]: See the user's verbatim words in CLAUDE.md.

<!-- pagebreak -->

## Math (Pandoc / GitHub)

Inline: $E = mc^2$.

Display:

$$
\int_{-\infty}^{\infty} e^{-x^2}\, dx = \sqrt{\pi}
$$

## Heading attributes {#custom-id .extra-class}

Pandoc / MultiMarkdown convention.

## Definition list

Tauri
: A toolkit for building lightweight, secure cross-platform desktop apps using a Rust backend and a system webview.

pulldown-cmark
: A pull-parser for CommonMark written in Rust.

## Wikilinks (Obsidian)

See [[Some Other Note]] and [[README]] for context.

## Raw HTML (should be escaped, not rendered)

<script>alert('XSS would be very bad')</script>

<style>body { display: none }</style>

Plain inline tags should also appear as literal text: <b>not bold</b>.

## Code block

```rust
fn render(text: &str) -> String {
    let parser = pulldown_cmark::Parser::new_ext(text, Options::all());
    let mut html = String::new();
    pulldown_cmark::html::push_html(&mut html, parser);
    html
}
```

## Quote

> The pivot reflex is the failure mode this skill exists to interrupt.

## A link

[Tauri docs](https://v2.tauri.app/)

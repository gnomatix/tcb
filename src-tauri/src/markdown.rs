//! Markdown rendering and feature detection (pulldown-cmark). No Tauri dependency,
//! so the whole pipeline is unit-testable; `lib.rs` exposes it as a command.

use serde::Serialize;

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    pub html: String,
    /// Feature labels detected in the source, e.g. "frontmatter", "tables", "math".
    /// Used by the UI to badge what's present in the document.
    pub features: Vec<String>,
}

/// Render markdown to HTML and detect notable features in one pass.
///
/// Enables the full pulldown-cmark extension set so any flavor's content renders.
/// Raw HTML in the source is escaped (not passed through) to keep XSS off the table
/// when opening untrusted `.md` files.
///
/// Explicit `<!-- pagebreak -->` markers in the source are turned into
/// `<hr class="mdview-pagebreak" />` so CSS / paged.js / native print can act on them.
pub fn render(text: &str) -> Rendered {
    use pulldown_cmark::{html, Event, Options, Parser};

    // Pre-process: rewrite `<!-- pagebreak -->` (with flexible inner whitespace) into a
    // unique paragraph token that survives parsing without being escaped as raw HTML.
    let pre = rewrite_pagebreak_markers(text);

    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_FOOTNOTES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);
    opts.insert(Options::ENABLE_SMART_PUNCTUATION);
    opts.insert(Options::ENABLE_HEADING_ATTRIBUTES);
    opts.insert(Options::ENABLE_YAML_STYLE_METADATA_BLOCKS);
    opts.insert(Options::ENABLE_PLUSES_DELIMITED_METADATA_BLOCKS);
    opts.insert(Options::ENABLE_MATH);
    opts.insert(Options::ENABLE_DEFINITION_LIST);
    opts.insert(Options::ENABLE_GFM);
    // Intentionally NOT enabling ENABLE_OLD_FOOTNOTES — it changes footnote syntax
    // away from the GitHub-style one which is the modern convention.

    let parser = Parser::new_ext(&pre, opts).map(|event| match event {
        // Defang raw HTML in the input by demoting it to text. The user sees the
        // literal tag text instead of having it rendered (and possibly executed).
        // `push_html` escapes Text events itself — escaping here as well produced
        // visible `&lt;b&gt;` entities in the preview (double escaping).
        Event::Html(html) => Event::Text(html),
        Event::InlineHtml(html) => Event::Text(html),
        other => other,
    });

    let mut out = String::with_capacity(pre.len() * 3 / 2);
    html::push_html(&mut out, parser);

    // Post-process: replace the pagebreak placeholder paragraphs with real <hr> elements.
    let final_html = out
        .replace(
            &format!("<p>{}</p>\n", PAGEBREAK_PLACEHOLDER),
            "<hr class=\"mdview-pagebreak\" />\n",
        )
        .replace(
            &format!("<p>{}</p>", PAGEBREAK_PLACEHOLDER),
            "<hr class=\"mdview-pagebreak\" />",
        );

    Rendered {
        html: final_html,
        features: detect_features(text),
    }
}

const PAGEBREAK_PLACEHOLDER: &str = "MDVIEW_PAGEBREAK_7f29a5b3";

pub fn rewrite_pagebreak_markers(text: &str) -> String {
    // Match `<!--` + optional whitespace + `pagebreak` + optional whitespace + `-->`.
    // Uses string slicing on str (UTF-8 safe) instead of byte indexing.
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(idx) = rest.find("<!--") {
        out.push_str(&rest[..idx]);
        let after = &rest[idx + 4..];
        let trimmed = after.trim_start();
        if let Some(tail) = trimmed.strip_prefix("pagebreak") {
            if let Some(tail2) = tail.trim_start().strip_prefix("-->") {
                out.push_str("\n\n");
                out.push_str(PAGEBREAK_PLACEHOLDER);
                out.push_str("\n\n");
                rest = tail2;
                continue;
            }
        }
        out.push_str("<!--");
        rest = after;
    }
    out.push_str(rest);
    out
}

pub fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&'  => out.push_str("&amp;"),
            '<'  => out.push_str("&lt;"),
            '>'  => out.push_str("&gt;"),
            '"'  => out.push_str("&quot;"),
            '\'' => out.push_str("&#x27;"),
            other => out.push(other),
        }
    }
    out
}

/// Scan the source for feature signatures. Cheap string-based heuristics — not a parser.
/// Returns the labels in a stable order so the UI badge row doesn't shuffle on re-render.
pub fn detect_features(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut push = |label: &str| {
        if !found.iter().any(|s: &String| s == label) {
            found.push(label.to_string());
        }
    };

    // YAML frontmatter at the very top: starts with `---\n` and has a closing `---` or `...`.
    if text.starts_with("---\n") || text.starts_with("---\r\n") {
        let body = &text[3..];
        if body.contains("\n---\n") || body.contains("\n---\r\n") || body.contains("\n...\n")
            || body.ends_with("\n---") || body.ends_with("\n...")
        {
            push("frontmatter");
        }
    }

    // GitHub alerts: `> [!NOTE]` style callouts.
    if text.contains("> [!NOTE]")
        || text.contains("> [!TIP]")
        || text.contains("> [!WARNING]")
        || text.contains("> [!IMPORTANT]")
        || text.contains("> [!CAUTION]")
    {
        push("github-alerts");
    }

    // Task lists.
    for line in text.lines() {
        let l = line.trim_start();
        if l.starts_with("- [ ]") || l.starts_with("- [x]") || l.starts_with("- [X]")
            || l.starts_with("* [ ]") || l.starts_with("* [x]") || l.starts_with("* [X]")
        {
            push("tasklists");
            break;
        }
    }

    // Tables: a line with a pipe AND a separator line with dashes and pipes.
    let mut prev_has_pipe = false;
    for line in text.lines() {
        let has_pipe = line.contains('|');
        let trimmed = line.trim();
        let is_sep = !trimmed.is_empty()
            && trimmed.chars().all(|c| matches!(c, '|' | '-' | ':' | ' '))
            && trimmed.contains('-') && trimmed.contains('|');
        if prev_has_pipe && is_sep {
            push("tables");
            break;
        }
        prev_has_pipe = has_pipe;
    }

    // Strikethrough.
    if text.matches("~~").count() >= 2 {
        push("strikethrough");
    }

    // Footnotes: `[^id]:` definition somewhere.
    if text.lines().any(|l| {
        let t = l.trim_start();
        t.starts_with("[^") && t.contains("]:")
    }) {
        push("footnotes");
    }

    // Math: $$...$$ (display) or $...$ (inline). Naive check — false positives possible.
    if text.contains("$$") {
        push("math");
    } else if has_inline_math(text) {
        push("math");
    }

    // Wikilinks `[[...]]`.
    if text.contains("[[") && text.contains("]]") {
        push("wikilinks");
    }

    // Heading attributes `# Heading {#id .class}`.
    if text.lines().any(|l| {
        let t = l.trim_start();
        (t.starts_with('#')) && t.contains("{#")
    }) {
        push("heading-attrs");
    }

    // Pandoc fenced divs `:::`.
    if text.lines().any(|l| l.trim_start().starts_with(":::")) {
        push("fenced-divs");
    }

    // Definition lists: term line followed by `: ` continuation.
    let lines: Vec<&str> = text.lines().collect();
    for i in 1..lines.len() {
        if lines[i].trim_start().starts_with(": ") && !lines[i - 1].trim().is_empty() {
            push("definitions");
            break;
        }
    }

    // Pandoc citations: `[@key]` or standalone `@key` patterns.
    if text.contains("[@") {
        push("citations");
    }

    // Explicit page-break marker.
    if text.contains("<!--") && text.contains("pagebreak") && text.contains("-->") {
        push("pagebreaks");
    }

    found
}

/// Conservative inline-math detector: looks for a `$` followed by non-space then `$`
/// on the same line. Avoids false positives on currency like "$5".
pub fn has_inline_math(text: &str) -> bool {
    for line in text.lines() {
        let bytes = line.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'$' && i + 1 < bytes.len() && bytes[i + 1] != b' ' && bytes[i + 1] != b'$' {
                if let Some(close) = line[i + 1..].find('$') {
                    let inside = &line[i + 1..i + 1 + close];
                    if !inside.is_empty() && !inside.starts_with(' ') && !inside.ends_with(' ') {
                        return true;
                    }
                    i = i + 1 + close + 1;
                    continue;
                }
            }
            i += 1;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_html_is_escaped_not_rendered() {
        let r = render("hello <script>alert(1)</script> <b>x</b>");
        assert!(!r.html.contains("<script>"), "{}", r.html);
        assert!(r.html.contains("&lt;script&gt;"), "{}", r.html);
        assert!(!r.html.contains("<b>"), "{}", r.html);
        // Escaped exactly once: the browser must display `<b>`, not `&lt;b&gt;`.
        assert!(!r.html.contains("&amp;lt;"), "double-escaped: {}", r.html);
    }

    #[test]
    fn block_html_is_escaped() {
        let r = render("<style>body{display:none}</style>\n\ntext");
        assert!(!r.html.contains("<style>"), "{}", r.html);
        assert!(r.html.contains("&lt;style&gt;"), "{}", r.html);
    }

    #[test]
    fn pagebreak_marker_becomes_hr() {
        for src in ["a\n\n<!-- pagebreak -->\n\nb", "a\n\n<!--pagebreak-->\n\nb", "a\n\n<!--   pagebreak   -->\n\nb"] {
            let r = render(src);
            assert!(r.html.contains("<hr class=\"mdview-pagebreak\" />"), "{src:?} → {}", r.html);
            assert!(!r.html.contains(PAGEBREAK_PLACEHOLDER), "{}", r.html);
            assert!(r.features.contains(&"pagebreaks".to_string()));
        }
    }

    #[test]
    fn other_comments_are_left_alone_and_escaped() {
        let r = render("x <!-- note --> y");
        assert!(r.html.contains("&lt;!-- note --&gt;"), "{}", r.html);
        assert!(!r.html.contains("mdview-pagebreak"));
        assert!(!r.features.contains(&"pagebreaks".to_string()));
    }

    #[test]
    fn rewrite_is_utf8_safe() {
        let s = "héllo <!-- pagebreak --> wörld ✓ <!-- keep -->";
        let out = rewrite_pagebreak_markers(s);
        assert!(out.contains(PAGEBREAK_PLACEHOLDER));
        assert!(out.contains("<!-- keep -->"));
        assert!(out.starts_with("héllo "));
    }

    #[test]
    fn escape_html_covers_all_specials() {
        assert_eq!(escape_html("<a href=\"x\">&'</a>"), "&lt;a href=&quot;x&quot;&gt;&amp;&#x27;&lt;/a&gt;");
    }

    #[test]
    fn gfm_table_and_tasklist_render() {
        let r = render("| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n");
        assert!(r.html.contains("<table>"), "{}", r.html);
        assert!(r.html.contains("type=\"checkbox\""), "{}", r.html);
        assert_eq!(r.features, vec!["tasklists", "tables"]);
    }

    #[test]
    fn math_spans_are_emitted_for_katex() {
        let r = render("Inline $E=mc^2$ and\n\n$$\n\\int x\n$$\n");
        assert!(r.html.contains("class=\"math math-inline\""), "{}", r.html);
        assert!(r.html.contains("class=\"math math-display\""), "{}", r.html);
        assert!(r.features.contains(&"math".to_string()));
    }

    #[test]
    fn inline_math_ignores_currency() {
        assert!(!has_inline_math("costs $5 and $10 each"));
        assert!(!has_inline_math("$ 5 and 10 $"));
        assert!(has_inline_math("let $x$ be"));
    }

    #[test]
    fn frontmatter_detection() {
        assert_eq!(detect_features("---\ntitle: a\n---\n# h\n"), vec!["frontmatter"]);
        assert_eq!(detect_features("---\r\ntitle: a\r\n---\r\n# h\r\n"), vec!["frontmatter"]);
        // Closing fence at EOF without trailing newline still counts.
        assert_eq!(detect_features("---\ntitle: a\n---"), vec!["frontmatter"]);
        // A thematic break mid-document is not frontmatter.
        assert!(detect_features("# h\n\n---\n\ntext\n").is_empty());
    }

    #[test]
    fn feature_order_is_stable() {
        let src = "---\nt: 1\n---\n> [!NOTE]\n> n\n\n| a |\n|---|\n\n~~x~~ ~~y~~\n\n[^1]: f\n\n$$x$$\n\n[[w]]\n\n# H {#id}\n\n:::\n\nTerm\n: def\n\n[@cite]\n\n<!-- pagebreak -->\n";
        let f = detect_features(src);
        assert_eq!(
            f,
            vec![
                "frontmatter", "github-alerts", "tables", "strikethrough", "footnotes", "math",
                "wikilinks", "heading-attrs", "fenced-divs", "definitions", "citations", "pagebreaks",
            ]
        );
        // Deterministic across calls.
        assert_eq!(f, detect_features(src));
    }

    #[test]
    fn empty_input_renders_empty() {
        let r = render("");
        assert_eq!(r.html, "");
        assert!(r.features.is_empty());
    }
}

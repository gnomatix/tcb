//! Markdown rendering and feature detection (pulldown-cmark). No Tauri dependency,
//! so the whole pipeline is unit-testable; `lib.rs` exposes it as a command.

use std::path::{Component, Path, PathBuf};

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
/// Markers inside fenced code blocks or inline code spans are left as literal text.
///
/// `base_dir` is the folder of the document being rendered. Images whose destination
/// is a relative path (`![](images/fig.png)`) are resolved against it and inlined as
/// `data:` URIs, because the WebView's origin is the app, not the document's folder,
/// so a plain relative `src` can never load. See [`inline_local_image`] for the rules.
pub fn render(text: &str, base_dir: Option<&Path>) -> Rendered {
    use pulldown_cmark::{html, Event, Options, Parser, Tag};

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
        // Local images: swap a relative (or absolute local) path for a data: URI so the
        // WebView can actually display it. Anything that can't be inlined is left as is.
        Event::Start(Tag::Image { link_type, dest_url, title, id }) => {
            let dest_url = match inline_local_image(&dest_url, base_dir) {
                Some(data_uri) => data_uri.into(),
                None => dest_url,
            };
            Event::Start(Tag::Image { link_type, dest_url, title, id })
        }
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
    // Match `<!--` + optional whitespace + `pagebreak` + optional whitespace + `-->`,
    // skipping any occurrence that overlaps a fenced code block or inline code span
    // (there the marker is literal text and must stay in the code). Byte offsets below
    // always sit on ASCII characters (`<`, `>`, `` ` ``, newlines), so slicing is UTF-8 safe.
    let code = code_spans(text);
    let mut out = String::with_capacity(text.len());
    let mut pos = 0;
    while let Some(rel) = text[pos..].find("<!--") {
        let idx = pos + rel;
        out.push_str(&text[pos..idx]);
        let after = &text[idx + 4..];
        let trimmed = after.trim_start();
        if let Some(tail) = trimmed.strip_prefix("pagebreak") {
            if let Some(tail2) = tail.trim_start().strip_prefix("-->") {
                let end = text.len() - tail2.len();
                if !overlaps_code(&code, idx, end) {
                    out.push_str("\n\n");
                    out.push_str(PAGEBREAK_PLACEHOLDER);
                    out.push_str("\n\n");
                    pos = end;
                    continue;
                }
            }
        }
        out.push_str("<!--");
        pos = idx + 4;
    }
    out.push_str(&text[pos..]);
    out
}

/// Kind of code region found by [`code_spans`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CodeKind {
    /// A fenced code block, fence lines included (```` ``` ```` or `~~~`).
    Fenced,
    /// An inline code span, backticks included.
    Inline,
}

/// A byte range of `text` that is code. Boundaries always fall on ASCII bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CodeSpan {
    start: usize,
    end: usize,
    kind: CodeKind,
}

fn overlaps_code(spans: &[CodeSpan], start: usize, end: usize) -> bool {
    spans.iter().any(|s| s.start < end && start < s.end)
}

/// Return the source with code removed so string heuristics don't trip over it:
/// fenced code blocks (fence lines included) become empty lines and inline code spans
/// become runs of spaces. Line breaks are kept exactly, so line-based scans over the
/// result see the same line numbers as the original.
pub fn strip_code(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for span in code_spans(text) {
        out.push_str(&text[last..span.start]);
        for ch in text[span.start..span.end].chars() {
            match ch {
                '\n' | '\r' => out.push(ch),
                _ if span.kind == CodeKind::Inline => out.push(' '),
                _ => {}
            }
        }
        last = span.end;
    }
    out.push_str(&text[last..]);
    out
}

/// Locate fenced code blocks and inline code spans, CommonMark style, returned in
/// document order without overlaps.
///
/// Fences: 0–3 spaces of indent, a run of 3+ backticks or tildes, an info string (no
/// backtick allowed in a backtick fence's info string); closed by a fence of the same
/// character at least as long, with nothing but whitespace after it. An unterminated
/// fence runs to the end of the document. Fences inside block quotes or deeper list
/// indentation are not recognised.
///
/// Inline spans: a backtick run opens a span closed by the next run of exactly the same
/// length; runs of other lengths in between are part of the span. A run with no closer
/// is literal text. A span cannot cross a blank line (paragraph boundary) or a fence.
fn code_spans(text: &str) -> Vec<CodeSpan> {
    let mut spans = Vec::new();
    let mut pos = 0usize;
    // (fence char, fence length, byte offset of the opening fence line)
    let mut open_fence: Option<(u8, usize, usize)> = None;
    // Start of the current run of non-fenced text, scanned for inline spans.
    let mut segment_start = 0usize;

    for line in text.split_inclusive('\n') {
        let line_start = pos;
        pos += line.len();
        let content = line.strip_suffix('\n').unwrap_or(line);
        let content = content.strip_suffix('\r').unwrap_or(content);

        if let Some((ch, len, start)) = open_fence {
            if is_closing_fence(content, ch, len) {
                spans.push(CodeSpan { start, end: pos, kind: CodeKind::Fenced });
                open_fence = None;
                segment_start = pos;
            }
            continue;
        }
        if let Some((ch, len)) = opening_fence(content) {
            inline_code_spans(text, segment_start, line_start, &mut spans);
            open_fence = Some((ch, len, line_start));
        }
    }

    match open_fence {
        Some((_, _, start)) => {
            spans.push(CodeSpan { start, end: text.len(), kind: CodeKind::Fenced });
        }
        None => inline_code_spans(text, segment_start, text.len(), &mut spans),
    }
    spans
}

/// If `line` (without its line terminator) opens a fenced code block, return the fence
/// character and run length.
fn opening_fence(line: &str) -> Option<(u8, usize)> {
    let bytes = line.as_bytes();
    let indent = bytes.iter().take_while(|&&b| b == b' ').count();
    if indent > 3 || indent >= bytes.len() {
        return None;
    }
    let ch = bytes[indent];
    if ch != b'`' && ch != b'~' {
        return None;
    }
    let len = bytes[indent..].iter().take_while(|&&b| b == ch).count();
    if len < 3 {
        return None;
    }
    let info = &bytes[indent + len..];
    if ch == b'`' && info.contains(&b'`') {
        return None;
    }
    Some((ch, len))
}

/// Does `line` (without its line terminator) close a fence opened with `ch` × `len`?
fn is_closing_fence(line: &str, ch: u8, len: usize) -> bool {
    let bytes = line.as_bytes();
    let indent = bytes.iter().take_while(|&&b| b == b' ').count();
    if indent > 3 {
        return false;
    }
    let run = bytes[indent..].iter().take_while(|&&b| b == ch).count();
    run >= len && bytes[indent + run..].iter().all(|b| b.is_ascii_whitespace())
}

/// Append inline code spans found in `text[from..to]` to `spans`.
fn inline_code_spans(text: &str, from: usize, to: usize, spans: &mut Vec<CodeSpan>) {
    let bytes = &text.as_bytes()[from..to];
    let n = bytes.len();
    let backtick_run = |mut i: usize| -> usize {
        while i < n && bytes[i] == b'`' {
            i += 1;
        }
        i
    };
    // Is the line following the newline at `i` blank (whitespace only, or end of input)?
    let blank_line_after = |i: usize| -> bool {
        let mut k = i + 1;
        while k < n && matches!(bytes[k], b' ' | b'\t' | b'\r') {
            k += 1;
        }
        k >= n || bytes[k] == b'\n'
    };

    let mut i = 0;
    while i < n {
        if bytes[i] != b'`' {
            i += 1;
            continue;
        }
        let open_start = i;
        i = backtick_run(i);
        let run_len = i - open_start;

        let mut j = i;
        let mut close_end = None;
        while j < n {
            match bytes[j] {
                b'`' => {
                    let run_start = j;
                    j = backtick_run(j);
                    if j - run_start == run_len {
                        close_end = Some(j);
                        break;
                    }
                }
                b'\n' if blank_line_after(j) => break,
                _ => j += 1,
            }
        }
        if let Some(end) = close_end {
            spans.push(CodeSpan { start: from + open_start, end: from + end, kind: CodeKind::Inline });
            i = end;
        }
        // No closer: the opening run is literal text; scanning resumes right after it.
    }
}

// ---------------------------------------------------------------------------
// Local image inlining
// ---------------------------------------------------------------------------

/// Largest image file that is inlined. Anything bigger is left as a plain path
/// (which will not display) rather than ballooning the HTML sent over IPC.
pub const MAX_INLINE_IMAGE_BYTES: u64 = 8 * 1024 * 1024;

/// Turn an image destination into a `data:` URI when it names a local file.
///
/// Returns `None` (leave the destination untouched) when:
/// - the destination is a URL (`http:`, `https:`, `data:`, `file:`, `tauri:`, any
///   other scheme) or protocol-relative (`//host/…`),
/// - it is relative but `base_dir` is `None`,
/// - after `..` normalization it escapes `base_dir`,
/// - the file does not exist, is not a regular file, is larger than
///   [`MAX_INLINE_IMAGE_BYTES`], or has an extension that isn't a known image type.
///
/// Absolute local paths (`/x/y.png`, `C:\x\y.png`) are inlined too when the file
/// exists; opening a document is already an act of trust in that document's author,
/// and the result is a picture, not code.
pub fn inline_local_image(dest: &str, base_dir: Option<&Path>) -> Option<String> {
    let path = resolve_image_path(dest, base_dir)?;
    let mime = image_mime_for_path(&path)?;
    let meta = std::fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MAX_INLINE_IMAGE_BYTES {
        return None;
    }
    let bytes = std::fs::read(&path).ok()?;
    Some(data_uri(mime, &bytes))
}

/// Resolve an image destination to a filesystem path, or `None` when it is not a
/// local file reference that may be read (see [`inline_local_image`]).
pub fn resolve_image_path(dest: &str, base_dir: Option<&Path>) -> Option<PathBuf> {
    let dest = dest.trim();
    if dest.is_empty() || dest.starts_with("//") || has_url_scheme(dest) {
        return None;
    }
    let decoded = percent_decode(dest);
    let p = Path::new(&decoded);
    if is_absolute_local_path(&decoded) {
        return Some(p.to_path_buf());
    }
    let base = base_dir?;
    // Lexically normalize: `.` is dropped, `..` pops. Popping past the start means the
    // reference escapes the document folder — refuse it.
    let mut rel = PathBuf::new();
    let mut depth = 0usize;
    for comp in p.components() {
        match comp {
            Component::CurDir => {}
            Component::Normal(seg) => {
                rel.push(seg);
                depth += 1;
            }
            Component::ParentDir => {
                if depth == 0 {
                    return None;
                }
                rel.pop();
                depth -= 1;
            }
            // Only reachable for odd inputs (e.g. a drive prefix on Windows that
            // `is_absolute_local_path` didn't classify). Refuse rather than guess.
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    if depth == 0 {
        return None; // resolved to the folder itself, not a file
    }
    Some(base.join(rel))
}

/// `scheme:` per RFC 3986: a letter followed by letters, digits, `+`, `-`, `.`, then a
/// colon. A single letter before the colon (`C:\…`) is a Windows drive, not a scheme.
fn has_url_scheme(s: &str) -> bool {
    let Some(colon) = s.find(':') else { return false; };
    let scheme = &s[..colon];
    let mut chars = scheme.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    if scheme.len() < 2 {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
}

/// Absolute on this platform, or Windows-style absolute (`C:\`, `C:/`, `\\server\share`)
/// regardless of platform so a document authored on Windows behaves the same everywhere.
fn is_absolute_local_path(s: &str) -> bool {
    if Path::new(s).is_absolute() {
        return true;
    }
    let b = s.as_bytes();
    (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'))
        || s.starts_with("\\\\")
}

/// Decode `%XX` escapes (`%20` → space). Malformed escapes are kept literally. Invalid
/// UTF-8 after decoding is replaced rather than rejected: a filename that doesn't
/// decode cleanly simply won't be found on disk.
pub fn percent_decode(s: &str) -> String {
    if !s.contains('%') {
        return s.to_owned();
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// MIME type for a known raster/vector image extension (case-insensitive).
pub fn image_mime_for_extension(ext: &str) -> Option<&'static str> {
    Some(match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        _ => return None,
    })
}

fn image_mime_for_path(path: &Path) -> Option<&'static str> {
    image_mime_for_extension(path.extension()?.to_str()?)
}

/// `data:<mime>;base64,<payload>`.
pub fn data_uri(mime: &str, bytes: &[u8]) -> String {
    use base64::Engine;
    let mut out = String::with_capacity(bytes.len() * 4 / 3 + mime.len() + 16);
    out.push_str("data:");
    out.push_str(mime);
    out.push_str(";base64,");
    base64::engine::general_purpose::STANDARD.encode_string(bytes, &mut out);
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
///
/// All checks except `frontmatter` run over [`strip_code`] output, so syntax that only
/// occurs inside fenced code blocks or inline code (`$PATH` in a shell sample, `~~` in a
/// diff, a YAML `---` line, `[[ ... ]]` in a shell test) does not count as a feature.
pub fn detect_features(original: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut push = |label: &str| {
        if !found.iter().any(|s: &String| s == label) {
            found.push(label.to_string());
        }
    };

    // YAML frontmatter at the very top: starts with `---\n` and has a closing `---` or `...`.
    // Checked against the original text: it must be the first thing in the file.
    if original.starts_with("---\n") || original.starts_with("---\r\n") {
        let body = &original[3..];
        if body.contains("\n---\n") || body.contains("\n---\r\n") || body.contains("\n...\n")
            || body.ends_with("\n---") || body.ends_with("\n...")
        {
            push("frontmatter");
        }
    }

    let stripped = strip_code(original);
    let text = stripped.as_str();

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
        let r = render("hello <script>alert(1)</script> <b>x</b>", None);
        assert!(!r.html.contains("<script>"), "{}", r.html);
        assert!(r.html.contains("&lt;script&gt;"), "{}", r.html);
        assert!(!r.html.contains("<b>"), "{}", r.html);
        // Escaped exactly once: the browser must display `<b>`, not `&lt;b&gt;`.
        assert!(!r.html.contains("&amp;lt;"), "double-escaped: {}", r.html);
    }

    #[test]
    fn block_html_is_escaped() {
        let r = render("<style>body{display:none}</style>\n\ntext", None);
        assert!(!r.html.contains("<style>"), "{}", r.html);
        assert!(r.html.contains("&lt;style&gt;"), "{}", r.html);
    }

    #[test]
    fn pagebreak_marker_becomes_hr() {
        for src in ["a\n\n<!-- pagebreak -->\n\nb", "a\n\n<!--pagebreak-->\n\nb", "a\n\n<!--   pagebreak   -->\n\nb"] {
            let r = render(src, None);
            assert!(r.html.contains("<hr class=\"mdview-pagebreak\" />"), "{src:?} → {}", r.html);
            assert!(!r.html.contains(PAGEBREAK_PLACEHOLDER), "{}", r.html);
            assert!(r.features.contains(&"pagebreaks".to_string()));
        }
    }

    #[test]
    fn other_comments_are_left_alone_and_escaped() {
        let r = render("x <!-- note --> y", None);
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
        let r = render("| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n", None);
        assert!(r.html.contains("<table>"), "{}", r.html);
        assert!(r.html.contains("type=\"checkbox\""), "{}", r.html);
        assert_eq!(r.features, vec!["tasklists", "tables"]);
    }

    #[test]
    fn math_spans_are_emitted_for_katex() {
        let r = render("Inline $E=mc^2$ and\n\n$$\n\\int x\n$$\n", None);
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
        let r = render("", None);
        assert_eq!(r.html, "");
        assert!(r.features.is_empty());
    }

    // ---- strip_code: fenced blocks ----

    #[test]
    fn strip_code_blanks_fenced_block_but_keeps_line_structure() {
        let src = "before\n```bash\necho $HOME\n```\nafter\n";
        let out = strip_code(src);
        assert_eq!(out, "before\n\n\n\nafter\n");
        assert_eq!(out.lines().count(), src.lines().count());
        assert_eq!(out.matches('\n').count(), src.matches('\n').count());
    }

    #[test]
    fn strip_code_preserves_crlf_line_endings() {
        let src = "a\r\n```\r\n$x$\r\n```\r\nb\r\n";
        let out = strip_code(src);
        assert_eq!(out, "a\r\n\r\n\r\n\r\nb\r\n");
    }

    #[test]
    fn strip_code_handles_tilde_fences() {
        let src = "x\n~~~\n~~gone~~ ~~gone~~\n~~~\ny\n";
        assert_eq!(strip_code(src), "x\n\n\n\ny\n");
        // The fence lines themselves must not read as strikethrough.
        assert!(detect_features(src).is_empty(), "{:?}", detect_features(src));
    }

    #[test]
    fn strip_code_unterminated_fence_runs_to_eof() {
        let src = "intro\n```\n$a$ and $b$\n[[wiki]]\nstill code";
        assert_eq!(strip_code(src), "intro\n\n\n\n");
        assert!(detect_features(src).is_empty());
    }

    #[test]
    fn strip_code_closing_fence_must_be_at_least_as_long() {
        // Four-backtick fence: an inner three-backtick line is content, not a closer.
        let src = "````md\n```\n$x$\n```\n````\n$y$\n";
        assert_eq!(strip_code(src), "\n\n\n\n\n$y$\n");
        // A longer run does close a shorter fence.
        let src2 = "```\ncode\n`````\n$y$\n";
        assert_eq!(strip_code(src2), "\n\n\n$y$\n");
        // A different fence character does not close.
        let src3 = "```\n~~~\n$x$\n```\n";
        assert_eq!(strip_code(src3), "\n\n\n\n");
    }

    #[test]
    fn strip_code_fence_indent_and_info_string_rules() {
        // Up to three spaces of indent is still a fence; the closer may be indented too.
        assert_eq!(strip_code("   ```yaml\n---\n  ```\nz\n"), "\n\n\nz\n");
        // Four spaces is an indented code block in CommonMark, not a fence.
        assert_eq!(strip_code("    ```\n$x$\nmore\n"), "    ```\n$x$\nmore\n");
        // A backtick fence's info string may not contain a backtick.
        assert_eq!(strip_code("``` a`b\n$x$\n"), "``` a`b\n$x$\n");
        // Trailing whitespace after the closing fence is allowed; other text is not.
        assert_eq!(strip_code("```\nc\n```  \nd\n"), "\n\n\nd\n");
        assert_eq!(strip_code("```\nc\n``` x\nd\n"), "\n\n\n\n");
    }

    #[test]
    fn strip_code_fence_resets_an_unclosed_inline_backtick() {
        // Block structure wins: an unmatched backtick above a fence does not swallow it.
        let src = "a ` b\n```\n$x$\n```\nc ` d\n";
        assert_eq!(strip_code(src), "a ` b\n\n\n\nc ` d\n");
    }

    // ---- strip_code: inline spans ----

    #[test]
    fn strip_code_inline_spans_use_commonmark_run_matching() {
        // `` opens; the single ` inside is content; `` closes (11 characters in all).
        assert_eq!(strip_code("x `` a ` b `` y"), format!("x {} y", " ".repeat(11)));
        // Plain single-backtick span.
        assert_eq!(strip_code("a `$x$` b"), format!("a {} b", " ".repeat(5)));
        // Unmatched opening run is literal and does not consume what follows.
        assert_eq!(strip_code("`` a ` b"), "`` a ` b");
        assert_eq!(strip_code("a ` b `` c"), "a ` b `` c");
        // Two spans on one line are matched independently.
        assert_eq!(strip_code("`a` and `b`"), "    and    ");
        // Span content may be multi-byte; one space per character.
        assert_eq!(strip_code("`héllo`"), "       ");
    }

    #[test]
    fn strip_code_inline_span_may_cross_a_newline_but_not_a_blank_line() {
        assert_eq!(strip_code("`a\nb` c"), "  \n   c");
        assert_eq!(strip_code("`a\n\nb` c"), "`a\n\nb` c");
    }

    // ---- detect_features: false positives removed ----

    #[test]
    fn math_inside_code_is_not_a_feature() {
        let src = "Setup:\n\n```bash\nexport PATH=$HOME/bin:$PATH\necho $$\n```\n\nand `$x$` inline.\n";
        assert!(!detect_features(src).contains(&"math".to_string()), "{:?}", detect_features(src));
        // Positive control: the same text outside code is math.
        assert!(detect_features("$HOME$ and $PATH$").contains(&"math".to_string()));
        assert!(detect_features("$$\nx\n$$").contains(&"math".to_string()));
    }

    #[test]
    fn strikethrough_inside_code_is_not_a_feature() {
        let src = "```\n~~a~~ ~~b~~\n```\n`~~c~~ ~~d~~`\n";
        assert!(!detect_features(src).contains(&"strikethrough".to_string()));
        assert!(detect_features("~~a~~ ~~b~~").contains(&"strikethrough".to_string()));
    }

    #[test]
    fn tables_inside_code_are_not_a_feature() {
        let yaml = "```yaml\nkey: value | other\n---\nnext: doc\n```\n";
        assert!(!detect_features(yaml).contains(&"tables".to_string()), "{:?}", detect_features(yaml));
        let table = "```\n| a | b |\n|---|---|\n| 1 | 2 |\n```\n";
        assert!(!detect_features(table).contains(&"tables".to_string()));
        assert!(detect_features("| a | b |\n|---|---|\n").contains(&"tables".to_string()));
        // Inline code inside a real table cell still leaves the pipes intact.
        assert!(detect_features("| `a` | b |\n|---|---|\n").contains(&"tables".to_string()));
    }

    #[test]
    fn wikilinks_inside_code_are_not_a_feature() {
        let src = "```bash\nif [[ -f \"$f\" ]]; then echo ok; fi\n```\nUse `[[x]]` for arrays.\n";
        let f = detect_features(src);
        assert!(!f.contains(&"wikilinks".to_string()), "{f:?}");
        assert!(!f.contains(&"math".to_string()), "{f:?}");
        assert!(detect_features("see [[Other Page]]").contains(&"wikilinks".to_string()));
    }

    #[test]
    fn footnotes_inside_code_are_not_a_feature() {
        let src = "```md\n[^1]: a footnote sample\n```\n";
        assert!(!detect_features(src).contains(&"footnotes".to_string()));
        assert!(detect_features("text[^1]\n\n[^1]: note").contains(&"footnotes".to_string()));
    }

    #[test]
    fn other_features_inside_code_are_not_detected() {
        let src = "```md\n> [!NOTE]\n- [ ] task\n# H {#id}\n:::\nTerm\n: def\n[@cite]\n<!-- pagebreak -->\n```\n";
        assert!(detect_features(src).is_empty(), "{:?}", detect_features(src));
    }

    #[test]
    fn frontmatter_still_uses_original_text_start() {
        // Frontmatter is detected from the raw start of the file, independent of stripping.
        let src = "---\ntitle: a\n---\n```\n$x$\n```\n";
        assert_eq!(detect_features(src), vec!["frontmatter"]);
    }

    // ---- pagebreak markers inside code ----

    #[test]
    fn pagebreak_marker_inside_fence_stays_literal() {
        let src = "a\n\n```html\n<!-- pagebreak -->\n```\n\nb\n";
        assert_eq!(rewrite_pagebreak_markers(src), src);
        let r = render(src, None);
        assert!(!r.html.contains("mdview-pagebreak"), "{}", r.html);
        assert!(!r.html.contains(PAGEBREAK_PLACEHOLDER), "{}", r.html);
        assert!(r.html.contains("<code class=\"language-html\">&lt;!-- pagebreak --&gt;"), "{}", r.html);
        assert!(!r.features.contains(&"pagebreaks".to_string()), "{:?}", r.features);
    }

    #[test]
    fn pagebreak_marker_inside_inline_code_stays_literal() {
        let src = "Write `<!-- pagebreak -->` to break.";
        assert_eq!(rewrite_pagebreak_markers(src), src);
        let r = render(src, None);
        assert!(r.html.contains("<code>&lt;!-- pagebreak --&gt;</code>"), "{}", r.html);
        assert!(!r.html.contains("mdview-pagebreak"), "{}", r.html);
        assert!(!r.features.contains(&"pagebreaks".to_string()));
    }

    #[test]
    fn pagebreak_marker_outside_code_still_rewritten_alongside_code_copy() {
        let src = "Use `<!-- pagebreak -->` like so:\n\n<!-- pagebreak -->\n\nnext page\n";
        let r = render(src, None);
        assert_eq!(r.html.matches("<hr class=\"mdview-pagebreak\" />").count(), 1, "{}", r.html);
        assert!(r.html.contains("<code>&lt;!-- pagebreak --&gt;</code>"), "{}", r.html);
        assert!(r.features.contains(&"pagebreaks".to_string()));
    }

    // ----- local image inlining -----

    /// 8-byte PNG signature. Enough for the inliner (it never decodes pixels), and its
    /// base64 form is a fixed string we can assert on.
    const PNG_SIG: [u8; 8] = [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1A, b'\n'];
    const PNG_SIG_B64: &str = "iVBORw0KGgo=";

    /// Fresh temp dir per test (unique by name + pid) with `images/fig.png` and
    /// `my fig.png` inside it. Caller removes it.
    fn image_fixture(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tcb-img-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("images")).unwrap();
        std::fs::write(dir.join("images").join("fig.png"), PNG_SIG).unwrap();
        std::fs::write(dir.join("my fig.png"), PNG_SIG).unwrap();
        dir
    }

    #[test]
    fn relative_image_is_inlined_as_data_uri() {
        let dir = image_fixture("rel");
        let r = render("![alt](images/fig.png)", Some(&dir));
        let expected = format!("src=\"data:image/png;base64,{}\"", PNG_SIG_B64);
        assert!(r.html.contains(&expected), "{}", r.html);
        assert!(r.html.contains("alt=\"alt\""), "{}", r.html);
        assert!(!r.html.contains("images/fig.png"), "{}", r.html);

        // `./` prefix and a nested `..` that stays inside the folder both resolve.
        let r = render("![](./images/fig.png) ![](images/../images/fig.png)", Some(&dir));
        assert_eq!(r.html.matches(PNG_SIG_B64).count(), 2, "{}", r.html);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn percent_encoded_filename_is_decoded() {
        let dir = image_fixture("pct");
        let r = render("![](my%20fig.png)", Some(&dir));
        assert!(r.html.contains(PNG_SIG_B64), "{}", r.html);
        assert_eq!(percent_decode("a%20b%2Fc"), "a b/c");
        assert_eq!(percent_decode("100%"), "100%");          // dangling % kept
        assert_eq!(percent_decode("%zz%4"), "%zz%4");        // malformed kept
        assert_eq!(percent_decode("plain"), "plain");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_file_is_left_untouched() {
        let dir = image_fixture("missing");
        let r = render("![x](images/nope.png)", Some(&dir));
        assert!(r.html.contains("src=\"images/nope.png\""), "{}", r.html);
        assert!(!r.html.contains("data:"), "{}", r.html);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn urls_are_left_untouched() {
        let dir = image_fixture("urls");
        for src in [
            "http://example.com/fig.png",
            "https://example.com/fig.png",
            "data:image/png;base64,AAAA",
            "file:///etc/fig.png",
            "tauri://localhost/fig.png",
            "//cdn.example.com/fig.png",
        ] {
            let r = render(&format!("![]({})", src), Some(&dir));
            assert!(r.html.contains(&format!("src=\"{}\"", src)), "{src} → {}", r.html);
            assert!(resolve_image_path(src, Some(&dir)).is_none(), "{src}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn path_escaping_base_dir_is_rejected() {
        let dir = image_fixture("escape");
        // Put a real image one level above so the test proves the path is refused,
        // not merely not found.
        let parent = dir.parent().unwrap().to_path_buf();
        let outside = parent.join(format!("tcb-outside-{}.png", std::process::id()));
        std::fs::write(&outside, PNG_SIG).unwrap();
        let name = outside.file_name().unwrap().to_str().unwrap().to_owned();

        for src in [
            format!("../{}", name),
            format!("images/../../{}", name),
            "../../etc/passwd".to_string(),
            "../../../../../../etc/passwd".to_string(),
        ] {
            let r = render(&format!("![]({})", src), Some(&dir));
            assert!(!r.html.contains("data:"), "{src} → {}", r.html);
            assert!(resolve_image_path(&src, Some(&dir)).is_none(), "{src}");
        }
        // Sanity: the same file IS readable through a non-escaping path.
        assert!(inline_local_image(outside.to_str().unwrap(), None).is_some());
        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_base_dir_leaves_relative_untouched_but_absolute_still_inlines() {
        let dir = image_fixture("nobase");
        let r = render("![](images/fig.png)", None);
        assert!(r.html.contains("src=\"images/fig.png\""), "{}", r.html);

        let abs = dir.join("images").join("fig.png");
        let r = render(&format!("![]({})", abs.display()), None);
        assert!(r.html.contains(PNG_SIG_B64), "{}", r.html);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_image_path_joins_under_base() {
        let base = Path::new("/docs");
        assert_eq!(resolve_image_path("images/fig.png", Some(base)), Some(PathBuf::from("/docs/images/fig.png")));
        assert_eq!(resolve_image_path("./a.jpg", Some(base)), Some(PathBuf::from("/docs/a.jpg")));
        assert_eq!(resolve_image_path("a/./b/../c.gif", Some(base)), Some(PathBuf::from("/docs/a/c.gif")));
        assert_eq!(resolve_image_path("", Some(base)), None);
        assert_eq!(resolve_image_path(".", Some(base)), None);
        assert_eq!(resolve_image_path("images/fig.png", None), None);
        // Windows drive paths are recognised as absolute on every platform.
        assert_eq!(resolve_image_path(r"C:\pics\a.png", Some(base)), Some(PathBuf::from(r"C:\pics\a.png")));
        assert_eq!(resolve_image_path("C:/pics/a.png", Some(base)), Some(PathBuf::from("C:/pics/a.png")));
        assert_eq!(resolve_image_path(r"\\server\share\a.png", Some(base)), Some(PathBuf::from(r"\\server\share\a.png")));
    }

    #[test]
    fn url_scheme_detection() {
        for s in ["http://x", "HTTPS://x", "data:,x", "file:///x", "tauri://x", "mailto:a@b", "x-app+1.0:foo"] {
            assert!(has_url_scheme(s), "{s}");
        }
        for s in ["C:\\x", "c:/x", "images/fig.png", "", ":x", "1a:b", "a b:c", "no-colon"] {
            assert!(!has_url_scheme(s), "{s}");
        }
    }

    #[test]
    fn size_cap_is_respected() {
        let dir = image_fixture("cap");
        let big = dir.join("big.png");
        // Sparse-ish: set_len allocates lazily on every mainstream filesystem, so this
        // costs no real disk and no time.
        let f = std::fs::File::create(&big).unwrap();
        f.set_len(MAX_INLINE_IMAGE_BYTES + 1).unwrap();
        drop(f);
        assert!(inline_local_image("big.png", Some(&dir)).is_none());

        let exact = dir.join("exact.png");
        let f = std::fs::File::create(&exact).unwrap();
        f.set_len(MAX_INLINE_IMAGE_BYTES).unwrap();
        drop(f);
        let uri = inline_local_image("exact.png", Some(&dir)).expect("file at the cap is inlined");
        assert!(uri.starts_with("data:image/png;base64,"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_extension_and_directories_are_not_inlined() {
        let dir = image_fixture("ext");
        std::fs::write(dir.join("notes.txt"), "hello").unwrap();
        assert!(inline_local_image("notes.txt", Some(&dir)).is_none());
        assert!(inline_local_image("images", Some(&dir)).is_none());
        let r = render("![](notes.txt)", Some(&dir));
        assert!(r.html.contains("src=\"notes.txt\""), "{}", r.html);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn mime_mapping() {
        assert_eq!(image_mime_for_extension("png"), Some("image/png"));
        assert_eq!(image_mime_for_extension("PNG"), Some("image/png"));
        assert_eq!(image_mime_for_extension("jpg"), Some("image/jpeg"));
        assert_eq!(image_mime_for_extension("JPEG"), Some("image/jpeg"));
        assert_eq!(image_mime_for_extension("gif"), Some("image/gif"));
        assert_eq!(image_mime_for_extension("webp"), Some("image/webp"));
        assert_eq!(image_mime_for_extension("svg"), Some("image/svg+xml"));
        assert_eq!(image_mime_for_extension("bmp"), Some("image/bmp"));
        assert_eq!(image_mime_for_extension("ico"), Some("image/x-icon"));
        assert_eq!(image_mime_for_extension("avif"), Some("image/avif"));
        assert_eq!(image_mime_for_extension("txt"), None);
        assert_eq!(image_mime_for_extension("md"), None);
        assert_eq!(image_mime_for_extension(""), None);
    }

    #[test]
    fn data_uri_encoding() {
        assert_eq!(data_uri("image/png", &PNG_SIG), format!("data:image/png;base64,{}", PNG_SIG_B64));
        assert_eq!(data_uri("image/gif", b""), "data:image/gif;base64,");
        assert_eq!(data_uri("image/gif", b"a"), "data:image/gif;base64,YQ==");
        assert_eq!(data_uri("image/gif", b"ab"), "data:image/gif;base64,YWI=");
        assert_eq!(data_uri("image/gif", b"abc"), "data:image/gif;base64,YWJj");
    }

    #[test]
    fn raw_html_defang_is_unchanged_with_base_dir() {
        let dir = image_fixture("defang");
        let r = render("<img src=\"images/fig.png\"> ![](images/fig.png)", Some(&dir));
        // The raw <img> tag is still shown as text (pulldown-cmark escapes < and > in text
        // but leaves quotes alone); only the Markdown image is inlined.
        assert!(r.html.contains("&lt;img src=\"images/fig.png\"&gt;"), "{}", r.html);
        assert!(!r.html.contains("<img src=\"images/fig.png\">"), "{}", r.html);
        assert_eq!(r.html.matches("data:image/png").count(), 1, "{}", r.html);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

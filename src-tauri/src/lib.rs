use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

/// Shared app state. The launch file path is set once at process start from argv
/// and consumed by the frontend on its first `get_launch_file` call.
#[derive(Default)]
struct AppState {
    launch_path: Mutex<Option<PathBuf>>,
}

#[derive(Serialize, Clone)]
struct LoadedFile {
    path: String,
    content: String,
}

/// Returns the file passed via argv at launch (if any), reading its content.
/// The frontend calls this once on startup.
#[tauri::command]
fn get_launch_file(state: State<AppState>) -> Option<LoadedFile> {
    let path = state.launch_path.lock().ok()?.take()?;
    read_file(&path)
}

/// Open an arbitrary path. Used when a second app instance is launched with a file
/// and forwards the path here via the single-instance plugin.
#[tauri::command]
fn open_path(path: String) -> Option<LoadedFile> {
    read_file(Path::new(&path))
}

fn read_file(path: &Path) -> Option<LoadedFile> {
    let content = std::fs::read_to_string(path).ok()?;
    Some(LoadedFile {
        path: path.to_string_lossy().into_owned(),
        content,
    })
}

#[tauri::command]
fn save_file(app: AppHandle, path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, &content).map_err(|e| e.to_string())?;
    // If the file ISN'T in a git repo, take a local snapshot so we still have history.
    // Best-effort: a failed snapshot does not fail the save itself.
    let p = Path::new(&path);
    if !is_inside_git(p) {
        if let Err(err) = snapshot_save_impl(&app, p, &content) {
            eprintln!("[snapshot] failed: {}", err);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Versioning: git first, local snapshots as fallback.
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
struct VersionInfo {
    /// "git" | "snapshots" | "none"
    backend: String,
    /// Branch name when backend == "git", otherwise None.
    branch: Option<String>,
    /// "clean" | "modified" | "untracked" | "tracked" | "unknown"
    status: String,
    /// Past version count (git: commits touching this file; snapshots: file count).
    count: usize,
}

#[derive(Serialize, Clone)]
struct VersionEntry {
    /// git commit hash, OR snapshot timestamp (Unix seconds as decimal string).
    id: String,
    /// Author time (git) or file mtime / filename (snapshots). Unix seconds.
    timestamp_unix: i64,
    /// Commit subject (git) or "snapshot" (snapshots).
    label: String,
    /// Git author name; None for snapshots.
    author: Option<String>,
}

/// List past versions (git commits or local snapshots), newest first, capped at 200.
#[tauri::command]
fn list_versions(app: AppHandle, path: String) -> Vec<VersionEntry> {
    let p = Path::new(&path);
    if let Some(dir) = p.parent() {
        if let Some((toplevel, _)) = git_toplevel_and_branch(dir) {
            let rel = path_relative_to(p, &toplevel);
            return git_list_versions(dir, &rel);
        }
    }
    snapshot_list_versions(&app, p)
}

/// Read a specific past version's content by id (commit hash or snapshot timestamp).
#[tauri::command]
fn read_version(app: AppHandle, path: String, id: String) -> Result<String, String> {
    let p = Path::new(&path);
    if let Some(dir) = p.parent() {
        if let Some((toplevel, _)) = git_toplevel_and_branch(dir) {
            let rel = path_relative_to(p, &toplevel);
            return git_show_file(dir, &id, &rel);
        }
    }
    snapshot_read_impl(&app, p, &id)
}

fn git_list_versions(dir: &Path, rel: &Path) -> Vec<VersionEntry> {
    let rel_s = rel.to_string_lossy().replace('\\', "/");
    // %H = full commit hash, %at = author time (Unix), %an = author name, %s = subject.
    // Use a separator the chance of which appearing in the subject is ~0.
    let sep = "\x1f"; // ASCII unit separator
    let fmt = format!("%H{0}%at{0}%an{0}%s", sep);
    let out = match git_run(dir, &["log", &format!("--format={}", fmt), "-n", "200", "--", &rel_s]) {
        Some(s) => s,
        None => return Vec::new(),
    };
    out.lines().filter_map(|line| {
        let mut parts = line.split(sep);
        let id = parts.next()?.to_string();
        let ts: i64 = parts.next()?.parse().ok()?;
        let author = parts.next()?.to_string();
        let label = parts.next().unwrap_or("").to_string();
        Some(VersionEntry { id, timestamp_unix: ts, label, author: Some(author) })
    }).collect()
}

fn git_show_file(dir: &Path, hash: &str, rel: &Path) -> Result<String, String> {
    let rel_s = rel.to_string_lossy().replace('\\', "/");
    let spec = format!("{}:{}", hash, rel_s);
    let out = Command::new("git")
        .arg("-C").arg(dir)
        .args(["show", &spec])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn snapshot_list_versions(app: &AppHandle, path: &Path) -> Vec<VersionEntry> {
    let Ok(dir) = snapshot_dir(app, path) else { return Vec::new(); };
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new(); };
    let mut versions: Vec<VersionEntry> = entries.filter_map(|e| {
        let e = e.ok()?;
        let name = e.file_name();
        let stem = name.to_str()?.strip_suffix(".md")?;
        let ts: i64 = stem.parse().ok()?;
        Some(VersionEntry {
            id: stem.to_string(),
            timestamp_unix: ts,
            label: "snapshot".to_string(),
            author: None,
        })
    }).collect();
    versions.sort_by(|a, b| b.timestamp_unix.cmp(&a.timestamp_unix));
    versions
}

fn snapshot_read_impl(app: &AppHandle, path: &Path, id: &str) -> Result<String, String> {
    let dir = snapshot_dir(app, path)?;
    let file = dir.join(format!("{}.md", id));
    std::fs::read_to_string(file).map_err(|e| e.to_string())
}

/// Produce a unified text diff between two strings. `similar` 3.x returns `&mut Self`
/// from chained builder methods, so we bind, configure, then format.
#[tauri::command]
fn diff_text(old: String, new: String) -> String {
    use similar::TextDiff;
    let diff = TextDiff::from_lines(&old, &new);
    let mut ud = diff.unified_diff();
    ud.context_radius(3).header("older", "current");
    ud.to_string()
}

// ---------------------------------------------------------------------------
// Per-file metadata (currently: target flavor). Stored as small JSON files in
// app_data_dir/file-meta/<path-hash>.json. Doesn't touch the user's source file.
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Default, Clone)]
struct FileMeta {
    flavor: Option<String>,
}

fn file_meta_path(app: &AppHandle, path: &Path) -> Result<PathBuf, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let abs = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let key = format!("{:016x}", path_hash(&abs.to_string_lossy()));
    Ok(data_dir.join("file-meta").join(format!("{}.json", key)))
}

#[tauri::command]
fn get_file_meta(app: AppHandle, path: String) -> FileMeta {
    let meta_path = match file_meta_path(&app, Path::new(&path)) {
        Ok(p) => p,
        Err(_) => return FileMeta::default(),
    };
    std::fs::read_to_string(&meta_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn set_file_meta(app: AppHandle, path: String, meta: FileMeta) -> Result<(), String> {
    let meta_path = file_meta_path(&app, Path::new(&path))?;
    if let Some(parent) = meta_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string(&meta).map_err(|e| e.to_string())?;
    std::fs::write(meta_path, json).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_version_info(app: AppHandle, path: String) -> VersionInfo {
    let p = Path::new(&path);
    if let Some(dir) = p.parent() {
        if let Some((toplevel, branch)) = git_toplevel_and_branch(dir) {
            let rel = path_relative_to(p, &toplevel);
            return VersionInfo {
                backend: "git".to_string(),
                branch: Some(branch),
                status: git_file_status(dir, &rel).unwrap_or_else(|| "unknown".to_string()),
                count: git_count_commits(dir, &rel),
            };
        }
    }
    VersionInfo {
        backend: "snapshots".to_string(),
        branch: None,
        status: if p.exists() { "tracked".to_string() } else { "untracked".to_string() },
        count: snapshot_count(&app, p),
    }
}

// ----- git helpers (subprocess) -----

fn git_run(dir: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
}

fn is_inside_git(path: &Path) -> bool {
    let dir = path.parent().unwrap_or(path);
    git_run(dir, &["rev-parse", "--is-inside-work-tree"])
        .map(|s| s == "true")
        .unwrap_or(false)
}

fn git_toplevel_and_branch(dir: &Path) -> Option<(PathBuf, String)> {
    let out = git_run(dir, &["rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"])?;
    let mut lines = out.lines();
    let top = PathBuf::from(lines.next()?);
    let branch = lines.next()?.to_string();
    Some((top, branch))
}

fn path_relative_to(file: &Path, root: &Path) -> PathBuf {
    let abs = file.canonicalize().unwrap_or_else(|_| file.to_path_buf());
    let root_abs = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    abs.strip_prefix(&root_abs)
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|_| file.to_path_buf())
}

fn git_file_status(dir: &Path, rel: &Path) -> Option<String> {
    let rel_s = rel.to_string_lossy().replace('\\', "/");
    let out = git_run(dir, &["status", "--porcelain", "--", &rel_s])?;
    if out.is_empty() {
        return Some("clean".to_string());
    }
    let prefix: String = out.chars().take(2).collect();
    Some(if prefix == "??" {
        "untracked".to_string()
    } else if prefix.contains('M') || prefix.contains('A') || prefix.contains('R') || prefix.contains('D') {
        "modified".to_string()
    } else {
        "unknown".to_string()
    })
}

fn git_count_commits(dir: &Path, rel: &Path) -> usize {
    let rel_s = rel.to_string_lossy().replace('\\', "/");
    git_run(dir, &["log", "--format=%H", "--", &rel_s])
        .map(|s| if s.is_empty() { 0 } else { s.lines().count() })
        .unwrap_or(0)
}

// ----- local snapshot fallback -----

/// Stable per-path key. FNV-1a 64-bit — deterministic across process restarts.
fn path_hash(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn snapshot_dir(app: &AppHandle, path: &Path) -> Result<PathBuf, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let abs = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let key = format!("{:016x}", path_hash(&abs.to_string_lossy()));
    Ok(data_dir.join("snapshots").join(key))
}

fn snapshot_count(app: &AppHandle, path: &Path) -> usize {
    snapshot_dir(app, path)
        .ok()
        .and_then(|d| std::fs::read_dir(d).ok())
        .map(|entries| entries.filter_map(|e| e.ok()).count())
        .unwrap_or(0)
}

fn snapshot_save_impl(app: &AppHandle, path: &Path, content: &str) -> Result<(), String> {
    let dir = snapshot_dir(app, path)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    let file = dir.join(format!("{}.md", ts));
    std::fs::write(file, content).map_err(|e| e.to_string())
}

/// Take a snapshot of arbitrary content for a file path, regardless of whether the file
/// is in git. Used by the "Backup current first" flow before a destructive restore.
#[tauri::command]
fn snapshot_current(app: AppHandle, path: String, content: String) -> Result<(), String> {
    snapshot_save_impl(&app, Path::new(&path), &content)
}

// ---------------------------------------------------------------------------
// Typeset PDF export via external binaries (pandoc + typst).
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Default)]
struct TypesettingTools {
    pandoc: bool,
    typst: bool,
}

fn binary_present(name: &str) -> bool {
    Command::new(name)
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[tauri::command]
fn detect_typesetting_tools() -> TypesettingTools {
    TypesettingTools {
        pandoc: binary_present("pandoc"),
        typst: binary_present("typst"),
    }
}

/// Render the input markdown file to a PDF at `output` using pandoc with the typst
/// engine. Requires both `pandoc` and `typst` on PATH. Returns stderr on failure.
#[tauri::command]
fn export_typeset_pdf(input: String, output: String) -> Result<(), String> {
    let out = Command::new("pandoc")
        .arg(&input)
        .arg("-o").arg(&output)
        .arg("--pdf-engine=typst")
        .output()
        .map_err(|e| format!("Could not run pandoc: {}", e))?;
    if !out.status.success() {
        return Err(format!(
            "pandoc → typst failed:\n{}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

#[derive(Serialize)]
struct RenderResult {
    html: String,
    /// Feature labels detected in the source, e.g. "frontmatter", "tables", "math".
    /// Used by the UI to badge what's present in the document.
    features: Vec<String>,
}

/// Render markdown to HTML and detect notable features in one pass.
///
/// Enables the full pulldown-cmark extension set so any flavor's content renders.
/// Raw HTML in the source is escaped (not passed through) to keep XSS off the table
/// when opening untrusted `.md` files.
///
/// Explicit `<!-- pagebreak -->` markers in the source are turned into
/// `<hr class="mdview-pagebreak" />` so CSS / paged.js / native print can act on them.
#[tauri::command]
fn render_markdown(text: String) -> RenderResult {
    use pulldown_cmark::{html, CowStr, Event, Options, Parser};

    // Pre-process: rewrite `<!-- pagebreak -->` (with flexible inner whitespace) into a
    // unique paragraph token that survives parsing without being escaped as raw HTML.
    let pre = rewrite_pagebreak_markers(&text);

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
        // Defang raw HTML in the input by escaping it. The user sees the literal tag
        // text instead of having it rendered (and possibly executed).
        Event::Html(html) => Event::Text(CowStr::from(escape_html(&html))),
        Event::InlineHtml(html) => Event::Text(CowStr::from(escape_html(&html))),
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

    RenderResult {
        html: final_html,
        features: detect_features(&text),
    }
}

const PAGEBREAK_PLACEHOLDER: &str = "MDVIEW_PAGEBREAK_7f29a5b3";

fn rewrite_pagebreak_markers(text: &str) -> String {
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

fn escape_html(s: &str) -> String {
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
fn detect_features(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut push = |label: &str| {
        if !found.iter().any(|s: &String| s == label) {
            found.push(label.to_string());
        }
    };

    // YAML frontmatter at the very top: starts with `---\n` and has a closing `---` or `...`.
    if text.starts_with("---\n") || text.starts_with("---\r\n") {
        let body = &text[3..];
        if body.contains("\n---\n") || body.contains("\n---\r\n") || body.contains("\n...\n") {
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
fn has_inline_math(text: &str) -> bool {
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

/// Frontend calls this once it has painted its initial state.
/// The window is created with `visible: false` so we avoid the
/// classic empty-white-window flash during cold start.
#[tauri::command]
fn frontend_ready(window: WebviewWindow) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())
}

pub fn run() {
    let launch_path = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .filter(|p| p.exists());

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                if let Some(path) = args.get(1) {
                    let _ = window.emit("open-file", path.clone());
                }
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState {
            launch_path: Mutex::new(launch_path),
        })
        .invoke_handler(tauri::generate_handler![
            get_launch_file,
            open_path,
            save_file,
            render_markdown,
            frontend_ready,
            get_version_info,
            list_versions,
            read_version,
            diff_text,
            get_file_meta,
            set_file_meta,
            snapshot_current,
            detect_typesetting_tools,
            export_typeset_pdf,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}

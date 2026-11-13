use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

pub mod markdown;
pub mod textfile;

use textfile::{TextFormat, VersionEntry};

/// Shared app state. The launch file path is set once at process start from argv
/// and consumed by the frontend on its first `get_launch_file` call.
#[derive(Default)]
struct AppState {
    launch_path: Mutex<Option<PathBuf>>,
}

#[derive(Serialize, Clone, Debug)]
struct LoadedFile {
    path: String,
    /// LF-normalized, BOM-free text ready for the editor.
    content: String,
    /// On-disk format captured at load; the frontend hands it back to `save_file`
    /// so line endings / BOM / UTF-16 survive a round trip untouched.
    format: TextFormat,
}

/// Returns the file passed via argv at launch (if any), reading its content.
/// The frontend calls this once on startup. `Err` carries a user-facing reason
/// (unreadable, not text, …) so the UI can say *why* nothing opened.
#[tauri::command]
fn get_launch_file(state: State<AppState>) -> Result<Option<LoadedFile>, String> {
    let Some(path) = state.launch_path.lock().map_err(|e| e.to_string())?.take() else {
        return Ok(None);
    };
    read_file(&path).map(Some)
}

/// Open an arbitrary path. Used when a second app instance is launched with a file
/// and forwards the path here via the single-instance plugin, when a file is
/// dropped on the window, or when the user picks one via Ctrl+O.
#[tauri::command]
fn open_path(path: String) -> Result<LoadedFile, String> {
    read_file(Path::new(&path))
}

fn read_file(path: &Path) -> Result<LoadedFile, String> {
    let bytes = std::fs::read(path)
        .map_err(|e| format!("Could not read {}: {}", path.display(), e))?;
    let decoded = textfile::decode(&bytes)
        .map_err(|e| format!("Could not open {}: {}", path.display(), e))?;
    Ok(LoadedFile {
        path: path.to_string_lossy().into_owned(),
        content: decoded.text,
        format: decoded.format,
    })
}

/// Write `content` (LF-normalized editor text) to `path`, re-applying the file's
/// original encoding / BOM / line endings. `format` is `None` for brand-new files,
/// which are written as plain UTF-8 with LF.
#[tauri::command]
fn save_file(app: AppHandle, path: String, content: String, format: Option<TextFormat>) -> Result<TextFormat, String> {
    let format = format.unwrap_or_default();
    let bytes = textfile::encode(&content, format);
    std::fs::write(&path, &bytes).map_err(|e| format!("Could not write {}: {}", path, e))?;
    // If the file ISN'T in a git repo, take a local snapshot so we still have history.
    // Best-effort: a failed snapshot does not fail the save itself.
    let p = Path::new(&path);
    if !is_inside_git(p) {
        if let Err(err) = snapshot_save_impl(&app, p, &content) {
            eprintln!("[snapshot] failed: {}", err);
        }
    }
    Ok(format)
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
    /// Local snapshots that exist alongside git history (0 when backend == "snapshots",
    /// where `count` already is the snapshot count).
    snapshots: usize,
}

/// List past versions newest first: git commits (capped at 200) merged with any
/// local snapshots. Snapshots exist for git-tracked files too, because the
/// "Backup current first" restore option always writes one.
#[tauri::command]
fn list_versions(app: AppHandle, path: String) -> Vec<VersionEntry> {
    let p = Path::new(&path);
    let snapshots = snapshot_list_versions(&app, p);
    if let Some(dir) = p.parent() {
        if let Some((toplevel, _)) = git_toplevel_and_branch(dir) {
            let rel = path_relative_to(p, &toplevel);
            return textfile::merge_versions(git_list_versions(&toplevel, &rel), snapshots);
        }
    }
    snapshots
}

/// Read a specific past version's content by id (commit hash or snapshot timestamp).
#[tauri::command]
fn read_version(app: AppHandle, path: String, id: String) -> Result<String, String> {
    let p = Path::new(&path);
    if textfile::is_snapshot_id(&id) {
        return snapshot_read_impl(&app, p, &id);
    }
    if let Some(dir) = p.parent() {
        if let Some((toplevel, _)) = git_toplevel_and_branch(dir) {
            let rel = path_relative_to(p, &toplevel);
            return git_show_file(&toplevel, &id, &rel);
        }
    }
    Err(format!("Version {} not found", id))
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
    // Historical blobs may carry CRLF / a BOM; normalize like a fresh load so the
    // diff against the (LF) editor text doesn't flag every line.
    match textfile::decode(&out.stdout) {
        Ok(d) => Ok(d.text),
        Err(_) => Ok(String::from_utf8_lossy(&out.stdout).into_owned()),
    }
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
    let bytes = std::fs::read(file).map_err(|e| e.to_string())?;
    // Snapshots written by older builds may carry a BOM / CRLF; normalize like a load.
    textfile::decode(&bytes).map(|d| d.text)
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
                status: git_file_status(&toplevel, &rel).unwrap_or_else(|| "unknown".to_string()),
                count: git_count_commits(&toplevel, &rel),
                snapshots: snapshot_count(&app, p),
            };
        }
    }
    VersionInfo {
        backend: "snapshots".to_string(),
        branch: None,
        status: if p.exists() { "tracked".to_string() } else { "untracked".to_string() },
        count: snapshot_count(&app, p),
        snapshots: 0,
    }
}

// ----- git helpers (subprocess) -----
//
// Every helper that takes a `rel` path runs git from the repository TOPLEVEL.
// Pathspecs are interpreted relative to git's working directory, so running from
// the file's own directory with a toplevel-relative path matched nothing for any
// file below the repo root (empty history, "0 commits").

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
    snapshot_list_versions(app, path).len()
}

fn snapshot_save_impl(app: &AppHandle, path: &Path, content: &str) -> Result<(), String> {
    let dir = snapshot_dir(app, path)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    // Snapshot ids have one-second resolution. Two saves inside the same second
    // (e.g. "Backup current first" immediately after Ctrl+S) must not overwrite
    // each other, so bump forward until the slot is free.
    let mut file = dir.join(format!("{}.md", ts));
    while file.exists() {
        ts += 1;
        file = dir.join(format!("{}.md", ts));
    }
    std::fs::write(file, content).map_err(|e| e.to_string())?;
    prune_snapshot_dir(&dir, MAX_SNAPSHOTS_PER_FILE);
    Ok(())
}

/// Every save of a non-git file writes a full copy, so an editing session can leave
/// hundreds of snapshots behind. Keep the newest N per document.
const MAX_SNAPSHOTS_PER_FILE: usize = 200;

/// Delete the oldest `<timestamp>.md` snapshots in `dir` beyond `keep`. Best-effort:
/// unrelated files are ignored and removal errors are not fatal.
fn prune_snapshot_dir(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else { return; };
    let mut stamps: Vec<(i64, PathBuf)> = entries
        .filter_map(|e| {
            let e = e.ok()?;
            let name = e.file_name();
            let ts: i64 = name.to_str()?.strip_suffix(".md")?.parse().ok()?;
            Some((ts, e.path()))
        })
        .collect();
    if stamps.len() <= keep {
        return;
    }
    stamps.sort_by(|a, b| b.0.cmp(&a.0)); // newest first
    for (_, path) in stamps.into_iter().skip(keep) {
        if let Err(err) = std::fs::remove_file(&path) {
            eprintln!("[snapshot] prune failed for {}: {}", path.display(), err);
        }
    }
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

/// Render markdown to HTML and detect notable features in one pass.
/// See [`markdown::render`] for the details (extension set, HTML escaping, pagebreaks).
///
/// `base_dir` is the folder of the open document (the frontend passes `parentDir(path)`,
/// or nothing for an unsaved buffer). Relative image references are resolved against it
/// and inlined as `data:` URIs so they display in the WebView.
#[tauri::command]
fn render_markdown(text: String, base_dir: Option<String>) -> markdown::Rendered {
    markdown::render(&text, base_dir.as_deref().map(Path::new))
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
        .filter(|p| p.is_file());

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                if let Some(arg) = args.get(1) {
                    // The second instance may have been started with a relative path from
                    // a different working directory — resolve against *its* cwd. Ignore
                    // arguments that aren't files (same filter as the first instance).
                    let path = textfile::resolve_path_arg(arg, Some(Path::new(&cwd)));
                    if path.is_file() {
                        let _ = window.emit("open-file", path.to_string_lossy().into_owned());
                    }
                }
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // External links clicked in the preview open in the default browser / mail client
        // (`opener:default` in capabilities/default.json limits this to http/https/mailto/tel).
        .plugin(tauri_plugin_opener::init())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_hash_is_deterministic_and_distinct() {
        assert_eq!(path_hash("C:\\a\\b.md"), path_hash("C:\\a\\b.md"));
        assert_ne!(path_hash("C:\\a\\b.md"), path_hash("C:\\a\\c.md"));
        // Known FNV-1a 64 vector.
        assert_eq!(path_hash(""), 0xcbf29ce484222325);
        assert_eq!(path_hash("a"), 0xaf63dc4c8601ec8c);
    }

    #[test]
    fn diff_text_produces_unified_hunks() {
        let d = diff_text("a\nb\nc\n".into(), "a\nB\nc\n".into());
        assert!(d.contains("--- older"), "{d}");
        assert!(d.contains("+++ current"), "{d}");
        assert!(d.contains("-b\n"), "{d}");
        assert!(d.contains("+B\n"), "{d}");
    }

    #[test]
    fn diff_text_identical_is_empty() {
        assert_eq!(diff_text("same\n".into(), "same\n".into()), "");
    }

    #[test]
    fn read_file_reports_missing_and_binary() {
        let dir = std::env::temp_dir().join(format!("tcb-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let missing = read_file(&dir.join("nope.md")).unwrap_err();
        assert!(missing.starts_with("Could not read"), "{missing}");

        let bin = dir.join("bin.md");
        std::fs::write(&bin, [0x00, 0xFF, 0xFE, 0x80, 0x81]).unwrap();
        let err = read_file(&bin).unwrap_err();
        assert!(err.contains("not valid UTF-8"), "{err}");

        let crlf = dir.join("crlf.md");
        std::fs::write(&crlf, b"\xEF\xBB\xBF# T\r\n\r\nx\r\n").unwrap();
        let f = read_file(&crlf).unwrap();
        assert_eq!(f.content, "# T\n\nx\n");
        assert_eq!(f.format, TextFormat { encoding: textfile::Encoding::Utf8, bom: true, eol: textfile::LineEnding::Crlf });
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_keeps_newest_and_ignores_other_files() {
        let dir = std::env::temp_dir().join(format!("tcb-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for ts in [100, 300, 200, 500, 400] {
            std::fs::write(dir.join(format!("{}.md", ts)), "x").unwrap();
        }
        std::fs::write(dir.join("notes.txt"), "keep me").unwrap();

        prune_snapshot_dir(&dir, 10);   // under the cap → untouched
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 6);

        prune_snapshot_dir(&dir, 2);
        let mut left: Vec<String> = std::fs::read_dir(&dir).unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, vec!["400.md", "500.md", "notes.txt"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn updater_has_a_reachable_fallback_endpoint() {
        // The first endpoint is a custom domain; if it has no DNS record or is down the
        // updater moves on to the next one, so the GitHub release manifest must stay listed.
        let conf: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json")).unwrap(),
        )
        .unwrap();
        let endpoints: Vec<&str> = conf["plugins"]["updater"]["endpoints"]
            .as_array()
            .expect("updater endpoints")
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert!(endpoints.iter().all(|u| u.starts_with("https://")), "{endpoints:?}");
        assert!(
            endpoints.contains(&"https://github.com/gnomatix/tcb/releases/latest/download/latest.json"),
            "{endpoints:?}"
        );
        assert!(conf["plugins"]["updater"]["pubkey"].as_str().map_or(false, |k| !k.is_empty()));
    }

    #[test]
    fn git_helpers_run_against_this_repo() {
        // The crate lives inside the project's own git checkout; use it as a fixture.
        let here = Path::new(env!("CARGO_MANIFEST_DIR"));
        if git_toplevel_and_branch(here).is_none() {
            eprintln!("skipping: not inside a git work tree");
            return;
        }
        assert!(is_inside_git(&here.join("Cargo.toml")));
        let (top, _branch) = git_toplevel_and_branch(here).unwrap();
        let rel = path_relative_to(&here.join("Cargo.toml"), &top);
        assert_eq!(rel, Path::new("src-tauri/Cargo.toml"));
        // Regression: the file lives in a subdirectory, so this only works when git
        // runs from the toplevel.
        let versions = git_list_versions(&top, &rel);
        assert!(!versions.is_empty());
        assert!(versions.windows(2).all(|w| w[0].timestamp_unix >= w[1].timestamp_unix));
        assert_eq!(git_count_commits(&top, &rel), versions.len());
        let content = git_show_file(&top, &versions[0].id, &rel).unwrap();
        assert!(content.contains("[package]"));
        assert!(git_file_status(&top, &rel).is_some());
        assert!(git_list_versions(here, &rel).is_empty(), "sanity: running from the subdir still fails");
    }
}

//! Text-file plumbing with no Tauri dependency: encoding / BOM / line-ending
//! detection and round-tripping, launch-path resolution, and version-list merging.
//!
//! Everything here is a pure function so it can be unit-tested without a WebView.
//!
//! Why this exists: the editor is a `<textarea>`, and the HTML spec normalizes a
//! textarea's `.value` to LF. Without explicit handling, opening a CRLF file (the
//! Windows default) and pressing Save silently rewrote every line ending in the
//! file. Likewise a UTF-8 BOM or a UTF-16 file (Notepad's legacy default) either
//! leaked into the document text or failed to open with no message at all.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Byte encoding of the file on disk.
/// Wire names are pinned explicitly (`utf-8`, `utf-16le`, `utf-16be`) — they are what
/// `app.js` matches on; see `text_format_wire_names` below.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum Encoding {
    #[default]
    #[serde(rename = "utf-8")]
    Utf8,
    #[serde(rename = "utf-16le")]
    Utf16Le,
    #[serde(rename = "utf-16be")]
    Utf16Be,
}

/// Dominant line ending of the file on disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum LineEnding {
    #[default]
    Lf,
    Crlf,
}

/// On-disk text format, captured on load and re-applied on save so the bytes the
/// user did not touch come back out exactly as they went in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct TextFormat {
    pub encoding: Encoding,
    pub bom: bool,
    pub eol: LineEnding,
}

/// Result of decoding a file: LF-normalized, BOM-free text plus the format needed
/// to write it back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedText {
    pub text: String,
    pub format: TextFormat,
}

const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];
const UTF16_LE_BOM: [u8; 2] = [0xFF, 0xFE];
const UTF16_BE_BOM: [u8; 2] = [0xFE, 0xFF];

/// Decode file bytes into editor text.
///
/// Accepts UTF-8 (with or without BOM) and UTF-16 LE/BE **with** a BOM. Anything
/// else is rejected with a human-readable reason rather than being read lossily,
/// because a lossy read followed by a save would destroy the user's data.
pub fn decode(bytes: &[u8]) -> Result<DecodedText, String> {
    let (encoding, bom, body): (Encoding, bool, &[u8]) = if bytes.starts_with(&UTF8_BOM) {
        (Encoding::Utf8, true, &bytes[3..])
    } else if bytes.starts_with(&UTF16_LE_BOM) {
        (Encoding::Utf16Le, true, &bytes[2..])
    } else if bytes.starts_with(&UTF16_BE_BOM) {
        (Encoding::Utf16Be, true, &bytes[2..])
    } else {
        (Encoding::Utf8, false, bytes)
    };

    let raw = match encoding {
        Encoding::Utf8 => std::str::from_utf8(body)
            .map(str::to_owned)
            .map_err(|e| format!("file is not valid UTF-8 text (byte {}): it may be binary or use an unsupported encoding", e.valid_up_to()))?,
        Encoding::Utf16Le | Encoding::Utf16Be => {
            if body.len() % 2 != 0 {
                return Err("file has a UTF-16 byte-order mark but an odd number of bytes".to_string());
            }
            let units: Vec<u16> = body
                .chunks_exact(2)
                .map(|c| match encoding {
                    Encoding::Utf16Le => u16::from_le_bytes([c[0], c[1]]),
                    _ => u16::from_be_bytes([c[0], c[1]]),
                })
                .collect();
            String::from_utf16(&units).map_err(|_| "file is UTF-16 but contains an invalid surrogate pair".to_string())?
        }
    };

    let eol = detect_line_ending(&raw);
    Ok(DecodedText {
        text: normalize_newlines(&raw),
        format: TextFormat { encoding, bom, eol },
    })
}

/// Encode editor text (LF-normalized) back into file bytes using `format`.
pub fn encode(text: &str, format: TextFormat) -> Vec<u8> {
    let with_eol: String = match format.eol {
        LineEnding::Lf => text.to_owned(),
        LineEnding::Crlf => normalize_newlines(text).replace('\n', "\r\n"),
    };
    match format.encoding {
        Encoding::Utf8 => {
            let mut out = Vec::with_capacity(with_eol.len() + 3);
            if format.bom {
                out.extend_from_slice(&UTF8_BOM);
            }
            out.extend_from_slice(with_eol.as_bytes());
            out
        }
        Encoding::Utf16Le | Encoding::Utf16Be => {
            // A UTF-16 file is only ever recognised via its BOM, so always write one back.
            let mut out = Vec::with_capacity(with_eol.len() * 2 + 2);
            let le = format.encoding == Encoding::Utf16Le;
            out.extend_from_slice(if le { &UTF16_LE_BOM } else { &UTF16_BE_BOM });
            for unit in with_eol.encode_utf16() {
                out.extend_from_slice(&if le { unit.to_le_bytes() } else { unit.to_be_bytes() });
            }
            out
        }
    }
}

/// Majority vote between CRLF and bare LF. Lone CR (classic Mac) counts as LF
/// because that is what it becomes after normalization. Files with no line breaks
/// default to LF.
pub fn detect_line_ending(text: &str) -> LineEnding {
    let crlf = text.matches("\r\n").count();
    let lf_total = text.matches('\n').count();
    let bare_lf = lf_total - crlf;
    if crlf > bare_lf { LineEnding::Crlf } else { LineEnding::Lf }
}

/// Convert CRLF and lone CR to LF — the same normalization the textarea applies,
/// done up front so dirty-tracking compares like with like.
pub fn normalize_newlines(text: &str) -> String {
    if !text.contains('\r') {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            out.push('\n');
        } else {
            out.push(c);
        }
    }
    out
}

/// Resolve a path argument received from a *second* app instance.
///
/// The single-instance plugin forwards the other process's `argv` together with
/// its working directory. A relative argument (`tcb notes.md` typed in a shell)
/// must be resolved against **that** directory, not ours — otherwise the file is
/// looked up in the wrong place and silently fails to open.
pub fn resolve_path_arg(arg: &str, cwd: Option<&Path>) -> PathBuf {
    let p = Path::new(arg);
    if p.is_absolute() {
        return p.to_path_buf();
    }
    match cwd {
        Some(dir) => dir.join(p),
        None => p.to_path_buf(),
    }
}

/// One entry in the version picker: a git commit or a local snapshot.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct VersionEntry {
    /// git commit hash, OR snapshot timestamp (Unix seconds as decimal string).
    pub id: String,
    /// Author time (git) or file mtime / filename (snapshots). Unix seconds.
    pub timestamp_unix: i64,
    /// Commit subject (git) or "snapshot" (snapshots).
    pub label: String,
    /// Git author name; None for snapshots.
    pub author: Option<String>,
}

/// Merge git history with local snapshots into one newest-first list.
///
/// A file inside a git repo can still have snapshots (the "Backup current first"
/// restore option writes one regardless of backend). Before this merge those
/// snapshots were written but never listed, so the backup was unrecoverable from
/// the UI. Ties are broken git-first so a commit and a same-second snapshot keep a
/// stable order.
pub fn merge_versions(git: Vec<VersionEntry>, snapshots: Vec<VersionEntry>) -> Vec<VersionEntry> {
    let mut all: Vec<(u8, VersionEntry)> = Vec::with_capacity(git.len() + snapshots.len());
    all.extend(git.into_iter().map(|v| (0u8, v)));
    all.extend(snapshots.into_iter().map(|v| (1u8, v)));
    // Stable sort by timestamp descending; the (source) tag keeps git ahead on ties.
    all.sort_by(|a, b| b.1.timestamp_unix.cmp(&a.1.timestamp_unix).then(a.0.cmp(&b.0)));
    all.into_iter().map(|(_, v)| v).collect()
}

/// Snapshot ids are decimal Unix timestamps; git ids are 7–40 hex digits and in
/// practice always contain a letter. Used to route `read_version` to the right
/// backend when a git-tracked file also has snapshots.
pub fn is_snapshot_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_format_wire_names_match_app_js() {
        // app.js: FORMAT_LABEL keys and MOCK_FORMAT use exactly these strings.
        let f = |encoding, bom, eol| serde_json::to_string(&TextFormat { encoding, bom, eol }).unwrap();
        assert_eq!(f(Encoding::Utf8, false, LineEnding::Lf), r#"{"encoding":"utf-8","bom":false,"eol":"lf"}"#);
        assert_eq!(f(Encoding::Utf16Le, true, LineEnding::Crlf), r#"{"encoding":"utf-16le","bom":true,"eol":"crlf"}"#);
        assert_eq!(f(Encoding::Utf16Be, true, LineEnding::Lf), r#"{"encoding":"utf-16be","bom":true,"eol":"lf"}"#);
        // And a JS-built default must deserialize (save_file receives it from the front end).
        let parsed: TextFormat = serde_json::from_str(r#"{"encoding":"utf-8","bom":false,"eol":"crlf"}"#).unwrap();
        assert_eq!(parsed, TextFormat { encoding: Encoding::Utf8, bom: false, eol: LineEnding::Crlf });
        // Missing format on save → defaults.
        assert_eq!(TextFormat::default(), TextFormat { encoding: Encoding::Utf8, bom: false, eol: LineEnding::Lf });
        assert_eq!(encode("a\nb", TextFormat::default()), b"a\nb");
    }

    #[test]
    fn decode_plain_utf8_lf() {
        let d = decode(b"# Hi\n\nbody\n").unwrap();
        assert_eq!(d.text, "# Hi\n\nbody\n");
        assert_eq!(d.format, TextFormat { encoding: Encoding::Utf8, bom: false, eol: LineEnding::Lf });
    }

    #[test]
    fn decode_crlf_is_normalized_and_remembered() {
        let d = decode(b"a\r\nb\r\nc").unwrap();
        assert_eq!(d.text, "a\nb\nc");
        assert_eq!(d.format.eol, LineEnding::Crlf);
        assert!(!d.format.bom);
    }

    #[test]
    fn decode_strips_utf8_bom() {
        let d = decode(b"\xEF\xBB\xBF---\ntitle: x\n---\n").unwrap();
        assert!(d.text.starts_with("---\n"), "BOM must not leak into the text: {:?}", d.text);
        assert!(d.format.bom);
        assert_eq!(d.format.encoding, Encoding::Utf8);
    }

    #[test]
    fn decode_utf16le_with_bom() {
        // "hi\r\n" in UTF-16 LE with BOM.
        let bytes = [0xFF, 0xFE, b'h', 0, b'i', 0, b'\r', 0, b'\n', 0];
        let d = decode(&bytes).unwrap();
        assert_eq!(d.text, "hi\n");
        assert_eq!(d.format, TextFormat { encoding: Encoding::Utf16Le, bom: true, eol: LineEnding::Crlf });
    }

    #[test]
    fn decode_utf16be_with_bom() {
        let bytes = [0xFE, 0xFF, 0, b'o', 0, b'k'];
        let d = decode(&bytes).unwrap();
        assert_eq!(d.text, "ok");
        assert_eq!(d.format.encoding, Encoding::Utf16Be);
    }

    #[test]
    fn decode_rejects_invalid_utf8_with_reason() {
        let err = decode(&[b'a', 0xFF, 0xFE, b'b']).unwrap_err();
        assert!(err.contains("not valid UTF-8"), "{err}");
    }

    #[test]
    fn decode_rejects_odd_length_utf16() {
        let err = decode(&[0xFF, 0xFE, b'h']).unwrap_err();
        assert!(err.contains("odd number"), "{err}");
    }

    #[test]
    fn roundtrip_preserves_bytes_for_each_format() {
        let samples: Vec<Vec<u8>> = vec![
            b"plain\nlf\n".to_vec(),
            b"win\r\ncrlf\r\n".to_vec(),
            b"\xEF\xBB\xBFbom\r\nfile\r\n".to_vec(),
            vec![0xFF, 0xFE, b'u', 0, b'\r', 0, b'\n', 0, 0x3B, 0x4E], // UTF-16 LE incl. a CJK char
            vec![0xFE, 0xFF, 0, b'b', 0, b'e', 0, b'\n'],
        ];
        for bytes in samples {
            let d = decode(&bytes).unwrap();
            assert_eq!(encode(&d.text, d.format), bytes, "roundtrip failed for {:?}", bytes);
        }
    }

    #[test]
    fn encode_applies_crlf_without_doubling() {
        // Editor text is LF; a stray CR must not become CRCRLF.
        let out = encode("a\nb\r\nc", TextFormat { encoding: Encoding::Utf8, bom: false, eol: LineEnding::Crlf });
        assert_eq!(out, b"a\r\nb\r\nc");
    }

    #[test]
    fn line_ending_majority_vote() {
        assert_eq!(detect_line_ending("no newlines"), LineEnding::Lf);
        assert_eq!(detect_line_ending("a\r\nb\r\nc\n"), LineEnding::Crlf);
        assert_eq!(detect_line_ending("a\nb\nc\r\n"), LineEnding::Lf);
        assert_eq!(detect_line_ending("a\rb\rc"), LineEnding::Lf);
    }

    #[test]
    fn normalize_handles_lone_cr() {
        assert_eq!(normalize_newlines("a\rb\r\nc\n"), "a\nb\nc\n");
        assert_eq!(normalize_newlines("untouched\n"), "untouched\n");
    }

    #[test]
    fn resolve_relative_against_other_cwd() {
        let cwd = Path::new("/work/docs");
        assert_eq!(resolve_path_arg("notes.md", Some(cwd)), PathBuf::from("/work/docs/notes.md"));
        assert_eq!(resolve_path_arg("/abs/notes.md", Some(cwd)), PathBuf::from("/abs/notes.md"));
        assert_eq!(resolve_path_arg("notes.md", None), PathBuf::from("notes.md"));
    }

    #[cfg(windows)]
    #[test]
    fn resolve_windows_drive_path_is_absolute() {
        assert_eq!(resolve_path_arg(r"C:\x\a.md", Some(Path::new(r"D:\cwd"))), PathBuf::from(r"C:\x\a.md"));
        assert_eq!(resolve_path_arg(r"sub\a.md", Some(Path::new(r"D:\cwd"))), PathBuf::from(r"D:\cwd\sub\a.md"));
    }

    fn v(id: &str, ts: i64) -> VersionEntry {
        VersionEntry { id: id.into(), timestamp_unix: ts, label: String::new(), author: None }
    }

    #[test]
    fn merge_is_newest_first_and_git_wins_ties() {
        let git = vec![v("c3", 300), v("c1", 100)];
        let snaps = vec![v("400", 400), v("300", 300), v("50", 50)];
        let merged = merge_versions(git, snaps);
        let ids: Vec<&str> = merged.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["400", "c3", "300", "c1", "50"]);
    }

    #[test]
    fn snapshot_id_detection() {
        assert!(is_snapshot_id("1718000000"));
        assert!(!is_snapshot_id("a7345e6fbafbee4476403fa7e708083816028aac"));
        assert!(!is_snapshot_id(""));
        assert!(!is_snapshot_id("12ab"));
    }
}

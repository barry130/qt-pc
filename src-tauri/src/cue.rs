//! CUE Sheet parsing. Offsets use CD frames (75 frames per second), never decimals.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CueTrack {
    pub path: PathBuf,
    pub number: u32,
    pub title: Option<String>,
    pub performer: Option<String>,
    pub album: Option<String>,
    pub start_ms: u64,
    pub end_ms: Option<u64>,
}

/// A virtual local ID is `<physical audio path>#cue:<track number>`.
/// Only a terminal, nonempty ASCII decimal suffix is reserved.
pub fn strip_cue_suffix(id: &str) -> &str {
    match id.rsplit_once("#cue:") {
        Some((path, number))
            if !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()) =>
        {
            path
        }
        _ => id,
    }
}

pub fn is_cue_file(path: &Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("cue"))
}

/// UTF-8 (optionally BOM-prefixed), then the GB18030 superset of GBK/GB2312.
fn decode(bytes: &[u8]) -> Result<String, String> {
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    if let Ok(text) = std::str::from_utf8(bytes) {
        return Ok(text.to_owned());
    }
    let (text, _, malformed) = encoding_rs::GB18030.decode(bytes);
    if malformed {
        Err("CUE text is neither valid UTF-8 nor GB18030".into())
    } else {
        Ok(text.into_owned())
    }
}

/// Consume one CUE token, respecting quoted filenames and metadata with spaces.
fn token(text: &str) -> Option<(&str, &str)> {
    let text = text.trim_start();
    if let Some(rest) = text.strip_prefix('"') {
        let end = rest.find('"')?;
        Some((&rest[..end], &rest[end + 1..]))
    } else {
        let end = text.find(char::is_whitespace).unwrap_or(text.len());
        (end > 0).then_some((&text[..end], &text[end..]))
    }
}

fn value(text: &str) -> Option<String> {
    let text = text.trim();
    let text = if text.starts_with('"') {
        token(text)?.0
    } else {
        text
    };
    (!text.trim().is_empty()).then(|| text.trim().to_owned())
}

fn timestamp(text: &str) -> Option<u64> {
    let parts: Vec<&str> = text.trim().split(':').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    let minutes: u64 = parts[0].parse().ok()?;
    let seconds: u64 = parts[1].parse().ok()?;
    let frames: u64 = parts[2].parse().ok()?;
    if seconds >= 60 || frames >= 75 {
        return None;
    }
    minutes
        .checked_mul(60)?
        .checked_add(seconds)?
        .checked_mul(75)?
        .checked_add(frames)?
        .checked_mul(1000)
        .map(|n| n / 75)
}

#[derive(Default)]
struct PendingTrack {
    path: Option<PathBuf>,
    number: u32,
    audio: bool,
    title: Option<String>,
    performer: Option<String>,
    album: Option<String>,
    start_ms: Option<u64>,
    invalid: bool,
}

/// Parse a sheet relative to its containing directory. Missing FILEs are checked
/// by `read_cue`; this pure parser also makes malformed-sheet behavior testable.
/// Missing/invalid INDEX 01, duplicate numbers and non-increasing file offsets
/// are skipped. INDEX 00/PREGAP do not change the audible track boundary.
pub fn parse_cue(bytes: &[u8], directory: &Path) -> Result<Vec<CueTrack>, String> {
    let text = decode(bytes)?;
    let mut album = None;
    let mut performer = None;
    let mut file = None;
    let mut tracks: Vec<PendingTrack> = Vec::new();
    let mut current: Option<usize> = None;
    for line in text.lines() {
        let Some((command, rest)) = token(line) else {
            continue;
        };
        match command.to_ascii_uppercase().as_str() {
            "FILE" => {
                current = None;
                file = token(rest).and_then(|(name, _)| {
                    // Backslashes in Windows-generated sheets are separators on Unix too.
                    let name = name.replace('\\', "/");
                    let path = directory.join(name);
                    crate::local::is_audio_file(&path).then_some(path)
                });
            }
            "TRACK" => {
                let mut fields = rest.split_whitespace();
                let number = fields
                    .next()
                    .and_then(|v| v.parse::<u32>().ok())
                    .filter(|n| *n > 0);
                let audio = fields
                    .next()
                    .is_some_and(|v| v.eq_ignore_ascii_case("AUDIO"));
                tracks.push(PendingTrack {
                    path: file.clone(),
                    number: number.unwrap_or(0),
                    audio,
                    album: album.clone(),
                    performer: performer.clone(),
                    invalid: number.is_none(),
                    ..PendingTrack::default()
                });
                current = Some(tracks.len() - 1);
            }
            "TITLE" => {
                if let Some(i) = current {
                    tracks[i].title = value(rest);
                } else {
                    album = value(rest);
                }
            }
            "PERFORMER" => {
                if let Some(i) = current {
                    tracks[i].performer = value(rest).or_else(|| performer.clone());
                } else {
                    performer = value(rest);
                }
            }
            "INDEX" => {
                if let (Some(i), Some((index, time))) = (current, token(rest)) {
                    if index == "01" {
                        let offset = timestamp(time);
                        if tracks[i].start_ms.is_some() || offset.is_none() {
                            tracks[i].invalid = true;
                        }
                        tracks[i].start_ms = offset;
                    }
                }
            }
            _ => {}
        }
    }
    let mut out: Vec<CueTrack> = Vec::new();
    let mut numbers = std::collections::HashSet::new();
    let mut last_offsets = std::collections::HashMap::new();
    for track in tracks {
        let (Some(path), Some(start_ms)) = (track.path, track.start_ms) else {
            continue;
        };
        if track.invalid || !track.audio || !numbers.insert((path.clone(), track.number)) {
            continue;
        }
        if last_offsets
            .get(&path)
            .is_some_and(|last| start_ms <= *last)
        {
            continue;
        }
        last_offsets.insert(path.clone(), start_ms);
        if let Some(previous) = out.iter_mut().rev().find(|t| t.path == path) {
            previous.end_ms = Some(start_ms);
        }
        out.push(CueTrack {
            path,
            number: track.number,
            title: track.title,
            performer: track.performer,
            album: track.album,
            start_ms,
            end_ms: None,
        });
    }
    Ok(out)
}

/// Read a sheet; unavailable referenced audio files are ignored independently.
pub fn read_cue(path: &Path) -> Result<Vec<CueTrack>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let tracks = parse_cue(&bytes, path.parent().unwrap_or_else(|| Path::new(".")))?;
    Ok(tracks.into_iter().filter(|t| t.path.is_file()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cue_suffix_is_terminal_numeric_only() {
        for id in ["a#cue:1", "a#cue:002", "a#cue:999999999999999999999999"] {
            assert_eq!(strip_cue_suffix(id), "a");
        }
        for id in [
            "a#cue:",
            "a#cue:1.flac",
            "a#cue:-1",
            "a#cue:１",
            "a#cue:1/b.flac",
        ] {
            assert_eq!(strip_cue_suffix(id), id);
        }
        assert_eq!(strip_cue_suffix("a#cue:x.flac#cue:2"), "a#cue:x.flac");
    }

    #[test]
    fn cue_parser_uses_75fps_and_per_track_metadata() {
        let sheet = b"PERFORMER \"Album Artist\"\nTITLE \"Album\"\nFILE \"album.FLAC\" WAVE\nTRACK 01 AUDIO\nTITLE \"First\"\nINDEX 00 00:00:00\nINDEX 01 00:00:01\nTRACK 02 AUDIO\nPERFORMER \"Guest\"\nTITLE \"Second\"\nINDEX 01 01:02:74\n";
        let tracks = parse_cue(sheet, Path::new("music")).unwrap();
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].start_ms, 13);
        assert_eq!(tracks[0].end_ms, Some(62_986));
        assert_eq!(tracks[1].end_ms, None);
        assert_eq!(tracks[0].performer.as_deref(), Some("Album Artist"));
        assert_eq!(tracks[1].performer.as_deref(), Some("Guest"));
        assert_eq!(tracks[0].album.as_deref(), Some("Album"));
    }

    #[test]
    fn cue_multiple_files_restart_offsets() {
        let sheet = b"FILE \"one.wav\" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nINDEX 01 00:10:00\nFILE \"two.flac\" WAVE\nTRACK 03 AUDIO\nINDEX 01 00:00:00\nTRACK 04 AUDIO\nINDEX 01 00:20:00";
        let tracks = parse_cue(sheet, Path::new(".")).unwrap();
        assert_eq!(tracks.len(), 4);
        assert_eq!(tracks[0].end_ms, Some(10_000));
        assert_eq!(tracks[1].end_ms, None);
        assert_eq!(tracks[2].start_ms, 0);
        assert_eq!(tracks[2].end_ms, Some(20_000));
    }

    #[test]
    fn cue_encoding_utf8_bom_and_gb18030() {
        let sheet = "TITLE \"专辑𠀀\"\nFILE \"音乐.flac\" WAVE\nTRACK 01 AUDIO\nTITLE \"曲目\"\nINDEX 01 00:00:00";
        let mut bom = vec![0xef, 0xbb, 0xbf];
        bom.extend_from_slice(sheet.as_bytes());
        let gb = encoding_rs::GB18030.encode(sheet).0.into_owned();
        let expected = parse_cue(sheet.as_bytes(), Path::new(".")).unwrap();
        assert_eq!(parse_cue(&bom, Path::new(".")).unwrap(), expected);
        assert_eq!(parse_cue(&gb, Path::new(".")).unwrap(), expected);
    }

    #[test]
    fn cue_invalid_bounds_and_non_audio_references_are_skipped() {
        let sheet = b"FILE \"image.jpg\" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\nFILE \"album.flac\" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nINDEX 01 00:00:75\nTRACK 03 AUDIO\nINDEX 01 00:60:00\nTRACK 04 AUDIO\nINDEX 01 -1:00:00\nTRACK 05 AUDIO\nINDEX 01 00:00:00\nTRACK 06 AUDIO\nINDEX 01 00:20:00\nTRACK 07 AUDIO\nINDEX 01 00:10:00\nTRACK 08 AUDIO\nINDEX 01 999999999999999999:00:00";
        let tracks = parse_cue(sheet, Path::new(".")).unwrap();
        assert_eq!(
            tracks.iter().map(|t| t.number).collect::<Vec<_>>(),
            vec![1, 6]
        );
        assert_eq!(tracks[0].end_ms, Some(20_000));
    }
}

//! Preserve media offsets when a metadata writer grows `moov` (including a new ilst).
//! Work only on the caller's temporary copy; never guess offsets from the new tags.
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::ops::Range;
use std::path::Path;

type Result<T> = std::result::Result<T, String>;
#[derive(Clone)]
struct Table {
    width: usize,
    positions: Vec<u64>,
    offsets: Vec<u64>,
    owner: u32,
    data: u64,
    identity: Vec<u8>,
}
pub(crate) struct Layout {
    media: Vec<Range<u64>>,
    tables: Vec<Table>,
}
struct Atom {
    kind: [u8; 4],
    data: u64,
    end: u64,
}

fn read_at<const N: usize>(file: &mut File, offset: u64) -> Result<[u8; N]> {
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    let mut bytes = [0; N];
    file.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes)
}
fn atoms(file: &mut File, start: u64, end: u64) -> Result<Vec<Atom>> {
    let mut output = Vec::new();
    let mut position = start;
    while position < end {
        if end - position < 8 {
            return Err("truncated MP4 atom".into());
        }
        let header = read_at::<8>(file, position)?;
        let size = u32::from_be_bytes(header[..4].try_into().unwrap());
        let (length, header_len) = match size {
            0 => (end - position, 8),
            1 => {
                if end - position < 16 {
                    return Err("truncated extended MP4 atom".into());
                }
                (u64::from_be_bytes(read_at::<8>(file, position + 8)?), 16)
            }
            value => (u64::from(value), 8),
        };
        if length < header_len || length > end - position {
            return Err("invalid MP4 atom size".into());
        }
        output.push(Atom {
            kind: header[4..].try_into().unwrap(),
            data: position + header_len,
            end: position + length,
        });
        position += length;
    }
    Ok(output)
}
fn child(file: &mut File, parent: &Atom, kind: [u8; 4]) -> Result<Atom> {
    let mut found: Vec<_> = atoms(file, parent.data, parent.end)?
        .into_iter()
        .filter(|atom| atom.kind == kind)
        .collect();
    if found.len() != 1 {
        return Err(format!("missing or ambiguous MP4 child {kind:?}"));
    }
    Ok(found.pop().unwrap())
}
fn local_track_references(file: &mut File, track: &Atom) -> Result<Atom> {
    let media = child(file, track, *b"mdia")?;
    let info = child(file, &media, *b"minf")?;
    let data = child(file, &info, *b"dinf")?;
    let references = child(file, &data, *b"dref")?;
    if references.end - references.data < 8
        || read_at::<8>(file, references.data)? != [0, 0, 0, 0, 0, 0, 0, 1]
    {
        return Err("unsupported MP4 data references".into());
    }
    let entries = atoms(file, references.data + 8, references.end)?;
    if entries.len() != 1
        || entries[0].kind != *b"url "
        || entries[0].end - entries[0].data != 4
        || read_at::<4>(file, entries[0].data)? != [0, 0, 0, 1]
    {
        return Err("external MP4 media reference".into());
    }
    let samples = child(file, &info, *b"stbl")?;
    let descriptions = child(file, &samples, *b"stsd")?;
    if descriptions.end - descriptions.data < 8 {
        return Err("truncated MP4 sample descriptions".into());
    }
    let header = read_at::<8>(file, descriptions.data)?;
    let entries = atoms(file, descriptions.data + 8, descriptions.end)?;
    if header[..4] != [0; 4]
        || entries.is_empty()
        || u64::from(u32::from_be_bytes(header[4..].try_into().unwrap())) != entries.len() as u64
    {
        return Err("invalid MP4 sample descriptions".into());
    }
    for entry in entries {
        if entry.end - entry.data < 8 || read_at::<8>(file, entry.data)? != [0, 0, 0, 0, 0, 0, 0, 1]
        {
            return Err("unsupported MP4 sample data reference".into());
        }
    }
    Ok(samples)
}
fn metadata_tables(
    file: &mut File,
    atom: &Atom,
    depth: usize,
    output: &mut Vec<Table>,
) -> Result<()> {
    if atom.end - atom.data < 4 || read_at::<4>(file, atom.data)? != [0; 4] {
        return Err("unsupported MP4 metadata layout".into());
    }
    tables(file, atom.data + 4, atom.end, depth, output)
}
fn tables(
    file: &mut File,
    start: u64,
    end: u64,
    depth: usize,
    output: &mut Vec<Table>,
) -> Result<()> {
    if depth > 8 {
        return Err("MP4 container nesting limit".into());
    }
    for atom in atoms(file, start, end)? {
        match &atom.kind {
            b"trak" => {
                if depth != 0 || atom.end - atom.data > 16 * 1024 * 1024 {
                    return Err("unsupported MP4 track layout or size".into());
                }
                let sample_table = local_track_references(file, &atom)?;
                let header = child(file, &atom, *b"tkhd")?;
                let id_offset = match read_at::<1>(file, header.data)?[0] {
                    0 => 12,
                    1 => 20,
                    _ => return Err("unsupported MP4 track header".into()),
                };
                if header.end - header.data < id_offset + 4 {
                    return Err("truncated MP4 track identity".into());
                }
                let owner = u32::from_be_bytes(read_at::<4>(file, header.data + id_offset)?);
                if owner == 0 || output.iter().any(|table| table.owner == owner) {
                    return Err("ambiguous MP4 track identity".into());
                }
                let first = output.len();
                tables(file, atom.data, atom.end, depth + 1, output)?;
                if output.len() != first + 1
                    || !(sample_table.data..sample_table.end).contains(&output[first].data)
                {
                    return Err("ambiguous MP4 track chunk table".into());
                }
                let table = &mut output[first];
                let mut identity = vec![0; (atom.end - atom.data) as usize];
                file.seek(SeekFrom::Start(atom.data))
                    .map_err(|e| e.to_string())?;
                file.read_exact(&mut identity).map_err(|e| e.to_string())?;
                for position in &table.positions {
                    let start = usize::try_from(
                        position.checked_sub(atom.data).ok_or("foreign MP4 table")?,
                    )
                    .map_err(|_| "MP4 table position overflow")?;
                    let end = start
                        .checked_add(table.width)
                        .ok_or("MP4 table span overflow")?;
                    identity
                        .get_mut(start..end)
                        .ok_or("foreign MP4 table span")?
                        .fill(0);
                }
                table.owner = owner;
                table.identity = identity;
            }
            b"mdia" | b"minf" | b"stbl" | b"udta" => {
                tables(file, atom.data, atom.end, depth + 1, output)?
            }
            b"meta" => metadata_tables(file, &atom, depth + 1, output)?,
            b"saio" | b"iloc" | b"mvex" | b"cmov" | b"meco" => {
                return Err("unsupported MP4 auxiliary offsets".into())
            }
            b"stco" | b"co64" => {
                if atom.end - atom.data < 8 {
                    return Err("truncated MP4 chunk table".into());
                }
                let header = read_at::<8>(file, atom.data)?;
                if header[..4] != [0; 4] {
                    return Err("unsupported MP4 chunk table version".into());
                }
                let count = u64::from(u32::from_be_bytes(header[4..].try_into().unwrap()));
                let width = if &atom.kind == b"stco" { 4 } else { 8 };
                if count != (atom.end - atom.data - 8) / width
                    || (atom.end - atom.data - 8) % width != 0
                {
                    return Err("invalid MP4 chunk table count".into());
                }
                let mut table = Table {
                    width: width as usize,
                    positions: Vec::new(),
                    offsets: Vec::new(),
                    owner: 0,
                    data: atom.data,
                    identity: Vec::new(),
                };
                for index in 0..count {
                    let position = atom.data + 8 + index * width;
                    let offset = if width == 4 {
                        u64::from(u32::from_be_bytes(read_at::<4>(file, position)?))
                    } else {
                        u64::from_be_bytes(read_at::<8>(file, position)?)
                    };
                    table.positions.push(position);
                    table.offsets.push(offset);
                }
                output.push(table);
            }
            _ => {}
        }
    }
    Ok(())
}
pub(crate) fn capture(path: &Path) -> Result<Layout> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let length = file.metadata().map_err(|e| e.to_string())?.len();
    let mut layout = Layout {
        media: Vec::new(),
        tables: Vec::new(),
    };
    let mut movies = 0;
    for atom in atoms(&mut file, 0, length)? {
        match &atom.kind {
            b"mdat" => layout.media.push(atom.data..atom.end),
            b"moov" => {
                movies += 1;
                tables(&mut file, atom.data, atom.end, 0, &mut layout.tables)?;
            }
            b"meta" => metadata_tables(&mut file, &atom, 1, &mut layout.tables)?,
            b"udta" => tables(&mut file, atom.data, atom.end, 1, &mut layout.tables)?,
            b"moof" | b"sidx" | b"mfra" | b"mvex" | b"meco" => {
                return Err("unsupported MP4 offset/reference layout".into())
            }
            _ => {}
        }
    }
    if movies != 1
        || layout.media.is_empty()
        || layout.tables.is_empty()
        || layout.tables.iter().any(|table| table.owner == 0)
    {
        return Err("missing or unowned MP4 media/chunk tables".into());
    }
    for table in &layout.tables {
        for offset in &table.offsets {
            if !layout.media.iter().any(|range| range.contains(offset)) {
                return Err("MP4 chunk outside media data".into());
            }
        }
    }
    Ok(layout)
}

pub(crate) fn preserve(original: &Path, temporary: &Path, before: &Layout) -> Result<()> {
    let after = capture_tables_without_offset_validation(temporary)?;
    if before.media.len() != after.media.len() || before.tables.len() != after.tables.len() {
        return Err("MP4 media/table topology changed".into());
    }
    let mut source = File::open(original).map_err(|e| e.to_string())?;
    let mut target = OpenOptions::new()
        .read(true)
        .write(true)
        .open(temporary)
        .map_err(|e| e.to_string())?;
    let mut left = [0; 65_536];
    let mut right = [0; 65_536];
    for (old, new) in before.media.iter().zip(&after.media) {
        if old.end - old.start != new.end - new.start {
            return Err("MP4 media length changed".into());
        }
        source
            .seek(SeekFrom::Start(old.start))
            .map_err(|e| e.to_string())?;
        target
            .seek(SeekFrom::Start(new.start))
            .map_err(|e| e.to_string())?;
        let mut remaining = old.end - old.start;
        while remaining != 0 {
            let size = remaining.min(left.len() as u64) as usize;
            source
                .read_exact(&mut left[..size])
                .map_err(|e| e.to_string())?;
            target
                .read_exact(&mut right[..size])
                .map_err(|e| e.to_string())?;
            if left[..size] != right[..size] {
                return Err("MP4 audio bytes changed".into());
            }
            remaining -= size as u64;
        }
    }
    for (old, new) in before.tables.iter().zip(&after.tables) {
        if old.owner != new.owner
            || old.identity != new.identity
            || old.width != new.width
            || old.offsets.len() != new.offsets.len()
        {
            return Err("MP4 chunk table identity or topology changed".into());
        }
        for (offset, position) in old.offsets.iter().zip(&new.positions) {
            let index = before
                .media
                .iter()
                .position(|range| range.contains(offset))
                .unwrap();
            let corrected = after.media[index]
                .start
                .checked_add(offset - before.media[index].start)
                .ok_or("MP4 offset overflow")?;
            target
                .seek(SeekFrom::Start(*position))
                .map_err(|e| e.to_string())?;
            if new.width == 4 {
                let corrected = u32::try_from(corrected).map_err(|_| "MP4 stco offset overflow")?;
                target
                    .write_all(&corrected.to_be_bytes())
                    .map_err(|e| e.to_string())?;
            } else {
                target
                    .write_all(&corrected.to_be_bytes())
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

// The metadata writer may have left stale offsets, so validate topology first and
// derive their replacements exclusively from the captured original media ranges.
fn capture_tables_without_offset_validation(path: &Path) -> Result<Layout> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let length = file.metadata().map_err(|e| e.to_string())?.len();
    let mut layout = Layout {
        media: Vec::new(),
        tables: Vec::new(),
    };
    let mut movies = 0;
    for atom in atoms(&mut file, 0, length)? {
        match &atom.kind {
            b"mdat" => layout.media.push(atom.data..atom.end),
            b"moov" => {
                movies += 1;
                tables(&mut file, atom.data, atom.end, 0, &mut layout.tables)?;
            }
            b"meta" => metadata_tables(&mut file, &atom, 1, &mut layout.tables)?,
            b"udta" => tables(&mut file, atom.data, atom.end, 1, &mut layout.tables)?,
            b"moof" | b"sidx" | b"mfra" | b"mvex" | b"meco" => {
                return Err("unsupported MP4 offset/reference layout".into())
            }
            _ => {}
        }
    }
    if movies != 1
        || layout.media.is_empty()
        || layout.tables.is_empty()
        || layout.tables.iter().any(|table| table.owner == 0)
    {
        return Err("missing or unowned MP4 media/chunk tables".into());
    }
    Ok(layout)
}

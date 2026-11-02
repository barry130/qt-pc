//! 音频文件标签的读 / 写（A2 · 对照分析文档 §4.2，2026-11-01）。
//!
//! ## 为什么不复用 `embed.rs`
//! `embed.rs` 是「下载成品时把封面 / 歌词灌进文件」的单向通道，写入策略是
//! **只补缺、不覆盖**（音源自带的标签更权威）。标签编辑恰恰相反：用户写什么
//! 就是什么，包括清空。两者共用同一套 lofty 逻辑只会让两边的策略互相污染，
//! 所以这个模块独立实现，但**沿用同一条安全口径**：
//!
//! ## 安全口径（DESIGN §13「绝不毁歌」）
//! 绝不在原文件上原地改：先复制 `<原名>.tagtmp` 副本，在副本上读改写，成功后
//! `rename` 回去；任何一步失败都删副本，原文件字节不变。副本与原文件同目录
//! （`rename` 不能跨卷），扩展名不在白名单（`embed::SUPPORTED_EXTS`）的文件
//! 一律拒绝——「格式不支持」比「写坏一个文件」好得多。
//!
//! ## 哪些文件不能改
//! - CUE 虚拟分轨（`id` 形如 `D:/x.cue#cue:3`）：文件本身是整轨，改标签会
//!   毁掉分轨信息，直接 `Err`；
//! - 不在 `embed::SUPPORTED_EXTS` 白名单里的格式；
//! - 只读 / 被占用的文件（由 `std::fs::copy` 与 `rename` 报错，原文件不受影响）。
//!
//! ## 撤销
//! 本模块只负责「读原值 / 写新值 / 把原值整份写回」，留痕与撤销编排在
//! `db/store/tags.rs` 与 `commands.rs`（先记原值再动手，见
//! [`TagValues`] 与 `write_tags` 的调用顺序）。

use lofty::config::WriteOptions;
use lofty::file::TaggedFileExt;
use lofty::prelude::*;
use lofty::probe::Probe;
use lofty::tag::{ItemKey, ItemValue, Tag, TagItem, TagType};
use std::path::{Path, PathBuf};

/// 一首曲目在文件里的可编辑标签（整份快照，撤销时原样写回）。
///
/// 文本字段用 `String`（缺标签就是空串），数字字段用 `Option<u32>`（缺就是
/// `None`）—— 界面要区分「没有年份」与「年份是 0」，而空串与 `None` 对文本
/// 来说没有区别。
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagValues {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub genre: String,
    pub year: Option<u32>,
    pub track_no: Option<u32>,
    pub disc_no: Option<u32>,
}

/// 一次编辑要写的字段。`None` = 这一项不动。
///
/// 文本传空串 = 清掉这个标签；数字传 `Some(0)` = 清掉。两种「清空」都得能表达，
/// 否则用户没法把误填的年份抹掉。
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagPatch {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub genre: Option<String>,
    pub year: Option<u32>,
    pub track_no: Option<u32>,
    pub disc_no: Option<u32>,
}

impl TagPatch {
    /// 有没有任何一项要改（空 patch 直接拒绝，免得白做一次全文件 IO）。
    pub fn is_empty(&self) -> bool {
        self.title.is_none()
            && self.artist.is_none()
            && self.album.is_none()
            && self.album_artist.is_none()
            && self.genre.is_none()
            && self.year.is_none()
            && self.track_no.is_none()
            && self.disc_no.is_none()
    }
}

/// CUE 虚拟分轨：`D:/album.cue#cue:3`。整轨文件不该按单曲改标签。
pub fn is_cue_virtual(path: &str) -> bool {
    path.contains("#cue:")
}

/// 读一个文件的标签（不存在的字段给默认值）。
pub fn read_tags(path: &Path) -> Result<TagValues, String> {
    let tagged = Probe::open(path)
        .map_err(|e| format!("打开文件失败: {e}"))?
        .guess_file_type()
        .map_err(|e| format!("无法识别的音频内容: {e}"))?
        .read()
        .map_err(|e| format!("读取标签失败: {e}"))?;
    Ok(values_of(tagged.primary_tag()))
}

/// 把标签整份写回文件（撤销用）。与 [`write_tags`] 走同一条安全通道。
pub fn restore_tags(path: &Path, values: &TagValues) -> Result<(), String> {
    let patch = TagPatch {
        title: Some(values.title.clone()),
        artist: Some(values.artist.clone()),
        album: Some(values.album.clone()),
        album_artist: Some(values.album_artist.clone()),
        genre: Some(values.genre.clone()),
        year: Some(values.year.unwrap_or(0)),
        track_no: Some(values.track_no.unwrap_or(0)),
        disc_no: Some(values.disc_no.unwrap_or(0)),
    };
    write_tags(path, &patch).map(|_| ())
}

/// 改一个文件的标签，返回写完之后**重新读回**的值。
///
/// 返回写回后的值而不是把 patch 合并进旧值：容器支持哪些字段（比如 WAV 的
/// ID3v2 不认 `AlbumArtist`）由 lofty 决定，界面应当看到文件里真实的内容。
pub fn write_tags(path: &Path, patch: &TagPatch) -> Result<TagValues, String> {
    if patch.is_empty() {
        return Err("没有任何要修改的字段".to_string());
    }
    if is_cue_virtual(&path.to_string_lossy()) {
        return Err("CUE 分轨是虚拟曲目，不能单独改标签".to_string());
    }
    if !ext_supported(path) {
        return Err(format!(
            "不支持写这个格式的标签：{}",
            path.extension()
                .and_then(|e| e.to_str())
                .unwrap_or("(无扩展名)")
        ));
    }
    let tmp = tmp_sibling(path);
    std::fs::copy(path, &tmp).map_err(|e| format!("复制临时副本失败（文件可能只读或被占用）: {e}"))?;

    let outcome = (|| -> Result<(), String> {
        // `.tagtmp` 猜不出类型，必须按内容重新探测（同 embed.rs）
        let mut tagged = Probe::open(&tmp)
            .map_err(|e| format!("打开临时副本失败: {e}"))?
            .guess_file_type()
            .map_err(|e| format!("无法识别的音频内容: {e}"))?
            .read()
            .map_err(|e| format!("读取标签失败: {e}"))?;
        // 原本没有标签的文件：按目标格式的主标签类型新建（与 embed.rs 同口径），
        // 否则 mp3 这种必须已有 ID3v2 才能写
        if tagged.primary_tag_mut().is_none() {
            let tag_type = tagged.primary_tag_type();
            tagged.insert_tag(Tag::new(tag_type));
        }
        let tag = tagged
            .primary_tag_mut()
            .ok_or_else(|| "这个容器不支持写入标签".to_string())?;
        apply(tag, patch);
        tag.save_to_path(&tmp, WriteOptions::default())
            .map_err(|e| format!("标签写回失败: {e}"))
    })();

    match outcome {
        Ok(()) => match std::fs::rename(&tmp, path) {
            Ok(()) => read_tags(path),
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                Err(format!("替换原文件失败: {e}"))
            }
        },
        Err(why) => {
            let _ = std::fs::remove_file(&tmp);
            Err(why)
        }
    }
}

/// 把 patch 落到 `Tag` 上：`Some(空串)` / `Some(0)` 是清除。
fn apply(tag: &mut Tag, patch: &TagPatch) {
    put_text(tag, ItemKey::TrackTitle, patch.title.as_deref());
    put_text(tag, ItemKey::TrackArtist, patch.artist.as_deref());
    put_text(tag, ItemKey::AlbumTitle, patch.album.as_deref());
    put_text(tag, ItemKey::AlbumArtist, patch.album_artist.as_deref());
    put_text(tag, ItemKey::Genre, patch.genre.as_deref());
    put_year(tag, patch.year);
    put_number(tag, ItemKey::TrackNumber, patch.track_no);
    put_number(tag, ItemKey::DiscNumber, patch.disc_no);
}

fn put_text(tag: &mut Tag, key: ItemKey, value: Option<&str>) {
    match value {
        None => {}
        Some(v) if v.trim().is_empty() => tag.remove_key(key),
        Some(v) => {
            tag.insert(TagItem::new(
                key,
                ItemValue::Text(v.trim().to_string()),
            ));
        }
    }
}

/// 年份不能直接写 `ItemKey::Year`：lofty 的 `Accessor::set_date` 是「删 Year、
/// 写 RecordingDate」，ID3v2 只认 TDRC（RecordingDate），单写 Year 会写进一个
/// 读不回来的位置（自测发现：写完 `get_string(Year)` 返回 None）。ID3v1 例外，
/// 它只有 4 位的 year 字段。
fn put_year(tag: &mut Tag, value: Option<u32>) {
    match value {
        None => {}
        Some(0) => {
            tag.remove_key(ItemKey::RecordingDate);
            tag.remove_key(ItemKey::Year);
        }
        Some(n) => {
            if tag.tag_type() == TagType::Id3v1 {
                tag.insert(TagItem::new(
                    ItemKey::Year,
                    ItemValue::Text(n.to_string()),
                ));
            } else {
                tag.remove_key(ItemKey::Year);
                tag.insert(TagItem::new(
                    ItemKey::RecordingDate,
                    ItemValue::Text(n.to_string()),
                ));
            }
        }
    }
}

/// 年份读回：新写的文件只有 `RecordingDate`（`"2019"` 或 `"2019-05-01"`），
/// 老文件可能只有 ID3v1 的 `Year`。
fn year_of(tag: &Tag) -> Option<u32> {
    number(tag, ItemKey::RecordingDate).or_else(|| number(tag, ItemKey::Year))
}

fn put_number(tag: &mut Tag, key: ItemKey, value: Option<u32>) {
    match value {
        None => {}
        Some(0) => tag.remove_key(key),
        Some(n) => {
            tag.insert(TagItem::new(key, ItemValue::Text(n.to_string())));
        }
    }
}

/// 标签 → 整份快照。
fn values_of(tag: Option<&Tag>) -> TagValues {
    let Some(tag) = tag else {
        return TagValues::default();
    };
    TagValues {
        title: text(tag, ItemKey::TrackTitle),
        artist: text(tag, ItemKey::TrackArtist),
        album: text(tag, ItemKey::AlbumTitle),
        album_artist: text(tag, ItemKey::AlbumArtist),
        genre: text(tag, ItemKey::Genre),
        year: year_of(tag),
        track_no: number(tag, ItemKey::TrackNumber),
        disc_no: number(tag, ItemKey::DiscNumber),
    }
}

fn text(tag: &Tag, key: ItemKey) -> String {
    tag.get_string(key).unwrap_or("").trim().to_string()
}

/// 曲号 / 年份这些字段有的写入器会存成 `"3/12"` 或 `"2019-05-01"`：
/// 只取开头能解析的整数，解析不了就当没有（界面显示空，而不是一段垃圾）。
fn number(tag: &Tag, key: ItemKey) -> Option<u32> {
    let raw = tag.get_string(key)?;
    let head: String = raw
        .trim()
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    head.parse().ok()
}

fn ext_supported(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            crate::embed::SUPPORTED_EXTS.contains(&e.to_ascii_lowercase().as_str())
        })
        .unwrap_or(false)
}

/// `<原名>.tagtmp`：同目录（rename 不能跨卷），扩展名不在白名单，绝不会被
/// 扫描器当成音频。
fn tmp_sibling(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".tagtmp");
    PathBuf::from(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一个真实的最小 MP3（0.05 秒 440Hz 正弦，与 embed.rs 同源的那段字节）。
    /// 手搓无效帧会被 lofty 拒收，所以直接复用 embed.rs 里的常量。
    fn write_minimal_mp3(path: &Path) {
        let bytes = crate::embed::tests::MINIMAL_MP3;
        std::fs::write(path, bytes).expect("写最小 mp3");
    }

    fn temp_path(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "qt-tags-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        dir.join("a.mp3")
    }

    #[test]
    fn writes_and_reads_back_every_editable_field() {
        let path = temp_path("write");
        write_minimal_mp3(&path);
        let patch = TagPatch {
            title: Some("夜航".into()),
            artist: Some("某人".into()),
            album: Some("深水".into()),
            album_artist: Some("群星".into()),
            genre: Some("Ambient".into()),
            year: Some(2019),
            track_no: Some(3),
            disc_no: Some(1),
        };
        let after = write_tags(&path, &patch).expect("写标签");
        assert_eq!(after.title, "夜航");
        assert_eq!(after.artist, "某人");
        assert_eq!(after.album, "深水");
        assert_eq!(after.album_artist, "群星");
        assert_eq!(after.genre, "Ambient");
        assert_eq!(after.year, Some(2019));
        assert_eq!(after.track_no, Some(3));
        assert_eq!(after.disc_no, Some(1));
        // 落盘的字节真的变了：读回来（新开文件）也是同一份
        assert_eq!(read_tags(&path).unwrap(), after);
        // 临时副本收干净了
        assert!(!tmp_sibling(&path).exists(), "临时副本必须删掉/被 rename 走");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn empty_string_and_zero_clear_the_tag() {
        let path = temp_path("clear");
        write_minimal_mp3(&path);
        write_tags(
            &path,
            &TagPatch {
                title: Some("有标题".into()),
                year: Some(2020),
                ..Default::default()
            },
        )
        .unwrap();
        let after = write_tags(
            &path,
            &TagPatch {
                title: Some(String::new()),
                year: Some(0),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(after.title, "");
        assert_eq!(after.year, None);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn untouched_fields_survive_an_edit() {
        let path = temp_path("keep");
        write_minimal_mp3(&path);
        write_tags(
            &path,
            &TagPatch {
                title: Some("标题".into()),
                artist: Some("歌手".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let after = write_tags(
            &path,
            &TagPatch {
                album: Some("专辑".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(after.title, "标题");
        assert_eq!(after.artist, "歌手");
        assert_eq!(after.album, "专辑");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn restore_puts_the_original_snapshot_back() {
        let path = temp_path("restore");
        write_minimal_mp3(&path);
        let before = write_tags(
            &path,
            &TagPatch {
                title: Some("原值".into()),
                artist: Some("原歌手".into()),
                year: Some(1999),
                ..Default::default()
            },
        )
        .unwrap();
        write_tags(
            &path,
            &TagPatch {
                title: Some("改坏了".into()),
                artist: Some("改坏了".into()),
                year: Some(2024),
                ..Default::default()
            },
        )
        .unwrap();
        restore_tags(&path, &before).expect("撤销");
        assert_eq!(read_tags(&path).unwrap(), before);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn refuses_cue_virtual_unsupported_and_empty_patch() {
        let path = temp_path("refuse");
        write_minimal_mp3(&path);
        let err = write_tags(Path::new("D:/a.cue#cue:3"), &TagPatch {
            title: Some("x".into()),
            ..Default::default()
        })
        .unwrap_err();
        assert!(err.contains("CUE"), "{err}");

        // 白名单外的扩展名：先造一个同名 txt
        let txt = path.with_extension("txt");
        std::fs::write(&txt, b"x").unwrap();
        let err = write_tags(&txt, &TagPatch {
            title: Some("x".into()),
            ..Default::default()
        })
        .unwrap_err();
        assert!(err.contains("不支持"), "{err}");

        let err = write_tags(&path, &TagPatch::default()).unwrap_err();
        assert!(err.contains("没有任何要修改"), "{err}");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn number_fields_tolerate_writer_quirks() {
        // "3/12"、"2019-05-01" 这类写法取开头整数；纯垃圾当没有
        assert_eq!(
            {
                let mut tag = Tag::new(lofty::tag::TagType::Id3v2);
                tag.insert(TagItem::new(
                    ItemKey::TrackNumber,
                    ItemValue::Text("3/12".into()),
                ));
                number(&tag, ItemKey::TrackNumber)
            },
            Some(3)
        );
        assert_eq!(
            {
                // 正常写入的年份落在 RecordingDate（`ItemKey::Year` 在 ID3v2 没有
                // 映射，`Tag::insert` 会直接拒绝——这是自测踩过的坑）
                let mut tag = Tag::new(lofty::tag::TagType::Id3v2);
                tag.insert(TagItem::new(
                    ItemKey::RecordingDate,
                    ItemValue::Text("2019-05-01".into()),
                ));
                year_of(&tag)
            },
            Some(2019)
        );
        assert_eq!(
            {
                // 老写入器可能直接塞一个 YEAR 键（`insert_unchecked` 绕过映射校验），
                // 读回要能兜住
                let mut tag = Tag::new(lofty::tag::TagType::VorbisComments);
                tag.insert_unchecked(TagItem::new(
                    ItemKey::Year,
                    ItemValue::Text("2019".into()),
                ));
                year_of(&tag)
            },
            Some(2019)
        );
        assert_eq!(
            {
                let mut tag = Tag::new(lofty::tag::TagType::Id3v2);
                tag.insert_unchecked(TagItem::new(
                    ItemKey::Year,
                    ItemValue::Text("不详".into()),
                ));
                year_of(&tag)
            },
            None
        );
    }
}

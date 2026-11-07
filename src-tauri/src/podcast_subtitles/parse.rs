use super::{Cue, SubtitleDocument, TranscriptLink};

pub fn transcript_links(xml: &str) -> Vec<TranscriptLink> {
    let mut reader = quick_xml::Reader::from_str(xml);
    let mut links = Vec::new();
    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Start(e) | quick_xml::events::Event::Empty(e))
                if e.local_name().as_ref() == "transcript" =>
            {
                let mut link = TranscriptLink::default();
                for attr in e.attributes().flatten() {
                    let Ok(value) = attr.normalized_value(quick_xml::XmlVersion::Implicit1_0)
                    else {
                        continue;
                    };
                    match attr.key.as_ref() {
                        "url" => link.url = value.into_owned(),
                        "type" => link.mime = value.into_owned(),
                        "language" => link.language = value.into_owned(),
                        _ => {}
                    }
                }
                if !link.url.is_empty() && links.len() < 16 {
                    links.push(link);
                }
            }
            Ok(quick_xml::events::Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    links
}

fn timestamp(raw: &str) -> Option<i64> {
    let normalized = raw.trim().replace(',', ".");
    let parts: Vec<_> = normalized.split(':').collect();
    if !(2..=3).contains(&parts.len()) {
        return None;
    }
    let mut seconds = 0.0;
    for (index, part) in parts.iter().enumerate() {
        let value = part.parse::<f64>().ok()?;
        if !value.is_finite() || value < 0.0 || (index > 0 && value >= 60.0) {
            return None;
        }
        seconds = seconds * 60.0 + value;
    }
    (seconds <= 172_800.0).then_some((seconds * 1000.0).round() as i64)
}

/// VTT 的样式/说话人标签不作为 HTML 执行；字幕视图始终输出纯文本。
pub fn plain(raw: &str) -> String {
    let mut inside = false;
    let mut text = String::new();
    for ch in raw.chars() {
        match ch {
            '<' => inside = true,
            '>' => inside = false,
            _ if !inside => text.push(ch),
            _ => {}
        }
    }
    quick_xml::escape::unescape(&text)
        .unwrap_or(std::borrow::Cow::Borrowed(&text))
        .trim()
        .to_owned()
}

pub fn parse(raw: &str, format: &str) -> Result<SubtitleDocument, String> {
    if raw.len() > 8 * 1024 * 1024 {
        return Err("字幕文件超过 8 MB".into());
    }
    let text = raw
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let mut document = SubtitleDocument::default();
    if text.trim_start().starts_with('{') || text.trim_start().starts_with('[') {
        let value: serde_json::Value =
            serde_json::from_str(&text).map_err(|_| "字幕 JSON 无法解析")?;
        let items = value
            .get("segments")
            .or_else(|| value.get("cues"))
            .unwrap_or(&value)
            .as_array()
            .ok_or("字幕 JSON 缺少 segments")?;
        for item in items {
            let start = item
                .get("startTime")
                .or_else(|| item.get("start"))
                .and_then(|v| v.as_f64());
            let end = item
                .get("endTime")
                .or_else(|| item.get("end"))
                .and_then(|v| v.as_f64());
            if let (Some(start), Some(end)) = (start, end) {
                let body = item
                    .get("body")
                    .or_else(|| item.get("text"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                document.cues.push(Cue {
                    start_ms: (start * 1000.0).round() as i64,
                    end_ms: (end * 1000.0).round() as i64,
                    text: plain(body),
                    translation: String::new(),
                    chunk_index: None,
                });
            }
        }
    } else if text.contains("-->") {
        for block in text.split("\n\n") {
            let mut lines = block.lines();
            let first = lines.next().unwrap_or("").trim();
            if first == "STYLE" || first == "REGION" || first.starts_with("NOTE") {
                continue;
            }
            let timeline = if first.contains("-->") {
                Some(first)
            } else {
                lines.find(|line| line.contains("-->"))
            };
            let Some((start, end)) = timeline.and_then(|line| line.split_once("-->")) else {
                continue;
            };
            let (Some(start_ms), Some(end_ms)) = (
                timestamp(start),
                end.split_whitespace().next().and_then(timestamp),
            ) else {
                continue;
            };
            document.cues.push(Cue {
                start_ms,
                end_ms,
                text: plain(&lines.collect::<Vec<_>>().join("\n")),
                translation: String::new(),
                chunk_index: None,
            });
        }
    } else if format.to_lowercase().contains("txt") || format.to_lowercase().contains("text/plain")
    {
        document.timed = false;
        // 无时间轴的文字稿可阅读、翻译，但不会伪造逐句播放时间。
        for paragraph in text
            .split('\n')
            .map(str::trim)
            .filter(|line| !line.is_empty())
        {
            let chars: Vec<_> = paragraph.chars().collect();
            for chunk in chars.chunks(800) {
                document.cues.push(Cue {
                    start_ms: 0,
                    end_ms: 0,
                    text: chunk.iter().collect(),
                    translation: String::new(),
                    chunk_index: None,
                });
            }
        }
    } else {
        return Err("未找到有效时间轴，请选择 SRT、VTT、JSON 或 TXT 字幕".into());
    }
    document.cues.retain(|cue| {
        !cue.text.is_empty()
            && cue.text.len() <= 16_000
            && (!document.timed
                || (cue.start_ms >= 0 && cue.end_ms > cue.start_ms && cue.end_ms <= 172_800_000))
    });
    if document.cues.is_empty() || document.cues.len() > 30_000 {
        return Err("字幕为空、格式无效或超过 30000 句".into());
    }
    document.cues.sort_by_key(|cue| cue.start_ms);
    document.duration_ms = document
        .cues
        .iter()
        .map(|cue| cue.end_ms)
        .max()
        .unwrap_or(0);
    Ok(document)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rss_links_entities_and_multiple_languages() {
        let links = transcript_links(
            r#"<item><podcast:transcript url="/t.vtt?a=1&amp;b=2" type="text/vtt" language="en"/><podcast:transcript url='https://a.test/cn.srt' language='zh'/></item>"#,
        );
        assert_eq!(links.len(), 2);
        assert_eq!(links[0].url, "/t.vtt?a=1&b=2");
        assert_eq!(links[0].language, "en");
    }
    #[test]
    fn srt_vtt_multiline_offsets_and_non_cue_blocks() {
        let doc = parse("\u{feff}WEBVTT\r\n\r\nNOTE ignored\r\n\r\ncue-1\r\n00:01.200 --> 00:04.500 align:start\r\n<v Jane>Hello &amp; welcome</v>\r\nSecond line\r\n\r\nSTYLE\r\n::cue {color:red}", "vtt").unwrap();
        assert_eq!(doc.cues.len(), 1);
        assert_eq!(doc.cues[0].start_ms, 1200);
        assert_eq!(doc.cues[0].text, "Hello & welcome\nSecond line");
        assert_eq!(
            parse("1\n01:02:03,250 --> 01:02:05,000\nHello", "srt")
                .unwrap()
                .cues[0]
                .start_ms,
            3_723_250
        );
    }
    #[test]
    fn json_and_untimed_text_do_not_invent_timestamps() {
        let doc = parse(
            r#"{"segments":[{"startTime":1.5,"endTime":3,"body":"Hello"}]}"#,
            "json",
        )
        .unwrap();
        assert_eq!(doc.cues[0].end_ms, 3000);
        let plain = parse("Hello\nWorld", "txt").unwrap();
        assert!(!plain.timed);
        assert!(parse("1\n00:05,000 --> 00:03,000\nBad", "srt").is_err());
        assert!(parse("not subtitles", "srt").is_err());
    }
}

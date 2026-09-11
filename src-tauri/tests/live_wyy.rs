//! 四音源真实链路无头验证。
//!
//! 覆盖：Provider 移植正确性（响应解析、请求头、取址）与
//! HttpRangeReader 流式链路（Range 206 / 顺序读 / seek 重定位）。
//!
//! 全部标记 `#[ignore]`（依赖外网，常规 `cargo test` 不跑）。手动执行：
//! `cargo test --test live_wyy -- --ignored`

use std::io::{Read, Seek, SeekFrom};

use lightlisten_lib::audio::range_reader;
use lightlisten_lib::provider::types::{Quality, SourceId, Track};
use lightlisten_lib::provider::{KgProvider, KwProvider, MusicProvider, QqProvider, WyyProvider};

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime")
}

async fn search_first_wyy(provider: &WyyProvider, kw: &str) -> Track {
    let tracks = provider
        .search_tracks(kw, 1, 5)
        .await
        .expect("search_tracks 失败");
    assert!(!tracks.is_empty(), "搜索无结果");
    tracks[0].clone()
}

#[test]
#[ignore = "需要外网访问 music.163.com"]
fn live_search_returns_tracks() {
    let provider = WyyProvider::new();
    runtime().block_on(async {
        let tracks = provider
            .search_tracks("海阔天空 Beyond", 1, 10)
            .await
            .expect("搜索失败");
        assert!(!tracks.is_empty(), "搜索无结果");
        assert!(!tracks[0].title.is_empty());
        assert!(!tracks[0].id.is_empty());
    });
}

#[test]
#[ignore = "需要外网访问 music.163.com"]
fn live_lyric_returns_lrc() {
    let provider = WyyProvider::new();
    runtime().block_on(async {
        let track = search_first_wyy(&provider, "海阔天空 Beyond").await;
        let lyric = provider.lyric(&track).await.expect("取歌词失败");
        assert!(lyric.lrc.contains("["), "歌词不是 LRC 格式");
    });
}

#[test]
#[ignore = "需要外网访问 music.163.com"]
fn live_play_url_resolves() {
    let provider = WyyProvider::new();
    runtime().block_on(async {
        let track = search_first_wyy(&provider, "海阔天空 Beyond").await;
        let url = provider
            .play_url(&track, Quality::High)
            .await
            .expect("取播放地址失败");
        assert!(url.starts_with("http"), "非法播放地址: {url}");
    });
}

#[test]
#[ignore = "需要外网访问 music.163.com 与音频 CDN"]
fn live_http_range_reader_streams_and_seeks() {
    let provider = WyyProvider::new();
    let rt = runtime();
    let url = rt.block_on(async {
        let track = search_first_wyy(&provider, "海阔天空 Beyond").await;
        provider
            .play_url(&track, Quality::High)
            .await
            .expect("取播放地址失败")
    });
    drop(rt); // reqwest::blocking 不能在 tokio runtime 上下文中使用

    let client = reqwest::blocking::Client::builder()
        .user_agent("Mozilla/5.0")
        .build()
        .expect("blocking client");
    let cache_dir = std::path::PathBuf::from("target/live-test-cache");
    let (mut reader, shared) =
        range_reader::open(&url, &client, &cache_dir).expect("HttpRangeReader 打开失败");

    // 网易云音频 CDN 支持 Range，必须走流式而非 spool
    assert!(shared.supports_ranges(), "服务端不支持 Range，退化为 spool 模式");

    // 顺序读头部 64KB（覆盖 symphonia 解码器探针场景）
    let mut head = vec![0u8; 64 * 1024];
    let mut got = 0usize;
    while got < head.len() {
        match reader.read(&mut head[got..]) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(e) => panic!("顺序读失败: {e}"),
        }
    }
    assert_eq!(got, head.len(), "头部 64KB 未读满（got={got}）");

    // seek 到 1MB 处再读（Range 重定位链路，含前向跳过的空洞回填）
    let total = shared.total_len().expect("总长未知");
    if total > 2 * 1024 * 1024 {
        reader.seek(SeekFrom::Start(1024 * 1024)).unwrap();
        let mut buf = [0u8; 4096];
        let n = reader.read(&mut buf).expect("seek 后读失败");
        assert!(n > 0, "seek 后未读到数据");
    }
}

// ---------- qq / kw / kg 真实链路（与 wyy 相同的 搜索→取址→歌词 三步） ----------

async fn full_chain(
    provider: &dyn MusicProvider,
    source: SourceId,
    kw: &str,
) -> (Track, String, String) {
    let tracks = provider
        .search_tracks(kw, 1, 5)
        .await
        .unwrap_or_else(|e| panic!("{source} 搜索失败: {e}"));
    assert!(!tracks.is_empty(), "{source} 搜索无结果");
    let track = tracks[0].clone();
    let url = provider
        .play_url(&track, Quality::Standard)
        .await
        .unwrap_or_else(|e| panic!("{source} 取址失败: {e}"));
    assert!(url.starts_with("http"), "{source} 非法播放地址: {url}");
    let lyric = provider
        .lyric(&track)
        .await
        .unwrap_or_else(|e| panic!("{source} 取歌词失败: {e}"));
    (track, url, lyric.lrc)
}

#[test]
#[ignore = "需要外网访问 c.y.qq.com"]
fn live_qq_chain() {
    let provider = QqProvider::new();
    runtime().block_on(async {
        let (track, url, lrc) = full_chain(&provider, SourceId::Qq, "海阔天空 Beyond").await;
        assert_eq!(track.platform, SourceId::Qq);
        println!("[qq] {} - {} url_host={}", track.title, track.singer, host_of(&url));
        assert!(!lrc.is_empty(), "qq 歌词为空");
    });
}

#[test]
#[ignore = "需要外网访问 kuwo.cn / mobi.kuwo.cn"]
fn live_kw_chain() {
    let provider = KwProvider::new();
    runtime().block_on(async {
        let (track, url, _lrc) = full_chain(&provider, SourceId::Kw, "海阔天空 Beyond").await;
        assert_eq!(track.platform, SourceId::Kw);
        println!("[kw] {} - {} url_host={}", track.title, track.singer, host_of(&url));
    });
}

#[test]
#[ignore = "需要外网访问 kugou.com"]
fn live_kg_chain() {
    let provider = KgProvider::new();
    runtime().block_on(async {
        let (track, url, _lrc) = full_chain(&provider, SourceId::Kg, "海阔天空 Beyond").await;
        assert_eq!(track.platform, SourceId::Kg);
        println!("[kg] {} - {} url_host={}", track.title, track.singer, host_of(&url));
    });
}


#[test]
#[ignore = "需要外网访问 music.163.com 与视频 CDN"]
fn live_mv_url_and_range_passthrough() {
    let provider = WyyProvider::new();
    let rt = runtime();
    let url = rt.block_on(async {
        provider
            .video_url("14689667", "auto")
            .await
            .expect("取 MV 地址失败")
    });
    drop(rt);
    assert!(url.starts_with("http"), "非法 MV 地址: {url}");

    // Range 透传语义验证（qtres mv 转发的就是这两类响应）：
    // 无 Range → 200；带 Range → 206 + Content-Range
    let client = reqwest::blocking::Client::new();
    let partial = client
        .get(&url)
        .header("User-Agent", "Mozilla/5.0")
        .header("Range", "bytes=0-1023")
        .send()
        .unwrap();
    assert_eq!(partial.status().as_u16(), 206, "上游不支持 Range");
    assert!(partial.headers().get("content-range").is_some(), "缺少 Content-Range");
    let body = partial.bytes().unwrap();
    assert_eq!(body.len(), 1024, "Range 长度不符");
}

fn host_of(url: &str) -> String {
    url.split("//")
        .nth(1)
        .unwrap_or("")
        .split('/')
        .next()
        .unwrap_or("")
        .to_string()
}

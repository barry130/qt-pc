//! 发现类能力（M5/M6）真实链路验证。
//!
//! 覆盖四音源的 歌单分类 / 推荐歌单 / 排行榜 / 新歌 / 热词，
//! 以及 wyy 的榜单详情、歌单详情、三类搜索（其余音源同样调用但只做记录）。
//!
//! 全部 `#[ignore]`（依赖外网，常规 cargo test 不跑）。手动执行：
//! `cargo test --test live_discovery -- --ignored --nocapture`

use lightlisten_lib::provider::types::SourceId;
use lightlisten_lib::provider::{
    KgProvider, KwProvider, MusicProvider, QqProvider, WyyProvider,
};

/// 各音源歌词：取该源最新歌曲的第一首，看能否拿到 LRC。
/// 前端「一直显示歌词加载中」就是因为拿到了空歌词，这里用来定位是哪个源。
#[test]
#[ignore = "需要外网访问各音源"]
fn live_lyric_all_sources() {
    runtime().block_on(async {
        let (wyy, qq, kw, kg) = (
            WyyProvider::new(),
            QqProvider::new(),
            KwProvider::new(),
            KgProvider::new(),
        );
        for p in [
            &wyy as &dyn MusicProvider,
            &qq as &dyn MusicProvider,
            &kw as &dyn MusicProvider,
            &kg as &dyn MusicProvider,
        ] {
            let name = p.name();
            let songs = match p.latest(3, 0).await {
                Ok(v) => v,
                Err(e) => {
                    println!("[{name}] 取新歌失败: {e:?}");
                    continue;
                }
            };
            let Some(track) = songs.into_iter().next() else {
                println!("[{name}] 新歌为空，跳过");
                continue;
            };
            match p.lyric(&track).await {
                Ok(l) => println!(
                    "[{name}] 歌词 ok  len={} 含时间轴={} 有翻译={}  title={}",
                    l.lrc.len(),
                    l.lrc.contains('['),
                    !l.translation.is_empty(),
                    track.title
                ),
                Err(e) => println!("[{name}] 歌词失败: {e:?}  title={}", track.title),
            }
        }
    });
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime")
}

/// 五项基础发现能力的摘要（不 panic，便于一次看清哪个源哪项挂了）
async fn smoke(provider: &dyn MusicProvider) -> String {
    let name = provider.name();
    let cats = provider.playlist_categories().await.map(|v| v.len());
    let recs = provider.recommendations(None, 1).await.map(|v| v.len());
    let charts = provider.charts().await.map(|v| v.len());
    let latest = provider.latest(20, 0).await.map(|v| v.len());
    let hot = provider.hot_words().await.map(|v| v.len());
    format!(
        "[{name}] categories={cats:?} recommendations={recs:?} charts={charts:?} latest={latest:?} hot_words={hot:?}"
    )
}

#[test]
#[ignore = "需要外网访问 music.163.com"]
fn live_wyy_discovery() {
    let p = WyyProvider::new();
    runtime().block_on(async {
        println!("{}", smoke(&p).await);

        let cats = p.playlist_categories().await.expect("wyy 分类失败");
        assert!(!cats.is_empty(), "wyy 分类为空");
        let recs = p.recommendations(None, 1).await.expect("wyy 推荐歌单失败");
        assert!(!recs.is_empty(), "wyy 推荐歌单为空");
        let charts = p.charts().await.expect("wyy 榜单失败");
        assert!(!charts.is_empty(), "wyy 榜单为空");
        let latest = p.latest(20, 0).await.expect("wyy 新歌失败");
        assert!(!latest.is_empty(), "wyy 新歌为空");
        let hot = p.hot_words().await.expect("wyy 热词失败");
        assert!(!hot.is_empty(), "wyy 热词为空");

        // 榜单详情（榜单 = 特殊歌单，走 v6/playlist/detail）
        let detail = p
            .chart_detail(&charts[0], 1, 50)
            .await
            .unwrap_or_else(|e| panic!("wyy 榜单详情失败: {e}"));
        assert!(!detail.is_empty(), "wyy 榜单详情为空");
        println!("[wyy] chart '{}' tracks={}", charts[0].name, detail.len());

        // 歌单详情（trackIds → /api/v3/song/detail 分批）
        let pl = p
            .playlist(&recs[0].id, 1, 100)
            .await
            .unwrap_or_else(|e| panic!("wyy 歌单详情失败: {e}"));
        let n = pl.tracks.as_ref().map(|t| t.len()).unwrap_or(0);
        assert!(n > 0, "wyy 歌单详情无歌曲");
        println!("[wyy] playlist '{}' tracks={}", pl.name, n);

        // 三类搜索
        println!(
            "[wyy] search playlists={:?} artists={:?} albums={:?}",
            p.search_playlists("周杰伦", 1, 10).await.map(|v| v.len()),
            p.search_artists("周杰伦", 1, 10).await.map(|v| v.len()),
            p.search_albums("周杰伦", 1, 10).await.map(|v| v.len()),
        );
    });
}

/// qq / kw / kg 的共同冒烟：榜单与新歌是发现页核心，必须拿到数据。
async fn assert_core(provider: &dyn MusicProvider, source: SourceId) {
    println!("{}", smoke(provider).await);
    let charts = provider
        .charts()
        .await
        .unwrap_or_else(|e| panic!("{source} 榜单失败: {e}"));
    assert!(!charts.is_empty(), "{source} 榜单为空");
    let latest = provider
        .latest(20, 0)
        .await
        .unwrap_or_else(|e| panic!("{source} 新歌失败: {e}"));
    assert!(!latest.is_empty(), "{source} 新歌为空");
    println!("[{}] charts={} latest={}", provider.name(), charts.len(), latest.len());

    // 榜单详情 / 歌单详情 / 搜索：只记录，不阻断（各源支持度不同）
    if let Ok(d) = provider.chart_detail(&charts[0], 1, 30).await {
        println!("[{}] chart '{}' tracks={}", provider.name(), charts[0].name, d.len());
    } else {
        println!("[{}] chart_detail 失败（记录）", provider.name());
    }
    if let Ok(recs) = provider.recommendations(None, 1).await {
        if let Some(first) = recs.first() {
            match provider.playlist(&first.id, 1, 50).await {
                Ok(pl) => println!(
                    "[{}] playlist '{}' tracks={}",
                    provider.name(),
                    pl.name,
                    pl.tracks.as_ref().map(|t| t.len()).unwrap_or(0)
                ),
                Err(e) => println!("[{}] playlist 详情失败（记录）: {e}", provider.name()),
            }
        }
    }
    println!(
        "[{}] search playlists={:?} artists={:?} albums={:?}",
        provider.name(),
        provider.search_playlists("周杰伦", 1, 10).await.map(|v| v.len()),
        provider.search_artists("周杰伦", 1, 10).await.map(|v| v.len()),
        provider.search_albums("周杰伦", 1, 10).await.map(|v| v.len()),
    );
}

#[test]
#[ignore = "需要外网访问 c.y.qq.com"]
fn live_qq_discovery() {
    let p = QqProvider::new();
    runtime().block_on(async { assert_core(&p, SourceId::Qq).await });
}

#[test]
#[ignore = "需要外网访问 kuwo.cn"]
fn live_kw_discovery() {
    let p = KwProvider::new();
    runtime().block_on(async { assert_core(&p, SourceId::Kw).await });
}

#[test]
#[ignore = "需要外网访问 kugou.com"]
fn live_kg_discovery() {
    let p = KgProvider::new();
    runtime().block_on(async { assert_core(&p, SourceId::Kg).await });
}

/// 聚合命令依赖的「四源并发」语义：单个源失败不应影响其它源。
/// 这里直接并发调用四个源的 charts，统计成功数。
#[test]
#[ignore = "需要外网访问四个音源"]
fn live_all_sources_charts_concurrently() {
    runtime().block_on(async {
        // 先绑定再 join：Provider 临时值不能在 join! 里被借用（E0716）
        let (wyy, qq, kw, kg) = (
            WyyProvider::new(),
            QqProvider::new(),
            KwProvider::new(),
            KgProvider::new(),
        );
        let (a, b, c, d) = tokio::join!(wyy.charts(), qq.charts(), kw.charts(), kg.charts());
        let ok = [&a, &b, &c, &d]
            .iter()
            .filter(|r| r.as_ref().map(|v| !v.is_empty()).unwrap_or(false))
            .count();
        println!(
            "[all] charts ok={ok}/4 wyy={:?} qq={:?} kw={:?} kg={:?}",
            a.as_ref().map(|v| v.len()),
            b.as_ref().map(|v| v.len()),
            c.as_ref().map(|v| v.len()),
            d.as_ref().map(|v| v.len()),
        );
        assert!(ok >= 2, "四源榜单成功数过低（{ok}/4），聚合能力不可用");
    });
}

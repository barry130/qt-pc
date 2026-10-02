//! `db::store` 的单元测试。
//!
//! 由原 `db/store.rs` 末尾的 `#[cfg(test)] mod tests` 机械搬迁而来（P2-7）：
//! 去掉外层 mod 包裹、整体左移 4 空格，测试逻辑与断言一行未改；
//! `use super::*` 通过 store/mod.rs 的再导出拿到各域函数。
use rusqlite::Connection;

use crate::db::migrations;
use crate::provider::types::{SourceId, Track};

use super::*;
fn test_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    migrations::run(&conn).expect("migrations");
    conn
}

fn track(id: &str, title: &str) -> Track {
    Track {
        id: id.to_string(),
        platform: SourceId::Wyy,
        title: title.to_string(),
        singer: "测试歌手".to_string(),
        album: "测试专辑".to_string(),
        pic_url: String::new(),
        duration: 210.0,
        music_id: None,
    }
}

/// 离线队列：入队去重（同目标键新操作覆盖旧操作）、ack、退避、计数。
/// LIKE_SYNC_DESIGN.md §3 的 PC 版语义。
#[test]
fn pending_like_ops_queue_roundtrip() {
    let conn = test_conn();
    enqueue_pending_like_op(&conn, "song", "add", "song:wyy:1001", r#"{"sid":"1001"}"#)
        .expect("enqueue add");
    // 同键第二条（remove）覆盖第一条：重放后只有 remove 生效
    enqueue_pending_like_op(
        &conn,
        "song",
        "remove",
        "song:wyy:1001",
        r#"{"sid":"1001","action":"remove"}"#,
    )
    .expect("enqueue remove");
    enqueue_pending_like_op(
        &conn,
        "playlist",
        "add",
        "playlist:local:p1",
        r#"{"pid":"p1"}"#,
    )
    .expect("enqueue playlist");

    let ops = list_pending_like_ops(&conn).expect("list");
    assert_eq!(ops.len(), 2, "同键去重后应只剩 2 条");
    assert_eq!(count_pending_like_ops(&conn).expect("count"), 2);
    // 同键留下的那条必须是后入队的 remove（新操作覆盖旧操作）
    let song_op = ops.iter().find(|o| o.kind == "song").expect("song op");
    assert_eq!(song_op.action, "remove");

    // ack 歌单条目：队列和去重键一起清掉
    let pl_op = ops
        .iter()
        .find(|o| o.kind == "playlist")
        .expect("playlist op");
    ack_pending_like_op(&conn, &pl_op.id).expect("ack");
    assert_eq!(count_pending_like_ops(&conn).expect("count"), 1);

    // 再入同键操作不会复活已 ack 的条目，而是新起一条
    enqueue_pending_like_op(
        &conn,
        "playlist",
        "add",
        "playlist:local:p1",
        r#"{"pid":"p1"}"#,
    )
    .expect("re-enqueue");
    assert_eq!(count_pending_like_ops(&conn).expect("count"), 2);
    // 歌单键现在只有新条目，旧的不会出现两条
    let pl_ops: Vec<_> = list_pending_like_ops(&conn)
        .expect("list")
        .into_iter()
        .filter(|o| o.kind == "playlist")
        .collect();
    assert_eq!(pl_ops.len(), 1);

    // 退避：retry_count 递增，next_retry_at 写入下次时间
    defer_pending_like_op(&conn, &pl_ops[0].id, pl_ops[0].retry_count).expect("defer");
    let deferred = list_pending_like_ops(&conn).expect("list");
    let d = deferred
        .iter()
        .find(|o| o.id == pl_ops[0].id)
        .expect("deferred");
    assert_eq!(d.retry_count, pl_ops[0].retry_count + 1);
    assert!(d.next_retry_at.is_some());
}

/// 账号切换清库：收藏歌曲/歌单卡片/自建歌单/多归属/离线队列全清 + 游标复位。
/// 登出重置：只清队列和游标，收藏数据保留（LIKE_SYNC_DESIGN §6）。
#[test]
fn like_clear_local_vs_reset_sync() {
    let conn = test_conn();
    let t = track("1001", "晴天");
    let pid = create_playlist(&conn, "换号测试").expect("create");
    add_liked_song(&conn, &t, &pid).expect("add");
    add_liked_playlist(&conn, "wyy", "pl1", "云卡", "", "").expect("pl");
    enqueue_pending_like_op(&conn, "song", "add", "song:wyy:1001", "{}").expect("enqueue");
    set_setting(&conn, "like.sync.seq", "42").expect("set seq");
    set_setting(&conn, "like.imported", "1").expect("set imported");

    // 登出：数据保留，队列/游标清掉
    reset_like_sync_state(&conn).expect("reset");
    assert!(is_liked_song(&conn, &t).expect("song kept"));
    assert_eq!(list_liked_playlists(&conn).expect("pl kept").len(), 1);
    assert_eq!(count_pending_like_ops(&conn).expect("count"), 0);
    assert_eq!(
        get_setting(&conn, "like.sync.seq").expect("seq").unwrap(),
        ""
    );

    // 换号：全清
    let n = clear_like_local(&conn).expect("clear");
    assert!(n > 0, "应清掉至少一行");
    assert!(!is_liked_song(&conn, &t).expect("song gone"));
    assert!(list_liked_playlists(&conn).expect("pl gone").is_empty());
    let pls = list_my_playlists(&conn).expect("my pls");
    assert!(pls.is_empty(), "自建歌单也应清掉");
    assert_eq!(
        get_setting(&conn, "like.imported")
            .expect("imported")
            .unwrap(),
        ""
    );
    assert_eq!(count_pending_like_ops(&conn).expect("count"), 0);
}

/// 收藏：写入 / 幂等 / 查询 / 取消（DESIGN §5.3）
#[test]
fn favorite_roundtrip_is_idempotent() {
    let conn = test_conn();
    let t = track("1001", "晴天");
    assert!(!is_liked_song(&conn, &t).expect("is_liked"));

    let pid = create_playlist(&conn, "收藏测试").expect("create");
    add_liked_song(&conn, &t, &pid).expect("add");
    assert!(is_liked_song(&conn, &t).expect("is_liked after add"));

    // 重复收藏不产生重复行
    add_liked_song(&conn, &t, &pid).expect("add again");
    let list = list_liked_songs(&conn, Some(&pid)).expect("list");
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].title, "晴天");
    // 收藏会把曲目一并入库，因此时长应回得来
    assert!((list[0].duration - 210.0).abs() < 0.5);

    remove_liked_song(&conn, &t, None).expect("remove");
    assert!(!is_liked_song(&conn, &t).expect("is_liked after remove"));
    assert!(list_liked_songs(&conn, Some(&pid))
        .expect("list after remove")
        .is_empty());
}

/// 删除歌单必须把同 pid 的云端卡片一并清掉：
/// 登录建单会收到服务器 add 回声（liked_playlists 同 pid 行）。
/// 不清的话歌单里 0 首幽灵卡片残留在「我的歌单」的合并视图里
#[test]
fn delete_playlist_removes_ghost_cloud_card() {
    let conn = test_conn();
    let pid = create_playlist(&conn, "被删的歌单").expect("create");
    // 模拟服务器回声：同步回来一张同 pid 的 local 卡片
    add_liked_playlist(&conn, "local", &pid, "被删的歌单", "", "").expect("echo card");

    delete_playlist(&conn, &pid).expect("delete");

    let mine = list_my_playlists(&conn).expect("list");
    assert!(
        mine.iter().all(|p| p.pid != pid),
        "删除后同 pid 的幽灵卡片不能留在列表里"
    );
}

/// 多归属歌在主归属歌单删除后必须活着，且主归属重绑定
/// 云端按 (sid,pid) 行建模，主归属挂在被删歌单上时整首下线会误删
#[test]
fn delete_playlist_rebinds_main_pid_of_survivors() {
    let conn = test_conn();
    let t = track("3101", "多归属歌");
    let dying = create_playlist(&conn, "要删的歌单").expect("create");
    let alive = create_playlist(&conn, "幸存歌单").expect("create");
    add_liked_song(&conn, &t, &dying).expect("add dying");
    add_liked_song(&conn, &t, &alive).expect("add alive");

    delete_playlist(&conn, &dying).expect("delete");

    assert!(is_liked_song(&conn, &t).expect("歌必须活着"));
    assert_eq!(
        list_liked_songs(&conn, Some(&alive))
            .expect("幸存歌单")
            .len(),
        1
    );
    // 主归属重绑到幸存歌单
    assert_eq!(list_track_playlists(&conn, &t).expect("归属"), vec![alive]);
}

/// 云端确认点（v8 cloud_seq，机制 B 的界尺）。
/// NULL 表示从未上送过；mark 单调推进不回退
#[test]
fn playlist_cloud_seq_marks_monotonically() {
    let conn = test_conn();
    let pid = create_playlist(&conn, "确认点歌单").expect("create");
    let rows = list_playlist_sync_rows(&conn).expect("rows");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0, pid);
    assert!(rows[0].1.is_none(), "新歌单从未上送，确认点为 NULL");

    mark_playlist_cloud_seq(&conn, &pid, 42).expect("mark");
    mark_playlist_cloud_seq(&conn, &pid, 7).expect("mark lower");
    let rows = list_playlist_sync_rows(&conn).expect("rows");
    assert_eq!(rows[0].1, Some(42), "确认点只涨不跌");

    // 不存在的 pid 静默无操作
    mark_playlist_cloud_seq(&conn, "no-such-pid", 99).expect("mark unknown");
}

/// 跟随云端删除：与手动删除同构（自建行、归属、卡片全清）
#[test]
fn follow_cloud_delete_cleans_everything() {
    let conn = test_conn();
    let t = track("3201", "随歌单走的歌");
    let pid = create_playlist(&conn, "他端删的").expect("create");
    add_liked_song(&conn, &t, &pid).expect("add");
    add_liked_playlist(&conn, "local", &pid, "他端删的", "", "").expect("echo card");

    delete_playlist_follow_cloud(&conn, &pid).expect("follow delete");

    assert!(!is_liked_song(&conn, &t).expect("失去唯一归属，歌下线"));
    let mine = list_my_playlists(&conn).expect("list");
    assert!(mine.iter().all(|p| p.pid != pid), "歌单行和卡片都得清");
}

/// 一首歌可以同时挂在多个歌单（多归属），从其中一个移除不影响其他
#[test]
fn favorite_binds_to_playlist_by_pid() {
    let conn = test_conn();
    let a = track("3001", "稻香");
    let b = track("3002", "七里香");
    let pid = create_playlist(&conn, "开车听").expect("create");
    let other = create_playlist(&conn, "另一个").expect("create 2");

    // 同一首歌收藏进两个歌单（多归属）
    add_liked_song(&conn, &a, &pid).expect("add to pid");
    add_liked_song(&conn, &a, &other).expect("add to other");
    assert_eq!(
        list_liked_songs(&conn, Some(&pid)).expect("开车听").len(),
        1
    );
    assert_eq!(
        list_liked_songs(&conn, Some(&other)).expect("另一个").len(),
        1
    );
    // 归属清单两边都有
    assert_eq!(list_track_playlists(&conn, &a).expect("归属").len(), 2);

    // 从「开车听」摘掉后，「另一个」里的还在
    remove_liked_song(&conn, &a, Some(&pid)).expect("detach");
    assert!(list_liked_songs(&conn, Some(&pid))
        .expect("开车听")
        .is_empty());
    assert_eq!(
        list_liked_songs(&conn, Some(&other)).expect("另一个").len(),
        1
    );

    // 最后一个归属也摘掉 → 整首下线
    remove_liked_song(&conn, &a, Some(&other)).expect("detach last");
    assert!(!is_liked_song(&conn, &a).expect("整首下线"));

    // 歌单详情只看对应的 pid
    add_liked_song(&conn, &b, &other).expect("add b");
    assert!(get_playlist_tracks(&conn, &pid).expect("tracks").is_empty());
    assert_eq!(get_playlist_tracks(&conn, &other).expect("tracks").len(), 1);
    // 删歌单：b 因失去全部归属而下线
    delete_playlist(&conn, &other).expect("delete");
    assert!(get_playlist_tracks(&conn, &other)
        .expect("tracks")
        .is_empty());
    assert!(!is_liked_song(&conn, &b).expect("b 整首下线"));
}

/// 无默认歌单：歌单列表 = 本地自建 + 云端卡片，按 pid 去重
#[test]
fn playlist_list_merges_local_and_cloud_cards() {
    let conn = test_conn();
    // 本地自建一张
    let pid = create_playlist(&conn, "测试歌单").expect("create");
    // 云端同步回两张卡片（含一张 local「我喜欢的歌曲」）
    add_liked_playlist(&conn, "local", "local", "我喜欢的歌曲", "", "").expect("cloud card 1");
    add_liked_playlist(&conn, "qq", "5033052", "拯救歌荒", "", "").expect("cloud card 2");

    let all = list_my_playlists(&conn).expect("list");
    // 本地 1 张 + 云端 2 张，pid 各不相同
    assert_eq!(all.len(), 3);
    let mine = all.iter().find(|p| p.pid == pid).expect("自建歌单");
    assert!(mine.is_local);
    assert_eq!(mine.name, "测试歌单");
    let liked = all
        .iter()
        .find(|p| p.pid == "local")
        .expect("云端local卡片");
    assert!(!liked.is_local);
    assert_eq!(liked.name, "我喜欢的歌曲");
    assert_eq!(liked.track_count, 0);

    // 收藏进云端 local 卡片后，其曲目数实时更新
    add_liked_song(&conn, &track("7001", "晴天"), "local").expect("add to local");
    let all = list_my_playlists(&conn).expect("list");
    let liked = all
        .iter()
        .find(|p| p.pid == "local")
        .expect("云端local卡片");
    assert_eq!(liked.track_count, 1);
}

/// 历史：同曲目去重、按播放时间倒序、清空
#[test]
fn history_dedups_by_track_and_orders_desc() {
    let conn = test_conn();
    let a = track("2001", "A");
    let b = track("2002", "B");

    record_play_history(&conn, &a).expect("record a");
    record_play_history(&conn, &b).expect("record b");
    // 同一首再播一次：只保留最近一条
    record_play_history(&conn, &a).expect("record a again");

    let items = list_play_history(&conn, 0).expect("list");
    assert_eq!(items.len(), 2, "同一首歌应去重");
    assert_eq!(items[0].track.title, "A", "最近播放的排在最前");
    assert_eq!(items[1].track.title, "B");
    assert!(items[0].played_at >= items[1].played_at);

    clear_play_history(&conn).expect("clear");
    assert!(list_play_history(&conn, 0)
        .expect("list after clear")
        .is_empty());
}

/// 历史：limit 生效、默认 100 条；本地曲目未入库时静默跳过
#[test]
fn history_limit_and_untracked_local_track() {
    let conn = test_conn();
    for i in 0..5 {
        record_play_history(&conn, &track(&format!("300{i}"), &format!("T{i}"))).expect("record");
    }
    assert_eq!(list_play_history(&conn, 2).expect("limit 2").len(), 2);
    assert_eq!(list_play_history(&conn, 0).expect("default limit").len(), 5);

    // 本地曲目若未被扫描入库（tracks 无行、外键指向不存在），记历史应静默跳过
    let local = Track {
        id: "D:\\no-such-file.mp3".to_string(),
        platform: SourceId::Local,
        ..track("local-1", "本地")
    };
    record_play_history(&conn, &local).expect("本地未入库时不应报错");
    let items = list_play_history(&conn, 0).expect("list");
    assert!(items.iter().all(|it| it.track.platform != SourceId::Local));
}

/// 我的歌单：创建 / 加歌去重 / 顺序 / 移除 / 重命名 / 删除（DESIGN §5.3）
#[test]
fn my_playlist_crud_and_ordering() {
    let conn = test_conn();
    let id = create_playlist(&conn, "开车听").expect("create");

    let a = track("4001", "A");
    let b = track("4002", "B");
    let added = add_tracks_to_playlist(&conn, &id, &[a.clone(), b.clone()]).expect("add");
    assert_eq!(added, 2, "首次导入按全量计");
    // 重复添加不产生重复行、不改变原有顺序，也不计入新增
    let added_again =
        add_tracks_to_playlist(&conn, &id, std::slice::from_ref(&a)).expect("add again");
    assert_eq!(added_again, 0, "重复添加不应产生新增");

    let tracks = get_playlist_tracks(&conn, &id).expect("tracks");
    assert_eq!(tracks.len(), 2);
    let names: Vec<String> = tracks.iter().map(|t| t.title.clone()).collect();
    assert_eq!(
        names,
        vec!["A".to_string(), "B".to_string()],
        "应保持加入顺序"
    );

    let lists = list_playlists(&conn).expect("list");
    let mine = lists.iter().find(|p| p.pid == id).expect("找到刚建的歌单");
    assert_eq!(mine.name, "开车听");
    assert_eq!(mine.platform, LOCAL_PLATFORM);
    assert_eq!(mine.track_count, 2);
    assert!(mine.is_local);

    remove_track_from_playlist(&conn, &id, &a).expect("remove");
    assert_eq!(get_playlist_tracks(&conn, &id).expect("tracks").len(), 1);

    rename_playlist(&conn, &id, "改个名字").expect("rename");
    let lists = list_playlists(&conn).expect("list");
    assert_eq!(
        lists.iter().find(|p| p.pid == id).expect("找到歌单").name,
        "改个名字"
    );

    delete_playlist(&conn, &id).expect("delete");
    assert!(list_playlists(&conn)
        .expect("list")
        .iter()
        .all(|p| p.pid != id));
    assert!(get_playlist_tracks(&conn, &id).expect("tracks").is_empty());
}

/// 下载任务生命周期：创建 → 进度 → 完成 / 失败 → 删除（DESIGN §5.3）
#[test]
fn download_task_lifecycle() {
    let conn = test_conn();
    let t = track("5001", "下载用歌");

    let id = create_download_task(&conn, &t, "320", "D:\\dl\\a.mp3.part").expect("create task");
    let tasks = list_download_tasks(&conn).expect("list");
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].status, "pending");
    assert_eq!(tasks[0].track.title, "下载用歌");
    assert_eq!(tasks[0].quality, "320");
    assert_eq!(tasks[0].part_path.as_deref(), Some("D:\\dl\\a.mp3.part"));

    update_download_progress(&conn, &id, 0.5).expect("progress");
    let tasks = list_download_tasks(&conn).expect("list");
    assert_eq!(tasks[0].status, "downloading");
    assert!((tasks[0].progress - 0.5).abs() < 1e-6);

    finish_download_task(&conn, &id, "D:\\dl\\a.mp3", 12345).expect("finish");
    let tasks = list_download_tasks(&conn).expect("list");
    assert_eq!(tasks[0].status, "done");
    assert_eq!(tasks[0].file_path.as_deref(), Some("D:\\dl\\a.mp3"));
    assert_eq!(tasks[0].file_size, Some(12345));
    // 完成即清掉临时路径，避免看起来还有半截文件
    assert!(tasks[0].part_path.is_none());

    // 失败态单独一条
    let id2 =
        create_download_task(&conn, &track("5002", "另一首"), "128", "p2.part").expect("create 2");
    fail_download_task(&conn, &id2, "网络错误").expect("fail");
    let tasks = list_download_tasks(&conn).expect("list");
    let failed = tasks.iter().find(|x| x.id == id2).expect("找到失败任务");
    assert_eq!(failed.status, "failed");
    assert_eq!(failed.error.as_deref(), Some("网络错误"));

    // 删除任务会返回它曾下载的文件路径（是否删文件由调用方决定）
    assert_eq!(
        delete_download_task(&conn, &id).expect("delete").as_deref(),
        Some("D:\\dl\\a.mp3")
    );
    assert_eq!(list_download_tasks(&conn).expect("list").len(), 1);
}

/// 批量删除：单事务删多条并回传各自文件路径，未选中的保留
#[test]
fn delete_download_tasks_batch_returns_paths_of_selected_only() {
    let conn = test_conn();
    let a = create_download_task(&conn, &track("7001", "甲"), "320", "a.part").expect("a");
    let b = create_download_task(&conn, &track("7002", "乙"), "320", "b.part").expect("b");
    let c = create_download_task(&conn, &track("7003", "丙"), "320", "c.part").expect("c");
    finish_download_task(&conn, &a, "D:\\dl\\a.mp3", 10).expect("finish a");
    finish_download_task(&conn, &b, "D:\\dl\\b.mp3", 20).expect("finish b");

    // 空数组：不动任何数据
    assert!(delete_download_tasks(&conn, &[]).expect("empty").is_empty());
    assert_eq!(list_download_tasks(&conn).expect("list").len(), 3);

    let removed = delete_download_tasks(&conn, &[a.clone(), b.clone()]).expect("batch");
    assert_eq!(removed.len(), 2);
    // 完成的回传成品路径；未完成的回传临时路径
    let files: Vec<Option<String>> = removed.iter().map(|(f, _)| f.clone()).collect();
    assert!(files.contains(&Some("D:\\dl\\a.mp3".to_string())));
    assert!(files.contains(&Some("D:\\dl\\b.mp3".to_string())));
    let parts: Vec<Option<String>> = removed.iter().map(|(_, p)| p.clone()).collect();
    assert!(parts.iter().all(Option::is_none), "完成后临时路径应为空");

    let left = list_download_tasks(&conn).expect("list");
    assert_eq!(left.len(), 1, "只删选中的两条");
    assert_eq!(left[0].id, c);

    // 再删一次：已删的 id 不再返回，也不报错
    assert!(delete_download_tasks(&conn, &[a, b])
        .expect("again")
        .is_empty());
    assert_eq!(list_download_tasks(&conn).expect("list").len(), 1);
}

/// 下载 2.0：去重命中范围、离线文件查找、启动时把旧任务落成 paused（§5.3）
#[test]
fn download_dedupe_offline_lookup_and_stale_cleanup() {
    let conn = test_conn();
    let t = track("6001", "去重歌");
    let db_id = db_track_id(&t);

    // 没有任务时查不到
    assert!(find_download_task(&conn, &db_id, "320")
        .expect("find")
        .is_none());
    assert!(downloaded_file_for(&conn, &db_id)
        .expect("offline")
        .is_none());

    let id = create_download_task(&conn, &t, "320", "p.part").expect("create");
    // 进行中的任务算去重命中
    let hit = find_download_task(&conn, &db_id, "320")
        .expect("find")
        .expect("命中");
    assert_eq!(hit.id, id);
    // 音质不同不算命中
    assert!(find_download_task(&conn, &db_id, "flac")
        .expect("find")
        .is_none());

    // 下载中（downloading）→ 旧任务清理落成 paused
    update_download_progress(&conn, &id, 0.3).expect("progress");
    let n = mark_stale_downloads_paused(&conn).expect("stale");
    assert_eq!(n, 1);
    let task = download_task_by_id(&conn, &id)
        .expect("by id")
        .expect("存在");
    assert_eq!(task.status, "paused");
    assert!(task.error.is_some(), "应给出中断原因");

    // 完成后：去重仍命中（done），离线查找能拿到文件路径
    finish_download_task(&conn, &id, "D:\\dl\\x.flac", 999).expect("finish");
    assert!(find_download_task(&conn, &db_id, "320")
        .expect("find")
        .is_some());
    assert_eq!(
        downloaded_file_for(&conn, &db_id)
            .expect("offline")
            .as_deref(),
        Some("D:\\dl\\x.flac")
    );
    assert_eq!(
        downloaded_track_ids(&conn).expect("ids"),
        vec![db_id.clone()]
    );

    // 取消态不再挡新任务
    set_download_status(&conn, &id, "canceled", None).expect("cancel");
    assert!(find_download_task(&conn, &db_id, "320")
        .expect("find")
        .is_none());
}

/// 播放统计：单次播放累计 / 概览 / 排名（DESIGN §5.3）
#[test]
fn play_stats_accumulate_overview_and_rank() {
    let conn = test_conn();
    let a = track("1001", "晴天");
    let b = track("1002", "稻香");

    record_play_stat(&conn, &a, 1000).expect("stat 1");
    record_play_stat(&conn, &a, 1000).expect("stat 2");
    record_play_stat(&conn, &b, 2000).expect("stat 3");

    let overview = play_overview(&conn).expect("overview");
    assert_eq!(overview.total_plays, 3);
    assert_eq!(overview.total_ms, 4000);
    assert_eq!(overview.track_count, 2);
    assert!(overview.last_played_at.is_some());

    let top = list_top_tracks(&conn, 10).expect("top tracks");
    assert_eq!(top.len(), 2);
    // 播放 2 次的排前面
    assert_eq!(top[0].track.title, "晴天");
    assert_eq!(top[0].play_count, 2);
    assert_eq!(top[1].play_count, 1);
    assert_eq!(top[0].total_played_ms, 2000);

    let singers = list_top_singers(&conn, 10).expect("top singers");
    assert_eq!(singers.len(), 1);
    assert_eq!(singers[0].singer, "测试歌手");
    assert_eq!(singers[0].play_count, 3);
}

/// 没被扫描进库的本地曲目：跳过统计而不是撞外键报错（统计不能影响播放）
#[test]
fn play_stats_skips_local_track_missing_from_library() {
    let conn = test_conn();
    let local = Track {
        id: "D:/music/未知.mp3".to_string(),
        platform: SourceId::Local,
        title: "本地歌".to_string(),
        singer: String::new(),
        album: String::new(),
        pic_url: String::new(),
        duration: 180.0,
        music_id: None,
    };
    record_play_stat(&conn, &local, 1000).expect("本地曲目统计不该报错");
    assert_eq!(play_overview(&conn).expect("overview").total_plays, 0);
}

/// 封面要能随曲目读回来：收藏 / 历史 / 歌单 / 统计这几个列表都从 tracks.pic_url 取。
/// 之前这些查询把 pic_url 写死成空串，列表页就全是空白封面 —— 这里盯住别再退化。
#[test]
fn lists_keep_track_cover_url() {
    const COVER: &str = "https://img.example.com/cover.jpg";
    let conn = test_conn();
    let t = Track {
        id: "1001".to_string(),
        platform: SourceId::Wyy,
        title: "晴天".to_string(),
        singer: "测试歌手".to_string(),
        album: "测试专辑".to_string(),
        pic_url: COVER.to_string(),
        duration: 210.0,
        music_id: None,
    };

    let pid = create_playlist(&conn, "测试歌单").expect("建歌单");
    add_liked_song(&conn, &t, &pid).expect("收藏");
    record_play_history(&conn, &t).expect("历史");
    record_play_stat(&conn, &t, 210_000).expect("统计");
    add_tracks_to_playlist(&conn, &pid, std::slice::from_ref(&t)).expect("加歌");

    assert_eq!(
        list_liked_songs(&conn, Some(&pid)).expect("收藏列表")[0].pic_url,
        COVER
    );
    assert_eq!(
        list_play_history(&conn, 10).expect("历史列表")[0]
            .track
            .pic_url,
        COVER
    );
    assert_eq!(
        list_top_tracks(&conn, 10).expect("统计列表")[0]
            .track
            .pic_url,
        COVER
    );
    assert_eq!(
        get_playlist_tracks(&conn, &pid).expect("歌单曲目")[0].pic_url,
        COVER
    );
}

/// 回归：**手机端收藏的本地歌要能落进 PC 的「我喜欢的歌曲」**。
///
/// 用户实测场景：手机端把一首「本地音乐」（手机上的音频文件）收藏后，
/// PC 的「我喜欢的歌曲」里没有这首，而 PC 端收藏的本地歌手机上却有 —— 单向。
/// 根因是收藏变更落库（`cmd_like_apply`）与启动对账（`cmd_like_reconcile`）
/// 把 `platform = "local"` 当未知平台整条 `continue` 掉了，行根本没入库，
/// 所以歌单查询自然查不到（而不是查询/展示层把它过滤了）。
///
/// 本地曲目的 `id` 是设备自己的标识（PC 是绝对路径、Android 是 `local_<MediaStoreId>`），
/// 所以跨设备这条曲目只保证「显示得出来」（标题/歌手/专辑来自 liked_songs），
/// 不保证能播放 —— 这与手机端展示 PC 的本地歌是同一口径。
#[test]
fn foreign_local_song_lands_in_liked_playlist() {
    let conn = test_conn();
    // 手机端本地曲目的 id 形态（Android MediaStore id），且 pid 指向「我喜欢的歌曲」
    let phone_local = Track {
        id: "local_12345".to_string(),
        platform: SourceId::Local,
        title: "人生路慢慢".to_string(),
        singer: "某某".to_string(),
        album: "某专辑".to_string(),
        pic_url: String::new(),
        duration: 0.0,
        music_id: None,
    };

    add_liked_song(&conn, &phone_local, LOCAL_PLATFORM).expect("落库不应报错");

    // 主键口径必须是 local:<原始 id>，且能拆回去（否则最新收藏会串音源）
    let db_id = db_track_id(&phone_local);
    assert_eq!(db_id, "local:local_12345");
    assert_eq!(
        split_db_track_id(&db_id),
        Some((SourceId::Local, "local_12345".to_string()))
    );

    // 歌单查询（PC「我喜欢的歌曲」页走的就是这条）必须能查到
    let songs = get_playlist_tracks(&conn, LOCAL_PLATFORM).expect("歌单曲目");
    assert_eq!(songs.len(), 1, "手机端收藏的本地歌应出现在我喜欢的歌曲里");
    assert_eq!(songs[0].title, "人生路慢慢");
    assert_eq!(songs[0].platform, SourceId::Local);

    // 收藏列表（按 pid）同样要带上它
    assert_eq!(
        list_liked_songs(&conn, Some(LOCAL_PLATFORM))
            .expect("收藏列表")
            .len(),
        1
    );

    // 本地曲目不写 tracks 表（扫描器负责），所以没封面/时长也不该丢行
    let track_rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM tracks WHERE platform = 'local'",
            [],
            |r| r.get(0),
        )
        .expect("count tracks");
    assert_eq!(track_rows, 0, "外部本地曲目不应污染 tracks 表");
}

# -*- coding: utf-8 -*-
"""把 GBK 误读损坏的 tests.rs 重建回来。

- 基础：逆变换得到的 tests.recovered.rs（结构完好，仅约 126 行有损伤）
- 代码中文字面量：用损坏前编译出的测试二进制 quietmusic_lib-*.exe 精确还原
- 注释：按残留片段重建（语义等价；个别措辞可能与原文不同）
- 验证：把重建结果按同一损坏链路正向变换，必须与 .corrupt 文件逐字节相同
"""
import os

DIR = r"F:\qtMusic\qt-pc\src-tauri\src\db\store"
REC = os.path.join(DIR, "tests.recovered.rs")
OUT = os.path.join(DIR, "tests.rs")
CORRUPT = os.path.join(DIR, "tests.rs.corrupt")

REPAIR = {
1: "//! `db::store` 的单元测试。\n//!",
2: "//! 由原 `db/store.rs` 末尾的 `#[cfg(test)] mod tests` 机械搬迁而来（P2-7）：",
3: "//! 去掉外层 mod 包裹、整体左移 4 空格，测试逻辑与断言一行未改；",
4: "//! `use super::*` 通过 store/mod.rs 的再导出拿到各域函数。",
30: "/// 离线队列：入队去重（同目标键新操作覆盖旧操作）、ack、退避、计数。\n/// LIKE_SYNC_DESIGN.md §3 的 PC 版语义。\n#[test]",
35: "    // 同键第二条（remove）覆盖第一条：重放后只有 remove 生效",
42: '    assert_eq!(ops.len(), 2, "同键去重后应只剩 2 条");',
48: '    // ack 歌单条目：队列和去重键一起清掉\n    let pl_op = ops.iter().find(|o| o.kind == "playlist").expect("playlist op");',
52: '    // 再入同键操作不会复活已 ack 的条目，而是新起一条\n    enqueue_pending_like_op(&conn, "playlist", "add", "playlist:local:p1", r#"{"pid":"p1"}"#)',
55: "    // 歌单键现在只有新条目，旧的不会出现两条\n    let pl_ops: Vec<_> = list_pending_like_ops(&conn)",
62: "    // 退避：retry_count 递增，next_retry_at 写入下次时间",
70: "/// 账号切换清库：收藏歌曲/歌单卡片/自建歌单/多归属/离线队列全清 + 游标复位。\n/// 登出重置：只清队列和游标，收藏数据保留（LIKE_SYNC_DESIGN §6）。\n#[test]",
81: "    // 登出：数据保留，队列/游标清掉",
88: '    // 换号：全清\n    let n = clear_like_local(&conn).expect("clear");',
89: '    assert!(n > 0, "应清掉至少一行");',
93: '    assert!(pls.is_empty(), "自建歌单也应清掉");',
98: "/// 收藏：写入 / 幂等 / 查询 / 取消（DESIGN §5.3）\n#[test]",
108: "    // 重复收藏不产生重复行",
113: "    // 收藏会把曲目一并入库，因此时长应回得来\n    assert!((list[0].duration - 210.0).abs() < 0.5);",
122: "/// 删除歌单必须把同 pid 的云端卡片一并清掉：",
123: "/// 登录建单会收到服务器 add 回声（liked_playlists 同 pid 行）。\n/// 不清的话歌单里 0 首幽灵卡片残留在「我的歌单」的合并视图里",
127: '    let pid = create_playlist(&conn, "被删的歌单").expect("create");',
128: "    // 模拟服务器回声：同步回来一张同 pid 的 local 卡片",
129: '    add_liked_playlist(&conn, "local", &pid, "被删的歌单", "", "")',
141: "/// 多归属歌在主归属歌单删除后必须活着，且主归属重绑定\n/// 云端按 (sid,pid) 行建模，主归属挂在被删歌单上时整首下线会误删",
146: '    let dying = create_playlist(&conn, "要删的歌单").expect("create");',
147: '    let alive = create_playlist(&conn, "幸存歌单").expect("create");',
153: '    assert!(is_liked_song(&conn, &t).expect("歌必须活着"));',
162: "/// 云端确认点（v8 cloud_seq，机制 B 的界尺）。\n/// NULL 表示从未上送过；mark 单调推进不回退",
166: '    let pid = create_playlist(&conn, "确认点歌单").expect("create");',
170: '    assert!(rows[0].1.is_none(), "新歌单从未上送，确认点为 NULL");',
175: '    assert_eq!(rows[0].1, Some(42), "确认点只涨不跌");',
177: '    // 不存在的 pid 静默无操作\n    mark_playlist_cloud_seq(&conn, "no-such-pid", 99).expect("mark unknown");',
180: "/// 跟随云端删除：与手动删除同构（自建行、归属、卡片全清）",
185: '    let pid = create_playlist(&conn, "他端删的").expect("create");',
187: '    add_liked_playlist(&conn, "local", &pid, "他端删的", "", "")',
192: '    assert!(!is_liked_song(&conn, &t).expect("失去唯一归属，歌下线"));',
194: '    assert!(mine.iter().all(|p| p.pid != pid), "歌单行和卡片都得清");',
197: "/// 一首歌可以同时挂在多个歌单（多归属），从其中一个移除不影响其他",
201: '    let a = track("3001", "稻香");',
202: '    let b = track("3002", "七里香");',
203: '    let pid = create_playlist(&conn, "开车听").expect("create");',
204: '    let other = create_playlist(&conn, "另一个").expect("create 2");',
206: "    // 同一首歌收藏进两个歌单（多归属）",
209: '    assert_eq!(list_liked_songs(&conn, Some(&pid)).expect("开车听").len(), 1);',
210: '    assert_eq!(list_liked_songs(&conn, Some(&other)).expect("另一个").len(), 1);',
211: "    // 归属清单两边都有",
214: '    // 从「开车听」摘掉后，「另一个」里的还在\n    remove_liked_song(&conn, &a, Some(&pid)).expect("detach");',
215: '    assert!(list_liked_songs(&conn, Some(&pid)).expect("开车听").is_empty());',
216: '    assert_eq!(list_liked_songs(&conn, Some(&other)).expect("另一个").len(), 1);',
218: "    // 最后一个归属也摘掉 → 整首下线",
220: '    assert!(!is_liked_song(&conn, &a).expect("整首下线"));',
222: "    // 歌单详情只看对应的 pid",
226: '    // 删歌单：b 因失去全部归属而下线\n    delete_playlist(&conn, &other).expect("delete");',
228: '    assert!(!is_liked_song(&conn, &b).expect("b 整首下线"));',
231: "/// 无默认歌单：歌单列表 = 本地自建 + 云端卡片，按 pid 去重",
235: '    // 本地自建一张\n    let pid = create_playlist(&conn, "测试歌单").expect("create");',
236: "    // 云端同步回两张卡片（含一张 local「我喜欢的歌曲」）",
239: '    add_liked_playlist(&conn, "qq", "5033052", "拯救歌荒", "", "")',
243: "    // 本地 1 张 + 云端 2 张，pid 各不相同",
245: '    let mine = all.iter().find(|p| p.pid == pid).expect("自建歌单");',
248: '    let liked = all.iter().find(|p| p.pid == "local").expect("云端local卡片");',
253: "    // 收藏进云端 local 卡片后，其曲目数实时更新",
256: '    let liked = all.iter().find(|p| p.pid == "local").expect("云端local卡片");',
260: "/// 历史：同曲目去重、按播放时间倒序、清空\n#[test]",
268: '    // 同一首再播一次：只保留最近一条\n    record_play_history(&conn, &a).expect("record a again");',
271: '    assert_eq!(items.len(), 2, "同一首歌应去重");',
272: '    assert_eq!(items[0].track.title, "A", "最近播放的排在最前");',
282: "/// 历史：limit 生效、默认 100 条；本地曲目未入库时静默跳过",
296: "    // 本地曲目若未被扫描入库（tracks 无行、外键指向不存在），记历史应静默跳过",
300: '        ..track("local-1", "本地")',
302: '    record_play_history(&conn, &local).expect("本地未入库时不应报错");',
307: "/// 我的歌单：创建 / 加歌去重 / 顺序 / 移除 / 重命名 / 删除（DESIGN §5.3）\n#[test]",
310: '    let id = create_playlist(&conn, "开车听").expect("create");',
315: "    // 重复添加不产生重复行，也不应改变原有顺序",
321: '    assert_eq!(names, vec!["A".to_string(), "B".to_string()], "应保持加入顺序");',
327: '        .expect("找到刚建的歌单");',
328: '    assert_eq!(mine.name, "开车听");',
351: "/// 下载任务生命周期：创建 → 进度 → 完成 / 失败 → 删除（DESIGN §5.3）\n#[test]",
374: "    // 完成即清掉临时路径，避免看起来还有半截文件\n    assert!(tasks[0].part_path.is_none());",
376: '    // 失败态单独一条\n    let id2 = create_download_task(&conn, &track("5002", "另一首"), "128", "p2.part")',
378: '    fail_download_task(&conn, &id2, "网络错误").expect("fail");',
382: '    assert_eq!(failed.error.as_deref(), Some("网络错误"));',
384: "    // 删除任务会返回它曾下载的文件路径（是否删文件由调用方决定）\n    assert_eq!(",
391: "/// 批量删除：单事务删多条并回传各自文件路径，未选中的保留\n#[test]",
394: '    let a = create_download_task(&conn, &track("7001", "甲"), "320", "a.part").expect("a");',
395: '    let b = create_download_task(&conn, &track("7002", "乙"), "320", "b.part").expect("b");',
396: '    let c = create_download_task(&conn, &track("7003", "丙"), "320", "c.part").expect("c");',
400: "    // 空数组：不动任何数据",
406: "    // 完成的回传成品路径；未完成的回传临时路径",
414: '    assert_eq!(left.len(), 1, "只删选中的两条");',
417: '    // 再删一次：已删的 id 不再返回，也不报错\n    assert!(delete_download_tasks(&conn, &[a, b]).expect("again").is_empty());',
421: "/// 下载 2.0：去重命中范围、离线文件查找、启动时把旧任务落成 paused（§5.3）\n#[test]",
424: '    let t = track("6001", "去重歌");',
432: '    // 进行中的任务算去重命中\n    let hit = find_download_task(&conn, &db_id, "320").expect("find").expect("命中");',
437: "    // 下载中（downloading）→ 旧任务清理落成 paused",
443: '    assert!(task.error.is_some(), "应给出中断原因");',
445: '    // 完成后：去重仍命中（done），离线查找能拿到文件路径\n    finish_download_task(&conn, &id, "D:\\\\dl\\\\x.flac", 999).expect("finish");',
453: '    // 取消态不再挡新任务\n    set_download_status(&conn, &id, "canceled", None).expect("cancel");',
457: "/// 播放统计：单次播放累计 / 概览 / 排名（DESIGN §5.3）\n#[test]",
461: '    let b = track("1002", "稻香");',
475: '    // 播放 2 次的排前面\n    assert_eq!(top[0].track.title, "晴天");',
486: "/// 没被扫描进库的本地曲目：跳过统计而不是撞外键报错（统计不能影响播放）",
491: '        id: "D:/music/未知.mp3".to_string(),',
493: '        title: "本地歌".to_string(),',
500: '    record_play_stat(&conn, &local, 1000).expect("本地曲目统计不该报错");',
504: "/// 封面要能随曲目读回来：收藏 / 历史 / 歌单 / 统计这几个列表都从 tracks.pic_url 取。\n/// 之前这些查询把 pic_url 写死成空串，列表页就全是空白封面 —— 这里盯住别再退化。\n#[test]",
519: '    let pid = create_playlist(&conn, "测试歌单").expect("建歌单");',
522: '    record_play_stat(&conn, &t, 210_000).expect("统计");',
534: '        list_top_tracks(&conn, 10).expect("统计列表")[0].track.pic_url,',
543: "/// 回归：**手机端收藏的本地歌要能落进 PC 的「我喜欢的歌曲」**。\n///",
544: '/// 用户实测场景：手机端把一首「本地音乐」（手机上的音频文件）收藏后，\n/// PC 的「我喜欢的歌曲」里没有这首，而 PC 端收藏的本地歌手机上却有 —— 单向。\n/// 根因是收藏变更落库（`cmd_like_apply`）与启动对账（`cmd_like_reconcile`）\n/// 把 `platform = "local"` 当未知平台整条 `continue` 掉了，行根本没入库，',
545: "/// 所以歌单查询自然查不到（而不是查询/展示层把它过滤了）。\n///",
546: "/// 本地曲目的 `id` 是设备自己的标识（PC 是绝对路径、Android 是 `local_<MediaStoreId>`），",
547: "/// 所以跨设备这条曲目只保证「显示得出来」（标题/歌手/专辑来自 liked_songs），",
548: "/// 不保证能播放 —— 这与手机端展示 PC 的本地歌是同一口径。\n#[test]",
551: "    // 手机端本地曲目的 id 形态（Android MediaStore id），且 pid 指向「我喜欢的歌曲」\n    let phone_local = Track {",
554: '        title: "人生路慢慢".to_string(),',
556: '        album: "某专辑".to_string(),',
564: "    // 主键口径必须是 local:<原始 id>，且能拆回去（否则最新收藏会串音源）",
572: "    // 歌单查询（PC「我喜欢的歌曲」页走的就是这条）必须能查到",
574: '    assert_eq!(songs.len(), 1, "手机端收藏的本地歌应出现在我喜欢的歌曲里");',
575: '    assert_eq!(songs[0].title, "人生路慢慢");',
578: '    // 收藏列表（按 pid）同样要带上它\n    assert_eq!(',
583: '    // 本地曲目不写 tracks 表（扫描器负责），所以没封面/时长也不该丢行\n    let track_rows: i64 = conn',
590: '    assert_eq!(track_rows, 0, "外部本地曲目不应污染 tracks 表");',
}

raw = open(REC, encoding="utf-8").read()
lines = raw.split("\n")
print("recovered 行数:", len(lines))
bad = [i for i, l in enumerate(lines, 1) if "\ufffd" in l]
missing = [i for i in bad if i not in REPAIR]
print("未覆盖的受损行:", missing)

for i, txt in REPAIR.items():
    lines[i - 1] = txt

new = "\n".join(lines)
left = new.count("\ufffd")
print("重建后残留 U+FFFD:", left)
print("重建后行数:", len(new.split("\n")))

open(OUT, "w", encoding="utf-8", newline="").write(new)
print("已写出", OUT)

# ---- 行尾/BOM 与邻居文件对比 ----
for name in ("likes.rs", "playlists.rs", "mod.rs", "tests.rs"):
    p = os.path.join(DIR, name)
    b = open(p, "rb").read()
    print(f"  {name}: BOM={b[:3] == b'\xef\xbb\xbf'} CRLF={b.count(b'\r\n')} LF={b.count(b'\n')} bytes={len(b)}")

# ---- 正向变换校验：重建结果必须能还原出 .corrupt ----
def forward(text):
    buf = text.encode("utf-8")
    out = []
    i = 0
    n = len(buf)
    while i < n:
        b1 = buf[i]
        if b1 < 0x80:
            out.append(chr(b1))
            i += 1
            continue
        if i + 1 < n:
            b2 = buf[i + 1]
            trail_ok = (0x40 <= b2 <= 0x7E) or (0x80 <= b2 <= 0xFE)
            if 0x81 <= b1 <= 0xFE and trail_ok:
                try:
                    ch = bytes([b1, b2]).decode("gbk")
                    out.append(ch)
                    i += 2
                    continue
                except UnicodeDecodeError:
                    pass
        out.append("?")
        i += 2 if i + 1 < n else 1
    return "".join(out).encode("utf-8")

corrupt = open(CORRUPT, "rb").read()
got = forward(new)
print()
print("正向变换校验: 期望", len(corrupt), "字节, 得到", len(got), "字节 ->", "一致" if got == corrupt else "不一致")
if got != corrupt:
    for k in range(min(len(got), len(corrupt))):
        if got[k] != corrupt[k]:
            print("  首个差异 offset", k, repr(got[max(0,k-40):k+40]), "||", repr(corrupt[max(0,k-40):k+40]))
            break
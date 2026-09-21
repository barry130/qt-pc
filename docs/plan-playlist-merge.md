# 收藏 / 歌单模型重构（进行中）

目标：**歌单是唯一的组织单位**。

- `platform == "local"` → 本地歌单（本地创建的）
- 其他（qq / wyy / kw / kg）→ 在线歌单（从音源收藏的）
- 收藏歌曲必须归属到歌单，不再有独立的「收藏歌曲」列表
- **同步规则与 qt-uniappx 完全一致**

---

## 一、qt-uniappx 的实际逻辑（已核对，不是猜的）

### 1. 数据模型：歌曲与歌单是**两个独立的平行列表**

`qt-uniappx/stores/player.ts`：

- `likedSongs: Song[]` —— 收藏的歌曲
- `savedPlaylists: Playlist[]` —— 收藏的歌单

两者**没有绑定关系**。后端 `songs` 上确实有 `pid` 字段（值为 `local` 或某个歌单 id），
但**移动端没有用它做绑定**。

> 注意：用户口头要求「歌曲收藏必须与歌单绑定」，这与移动端现状不同。
> 以最新指令「要和 qt-uniappx 的逻辑一致」为准 —— 即**照搬同步规则**，
> 绑定关系属于 PC 端自己的 UI 组织方式。

### 2. 同步：增量 + 全量兜底 + LWW

`qt-uniappx/services/like.ts` 与 `stores/player.ts`：

| 接口 | 用途 |
|---|---|
| `POST app/user/like/song` `{action, sid, platform, name, singer, album, hash}` | 单曲收藏/取消，返回 `data.seq` |
| `POST app/user/like/playlist` `{action, pid, platform, name, picUrl}` | 歌单收藏/取消 |
| `GET app/user/like/changes?since=N` | 增量，返回 `{changes, maxSeq}` |
| `GET app/user/like/list?page&size` | 全量分页，返回 `{songs, playlists, maxSeq}` |

**关键**：`changes` 只保留最近若干条变更，老数据**不在里面**（实测 since=0 只回 4 条）。
所以**首次必须走全量**。`doFullPull()` 用 `fetchAllLikes(page, 500)` 循环，`page <= 100`。

**合并策略（LWW）** `player.ts:1338`：

1. 以服务器数据为准重建列表
2. 遍历本地条目，若满足以下之一则**保留本地版本**：
   - `hasPendingLikeOp("song"|"playlist", id, platform)` —— 本地有待推送的操作
   - `localSeq > serverSeq` —— 本地 seq 更新
3. 推进 `likeCursor = maxSeq`

### 3. 离线队列

`enqueueLikeOp()`：`player.ts:1050 / 1440 / 1498`。
离线时的收藏操作先入队（payload 存 JSON），联网后补推。
**PC 端目前没有这一层**，是全量/增量直接覆盖。

### 4. 字段归一

`like.ts:123` `parseChange()`：
- `type` 只认 `"song"` / `"playlist"`，其余丢弃
- `id` 优先取 `id`，缺失时回退 `sid` / `pid`；仍为空则丢弃整条
- `deleted` 字段表示取消收藏（全量接口里对应 `deletedAt != null`）

---

## 二、桌面端现状（已核对表结构）

| 表 | 说明 |
|---|---|
| `playlists` | 本地歌单。**无 platform 列**（天然就是 local）。字段：id, name, description, cover_path, is_smart, sort_order, is_favorite, created_at, updated_at |
| `playlist_tracks` | 歌单↔曲目：playlist_id + track_id + position |
| `liked_songs` | 收藏歌曲。**有 uid / updated_seq，无 pid**。约束 `UNIQUE(uid, platform, sid)` |
| `liked_playlists` | 收藏在线歌单。字段：id, uid, pid, platform, name, pic_url, is_import, deleted_at, updated_seq, updated_at, created_at。约束 `UNIQUE(uid, platform, pid)` |

**约定**：`uid` 固定写 `0`（与现有 `add_liked_song` 同口径，本地收藏不区分账号）。

---

## 三、分步计划

### 第一步：统一歌单视图 ✅ 已完成（已验证）

- [x] `store::list_my_playlists` —— 合并查询（本地 + 在线，按时间倒序）
- [x] `PlaylistSummary` 扩展 `platform` + `pic_url`（**加字段不换结构**，前端零改动即可编译）
- [x] `commands.rs` 现有 `cmd_list_my_playlists` 改调合并版
- [x] `types/index.ts` 的 `MyPlaylistSummary` 同步加 `platform` / `picUrl`
- [x] `MyPlaylistsPage.tsx` 重写：按 platform 分「本地歌单 / 收藏的在线歌单」两组
- [x] 在线歌单点击跳 `/playlist/$platform/$id`（本地仍走 `/my/playlist/$id`）
- [x] 在线歌单隐藏「重命名」，「移除」= 取消收藏（调 `unfavoritePlaylist`）
- [x] 应用已重启，日志确认 `liked_songs 补上 pid 列`

> 本地歌单的 `platform` **不落列** —— 它天然就是 local，查询时用常量，省一次表结构变更。

### 第二步：歌曲归入歌单 ⬜ 进行中

- [x] `liked_songs` 补 `pid` 列（`NOT NULL DEFAULT 'local'`），已通过补列机制生效
- [ ] `add_liked_song` 加 `pid` 参数并写入
- [ ] `cmd_add_favorite` 接收 pid（可选，默认 `local`）
- [ ] 前端收藏歌曲时传入所属歌单
- [ ] `pid=local` 的散装收藏归入默认歌单「我喜欢的音乐」（platform=local）
- [ ] `FavoritesPage.tsx` 去掉「歌曲」tab

> **注意**：`liked_songs` 的唯一约束是 `UNIQUE(uid, platform, sid)`，**不含 pid**，
> 所以同一首歌在表里只有一条记录、只能归属一个歌单。
> SQLite 不支持改约束，真要支持「一首歌在多个歌单」得重建表（换 `playlist_tracks` 那套关系）。
> 当前取舍：在线歌单的曲目点开时向音源取、本地歌单的曲目走 `playlist_tracks`，
> `liked_songs` 只承担「同步用的收藏记录」这一个职责。
- [ ] 收藏歌曲时指定 pid
- [ ] `pid=local` 的散装收藏归入默认歌单「我喜欢的音乐」（platform=local）
- [ ] 现有散装收藏原样迁移，不丢数据

### 第三步：同步规则对齐移动端 ⬜ 未开始

- [ ] 全量兜底：`like/list` 分页，size 改 **500**（对齐 `fetchAllLikes(page, 500)`）
- [ ] LWW 冲突解决：`localSeq > serverSeq` 或「待推送」→ 保留本地
- [ ] 待推送队列：离线收藏先入队，联网补推
- [ ] `parseChange` 的字段归一（type 只认 song/playlist，id 回退 sid/pid）

---

## 四、踩过的坑（务必先看结构再动手）

1. **`CREATE TABLE IF NOT EXISTS` 对已存在的表不补列**
   → `liked_playlists` 早于 v2 存在，加 `play_count` 时静默失败，插入报 `no column named play_count`。
   补列要按 `PRAGMA table_info` 检查后 `ALTER TABLE ADD COLUMN`。

2. **`liked_playlists.uid` 是 NOT NULL 且无默认**
   → 必须显式写 `uid = 0`。

3. **`list_my_playlists` 命令已存在**
   → 重复定义直接编译失败（E0428）。改现有命令，不要新增同名命令。

4. **错误处理里引用模块常量会掩盖真实错误**
   → 同步代码在启动早期执行，引用尚在 TDZ 的常量会抛 `ReferenceError`，
   把真正的错误（如 SQL 报错）盖掉。同步相关代码一律用**字符串字面量**。

5. **PowerShell 的 `Invoke-WebRequest` 走系统代理，探 `localhost` 会超时**
   → 用 `node -e "fetch(...)"` 探活。

6. **`cargo test` 前必须 kill 运行中的应用**
   → 否则 `failed to remove ... quietmusic.exe`（os error 5）。

---

## 五、验证基线（上一轮结束时的状态）

- `cargo clippy --all-targets -- -D warnings`：零警告
- `cargo test`：78 passed
- `pnpm tsc --noEmit`：无错
- `pnpm vitest run`：18 passed / 3 files

应用运行方式（**`pnpm tauri dev` 在本环境是坏的**）：
Vite dev server（端口 1420）+ `src-tauri` 下 `cargo run`。

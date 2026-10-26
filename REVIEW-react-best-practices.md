# qt-pc React 最佳实践全量审阅报告

- 日期：2026-10-24
- 依据：Vercel React Best Practices（vercel-react-best-practices 技能，70 条规则 / 8 类）
- 范围：qt-pc `src/` 全部 ~190 个 .ts/.tsx（约 1.9MB）。大文件全文细读（SettingsPage 3921 行、daily-recommend 2573 行、ai-assistant-local 735、recommend-dimensions 724、ai.ts 658、recommend-rank 643、richText 459、router 378、skins 318、stat 314、TrackList、QueuePanel、LyricScroller 等），其余快扫。
- 方法：5 个并行子代理分片（lib 前半 / lib 后半 / hooks+stores+services / discovery+player+music-source+source-engine / mine+common+layout+根组件+ai-assistant+lyric 等），交叉抽查了最高优先级发现的原文。
- 不适用：server-\*（RSC/SSR/缓存/hydration）类规则——本项目是 Tauri 2 + React 19 + Vite 纯客户端 SPA。
- 结果：**去重后 35 条规则内发现 + 1 条规则外缺陷**。高 5 / 中 11 / 低 19 + 规则外 1。

---

## 一、系统性主题

### 主题 A：播放进度 rAF 插值驱动的每帧全量重渲（最优先处理）

根因在 `src/hooks/useInterpolatedPosition.ts:22-26`：播放中 rAF 循环每帧 `setValue(interpolated())`，无量化/阈值。三个常驻消费端跟着 60fps 重渲：

| 位置 | 影响 |
| --- | --- |
| `src/components/player/PlayerBar.tsx:82` | 底部整个 PlayerBar（15+ 控件）播放期间每帧重渲 |
| `src/components/discovery/PlayingPage.tsx:43`（另 :118 `findActiveIndex` 每帧 O(歌词行数) 重扫） | 正在播放页全页每帧重渲 |
| `src/components/player/MiniPlayer.tsx:59`（:206-227 队列 map） | 迷你窗队列（可 200+ 行按钮）每帧全量 reconcile |
| `src/components/player/LyricScroller.tsx:217-265` | 歌词行（含逐字/翻译/音译）内联未 memo，每帧全列表重渲，而逐字染色只用 active 行 |

修法（两选一或组合）：① 把 hook 下沉到仅消费进度的叶子组件（进度条 / 歌词面板各自独立），上层不订阅每帧值；② rAF 直写 ref/DOM style 不走 React state。项目内已有现成范本：`LyricWindow.tsx:338-353` 先量化再 setState。歌词行顺手提取 memo 化 `LyricLine`，positionMs 只传 active 行（非 active 传 0）。

### 主题 B：串行 await 瀑布（async-parallel）

互不依赖的异步操作串行执行，延迟为各段之和。典型：`useAiChat.send` 四段、每日推荐三路取数、手动搜歌词 8 连发。明细见清单 B 组。

### 主题 C：重渲与 memo

`QueuePanel` 行组件未 memo（拖拽掉帧主因）；`SearchPage`/`PlaylistsPage` 列表行未 memo；`useAiChat` 的 `messages` 依赖导致流式期间四个 useCallback 每 300ms 重建。项目里 `TrackList.tsx:139-153` 的 latest-ref 稳定回调模式是标准答案，复制即可。

### 主题 D：JS 热路径

排序比较器内重复归一化、队列 `trackKey`（JSON.stringify）反复重算、每日推荐 `reasonOf` 每行 O(n) 查找造成整列表 O(n²)。

### 主题 E：正确性与持久化

`useLyricOffset` 在 setState updater 内做 IPC 副作用（StrictMode 下可能重复落库）；`stat.ts` 队列持久化按条数封顶不按字节，错误风暴下可能超 localStorage 配额且静默失败。

---

## 二、完整清单（按严重度）

### 高（5）

| # | 规则 | 位置 | 问题 | 建议 |
| --- | --- | --- | --- | --- |
| 1 | rerender-defer-reads | `src/hooks/useInterpolatedPosition.ts:22-26`（调用点 PlayerBar.tsx:82 / PlayingPage.tsx:43 / MiniPlayer.tsx:59） | rAF 每帧 setValue 无量化，PlayerBar/PlayingPage/MiniPlayer 播放期间 60fps 全量重渲 | 下沉到叶子组件或 ref/DOM 直写；参考 LyricWindow.tsx:338-353 量化范式 |
| 2 | rerender-memo | `src/components/player/LyricScroller.tsx:217-265` | 歌词行内联在接收 positionMs 的组件内，每帧全列表重渲 | 提取 memo 化 LyricLine，positionMs 只传 active 行 |
| 3 | rerender-memo | `src/components/player/MiniPlayer.tsx:59,206-227` | 顶层每帧更新，展开队列时 200+ 行跟着每帧 reconcile | 队列区提取为 memo 子组件，进度条留在原组件 |
| 4 | rerender-memo | `src/components/player/QueuePanel.tsx:498-654` | 队列行未 memo、无 content-visibility，拖动 overIndex 每换一行/多选每次点选全列表重渲（拖拽掉帧主因） | 行提取 memo 组件（复用 TrackList.tsx:139-153 latest-ref 模式）+ 行加 content-visibility |
| 5 | async-parallel | `src/hooks/useAiChat.ts:692-742`（send，:721 起） | 发消息串行瀑布：prepareCandidates（全源聚合搜索，链路最慢）→ 建会话 → buildContext（内部拉历史）→ astralAiSendMessage，互不依赖 | Promise.all 并行搜索与建会话/拉历史，砍掉 AI 首字延迟 |

### 中（11）

| # | 规则 | 位置 | 问题 | 建议 |
| --- | --- | --- | --- | --- |
| 6 | async-parallel | `src/hooks/useAiChat.ts:225-268`（init） | readAiMode → agents → capabilities → loadConversations 四步全串行；后两步独立 | 后两步 Promise.all |
| 7 | async-parallel | `src/lib/recommend-dimensions.ts:506-592` | collectDimensionLanes 三条独立网络路（榜单/关键词/歌单）串行 await，每日推荐生成延迟≈三路之和 | Promise.all 并跑（各路保留 try/catch；order 参数保证合并顺序不变） |
| 8 | async-parallel | `src/lib/localOnline.ts:384-408`（:393-395） | searchLyricCandidates 对 8 条候选逐个 await getLyric，串行 8 次网络往返 | `hits.map(h => getLyric(h).catch(() => null))` + Promise.all，按原序过滤非空 |
| 9 | rerender-dependencies | `src/hooks/useAiChat.ts:483`（sendLocal）、:797（stop）、:847（runAction）、:861（feedback） | deps 含 messages，流式期间每 300ms 一批 delta → 四个 useCallback 全部重建，消费组件 memo 失效；内部只用最近 6 条/最后一条 | 仿 activeConversationRef（:171）加 messagesRef 镜像，deps 收窄 |
| 10 | rerender-dependencies | `src/hooks/useAiChat.ts:487-514`（buildContext） | 依赖 [options]，hook 参数对象每渲染新字面量 → useCallback 失效，连带 send 每渲染重建 | 解构出 context，依赖 [context] |
| 11 | rerender-memo | `src/components/discovery/SearchPage.tsx:761,559,411` | 本地 TrackRow 未 memo 且 onPlay 内联；输入框每次击键数百行结果全量重渲 | TrackRow memo + onPlay 改稳定回调（对标 TrackList） |
| 12 | rerender-memo | `src/components/discovery/PlaylistsPage.tsx:173-178` | CoverCard 未 memo 且每项内联 onClick（navigate 闭包）；无限滚动累计数百卡每次翻页全重渲 | CoverCard memo + onClick 改接收 item 的稳定回调 |
| 13 | js-cache-repeated-function-calls | `src/lib/track-sort.ts:112-141` | 比较器每次比较对两侧字段调 normText（3 正则+toLowerCase，最多 6 次/比较），数千首歌单同一首歌归一化被重算 ~log N 次 | :115 decorate 步顺手预计算三字段归一化串（Schwartzian transform） |
| 14 | js-set-map-lookups | `src/components/player/QueuePanel.tsx:46-53,283-300` | matchesQueue 每次调用对全队列逐行 trackKey(JSON.stringify) 重算：拖动中每 pointermove 一次 O(n)、行 key 每渲染再算一遍 | useMemo 按 queue 引用缓存 keys 数组，比较改 keys 对 keys |
| 15 | js-set-map-lookups | `src/components/discovery/DailyRecommendPage.tsx:223-231` | reasonOf 内 items.find 每行 O(n)，TrackList 逐行调用 → 整列表 O(n²)（近万次比较/次重渲） | useMemo 建一次 Map<platform:id, reason> |
| 16 | rerender-functional-setstate | `src/hooks/useLyricOffset.ts:103-111,123-131` | setDraftState updater 函数体内调 setOffsetMs + IPC setLyricOffset（写库）；updater 必须纯，StrictMode/并发渲染可能双调用 → 重复落库 | 事件处理器先算目标值再分别 set，IPC 放 updater 外 |

### 低（19）

| # | 规则 | 位置 | 问题 | 建议 |
| --- | --- | --- | --- | --- |
| 17 | async-parallel | `src/hooks/usePlaybackEvents.ts:30-63` | 4 个 ipc.on\* 监听逐个 await 注册；getQueue 在 restore 后串行 | Promise.all，缩短首帧播放快照 |
| 18 | async-parallel | `src/hooks/useAiChat.ts:341-356` | prepareCandidates 内 ensure() 与 readAggregateSources() 串行 | Promise.all |
| 19 | async-parallel | `src/hooks/useUpdateCheck.ts:32-35` | 官方版本校验与更新检查串行（各自已 catch） | Promise.all |
| 20 | async-parallel | `src/hooks/useSourceUpdateCheck.ts:26-29` | discoverSourceUpdates 与 getSourceState 串行 | Promise.all |
| 21 | async-parallel | `src/lib/daily-recommend.ts:2403-2406`、:2324-2332 | checkDisliked 与 listHistory 串行；readMode 与 readTaste 串行 | 各合并一次 Promise.all（文件 :851 已有同款写法） |
| 22 | async-parallel | `src/lib/playlist-import.ts:36-43` | getPlaylistDetail 与 isPlaylistFavorited 串行（后者本地快读，收益小） | Promise.all |
| 23 | async-parallel | `src/components/settings/AiProvidersPanel.tsx:444-460` | detectProtocol 四协议串行探测，早位失败逐个吃满超时（最坏 4×） | Promise.all 并行后按原序取首个成功项（保留优先级语义） |
| 24 | async-parallel | `src/components/mine/FeedbackDetailPage.tsx:46-47` | 详情与回复两个独立 IPC 串行 | Promise.all |
| 25 | async-parallel | `src/components/library/LibraryPage.tsx:207-214` | 扫描后三个独立 IPC 串行 | Promise.all 后统一提交 |
| 26 | js-cache-repeated-function-calls | `src/lib/collect-dup.ts:100-106` | 循环内每轮重算 track 侧 normalizeTitle（3 正则）与歌手重拆 | 进循环前预归一化 track 侧 |
| 27 | js-cache-repeated-function-calls | `src/lib/daily-recommend.ts:2145,2178` | evidenceSnapshot 在 limitAiPicks + filterAiPicks 链路各算一遍 | generateDailyRecommend 里算一次传参 |
| 28 | js-cache-repeated-function-calls | `src/lib/skins.ts:153-225,256-318` | extractCoverColor 与 extractCoverAccent 各自 fetch+解码同一封面 URL；无在飞去重 | 仿 pending-cache.ts in-flight 模式共享一次 fetch/解码 |
| 29 | js-cache-repeated-function-calls | `src/lib/recommend-rank.ts:385-394,425-438` | MMR 循环每轮对每候选重算与全部已选的 similarity（≈7×10⁵ 次，几十 ms，仅生成/换一批时执行） | 每候选维护 running max，选中后 O(N) 增量更新 |
| 30 | client-localstorage-schema | `src/lib/stat.ts:22,130-139` | 统计队列持久化按条数(500)封顶但不按字节、无版本 key：错误风暴 500×16KB stack≈8MB 超配额，storageSet 静默失败使「托盘收起防丢」恰在此时失效；老 schema 事件可混入上报被后端整批打回 | 按 JSON 总长截断（>1MB 丢最旧）+ 加 schema 版本 key |
| 31 | rerender-dependencies | `src/hooks/useLyricOffset.ts:61` | 渲染期写 keyRef.current，与 usePagedList.ts:74-78 自己注释的并发渲染风险相悖 | 挪进 useEffect |
| 32 | client-event-listeners | `src/hooks/useDismissOnOutside.ts:32` | effect 依赖 onClose（调用方多传内联箭头），弹层打开期间 window 监听反复卸载重挂（清理正确，纯 churn） | onClose 存 ref，deps 收敛为 [ref, open] |
| 33 | client-passive-event-listeners | `src/components/common/ContextMenu.tsx:62` | window scroll 监听（capture）未加 passive；close 不调 preventDefault | `{ capture: true, passive: true }` |
| 34 | rendering-content-visibility | `src/components/discovery/SearchPage.tsx:554-561` | 搜索结果行无 content-visibility（TrackList 行已有 .cv-row） | 复用 .cv-row 同款样式 |
| 35 | js-batch-dom-css | `src/components/player/LyricScroller.tsx:159-175` | moveDrag 每 pointermove 写 scrollTop 后全列表读 offsetTop → 强制同步布局 + O(n) | 拖动激活时缓存各行 top，move 内扫缓存数组 |

### 规则外真实缺陷（1）

| # | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| 36 | `src/components/discovery/PlaylistsPage.tsx:61-64` | 排序切换 effect 直接 setSort 但不重置 page/items，load 重跑会把新排序的第 page 页 append 到旧列表 | 切排序时重置分页与已加载列表 |

---

## 三、已确认的良好实践（审阅中验证过、无需改动）

- **store 层**：普遍遵守「action 内 getState() 读取、选择器不订阅过粗」；`stores/player.ts` 把高频 positionMs 标量刻意放 state 快照之外（tick 级数据勿动）。
- **基础设施**：sourceRegistry 模块级单次绑定 + inflight 去重；source-engine/client.ts pending Map 配对、refreshing 单飞、指数退避；LRU/TTL/pending 合并缓存（localOnline、paged-all、artist-pic、pending-cache）。
- **列表优化范本**：TrackList / AlbumPage / ArtistPage / PlaylistDetailPage 已系统应用 memo + useCallback + Set 去重 + content-visibility(.cv-row) + latest-ref 稳定回调——修 QueuePanel/SearchPage 时直接照抄。
- **持久化**：ai-assistant-history、daily-recommend 的 localStorage 均有版本 key + try/catch + 容量封顶；search-history 走 SQLite。
- **安全**：richText.tsx 自写 HTML 白名单解析器，无 dangerouslySetInnerHTML。
- **大文件**：SettingsPage 3921 行、TitleBar 全文细读无一条问题（无内联组件、IPC 加载已 Promise.all、监听清理完备）。
- **有意设计（排除项）**：HorizontalScroller wheel `passive:false`（需 preventDefault）；quality-fallback 串行降档是语义；CollectButton setLiked(favorited) 是乐观 UI 回填；各 draft 镜像 effect 属输入草稿/计时动画合法模式；usePagedList 渲染期状态归位是 React 官方模式；lrc.ts O(n×m) 合并、spreadItemsBySinger O(n²)、salvageField new RegExp 等因实际规模小（几十~百次）按「只报真实可落地」跳过。

---

## 四、建议修复顺序

1. **主题 A**（#1–#3）：播放中 CPU 占用/掉帧体感收益最大；hook 下沉 + 歌词行/迷你窗队列 memo。
2. **#5 useAiChat.send 并行**：直接砍 AI 首字延迟。
3. **#16 useLyricOffset updater 副作用**：正确性问题，改动小。
4. **#4 + #14 QueuePanel**：memo 行 + trackKey 缓存，修拖拽掉帧。
5. **#9 + #10 useAiChat deps 收窄**：流式期间 callback churn。
6. **#7 + #8**：每日推荐三路并行、手动搜歌词并行。
7. **#13 + #15**：排序预归一化、reasonOf 换 Map。
8. **#36 PlaylistsPage 分页重置**（顺手修的正确性 bug）。
9. 其余低优先级按需批量处理（多为机械 Promise.all / passive / memo 补齐）。

> 本报告正文为审阅阶段的只读结论（行号以审阅当时的工作区为准）。**36 条已全部修复**，逐条落地情况见下节。

---

## 五、修复落地记录（2026-10-24 21:40）

验收：`pnpm typecheck` 0 错、`pnpm lint` 0 告警、`pnpm test` **101 文件 / 993 用例全绿**。

### 主题 A：播放进度（#1–#3）
- **#1** `src/hooks/useInterpolatedPosition.ts`：新增 `QUANTUM_MS = 100` + `quantizePosition()`，rAF 内只在量化值跨桶时 `setState`。渲染频率 60fps → ~10fps，误差上界 ±50ms（仍满足歌词同步 ≤50ms 口径）。三个消费端（PlayerBar / PlayingPage / MiniPlayer）不再每帧重渲。
- **#2** `src/components/player/LyricScroller.tsx`：提取 `LyricLineRow`（`memo` + 窄 props），`positionMs` 只在 active 行传真实值、其余行传常量 `0`，播放中整表 memo 不再被击穿。
- **#3** `src/components/player/MiniPlayer.tsx`：提取 `MiniQueueRow`（`memo`）+ `handlePlayAt` 改 `useCallback`，队列行只在换歌/播放行切换时重画。

### 主题 C：重渲与 memo（#4、#11、#12、#9、#10）
- **#4** `src/components/player/QueuePanel.tsx`：队列行提取为 `QueueRow`（`memo`），行加 `.cv-row`（`content-visibility: auto`）；`endPointerDrag` 依赖补齐 `resetPointerDrag`。
- **#11/#34** `src/components/SearchPage.tsx`：本地 `TrackRow` 改 `memo` + `onPlayTrack` 稳定回调，行加 `.cv-row`。
- **#12** `src/components/discovery/CoverCard.tsx`：改为 `memo` 泛型组件（`item` + `onPick(item)` 契约替代内联 `onClick`），并同步改造 `SearchPage` / `DiscoverPage` / `PlaylistsPage` 三处调用方（`playTrack` / `openArtist` / `openAlbum` / `openPlaylist` 全部 `useCallback`）。
- **#9** `src/hooks/useAiChat.ts`：新增 `messagesRef` 镜像，`sendLocal` / `stop` / `runAction` / `feedback` 改读 ref，deps 里去掉 `messages`——流式期间不再每 300ms 重建四个回调。
- **#10** `buildContext` deps 收敛为 `[context]`（原来 `[options]` 每次渲染换字面量）。

### 主题 B：串行瀑布（#5–#8、#17–#25）
- **#5** `send`：`prepareCandidates` 与建会话并行发出（`Promise.all`），`buildContext` 在其后合并候选——首字延迟从「两者之和」降到 `max`。
- **#6** `init`：`loadCaps()` 与 `loadConversations()` `Promise.all`。
- **#18** `prepareCandidates`：`readAggregateSources()` 与 `sourceRegistry.ensure()` `Promise.all`。
- **#7** `src/lib/recommend-dimensions.ts`：拆出 `collectCharts` / `collectKeywords` / `collectPlaylists` 三个局部 async 函数，三路 `Promise.all` 并跑，再按「榜单→关键词→歌单」固定顺序 `append`（`seq`/`order` 与串行完全一致）。
- **#8** `src/lib/localOnline.ts`：`searchLyricCandidates` 改 `Promise.all(hits.map(...))` 后按原序过滤空歌词。
- **#17** `src/hooks/usePlaybackEvents.ts`：四个 `ipc.on*` 改 `Promise.all` 并发注册，任一失败即中止后续读取。
- **#19** `useUpdateCheck` / **#20** `useSourceUpdateCheck`：各自 `Promise.all`。
- **#21** `src/lib/daily-recommend.ts`：`readMode`/`readTaste` 并行（:2330）、`checkDisliked`/`listHistory` 并行（:2414）。
- **#22** `playlist-import`、**#23** `AiProvidersPanel.detectProtocol`（四协议并行后按原序取首个成功项）、**#24** `FeedbackDetailPage`、**#25** `LibraryPage` 扫描后三 IPC：全部 `Promise.all`。

### 主题 D：JS 热路径（#13、#14、#15、#26–#29）
- **#13** `src/lib/track-sort.ts`：Schwartzian transform，`decorated` 预计算三字段 `normText`，比较器不再重复归一化。
- **#14** `QueuePanel`：`queueKeys = useMemo(() => queue.map(trackKey), [queue])`，`matchesQueueKeys()` 直接比对已算好的 keys，行 `key` 复用同数组，拖动中不再逐行 `JSON.stringify`。
- **#15** `DailyRecommendPage`：`reasonByKey`（`Map<platform:id, reason>`）建一次，`reasonOf` 改 `useCallback` 查表，消除 O(n²)。
- **#26** `src/lib/collect-dup.ts`：拆纯函数 `sameNormalizedTitle` / `artistsCompatible`，`findCrossSourceDup` 循环外预归一化 track 侧。
- **#27** `daily-recommend`：`evidenceSnapshot` 在 `generateDailyRecommend` 里算一次，作为 `snapshotIn` 传进 `limitAiPicks` + `filterAiPicks`。
- **#28** `src/lib/skins.ts`：新增 `loadCoverImage()`（fetch→blob→Image，`finally` 里 `revokeObjectURL`）+ `coverImageInflight` 去重，`extractCoverColor` / `extractCoverAccent` 共用一次取图。
- **#29** `src/lib/recommend-rank.ts`：MMR 维护 `simMax` running max，选中后 O(N) 增量更新（输出逐位不变，34 条单测验证）。

### 主题 E：正确性与持久化（#16、#30、#31–#36）
- **#16** `src/hooks/useLyricOffset.ts`：新增 `draftRef` 同步镜像，`commit`/`nudge` 先在事件处理器里算目标值再 `setOffsetMs` + IPC，副作用彻底移出 `setState` updater（StrictMode 下不再重复落库）。
- **#30** `src/lib/stat.ts`：`QUEUE_SCHEMA_VERSION = 2` + `{ v, queue }` 落盘格式（仍兼容 v1 裸数组）、`MAX_QUEUE_CHARS = 2MB` 按字符数丢最旧（每轮 10%）、`isStatEvent()` 过滤脏数据。
- **#31** `useLyricOffset`：`keyRef.current = trackId` 从渲染期挪进 `useEffect([trackId])`。
- **#32** `useDismissOnOutside`：`onCloseRef` + deps 收敛 `[ref, open]`。
- **#33** `ContextMenu`：scroll 监听改 `{ capture: true, passive: true }`。
- **#35** `LyricScroller`：拖动时把行几何（`offsetTop`/`clientHeight`）缓存进 `drag.rowGeometry`，`pointermove` 只扫缓存数组，active 行变化时才重建。
- **#36** `PlaylistsPage`：`pickSort()` 切排序时重置 `page=1` / `items=[]` / `hasMore=true`，不再把新排序的第 2 页 append 到旧列表。

### 连带改动
- `tests/playback-events.test.tsx`：`usePlaybackEvents` 改并发注册后，原「监听注册未完成时卸载」用例的 `expect(onPositionChanged).not.toHaveBeenCalled()` 不再成立（四个监听现在同时发起）。改为断言「迟到的监听被注销 + 已注册的监听也被注销 + 不触发状态读取」，语义覆盖更强。
- `tests/stat.test.ts`：新增 v2 落盘格式、v1 兼容读回、超字符上限丢最旧三组用例。


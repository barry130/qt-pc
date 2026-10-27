# 轻听 PC 端设计文档

- 项目名称：轻听 PC 版
- 目标平台：Windows 10 / Windows 11
- 技术栈：Tauri 2 + React 19 + TypeScript + Tailwind CSS v4 + shadcn/ui + Rust
- 文档版本：v1.24
- 更新日期：2026-10-27
- 关联文档：`qt-pc/REQUIREMENTS.md`、`../UPDATE_DESIGN.md`、`docs/CONFIG.md`、`docs/PACKAGING.md`

---

## 0. 基线核对与修订记录

### 0.1 后端基线核对结论（已对照 astral 源码逐项验证）

| 断言 | 核对结果 | 依据 |
|---|---|---|
| App 接口前缀 `/api/v1/app/**` | ✅ 成立 | `QtAppController`、`QtAppUserController` 的 `@RequestMapping` |
| 认证使用 `satoken` 请求头 | ✅ 成立（**不是** `Authorization: Bearer`） | 所有 App 控制器 `@RequestHeader("satoken")`；`QtAuthInterceptor` 亦读该头 |
| 响应包装器 | ✅ 三种并存，字段一致 `{code,msg,data}` | `QtRestResp`（qt）、`FeedbackRestResp`（反馈/消息）、`Result`（统计/宿主） |
| `type=1101/1102/1103/1104/1105` | ✅ 成立 | `QtAppUpdate.TYPE_WINDOWS = 1103L`（`TYPE_LINUX = 1104L`、`TYPE_MACOS = 1105L`）、`isSupportedType()` |
| `channel=app/pc/web/all` | ✅ 成立 | `SysNotice.CHANNEL_PC = "pc"`、`FeedbackNoticeService.listForPc()` |
| `ut=app-windows/app-linux/app-macos` | ✅ 成立 | `StatEventDTO.ut` 注释 + `dict-init.sql` 字典 `stat_platform` |
| 单批统计 ≤ 200 | ✅ 成立 | `StatReportRequest` `@Size(max = 200)` |
| `like/changes?since=` + `like/list?page=&size=` | ✅ 成立（`size` 默认 500） | `QtAppUserController` |
| 反馈客户端头 `X-App-Ut` / `X-App-Version` / `X-Device` / `X-OS` | ✅ 成立，与接口统计共用一套（`ClientHeaders`），`X-Device`/`X-OS` 落 `sys_feedback` | `AppFeedbackController.submit()` |
| 更新包校验字段 | ✅ **已存在** `md5` 与 `fileSize` | `QtAppUpdate` 实体 |
| 双链接下载 `browserUrl` / `isGithub` | ✅ **已落地**（非待开发） | `QtAppUpdate` 实体 + `QtAppService.getUpdate()` 注释 |
| 旧通知接口 `/api/v1/user/notice/**` | ⚠️ 后端已删除（2026 清理），PC 不得使用 | 原 `QtUserNoticeController`，统一通知走 `app/message/**` |
| Astral 提供音乐内容代理 | ❌ 不提供，结论正确 | 全量 Mapping 扫描无音乐内容接口 |

**新增结论（原文未写明，实现前必须知道）：**

1. `GET /app/update` 的 `version` 参数是**版本号数字的字符串形式**（`Long.parseLong(version)`），不是 `versionName`。传 `"3.0.0"` 会被判为格式错误并返回 `null`。
2. `/app/update` 只返回 `is_published=1` 且 `version_code >` 当前值的记录；`/app/version/check` **不过滤** `is_published`，因此本地未发布版本也能通过官方校验。
3. `channel=beta` 的客户端会同时取 beta 与 stable 的更高版本；`channel=stable` 只取 stable。
4. 移动端调用 `app/message/active` / `center` / `unread-count` 时**未传** `channel`，走后端默认值 `app`。PC 传 `channel=pc` 与后端能力一致，不会互相污染。

### 0.2 本次修订项

| # | 修订 | 位置 |
|---|---|---|
| R1 | 播放地址**不得持久化**到 SQLite，改为进程内缓存（与移动端 `types/music.ts` 注释一致） | §8.3 `tracks` |
| R2 | 补齐在线音频**流式播放链路**（HTTP Range → 磁盘缓冲 → 解码器），原文缺失 | §6.12 |
| R3 | 补齐封面 / MV 的 **Referer 限制**与自定义协议方案，原文缺失 | §6.13 |
| R4 | 桌面歌词改为**歌词窗口自行插值计算**，不再由主窗口中转（主窗口隐藏时定时器会被节流，无法满足 50ms） | §10.2 |
| R5 | 修正「锁定后鼠标穿透」与「悬停解锁」的**逻辑冲突** | §10.4 |
| R6 | 主题变量改用 **shadcn/ui 令牌名 + `@theme inline` 桥接**，否则 shadcn 组件不跟随皮肤 | §9.3 |
| R7 | `ThemeConfig` 拆分为「外观偏好」与「皮肤定义」，皮肤须同时携带 light/dark 两套色板 | §9.2 |
| R8 | `MusicProvider` trait 增加 `#[async_trait]` 与 `Result` 返回，否则无法 `dyn` 分发且丢失错误语义 | §6.4 |
| R9 | 补齐 IPC：`next/previous/play_at/set_quality/switch_source`、主题、桌面歌词、频谱、EQ、睡眠定时 | §11 |
| R10 | 补齐音频核心实现路径：频谱采样点、EQ 实现、输出设备热切换、无缝与淡入淡出、时间轴精度 | §7.7–§7.11 |
| R11 | 本地库补 **FTS5 + 拼音索引**，否则 10 万首规模下「1 秒内返回」无法保证 | §8.6 |
| R12 | 明确外键与「失效文件清理」的**数据安全边界**（`ON DELETE CASCADE` 会连带删除歌单与历史） | §8.7 |
| R13 | 补 `tauri.conf.json` / `capabilities` / CSP 骨架与无边框窗口的代价说明 | §4.1、§17.4 |
| R14 | 补 PC `versionCode` 规则与发布流程 | §15.7 |
| R15 | 路由表、事件表、状态结构补全至与 §19 目录结构一致 | §5.2、§11.8、§12.1 |
| R16 | 路由表拆出 `/daily-recommend`（每日推荐）与 `/daily`（每日新歌）两个独立页面，原文把两者混成一行；设置页分节补 `network` / `ai` | §5.2、§5.4 |
| R17 | 补「每日推荐」完整设计：三种推荐方式、三种口味、候选池四路、同歌手打散、当天缓存与失效规则、空态与降级文案 | §5.2「每日推荐」 |
| R18 | 补 `ai_local` 客户端直连模型：五个命令、重试与超时口径、SSE 兼容、Key 只留 Rust 侧 | §11.7.1、§17.1 |
| R19 | 「每日推荐」排序口径从**按歌手**改为**按风格画像多维综合**：新增 `music-style`（画像）/ `recommend-rank`（打分与多样性）/ `recommend-types`（契约）三个纯逻辑模块；候选池新增「同专辑」「风格歌单」两路；配额放宽改两阶段（先语种后歌手）；推荐理由改事实分级 | §0.3-F、§5.2「每日推荐」、§19.1、§20.2 |
| R20 | 「每日推荐」补**冷启动**：无播放记录也无收藏时不再给空页面，改为列出音源平台风格分类让用户点 2–4 个（存 `dailyRecommend.styleSeeds`，并入画像 tags），跳过则先给一批按分类歌单 + 最新流铺的兜底内容；冷启动**不调本地模型**（没有画像，让模型挑等于让它瞎猜） | §0.3-G、§5.2「每日推荐」、§8.8、§20.2 |
| R21 | 跨源聚合搜索下沉到**数据包**：qt-sources 新增 `searchMany` 入口（`META_REVISION` 5→6，一次调用搜 N 个关键词：包内 worker 池并发、总预算闸、逐词失败隔离），qt-pc facade 加 `searchManyBatches`，每日推荐候选池 ② 改为按 `SEARCH_CONCURRENCY` 分块调用；装在旧数据包上时自动退回 app 侧扇出（探测后记住，不再重复失败调用） | §0.3-H、§5.2「每日推荐」、§20.2 |
| R22 | **聚合搜索只用勾选的音源**：设置 → 音源包新增「聚合搜索音源」开关（`search.aggregateSources`，存源 id 数组，空 = 全部），未勾选的源在**数据包侧就不发请求**（`searchAll`/`searchMany` 可选 `sources` 入参，`META_REVISION` 保持 6），qt-pc facade 再按勾选集过滤一遍作答旧包兜底；覆盖搜索页「全部音源」、AI 找歌、手动换源、每日推荐跨源四个入口，单源搜索不受影响 | §0.3-I、§5.2、§6.2、§8.8、§20.2 |
| R23 | **聚合搜索的合并去重下沉到数据包**：qt-sources 新增 `searchMerged` 入口（`META_REVISION` 6→7，包内负责多源合并、去重、按相关性排序，并回 `full`「是否有任一源满页」作分页依据），qt-pc facade 加 `searchMergedPage`（返回 `{tracks, full}`），搜索页聚合模式改为一条去重列表、去掉「源名 + N 首」分组头、行尾只留源标；装在旧数据包上时退回本地 `mergeAggregateTracks`（探测后记住） | §0.3-J、§5.2、§20.2 |
| R24 | **所有音乐列表在歌名右侧标出平台简称**：抽公共组件 `components/common/SourceTag.tsx`（全站唯一实现，正在播放页 `sm`=11px、列表行 `xs`=10px；取注册表 `short` 简称，旧包无 `short` 回落全名，本地曲目不渲染），替换 12 处自绘源标（`TrackList` / 搜索页 / 队列 / AI 卡片 / 统计页 / 榜单卡片 / 歌曲卡片 / 换源面板 / 歌词搜索 / 听歌记录 ×2）；顺带把原本在歌名**左侧**的全名 chip 统一改成右侧简称；`LOCAL_PLATFORM` 抽到 `lib/platform.ts`，展示组件不再依赖整个 IPC 层 | §0.3-K、§12.2、§20.2 |
| R25 | **去重合并：能公用的实现不再各写一份**。新增四个叶子模块 —— `lib/text.ts`（`normText` / `compactText` / `trackKey` / `songNameKey` / `localDateKey` / `hashString` / `jitter` / `truncateChars` / `safeDecodeURIComponent`）、`lib/coerce.ts`（strict 族 `as*` + coerce 族 `coerce*`，头注释写明「不互相兜底」）、`lib/format.ts`（`formatBytes`）、`lib/pending-cache.ts`（在飞去重 + 已落定缓存）；`components/common/SourceTag` 之后再把听歌报告的两份 `EntryPicture` 合并成 `components/mine/ListenReportBits.tsx`（`size` 32/40 两档）；三份 facade 测试的 `engineInvoke` mock 收敛成 `tests/helpers/engine-client.ts`。**顺带修掉一个真 bug**：`recommend-rank` 曾自带一套 `durationBand` 边界（180/270/420），与 `music-style` 的（150/240/330）不一致 —— 同一首歌在画像里算「长歌」、在打分里算「普通」，`mainBand` 对比错位；现在用 `music-style` 那一份。语义确实不同的（聚合合并的 `normText`/`songKey`、两种 `formatTime`、两个 `SectionTitle`/`CollectButton`、队列的片段级 `trackKey`）**明确不合并**，理由见 §0.3-L | §0.3-L、§19.1、§20.2 |
| R26 | **搜索改成独立的整页**：标题栏原来的输入框改为「打开搜索页」的入口按钮（点击 → `/search` 落地页），搜索页落地页补齐**搜索历史 / 热门搜索**两块内容并自动聚焦输入框；页签栏与聚合开关只在**搜过之后**出现；歌曲页签右端加「播放全部」（已加载的整批入队起播）。理由：完整的搜索需要一个能摆下历史与热搜的版面，标题栏里的小框既放不下也重复实现了一遍输入逻辑 | §0.3-M、§5.2、§5.3、§20.2 |
| R27 | **本地模型精选与规则推荐拉不开差距（根因修复）**：`rankCandidates` 的 `target` 缺省是 `DAILY_TARGET`（50），所以 `rulePicked` 从来不超过 50 首，`DAILY_AI_POOL_MAX`（当时 60、后来 150）**是一段死代码** —— 模型永远拿到「和规则结果逐首相同的 50 首」再挑 50 首，两次结果只有顺序与理由不同。现在本地模型模式下把规则排序的目标放大到 `max(DAILY_TARGET, DAILY_AI_POOL_MAX)`（150），规则结果仍只取前 50；模型回执加三级容错（原样 → 修裸控制字符/尾逗号 → 正则捞序号）与一次低温重试；结果多带 `model` 字段并显示在页头 | §0.3-N、§5.2、§20.2 |
| R28 | **AI 推荐「像随机选」：从「求风格齐全」改成「求贴合」**：用户连续三次反馈后查当天缓存，50 首里第 47–50 首是 `Everywhere We Go`（陈冠希）/ `One Last Time`（Ariana Grande）/ `Control`（Zoe Wees）等与「华语古风」画像无关的英文歌 —— 根因是提示词在**主动推模型凑拼盘**（「不要直接照抄前 50 首」「尽量分散在不同歌手和不同风格」），且候选行只有歌名 / 歌手 / 专辑 / 语种，模型手上没有任何「这首对用户意味着什么」的证据。改法：候选行带本地证据（已收藏 / 听过 N 次 / 常听歌手 / 收藏歌手 / 常听专辑 / **非主语种**）+ 时长带；主语种定得下来时给「50 首里至少 40 首是华语」这种可对账的硬下限；规则改成「越靠前越贴合 / 非主语种不要选 / 整张歌单一个主题」，删掉那两句凑风格的指令；温度 0.8→**0.4**、重试 0.5→**0.2**；结果侧新增 `filterAiPicks`：非探索口味下模型挑进「本地零证据且非主语种」的歌会被剔掉并由规则补满 50 首；补 `limitAiPicks`：提示词让模型从第 51–90 首换进 6–10 首（防止退化成纯规则复读），但其实际会超额，app 侧封顶 12 首且每首需有画像依据；实测 150 首合成池两轮最终 50 首全华语、0 首英文、与规则前 50 重合 38–42 首；`spreadItemsBySinger` 从整段贪心重排改为**最小相邻交换**（第一首永不动，模型排好的顺序基本保留）；`DAILY_RULE_VERSION` 7→8，当天旧缓存自动重算 | §0.3-O、§5.2、§20.2 |
| R29 | **风格更多变、维度更多：先扩候选池，再按风格线配额**：v1.15 把提示词从「求多样」改成「求贴合」后，用户 2026-10-24 08:03 反馈「风格能够在多变一点…推荐的维度可以在多一点…你的数据来源是历史和搜索出来的，AI 主要是在你的结果里面选歌，那么你的搜索维度和结果就非常重要」—— 查当天缓存，50 首里古风 16 + 华语抒情 14 + 冷门网络流行 11 + kg 古风 5，**两条主线吃掉 30 首，其余是同一批种子歌手的边角料**。根因不在提示词而在**候选池只有两条路**：`buildCandidatePool` 的 6 条路全从「种子歌手 + 收藏/歌单 + 风格分类歌单」长出来，同一个画像永远长回同一片歌。改法：新增 `src/lib/recommend-dimensions.ts`（`planDimensionQueries` 按 画像标签 → 歌单名 → 次要语种 → 相邻风格 → 轮换兜底词 → 搜索历史 生成 ≤10 条查询；`collectDimensionLanes` 走**榜单 / 关键词跨源搜索 / 风格歌单**三路，每条结果挂「风格线」provenance）；`buildCandidatePoolWithLanes` 把维度层与原 6 路并行合并（`local` 源跳过、异常吞掉退化为空）；`diversifyByLanes` 在规则排序后按「七成保贴合、三成给风格线」补齐（≤5 条线，每条线按配额补位）；`interleaveByLanes` 按线交织排展示顺序；提示词 v9 给候选行加 `风格线：X`、给画像加「语种分布」、要求「覆盖 3–5 条线、主风格约一半、相邻线各 4–10 首」；`filterAiPicks` / `limitAiPicks` 放宽：画像里占比 ≥5% 的次要语种与有风格线依据的歌不再被硬剔；结果新增 `styleLanes`（按条数降序、最多 5 条），每日推荐页在「口味画像」下显示「本期风格」chips；`DAILY_RULE_VERSION` 8→9。真实模型两轮里有一轮给出 4 条线（古风 18 / 华语流行 8 / 粤语 6 / 纯音乐 2，0 首非华语） | §0.3-P、§5.2、§20.2 |
| R30 | **多源聚合接口一律下沉音源包，删除宿主侧 fan-out 与本地合并**：按用户 2026-10-24「后面所有使用多个音源的聚合接口必须放到音源包里面」逐处审计，`getAllLatestSongs` 是最后一处宿主逐源扇出（根因：包 `allLatest` 返回的 `MusicInfo` 不带 `platform`，混批后取链无法归属）；数据包 `META_REVISION` 7→8 给 `allLatest` 每条曲目盖 `platform`（交错合并抽成包内纯函数 `interleaveLatestBatches`），宿主改为一次 `sourceCall("allLatest")` 的薄包装；同时删掉「旧包降级」路径 —— `searchMany` / `searchMerged` 不再退回 app 侧 `fanOutSearch` / `localMerge`，缺入口一律抛「数据包版本过旧，请更新」；`lib/aggregate-merge.ts` 整体删除（`songKey` 迁到 `lib/song-key.ts` 供搜索页跨页去重，`mergeAggregateTracks` / `isJunkTrack` 随包侧 `merge-search.ts` 唯一实现消失） | §0.3-Q、§1.2、§20.2 |
| R31 | **详情页 hero 统一：左封面（176px）右内容，内容不得高于封面**：按用户 2026-10-24「把每日推荐和歌单详情模板类似的，左边图片，右边内容，高度不要超过图片，内容全部往右边搭」把两页 hero 改成与歌手页同一套结构并收紧内容 —— 封面 144→176px 定高；每日推荐把「共 N 首」并入元信息行、摘要限两行、口味画像与「本期风格」chips 并排一行、口味按钮与操作按钮并排一行；歌单详情简介限两行。结果：两页 hero 高度恒等于封面高度（176px），右侧内容约 170px / 164px，不再出现「图片下方的空白」 | §0.3-R |
| R32 | **AI 模式全局化：三种模式同时作用于「每日推荐」与「音乐助手」**：按用户 2026-10-24「这个需要完全支持音乐助手，每日推荐。选择哪个全局都得使用这个模式」把设置里只管每日推荐的「推荐方式」提升为全局 AI 模式 —— 设置项抽到 `src/lib/ai-mode.ts`（`AiEngineMode` / `AI_MODE_LABEL` / `AI_MODE_HINT` / `AI_MODE_OPTIONS` / `parseAiMode` / `readAiMode` / `saveAiMode`，键沿用 `dailyRecommend.mode`），`daily-recommend.ts` 只做别名 re-export 且 `effectiveMode()` 改为恒等；每日推荐的服务端模式不再降级，而是借 astral 音乐助手跑一次性会话（新增 `src/lib/ai-server-picks.ts`：校验登录 → 取 `MUSIC` 智能体 → 建会话 → 把 `buildPrompt()` 拼成一条消息（system 加 `【系统设定】` 前缀、上下文带前 150 首候选）→ 600ms 轮询到终态（总超时 90s）→ `parsePicks` 解析，失败时用 `song_list` 块按 `trackKey` 对回序号 → 删会话；运行时失败才退回规则并在 notice 写原因）；音乐助手补本地两种模式（新增 `src/lib/ai-assistant-local.ts`：rule = 风格词表 + 歌名/歌手点名 + 画像相似度，同歌手 ≤2 首取前 8；local = 本地模型 JSON 契约，失败整体回退 rule，永不抛错），`useAiChat` 按模式分流（非 server 不建 astral 会话、`init` 不拉智能体、`send` 前重读模式），助手页非 server 隐藏会话侧栏并显示模式横幅，设置页「推荐方式」改「AI 模式」并逐项说明。验收：全量 **96 files / 937 tests** 全绿、`tsc --noEmit` 0 错、eslint 干净 | §0.3-S |
| R33 | **音乐助手本地模式补齐：左侧历史对话 + 20 首上限**：按用户 2026-10-24「规则模式怎么左边不显示历史对话，然后每次只有8首，我要20首也是8首」修三处硬缺口 —— ①规则/本地模式在 `useAiChat.init()` 里直接 return，从不填会话列表，页面又按 `serverMode` 把侧栏整块隐藏；②`src/lib/ai-assistant-local.ts` 的 `MAX_SONGS = 8` 写死，且完全不解析用户话里的数量；③`MAX_PER_SINGER = 2` 让「点周杰伦」最多只出 2 首。修法：新增 `src/lib/ai-assistant-history.ts`（localStorage 持久化本地会话：最多 30 个会话 × 40 条消息、标题取首句、`AiConversation`/`AiChatMessage` 同构还原、时间并列按 id 倒序稳定排序），`useAiChat` 的 `init` / `selectConversation` / `removeConversation` / `sendLocal` 接本地历史，侧栏对三种模式都渲染（标题「历史对话」）；引擎默认给满 20 首（`DEFAULT_SONG_COUNT`）、解析「20 首 / 二十首」并封顶 20，`count` 贯通 `pickRuleSongs` / `buildLocalMessages` / `mapPicks` / `parseLocalReply` / `runLocalTurn`，用户点名的歌手不再受同歌手配额限制。验收：全量 **97 files / 957 tests** 全绿、`tsc --noEmit` 0 错、eslint 干净；新增 `tests/ai-assistant-history.test.ts` 11 条，hook 测试 5→8 条、引擎测试 17→23 条 | §0.3-T |
| R34 | **AI 接口配置改成「供应商列表 → 详情」主从 UI（多协议 / 多 Key / 模型多选 / 图标 / 跳过证书校验）** — 用户 2026-10-24 反馈「把本地模型精选下面 AI 配置的内容换成类似于截图这样的 UI，外面只展示一个列表，点进去进行配置 api 和密钥、模型等等」。设置页原来的「接口配置」是一排表单：多套接口靠下拉切当前生效，Key 只有一个明文输入框，模型只存一个字符串 —— 想换协议、存第二把 Key、试多个模型都得改代码。改成主从两态：列表每行 = 图标 / 名称 / 地址 / 协议 / N 个模型 / 掩码 Key / 生效开关 / 箭头；详情 = 名称、ID、Base URL、协议四选一（OpenAI 兼容 / OpenAI Responses / Anthropic 兼容 / Gemini 兼容）+ 检测协议、Key 多把（第一把生效，可删 / 置顶 / 追加）、内置图标 + 上传、跳过证书校验、模型 chips 多选（第一项生效），底部移除 / 复制 / 取消 / 保存。Rust 侧 `ai_local.rs` 扩了 `protocol` / `keys` / `models` / `icon` / `skipCertVerify` 字段，按协议分派请求体与鉴权（OpenAI `/chat/completions`、Responses `/responses`、Anthropic `/v1/messages` + `x-api-key` / `anthropic-version`、Gemini `generateContent` + `x-goog-api-key`，`systemInstruction` 与 `max_tokens` 各有坑，已按真机返回落住）；前端 `AiProvidersPanel.tsx` 保存时用增量字段（`addKeys` / `removeKeyIndexes` / `activeKeyIndex`），永远拿不到 Key 明文。验证：`ai_local.rs` 5 条单测（`cargo check --all-targets` 0 warning）、`tests/settings-ai-providers.test.tsx` 10 条，全量 98 files / 968 tests、`tsc` 0 错、eslint 干净。**同日追加**：设置页不再内联展开整块，只保留一行「接口配置」入口与「管理供应商…」按钮，列表/详情放进弹窗 `AiProvidersDialog`（`role="dialog"`，遮罩点击 / Esc / 右上角关闭）；`tests/settings-ai-providers.test.tsx` 增至 11 条。 同日修复：开关几何改回与设置页 `Switch` 一致的 `left-[0.125rem]` / `left-[1.125rem]` 两端定位（原先 `absolute` + `translate-x-*` 没有 `left`，勾选态小球会跑到轨道右外侧），列表行「正在使用」与详情「跳过证书校验」共用一个 `SwitchButton`，一处修改全部生效。| §0.3-U |
| R35 | **所有歌曲列表页加「排序」（对标 qt-uniappx 的 7 个合并选项）** — 用户 2026-10-24「所有歌曲列表的页面，需要和qt-uniappx一样，增加一个排序的功能，如歌单详情啊等等」。原状：只有本地曲库 `LibraryPage` 有排序（`SORT_OPTIONS` + 方向按钮），歌单/专辑/歌手/每日推荐/最近播放/我的混合这些 TrackList 页完全没有排序，想按歌名或歌手看一张上千首的歌单只能自己翻。修法：新增 `src/lib/track-sort.ts`（`TRACK_SORT_OPTIONS` = 默认顺序 / 按歌曲名·正序·倒序 / 按专辑名·正序·倒序 / 按歌手名·正序·倒序，`parseTrackSort` 把选项拆成 `key + desc`，`sortTracks` 用 `normText` 归一后 `localeCompare("zh-Hans-CN")` 比较、并列依次比较歌名/专辑/歌手、仍并列保留原始下标保证稳定）与共享控件 `src/components/TrackSortSelect.tsx`（`<select aria-label="排序方式">`）；每个页面把「播放全部 / `BatchBar` 的 `tracks` / `TrackList` 的 `tracks`」三处统一换成排序后的数组，保证播放顺序、批量管理范围、列表显示顺序三者一致。已接：歌单/榜单/专辑详情、专辑页、歌手页、每日推荐、最近播放、我的混合。明确不接：搜索页（分页结果）、每日新歌（分页流）、音频节目（无限下拉）、下载任务（`TaskRow` 非 `TrackList`）、播放队列（本身即顺序语义）；本地曲库保持原有 UI。验证：`tests/track-sort.test.ts` 6 条、全量 99 files / 974 tests 全绿、`tsc --noEmit` 0 错、eslint 干净。**同日改版**（用户 2026-10-24 晚，见 R36 / §0.3-W）：控件改为上下两个弹窗（字段 + 方向，默认都不勾选），`DailyPage` 每日新歌也接入排序。 | §0.3-V |
| R36 | **排序格式改成两个弹窗 + 每日新歌接入排序**（v1.23 · 2026-10-24）：用户「每日新歌也要支持排序。排序格式换一下，换成两个弹窗，上面显示按歌曲名、按专辑名、按歌手名，下面显示正序、倒序。默认顺序都不勾选」。`src/components/TrackSortSelect.tsx` 从单个 7 项 `<select>` 改为上下两个 `Popover` 弹层（字段：按歌曲名 / 按专辑名 / 按歌手名；方向：正序 / 倒序），`value === "none"` 时两个按钮都是占位「排序」/「方向」、方向按钮 `disabled`，即默认都不勾选；再点一次已选字段 = 取消回 `none`。`src/lib/track-sort.ts` 增 `TRACK_SORT_FIELDS` / `TRACK_SORT_DIRECTIONS` / `trackSortValue(key, desc)`，原 `TRACK_SORT_OPTIONS` / `DEFAULT_TRACK_SORT` / `parseTrackSort` / `sortTracks` 编码不变（6 个既有页面签名不动）。`DailyPage` 加 `sortValue` + `sortedSongs`，hero 右列竖排「排序 + BatchBar」，「播放全部 / `BatchBar` / `TrackList`」三处统一用排序后数组。验证：`tests/track-sort.test.ts` 10 条、新增 `tests/track-sort-select.test.tsx` 6 条 / `tests/daily-page-sort.test.tsx` 3 条；全量 **101 files / 990 tests** 全绿；`tsc --noEmit` 0 错；eslint 干净 | §0.3-W |
| R37 | **音乐助手全量开放 + 「服务端 AI」仅管理员**（v1.23 · 2026-10-24）：用户「音乐助手不再需要管理员权限了，但是服务端 AI 需要管理员权限才展示和允许使用（看后端是否满足控制条件，可以由后端建议，前端隐藏）」。① `Sidebar` 删除 `canUseMusicAssistant` 门禁，「助手 → 音乐助手」对全部用户（含未登录）渲染，`stores/auth.ts` 移除 `MUSIC_ASSISTANT_PERM` / `canUseMusicAssistant`（`isAdmin` / `hasPermission` 保留）；② `src/lib/ai-mode.ts` 增 `resolveAiMode(mode, canUseServer)`（server + 非管理员 → rule）与 `aiModeOptionsFor(canUseServer)`，设置页 `AiSection` 用 `isAdmin(profile)` 过滤选项，并修掉从不回读 `readAiMode()` / `readTaste()` 的旧 bug（载入前显示「载入中…」，带 unmount 守卫），库里有 server 但非管理员时显示 rule + 提示「服务端 AI 仅管理员可用，当前按纯规则运行。」；③ `useAiChat` 的 `init()` / `send()` 按 `resolveAiMode` 收敛，非管理员不拉 `astralAiAgents`、不建服务端会话、走本地回合；④ 执行层 `askServerForPicks()` 入口先判 `isAdmin(...)`，非管理员直接 throw，`daily-recommend.ts` 的 `readMode()` 返回有效模式、`generateDailyRecommend` 对显式 `options.mode` 再收敛且 `requested` 记 rule（否则非管理员每天命中不了当日缓存），规则分支 notice 说明。后端 astral 没有「服务端 AI」专用权限码（App 用户默认持有全部 `user:%`），故不改后端，仍按智能体权限码 + 客户端默认权限校验。验证：`tests/sidebar-assistant-entry.test.tsx` 重写为三种身份都展示、`tests/auth.store.test.ts` 删旧 `canUseMusicAssistant` 用例、`tests/ai-mode.test.ts` / `tests/use-ai-chat-modes.test.tsx` / `tests/daily-recommend-generate.test.ts` / `tests/ai-server-picks.test.ts` 补管理员与非管理员用例；全量 **101 files / 990 tests** 全绿、`tsc --noEmit` 0 错、eslint 干净 | §0.3-W |
| R38 | **音源账号全面改造：后台保活 + 内嵌网页登录 + bili 官方刷新**（v1.23 · 2026-10-26）：用户「全都做一下吧」（按分析报告 P0-P3 全量落地）。① **后台保活（P0）**：新建 `src/hooks/useSourceAuthKeepalive.ts`（AppShell 挂载，启动 20s 首检 + 每 6h 定时，失败静默），`src/lib/source-auth.ts` 增 `refreshAllSourceAccounts(reason?)`（模块级 Promise 锁防重入、失效只标记绝不删账号、单源异常不拖累其余）与 `mergeCredentialExtras(prev, refreshToken?)`（旧键保留/新键覆盖/空值剔除/全空→undefined）；账号记录扩 `extras?`，`saveSourceAuthAccount` 加第 4 参，`authCheckUser(source, cookie, extras)` 把凭据副键透传包侧、应答 `credential.refresh_token` 提为 `refreshToken`——修复 QQ musickey 短寿命「只有打开账号页才轮换」的根因（原 `authCheckUser` 唯一调用点在 SourceAccountsPage mount）。② **内嵌网页登录（P1）**：包契约 v17 增 `PlatformAuth.webLogin { url, cookieMarkers, captureUrls?, note? }`（wyy=music.163.com/#/login+MUSIC_U、qq=y.qq.com/portal/login.html+qm_keyst+captureUrls[y.qq.com,graph.qq.com,ssl.ptlogin2.qq.com]、kw=passport.kuwo.cn/login/index.jsp+kw_token、bili=passport.bilibili.com/login+SESSDATA；kg 不做——URL 离线无法核实），宿主 `src-tauri/src/web_login.rs` 三个 async command（480×640 官方登录窗「登录音源账号」、`source_web_login_capture` 逐 URL `WebviewWindow::cookies_for_url` 读取**含 httpOnly**、close；Windows 同步 command 会死锁必须 async），`src/lib/source-web-login.ts` `runWebLoginFlow`（开窗→1.5s 轮询 capture→按 name 去重合并→marker 命中（空=任意 cookie）→`authImportCookie` 官方校验→入库关窗，3min 超时，三态 ok/timeout/cancelled），账号页每卡「网页登录」按钮（登录中互斥禁用，三态 toast）。③ **bili 官方 cookie 刷新（P2）**：扫码确认包侧随 credential 下发 `refresh_token`（宿主 `authQrPoll` 提为 `refreshToken`，扫码保存点并入 extras 落库），凭据失效营救链 `biliRefreshCredential`（RSA PKCS1 v1.5 加密毫秒时间戳→GET correspond/1 取 refresh_csrf→POST /x/passport-login/web/cookie/refresh→Set-Cookie 拼新 cookie→nav 校验通过才返回；离线冻结实现，真机联调第一嫌疑=公钥 base64 疑丢 2 字符）。④ **关键语义**：`authUser` 是「旧凭据失效才营救刷新」——refresh_token 必须随账号持久化并在每次校验时经 extras 回传，否则失效后无法刷新。⑤ qt-sources 包侧同发 **v2026102602**（webLogin 四平台 + bili 刷新链 + qrPoll refresh_token；旧宿主忽略 webLogin 字段不受影响；META_REVISION 保持 13）。验证：qt-pc 新增 `tests/source-auth-keepalive.test.ts` 7 条 / `tests/source-web-login.test.ts` 7 条、全量 **104 files / 1022 tests** 全绿、`tsc --noEmit` 0 错、eslint 干净、`cargo check` 通过；qt-sources auth.test.ts 58/58 + 新 9 用例、tsc 0 错、`pnpm build`（meta-bundle 354KB v2026102602）+ smoke 全过 | §0.3-W |
| R39 | **账户歌单同步：登录后自动对比平台侧歌单，差集勾选收藏**（v1.23 · 2026-10-26）：用户「登录源帐户时自动获取当前帐户的收藏歌单，然后和本地的在线收藏歌单进行对比，将结果展示出来供用户选择是否收藏未收藏的歌单……在音源帐户那里增加一个选项，供选择是否需要继续同步」。① **包侧契约 v18**（qt-sources v2026102603，META_REVISION 14）：`AccountPlaylist { id, name, picUrl?, trackCount?, owned }`（owned=平台自建）+ meta 面新入口 `accountPlaylists(source)` → `{ list: [...] }`，五平台实现（wyy=/api/user/playlist 翻页、bili=登录态 created/list-all+collected/list 双接口、qq=musicu.fcg playlist 族、kg=mobiles v3 getuserlinkspecial、kw=kwapp/ www 双分支——后四者离线冻结待真机验证，失败路径全有人话报错不静默；凭据由实现内部自读 meta 面）。② **宿主**：`source-scripts` 新包装 `accountPlaylists(source)`（`SourceAccountPlaylist`，解析 `{ list }`，缺包提示 v2026.10.26.3）；新建 `src/lib/source-playlist-sync.ts`：`accountSyncPreview(source)` 与本地 `ipc.listMyPlaylists()` 同平台 pid 集合 diff（保平台顺序）→ `{missing, total}`、`collectAccountPlaylists(source, picks)` 顺序逐个 `favoritePlaylist`（幂等，已收藏 skipped、单失败不中断，返回 `{collected, skipped, failed}`）、`autoSyncMissingAfterLogin(source)`（syncPlaylists 开关把关）。③ **UI**：账号页每源卡片登录态下新增第三开关「登录后同步歌单」（`SourceAuthToggles.syncPlaylists?`，缺省 true，旧记录向后兼容）与「同步歌单」按钮；新弹窗 `SourcePlaylistSyncDialog`（预览 diff 列表 + 全选/单选 + 「收藏所选（N）」+ 空态/错误原样展示，样式对齐 ImportPlaylistDialog）。④ **自动触发**：四个登录成功点（扫码 confirmed / 导入 Cookie / 网页登录 / 密码短信）保存成功后经 `maybeAutoSync` 拉预览，missing>0 自动打开同步弹窗（mountedRef 竞态守卫，异常静默；不动 extras 落库与保活 mount effect）。验证：qt-pc 新增 `tests/source-playlist-sync.test.tsx` 20 条、全量 **104 files / 1042 tests** 全绿、tsc/eslint 干净；qt-sources auth.test.ts 64/64（新 6 条）、tsc 0 错、build（meta-bundle 368KB v2026102603）+ smoke 全过 | §0.3-W |
| R40 | **音源账号卡片改版：删「登录后同步歌单」开关（默认开启）+ 卡片可折叠 + 数据请求备注**（v1.23 · 2026-10-27）：用户「将截图红色的那个删掉，不需要展示这个，默认开启，上面的同步歌单已经足够了；绿色框改为一个可折叠的，折叠就是将这个容器下面几行收起来；数据请求使用登录态后面加个备注，只有启用时才能同步歌单」。① **删开关**：`SourceAuthToggles` 去掉 `syncPlaylists?` 字段、`parseSourceAuthToggles` 不再收该键（旧记录里的键读入即丢弃，向后兼容无需迁移），`source-auth.ts` 删 `readSourceAuthSyncPlaylistsFor` / `saveSourceAuthSyncPlaylists`；`autoSyncMissingAfterLogin(source)` 返回值从 `SourceAccountPlaylist[] | null` 收紧为 `SourceAccountPlaylist[]` 并去掉唯一开关门控——登录成功即对比，四个登录成功点（扫码 confirmed / 导入 Cookie / 网页登录 / 密码短信）行为不变；账号页删 `toggleSyncPlaylists` 与登录态下第三行开关，右上「同步歌单」按钮保留为唯一手动入口。② **卡片折叠**：新增 `collapsed: Record<string, boolean>`（缺省键 = 展开，仅内存不持久化，重进页面回到展开态）；卡片标题行左侧（源名 + 已登录/未登录/凭据已过期）由 `div` 改成 `<button aria-expanded title>`，前置 `ChevronDown`（折叠时 `-rotate-90` + `transition-transform`），下面 `.mt-2 border-t` 容器整块 `{isCollapsed ? null : …}` 条件渲染——「数据请求/播放请求开关 + 播放/下载音质」四行一起收起，标题行右侧的账号/登录工具条不受影响。③ **备注**：「数据请求使用登录态」描述追加「只有启用时才能同步歌单。」（写清同步依赖该面开关，不新增禁用逻辑）。验证：`tests/source-playlist-sync.test.tsx` 22 条（删 5 条旧开关用例，新增「库里残留开关也照样拉差集」「旧记录 syncPlaylists 键被丢弃」「平台侧无缺失不弹窗」「默认展开」「点标题行折叠/展开」「不再渲染开关行」「备注文案」）；全量 **105 files / 1047 tests** 全绿、`tsc --noEmit` 0 错、eslint 干净 | §0.3-W |
| R41 | **音源账号卡片折叠改默认收起 + 右上角一键全部折叠/展开 + 两面开关缺省调整**（v1.23 · 2026-10-27）：用户「修改为默认折叠的，页面右上角加一个全部折叠/打开的按钮。页面里面的数据请求使用登录态默认为开，播放请求使用登录态为关」。① **默认折叠**：折叠态从「单卡 override 表缺省展开」改成「页面级 `allCollapsed`（初值 true）+ 单卡覆盖表」，`isCollapsed = collapsed[id] ?? allCollapsed` —— 进页面所有卡片只露标题行（源名 + 已登录/未登录/凭据已过期 + 右侧账号工具条），四行设置默认收起。② **一键全开/全收**：页头 h1 与说明右侧新增按钮，文案与图标随状态切换（有任意卡片展开 → `ChevronsDownUp` +「全部折叠」；全收起 → `ChevronsUpDown` +「全部展开」），点击 `setAllCollapsed(anyCardExpanded)` 并清空单卡覆盖表；`cards.length === 0` 时不渲染（与「正在读取音源清单…」空态一致）。③ **两面缺省**：`effectiveTogglesFor` 登录态缺省从 `{ useMeta: true, usePlay: true }` 改为 `{ useMeta: true, usePlay: false }`（新登录源 `saveSourceAuthAccount` 随之物化为数据面开/播放面关，只注入 meta 面、显式 clear play 面），页面 `toggles[id] ?? { useMeta: true, usePlay: false }` 兜底同步调整；`sourcePlayLoginActiveSync` 的冷缓存兜底从「按开处理」改为「按关处理」（宁可先不展示官方档，也不展示取链会失败的档位）。未登录源也用同一缺省展示（开关行本就禁用，登录后这对值立刻生效）。验证：`tests/source-auth-toggles.test.ts` 5 条断言随缺省改成数据开/播放关（首登物化、解析链、`setSourceAuthToggle` 先开后关、`ensureSourceAuthInjected` 逐面对账）；`tests/source-playlist-sync.test.tsx` 折叠组重写为 6 条（默认全收起 + 「全部展开」、一键开/收、单卡开收、未登录两面禁用、登录后数据开播放关、开关行已移除、备注文案）；全量 **105 files / 1050 tests** 全绿、`tsc --noEmit` 0 错、eslint 干净。④ **旧全局键不再盖住新缺省**（同日追加，用户「但是我看现在没有登录的怎么还是双开」）：解析链第二级的旧全局键 `sourceAuth.useMeta` / `sourceAuth.usePlay` 是 per-source 表上线前所有源共用的一对，旧版缺省本身就是双开——库里残留的 `true/true` 与「从没动过」不可区分、不携带用户意图，整体继承会让它永久盖住新缺省，导致新装/未物化的源（如 migu）全都显示双开。`legacyGlobalToggles()` 改为只在「任一面为 false」时才返回继承值（那才证明用户主动关过），双开/两键都没有一律返回 null 回落新缺省；`sourcePlayLoginActiveSync` 的冷缓存兜底同步收敛。 | §0.3-W |
| R42 | **无缝播放预热提前到「当前曲目加载完成」**（v1.24 · 2026-10-27）：用户「能不能优化一下，改为当前音乐加载完成后就开始预热」。① 触发点从「播放圈下一次轮询」移到 `mount_decoder` 末尾当场触发（非播放态那一圈要等满 1s，等于白等一秒）+ `handle_cmd` 末尾补一次（恢复播放 / 重开无缝 / 弱网重载成功都即时生效）；② 作废名单收窄：`Seek` / `SetSpeed` 不再作废预载（改不了下一首是谁，随机模式下还表现为「拖进度条下一首就换人」）；③ 预载失败不再死等到曲末：`PreloadFailed` 立刻作废槽位换目标重试，同曲最多 2 次（`PRELOAD_RETRY_LIMIT`），用尽后到点现场取链；④ 闸门抽成纯函数 `preload_block` + `PreloadFacts`，8 条否决理由各自可断言。随机模式仍是「预热时掷一次骰并把下标存进 `PreloadSlot`，换曲时提交」，不重掷。验收：`preload_gate_tests` 4 条、`cargo test --lib audio::` 82 条全绿、`cargo check` / `clippy` 干净（3 条 warning 均在 ai_local.rs 既有代码） | §7.5 |
| R43 | **账户歌单同步改为「全量清单 + 已收藏标记 + 可取消收藏」**（v1.24 · 2026-10-27）：用户「同步歌单改为返回全部的歌单，如果本地已经收藏了则显示已收藏，同时允许这些取消收藏」。① **lib**：`AccountSyncPreview` 从 `{missing, total}` 扩成 `{rows, missing, total}`，`rows: AccountSyncRow[] = {playlist, favorited}[]` —— 平台侧**全部**歌单逐行带本地收藏态（同平台 pid 集合比对，本地自建/跨平台同 pid 一律算未收藏），`missing` 保留给登录后自动触发判断；新增 `uncollectAccountPlaylists(source, picks)` → `{removed, skipped, failed}`，逐个 `ipc.unfavoritePlaylist`（预检失败按已收藏继续——unfavorite 幂等；单失败不中断），**只动本地收藏关系，不碰平台侧**。② **弹窗**：`SourcePlaylistSyncDialog` 从「只列缺失项」改成「列全部歌单」，行尾给已收藏项加「已收藏」徽标，勾选语义统一为「希望它在本地我的歌单里」——默认全勾，取消勾选已收藏项即表示要取消收藏；底部按钮由「收藏所选（N）」改为「应用更改（N）」（N = 待收藏 + 待取消收藏的条数），点一次先收藏再取消收藏，toast 汇总「已收藏 X 个，已取消收藏 Y 个歌单」，任一侧 failed>0 走 `toastError` 提示可重开重试；全选框文案改「全选（平台侧 N 个，已收藏 M 个）」。③ **页面**：`SourceAccountsPage` 的 `maybeAutoSync` 与 `onDone` 无需改动（仍按 missing>0 决定是否自动弹窗、完成后刷新账号缓存）。验证：`tests/source-playlist-sync.test.tsx` 34 条（新增 uncollect 4 条、preview rows 断言、弹窗「全部列出+已收藏标记」「取消收藏」「同时收藏与取消收藏」等），全量 **106 files / 1065 tests** 全绿、`tsc --noEmit` 0 错 | §0.3-W |
| R44 | **「已登录但同步歌单报未登录」修复：数据面登录态前置检查 + 一键开启重试**（v1.24 · 2026-10-27）：用户「bili 已经登录了，点击同步歌单报错说未登录」。根因：宿主只在该源「数据请求使用登录态」开启时才把凭据灌进数据包 meta 面，关着时包侧 `accountPlaylists` 必然回「未登录」——账号页明明显示「已登录」，文案因此极易被误读成登录失效（R40 的备注「只有启用时才能同步歌单」只说了现象，没给可操作入口）。① **lib**：`src/lib/source-playlist-sync.ts` 新增 `AccountSyncNeedsMetaLoginError`（固定 `name` + `source` 字段）、`isAccountSyncNeedsMetaLoginError`、`assertAccountSyncMetaLogin(source)`；`accountSyncPreview` 进包之前先 `readSourceAuthAccounts()` + `readSourceAuthTogglesFor()`，**有账号且 `useMeta=false` → 抛可识别错误**，不再把误导性的包侧文案摊给用户；无账号时不拦（那是真的没登录）。`autoSyncMissingAfterLogin` 对该错误静默返回 `[]`（用户显式关掉的开关，不该因登录成功弹窗打扰，等他自己点「同步歌单」再提示）。② **弹窗**：`SourcePlaylistSyncDialog` 预览改走 `useRef` 序号守卫的 `load()`（一键重试/换源丢弃过期应答），捕获该错误 → 渲染琥珀色可操作面板（解释开关作用 + 「开启并使用登录态同步」），点击 `setSourceAuthToggle(source,"meta",true)` 成功后调 `onMetaLoginEnabled` 并自动重试预览；该态底部只留「关闭」（无任何更改可应用）。③ **页面**：`SourceAccountsPage` 的「同步歌单」按钮加 `title`（数据面关时提示点开可一键开启）；`onMetaLoginEnabled` 重读开关态刷新 `toggles`，弹窗开启后卡片开关立刻一致；数据请求备注改为「同步歌单也依赖此项，关闭时同步会报「未登录」。」④ **明确不做**：不临时强制注入凭据绕过用户显式关闭——尊重显式选择，改走可见提示 + 一键开启。验证：`tests/source-playlist-sync.test.tsx` 42 条（lib 前置检查 3 条、autoSync 静默 1 条、弹窗可操作面板 2 条、页面提示 + 开关态同步 1 条、包内「未登录」附失效提示 1 条），全量 **106 files / 1073 tests** 全绿、`tsc --noEmit` 0 错、eslint 干净。未改 Rust / qt-sources / 移动端。 | §0.3-W |

### 0.3 实现现状修订（v1.4 · 2026-09-27）

本节记录 v1.3 之后代码实际发生的架构变化，供阅读下文时对照。**与下文冲突处，以本节为准。**

**A. 音源架构：原生 Provider 已删除，改为前端音源脚本引擎**

- `MusicProvider` trait / `ProviderRegistry` / `async_trait` **在代码中已完全不存在** —— 上文
  §6.4 与 §0.2 的 **R8 已作废**（该 trait 从未落地为最终形态）。
- 现状：应用**不内置**第三方音源实现。wyy / qq / kw / kg 的接口与取链全部由「音源包」
  （`source-bundle.js`）在隐藏的**引擎窗口**里执行，前端经 `src/source-engine/client.ts` 与之通信；
  Rust 侧只保留 `src-tauri/src/provider/` 下的类型（`types.rs`）与进程内取址缓存（`url_cache.rs`）。
- 取链回填：前端预解析地址后经 `set_resolved_play_url` 回填 Rust 引擎缓存，引擎播放时命中缓存直接使用
  （对应 R1「播放地址不落库」）。

**B. 安全加固（详见 [`docs/代码审查与优化报告-20260927.md`](docs/代码审查与优化报告-20260927.md)）**

- `src-tauri/src/ipc_guard.rs`：危险命令校验**调用窗口**（更新安装器、删除本地文件/下载等只允许主窗口调用），
  引擎窗口无法越权；
- `src-tauri/src/net_guard.rs`：出网请求校验 scheme / 私网与回环地址 / host 白名单；
- 生产后端地址由明文 HTTP 改为 **HTTPS**（更新链路依赖它做完整性校验）。

**C. 数据层**

- `src-tauri/src/db/store.rs`（单文件 2615 行）**按域拆分为 `db/store/`**：
  `tracks` / `local` / `likes` / `playlists` / `history` / `stats` / `downloads` / `session` / `settings`（+ `tests`）。
  拆分是机械搬运，对外调用路径 `crate::db::store::xxx` 保持不变。
- `Database::conn()` 改为**容忍 Mutex 毒化**（`unwrap_or_else(|e| e.into_inner())`），
  配合 `panic` 恢复为默认 `unwind`：一次偶发 panic 不再让整个数据层在本次运行里永久不可用。

**D. 前端**

- 路由改为 **`React.lazy` 代码分割**（`src/lib/lazyPage.tsx`），首屏不再解析全部路由组件；
- 新增 `ErrorBoundary`（根级 + 常驻页级）；
- `src/main.tsx` 的全局错误兜底改为**叠加可关闭浮层**，不再清空 `#root`；
- KeepAlive 常驻页引入 `active` 标记（`components/layout/keepAliveActive.ts`），激活时才重新校验数据。

**E. 每日推荐与客户端直连模型（v1.5 · 2026-10-22）**

- 「每日推荐」不再是音源给的列表，改为**按本机播放历史 + 收藏本地算**：`src/lib/daily-recommend.ts`（纯逻辑，1658 行）+ `components/discovery/DailyRecommendPage.tsx`（渲染，463 行），另有 `music-style` / `recommend-rank` / `recommend-types` 三个纯逻辑模块（v1.6 拆出），合计 5 个测试文件 171 条单测。入口 `/daily-recommend`，与 `/daily`「每日新歌」（音源最新流）并存 —— 见 §5.2「每日推荐」。
- 三种推荐方式：`rule`（纯本地）/ `local`（本地模型挑序号，默认）/ `server`（Astral）。三种口味：`heart` / `familiar` / `explore`。**AI 只挑不造**，回执失败自动退回规则推荐并 toast 说明。
- 新增 Rust 模块 `src-tauri/src/ai_local.rs`（885 行）：让用户把任意 OpenAI 兼容接口填进设置页「AI」分节，Key 只留 Rust 侧、前端只读 `hasKey`。含 3 次重试与退避、120s 超时、SSE 兼容、上游错误透传 —— 见 §11.7.1。
- 设置页新增 `network` / `ai` 两个分节；`ai` 只管「模型接口怎么连」，不绑定具体功能。

**F. 每日推荐改按「风格」综合推荐（v1.6 · 2026-10-23）**

- 旧实现虽然号称"跨源推荐"，**排序实际只认歌手**：`heart` 收藏歌手 +4、`familiar` 常听歌手 ×3、`explore` 常听歌手倒扣，再按歌手分组轮流取。用户的原话是「不应该根据你听过的歌手去推荐，应该根据你之前听过歌曲的风格等等各方面综合一起去推荐」——一屏 50 首里全是同几个人的歌，也确实不像"每日推荐"。
- 音源契约（`src/source-scripts/qt-contract/contract.ts` 的 `MusicInfo`）与本地 `Track`（`src/types/index.ts`）**都没有 genre / 年代 / 语种字段**，风格只能从本地可算的信号推导 —— 这是整个设计的硬约束，决定了为什么不直接读"风格标签"。
- 拆成三个纯逻辑模块（都能单测，互不依赖 UI 与 IPC）：
  - `src/lib/recommend-types.ts`：`DailyTaste` / `MusicLang` / `DurationBand` / `TrackStyle` / `TrackQuality` / `StyleProfile` / `ScoredCandidate` / `RankHit` / `RankOptions` 等契约类型，零运行时代码；
  - `src/lib/music-style.ts`：从播放历史 + 收藏 + 歌单名提取**风格画像**（`buildStyleProfile`），并提供 `detectLanguage` / `durationBand` / `trackStyle` / `trackQuality` / `describeProfile`；
  - `src/lib/recommend-rank.ts`：多维打分 `scoreCandidates` + 多样性选择 `selectDiverse`（MMR）+ 理由生成 `reasonFor`。
- 画像的输入是**真实收听行为**，不只看播放次数：`play_stats` 的 `total_played_ms` 能算出**完播比**（`totalPlayedMs / (playCount × 时长)`），于是「点开听 20 秒就切」和「一遍遍听完」不再同分；`skipped`（听了 3 次以上但完播比 < 0.4）会被扣分。
- 候选池新增两路，只依赖音源包已验证存在的能力：`searchAlbums` + `getAlbumDetail`（同专辑兄弟，专辑是最强的风格代理）、`getPlaylistCategories` + `getRecommendations` + `getPlaylistDetail`（平台自己的"摇滚 / 华语 / 民谣"歌单；`explore` 故意挑画像**不**匹配的分类来换口味）。
- 结果页在摘要下一行显示「口味画像：…」（`describeProfile` 生成，如「华语为主，偏 3–4 分钟，常听 周杰伦 / 陈奕迅」），让用户知道系统是从哪几个维度判断的 —— 推荐理由不透明时，用户只会觉得"又在瞎推"。

**G. 每日推荐补冷启动（v1.7 · 2026-10-23）**

- v1.6 把排序改成了「按风格」，但**风格画像需要样本**：`heart` 是默认口味，新用户（没有 `play_stats`、没有收藏）进来时旧逻辑直接 `return` 一个空结果，页面上一句「先随便听几首」——功能第一次打开就是死的，用户没有理由第二天再来看。
- 现在的做法是**先问一句**：冷启动时页面顶部列出音源平台下发的风格分类（`getPlaylistCategories`，如「华语」「摇滚」「民谣」），用户点 2–4 个 → 存进 `settings` 的 `dailyRecommend.styleSeeds` → 画像把这些名字当歌单名一样抽成 `tags`（复用 `buildStyleProfile` 的 `playlistNames` 入参，`music-style.ts` 一行没改）→ 同日重算，`coldStart` 变 `false`。
- **不选也给内容**：冷启动的候选池按「分类歌单 + 最新流」放宽，用户不点也能听到一批歌（等于自动降级成"平台热门兜底"）；`notice` 保持 `null` 不弹 toast —— 冷启动不是错误，别用报错语气说话。
- **冷启动不调本地模型**：`mode = local` 时也直接走规则分支。没有画像时让模型"挑几首符合你口味的"，等于让它编。
- 设置键存**风格名**而不是分类 id：分类 id 是平台内部标识，换音源就失效，名字是用户认得、也不会随音源漂移的东西。读坏了的旧值按 `,，、/` 分隔符兜底救回来，最多 4 个。

**H. 跨源聚合搜索下沉到数据包（v1.8 · 2026-10-23）**

- 起因：每日推荐的候选池 ② 要按「种子歌手」跨源搜歌，旧实现是 app 侧 `mapLimit(singers, SEARCH_CONCURRENCY)` 逐词调 `searchAll` —— N 个歌手就是 N 次跨窗口 invoke，而**并发上限、单源超时（4000ms）、逐词失败隔离**这三件事每加一端就要重写一遍（PC / 安卓 / 以后别的 APP）。用户原话：「把这些聚合搜索接口放到 qt-sources 里面，后续直接通过这个聚合进行搜索是不是更方便些，因为后续我还需要支持其他 APP」。
- 分层：**单关键词四源聚合本来就在数据包里**（`searchAll` → `src/actions/aggregate.ts` 的 `allSearchBatches`）。本次补的是它上面那层「多关键词编排」，落成新入口 `searchMany({keywords, page, size, concurrency?, budgetMs?})`：
  - `src/actions/batch-search.ts` 是纯编排层（零平台依赖、可离线单测）：关键词归一化（trim / 丢空 / 折叠空白 + 小写去重保原文 / 封顶 32）、worker 池并发（缺省 3，clamp 1..8）、总预算闸（缺省 15s，clamp 1..18s；超预算只停「还没启动」的词，在途的等它跑完）、单关键词失败隔离（`ok=false`，空结果仍算成功）、`merged` 按 `${source}:${id}` 展平去重；
  - `meta-entries.ts` 把 `searchMany` 注册成宿主入口，`META_REVISION` 5 → 6；
  - 宿主契约（`src/contract.ts`）**没动** —— 新入口是**增量**能力，旧宿主不认识它不影响任何既有入口。
- app 侧（`src/source-scripts/index.ts`）：`searchManyBatches(keywords, page, size, {concurrency, budgetMs})` → `{groups, truncated}`。~~**兼容旧数据包**：应答报「缺少该接口」时不报错，退回 app 侧 `fanOutSearch`（worker 池 + 逐词 try/catch，语义与包内对齐），再把 `searchManySupported` 记成 `false`，后续调用不再白跑一次失败 invoke。~~ **v1.17 起（见 §0.3-Q）不再有宿主降级**：缺入口直接抛「数据包版本过旧，请更新数据包」，`fanOutSearch` / `searchManySupported` 已删除；`merged` 字段无人消费，一并移除。引擎未就绪、接口内部失败照旧抛错 —— 静默降级会把「包坏了」伪装成「搜不到」。
- 每日推荐只吃这一层：候选池 ② 按 `SEARCH_CONCURRENCY` = 3 个歌手一块调用，块内由数据包并发、块间串行。分块而不是一次全塞：单块超时 / 失败只影响这一块，容错粒度与旧实现「每个歌手各自失败」一致。
- 推荐策略（画像、候选池五路、打分与多样性）**仍留在 app**：它依赖本机播放历史与收藏，是产品策略不是音源能力 —— 换端时策略可以不同，音源编排不该不同。

**I. 聚合搜索音源可选（v1.9 · 2026-10-23）**

- 需求原话：「可不可以**在 qt-pc 设置聚合搜索源，选择哪几个源就搜索这几个，没有选择的就不使用**」。要的是「勾掉的源别被我搜到」，而不是「搜完再筛」。
- 分层（两层都做，理由不同）：
  - **数据包侧**（`qt-sources`）：`searchAll` / `searchMany` 入参加可选 `sources?: unknown`，`src/actions/source-filter.ts` 的 `pickSources` 归一化 —— undefined / 非数组 / 空数组 → 全量（返回副本）；否则 trim 后按注册表顺序投影，去重 + 未知 id 静默丢弃。**过滤发生在 `Promise.allSettled` 之前**，没勾的源根本不会发起请求（少一份往返、少一条超时线）。新增字段是可选的，所以 `META_REVISION` 保持 6 —— 新旧宿主行为都不变。
  - **app 侧**（`src/source-scripts/index.ts`）：`searchAllBatches(keyword, page, size, sources?)`、`searchManyBatches(..., {sources})` 把白名单透传下去，**收到应答后再按白名单过滤一遍** —— 装在旧数据包上时包会忽略未知字段、把四个源全返回，这一层是旧包兼容的唯一保证（幂等，新包上不会二次生效）。
- 设置项：`search.aggregateSources`（`settings` 表，JSON 字符串数组，存**源 id**）。**空值 / 未配置 = 全部音源**：一个都没勾不该变成「什么都搜不到」；UI 侧同时禁止关掉最后一个。「全选」写空值而不是写全量 id 数组 —— 以后数据包新增音源会自动参与，不会被一份旧白名单永久排除。
- 读取带进程内缓存（`src/lib/aggregate-sources.ts` 的 `readAggregateSources`）：聚合搜索是点一次跑一次，不值得每次走 IPC；设置页保存后同步刷新缓存，因此立即生效。解析失败一律按「全部」兜底 —— 一条坏设置不能让搜索变空。
- 覆盖面：`SearchPage` 的「全部音源」分组、`useAiChat` 的 AI 找歌候选池、`source-switch` 的手动换源、`daily-recommend` 候选池 ② 的跨源补充。**单源搜索不受影响**（某源的页签、榜单、歌单、歌手页用的是用户明确选中的那个源）。
- 设置 UI：`SettingsPage` 的 `AggregateSourcesRow`（音源包分节，动态按 `useSourceRegistryStore` 的 `sources` 渲染，不硬编码源列表）；乐观更新 + 串行写队列 —— 连点两个开关不丢第二个点击，落库顺序也不会乱。

**J. 聚合搜索的「合并去重」下沉到数据包（v1.10 · 2026-10-23）**

- 需求演进：先按用户「聚合搜索不应该这样展示，而是应该后台调用聚合搜索音源，然后过滤掉一些重复的内容，最终展示一些比较合适的」+「展示其实不需要在上方写个网易云音乐、qq音乐之类的」，把搜索页聚合模式的**按源分组**改成一条去重列表（客户端侧已实现 `src/lib/aggregate-merge.ts`）；随后用户问「这种聚合能不能由 qt-sources 去做，而不是客户端做」，于是把合并逻辑整体下沉成数据包入口 `searchMerged`（`META_REVISION` 6 → 7），客户端那份实现曾保留为旧数据包的降级路径 —— **v1.17 已删除**（见 §0.3-Q），现在只剩包侧一份。
- 为什么属音源层：「多源结果怎么合、重复怎么判、哪条更合适」依赖各平台的标题写法、版本后缀（`Live` / `伴奏` / `片段`）、元数据完整度 —— 这些知识在包侧最全；放 app 里意味着每个端（PC / 安卓 / 以后别的 APP）各写一份，必然漂移。与 R21 的 `searchMany` 是同一个判断。
- 包侧新增（`qt-sources`）：`src/actions/merge-search.ts`（`mergeSearchResults` 等纯函数，与 qt-pc `lib/song-key.ts` 的 `normText`/`songKey` 口径一致（v1.17 起 app 侧只留搜索页跨页去重键） —— 栈式剥**任意嵌套**括号、歌手集合排序后作键、junk 词看**原始标题**且关键词本身命中时豁免、打分 base 200 / 标题 60-45-30 互斥 / 歌手 55-35 / 专辑 10 / 软降级 −25 / `preferSource` +8 / 封面 +3 / 时长 +2、按「歌名+歌手集合」去重留最高分、分数降序 + 展平序稳定、`limit` 排序后截断、返回原件不改入参）；`aggregate.ts` 加 `searchMergedPageBatches`（一次扇出同时算 `full` 与合并结果，不让入口为拿 `full` 重复打一轮）；`meta-entries.ts` 注册入口 `searchMerged`。
- **`full` 是分页收尾的唯一依据**：出参 `{ list, full }`，`full` = 这一页是否有**任一源**返回满页，且必须用**合并前的原始批次**判定 —— 合并去重后条数必然少于各源之和，宿主拿 `tracks.length` 比 `size` 会永远判成「到底了」，后面的歌再也翻不出来；各源原始条数只有包侧知道。
- app 侧（`src/source-scripts/index.ts`）：`searchMergedPage(keyword, page, size, {sources, preferSource})` → `{tracks, full}`；~~**兼容旧数据包**：应答报「缺少该接口」时退回 `searchAllBatches` + 本地 `mergeAggregateTracks`…~~ **v1.17 起（见 §0.3-Q）直接抛「数据包版本过旧」**：`localMerge` / `searchMergedSupported` / `dropJunk` 已删除；其它错误照旧抛出（静默降级会把「包坏了」伪装成「搜不到」）。
- 搜索页（`src/components/SearchPage.tsx`）：聚合模式只渲染一条列表，**不再有「源名 + N 首」分组头**，行尾保留一个源标（用户认可的形态）；跨页去重按 `songKey`（歌名 + 歌手集合）而不是「源 + id」—— 第 2 页的同歌往往来自**另一个源**，只比 `platform:id` 会漏掉；`hasMore` 直接用包回的 `full`。
- 测试：`tests/source-scripts-search-merged.test.ts` 6 条（应答映射与 `full` 透传、空关键词不打引擎、非缺入口错误原样抛、旧包缺入口报「数据包版本过旧」且不再本地合并；v1.17 起 `aggregate-merge.test.ts` 已删）、`tests/search-page-pagination.test.tsx` 的聚合用例改为 mock `searchMergedPage` 并断言无分组头。

**K. 音乐列表统一标出平台简称（v1.11 · 2026-10-23）**

- 需求原话：「所有的音乐列表都需要增加一个展示该歌曲对应的平台的简称，放在歌名右边吧，样式和详情页歌曲名旁边的平台展示类似吧」。
- 为什么抽公共组件：改造前源标散在十几处，配色各写一份（正在播放页一套、搜索页一套、队列一套……），改一次颜色要动十几处，且必然有地方被漏掉。现在全站只有 `src/components/common/SourceTag.tsx` 一个实现，样式口径也只有一个地方可改。
- 两档尺寸：正在播放页 `sm`（`text-[11px]` / `px-1.5`，与改造前完全一致）；列表行 `xs`（`text-[10px]` / `px-1`）—— 曲目行行高只有 20px，11px 的徽标会把行撑高、行距变得忽宽忽窄。
- 展示**简称**而不是全名：`sourceRegistry` 的 `short`（如「网易云」「QQ」，由数据包下发）；旧数据包没有 `short` 时回落 `name`，再没有回落「未知」。全名（「网易云音乐」）在列表里会把歌名挤掉一截。未注册的源 `useSourceColor` 返回中性灰，徽标照常显示。
- 本地曲目没有「平台」概念：`SourceTag` 内部判 `LOCAL_PLATFORM` 直接返回 `null`，所以调用处不必逐个判 platform（`TrackList` 被 9 个页面复用，其中本地库、下载页、本地歌单都是本地曲目）。
- `LOCAL_PLATFORM` 从 `@/services/ipc` 抽到 `@/lib/platform.ts`（`ipc.ts` 改为再导出，旧 import 不受影响）：展示组件为判一个字符串常量把整个 IPC 层拖进依赖图不划算 —— 组件单测会因此被迫给整个 `@/services/ipc` 铺 mock，反而更容易与真实实现漂移。
- 覆盖面（12 处）：`discovery/TrackList`（9 个页面共用）、`SearchPage` 的 `TrackRow`（原来用行尾 `badge`，现统一成歌名右侧徽标）、`player/QueuePanel`、`ai-assistant/MessageBubble`、`mine/StatsPage`（前四名卡片 + 第 5 名开外列表）、`discovery/ChartSpotlight`（前三首）、`discovery/TrackCard`（首页 / 新歌速递卡片）、`player/SourceSwitchPanel` 与 `lyric/LyricSearchButton`（**原本在歌名左侧放全名 chip，现改为右侧简称**）、`mine/ListenReportDetail` 与 `mine/ListenTrendSection`（听歌记录里的歌曲行，`entry.track` 存在才渲染 —— 歌手 / 音源分组行不加）。
- 不覆盖：下载页与本地库页（本地文件无平台）、歌单类列表（歌单不是歌曲）、播放条 / 标题栏 / 分享卡（不是列表）。

**L. 去重合并：能公用的实现不再各写一份（v1.12 · 2026-10-23）**

- 需求原话：「这就是代码质量，把一些能公用的方法和代码全部合并一下，不要都各写各的，不方便维护」。触发点是 K 节把源标抽成 `SourceTag` 之后用户认可这个方向，要求全库同办。
- 原则一：**只合并语义相同的**。合并的前提是「同名函数在原处行为逐字一致」，否则就是拿改行为换行数。审计后落地的四个叶子模块：`lib/text.ts`（三处曾各有一份 `normText`：`music-style` / `daily-recommend` / `recommend-rank`；`trackKey`/`songNameKey`/`todayKey`/`hashString`/`jitter`/`truncateChars`/`safeDecode` 同理）、`lib/coerce.ts`（`ai.ts` / `feedback.ts` / `messages-data.ts` / `qt-NoticeDialog` / `store/disclaimer` 五处各有一套 `as*` 或 `coerce*`）、`lib/format.ts`（设置页与下载页各一份 `formatBytes`）、`lib/pending-cache.ts`（`artist-id` 与 `artist-pic` 两份同构的「在飞去重 + 已落定 + 逐出」缓存）。
- `lib/coerce.ts` 里刻意保留**两族**：`as*` 严格族（只认本类型，`asNumber("42")` → `0`，给「结构不符就当缺失」的解析用）与 `coerce*` 宽松族（`coerceNumber("42")` → `42`，给「后端字段经常是字符串/0-1」的读取用）。两族语义不同，合并成一族会让某一侧的行为悄悄变掉 —— 头注释写明了这条边界。
- 原则二：**跨仓镜像的代码不动**。`lib/song-key.ts` 的 `normText`/`songKey` 与 `qt-sources/src/actions/merge-search.ts` 的对应实现口径一致（v1.17 起 app 侧不再有 `mergeAggregateTracks`，只剩这个去重键）（栈式剥**嵌套**括号、额外剥 `《》〈〉「」『』【】`、歌手拆集合后排序），属「搜索合并」语义，不能改吃 `text.ts` 的 flat 版；两仓文件头互相标注了「唯一真源在包侧、改规则必须两边一起改」，单测各锁同一批用例。
- 原则三：**同名的「不是同一件事」不合并**，并在汇报里说明为什么：`lrc.ts` 的 `formatTime`（`mm:ss`）与 `messages-data.ts` 的 `formatTime`（日期时间）；`discovery/CoverCard` 与 `mine/StatsPage` 的两个 `SectionTitle`（`text-xl` 区块标题 vs `text-sm` + 右侧「全部」）；`mine` 与 `player` 的两个 `CollectButton`（列表行触发 vs 圆形按钮自持收藏态）；`QueuePanel` 的 `trackKey`（`JSON.stringify([platform,id,startMs,endMs])`，区分片段，与 `lib/text` 的同名函数不同义）。
- 顺带修掉的**真 bug**：`recommend-rank.ts` 原来为了「避免循环依赖」自带一份 `durationBand`（180/270/420），`music-style.ts` 的是 150/240/330 —— 同一首 240 秒的歌在画像里落 `long`、在打分里落 `normal`，`W_MAIN_BAND` 的主带对比一直错位。下沉到叶子模块后 `recommend-rank` 直接用 `music-style` 那一份（画像与打分必须同一个带边界），并把它自己那份删掉；`tests/recommend-rank.test.ts` 的夹具时长从 240 改成 200（两套边界下都是 `normal`，用例本意不变）。
- 组件层再合并一处：`mine/ListenReportDetail.tsx` 与 `mine/ListenTrendSection.tsx` 各写了一份 `EntryPicture`（三档分组 → 封面 / 歌手头像 / 音源 logo），现在只在 `components/mine/ListenReportBits.tsx` 有一份，`size` 取 32 / 40 两档（趋势区块行更紧凑用 32，详情页列表用 40）；两页各自删掉不再用的 `Music4` / `SourceLogo` / `ArtistAvatar` / `qtresCoverUrl` import。
- 测试替身也去重：`source-scripts-search-many` / `-source-filter` / `-search-merged` 三个文件原来各抄一遍约 25 行的 `vi.mock("@/source-engine/client")` 工厂，现在 mock 行为只有 `tests/helpers/engine-client.ts` 一份（`createEngineMock` 状态 + `engineClientModule(state)` + `resetEngineState`），错误注入统一成 `errors.set("searchAll:陈奕迅", …)` 这种「入口名或入口:关键词」的键，比原来两个文件各用一套数组/Map 更好读。
- 验收口径：`npx tsc --noEmit` 干净、全量 `npx vitest run` 88 files / 868 tests 全绿、`npm run build` ✓、改动文件 eslint 无告警；新增 `tests/shared-utils.test.ts`（15 条）把四个叶子模块的语义钉死 —— 消费方太多，改一处会牵动画像、听歌报告、AI 回复解析、头像缓存。

**M. 搜索改成独立的整页（v1.13 · 2026-10-23）**

- 需求原话：「我想要右上角的搜索变成一个完整的单独的页面，包括历史搜索，热门搜索等等」。
- 改造前的问题：标题栏里是一个真正的 `<input>`（输入关键词回车才跳 `/search`），而 `/search` 只有带 `?q=` 时才有内容 —— 用户点开「搜索」既看不到历史也看不到热搜，等于每次都在盲打一个词；同时搜索页自己也有一份输入框与联想逻辑，两处实现注定漂移。
- 标题栏（`src/components/TitleBar.tsx`）：`<input>` 换成**按钮**（胶囊样式与原来一致，左侧放大镜 + 提示语「搜索歌曲 / 歌手 / 专辑 / 歌单」），点击 `navigate({ to: "/search", search: { q: "", type: "song" } })` 落到搜索首页。标题栏不再持有任何输入状态（`useState` / `useSearch` / `parseSearchType` 三个依赖一并删掉）。
- 搜索首页（`src/components/SearchPage.tsx`，`?q=` 为空时）：`SearchLanding` **两块** ——
  1. **搜索历史**：settings 表 `search.history`（`lib/search-history.ts`，≤ 20 条，去重置顶）渲染成可点的胶囊，右侧一个「清空搜索历史」按钮，单个胶囊带 `×` 删除；
  2. **热门搜索**：当前音源 `hotWords`（数据包入口 `hotWords`），两列带序号，前三名用主色；标题旁标「按当前音源」；本地音源没有热搜，整块不出现。
  - **不放「热门歌单」**：第一版曾加过一块 `playlistCategories` → `recommendations` 的歌单网格，用户当轮就指出「热门搜索，不是热门歌单」——歌单推荐在「歌单广场」已经有整页，塞进搜索首页只会把真正要的入口挤下去。
- 输入框：进入落地页时 `inputRef.current?.focus()`（只在 `!searched` 时抢焦点；带 `?q=` 进来是看结果的，不该把光标抢走），并补了「清空输入」的 `×`。
- 页签栏（歌曲 / 歌单 / 歌手 / 专辑 + 聚合搜索开关）改为**只在搜过之后**渲染：落地页没有结果可切，摆一排灰按钮只会让人以为「搜索已经开始但没结果」。
- 歌曲页签的**播放全部**：页签栏右侧（聚合开关右边）一颗按钮，`playQueue(songs, 0)` —— 整批入队并从第一首起播（与列表播放入口同一语义，DESIGN §11.2）。「全部」只能是**已加载**的那批（搜索是滚到底续页的），所以按钮 `title` 写明「把已加载的 N 首加入队列」。没有结果时不渲染这颗按钮。
- **页签只有一个真源：URL**（`?type=`）。`SearchPage.tsx:133` `const tab = parseSearchType(urlParams.type)` 每帧派生，点页签只 `navigate(..., { replace: true })`，`resetKey` 带上 tab，`usePagedList` 在渲染期发现 `cursor.key !== resetKey` 就归第 1 页、清列表、nonce+1，并用 `cancelled` 丢弃旧页签的迟到应答。0b72104（2026-10-12）之前是 `useState<Tab>("song")` + `setTab`，URL 与 state 两个真源、谁最后写谁赢，这才是「页签切换偶发不生效」的历史成因（返回 / 前进后退 / 深链入口都会按默认 song 初始化）。2026-10-24 复查确认当前树已不存在该路径，并补了 `tests/search-tab-switch.test.tsx` 7 条把它钉住（含迟到应答竞态、翻到第 2 页再切页签必须回第 1 页）。
- 测试：`tests/search-landing.test.tsx` 5 条（历史与热搜都在且无页签栏、**不出现「热门歌单」**、输入框自动聚焦、点历史词发起搜索并写历史、输入 + 「搜索」按钮发起搜索、带 `?q=` 时落地内容全部收起）、`tests/search-play-all.test.tsx` 3 条（点播放全部 = `playQueue(songs, 0)`、无结果时没有这颗按钮、歌单/歌手/专辑页签没有它）与 `tests/titlebar-search.test.tsx` 2 条（点按钮跳 `/search`、标题栏里不再有文本框）。

**N. 本地模型精选 & 规则推荐：为什么看起来一样，以及怎么改的（v1.14 · 2026-10-23）**

- 用户反馈原话：「目前没有感觉到用AI推荐和规则推荐有什么不同」。查 `settings` 表里当天的 `dailyRecommend.cache`：`requested=local` 但 `mode=rule`、`notice=本地模型调用失败（模型返回的 JSON 无法解析），已退回规则推荐。`，50 条 `reason` 全是同一句「你收藏里的歌」——那天页面上的「AI 推荐」根本不是 AI 挑的。
- 但就算模型回执正常，结果也会几乎一样。**根因在 `rankCandidates` 的 `target` 缺省值**：`generateDailyRecommend` 调用它时没传 `target`，缺省即 `DAILY_TARGET`（50），于是 `rulePicked` 最多 50 首；后面 `const aiPool = pickAiPool(rulePicked, variant)` 再怎么扩 `DAILY_AI_POOL_MAX` 也是空转 —— 池子就是规则结果本身，让模型从 50 首里挑 50 首，歌单必然逐首相同，只剩顺序和理由文案不同。
- 修法（`src/lib/daily-recommend.ts`）：本地模型模式把排序目标放大到 `Math.max(DAILY_TARGET, DAILY_AI_POOL_MAX)`（**150**），规则结果仍然只取前 50（降级与补齐都用它）：
  ```ts
  const rankTarget = mode === "local" && !coldStart ? Math.max(DAILY_TARGET, DAILY_AI_POOL_MAX) : DAILY_TARGET;
  const rulePicked = rankCandidates(pool, pref, { ..., target: rankTarget });
  const ruleItems = rulePicked.slice(0, DAILY_TARGET).map(...);
  ```
  候选再多也不整池丢给模型：`pickAiPool` 固定保留前 `DAILY_AI_CORE`（90）首，剩下 60 个名额从尾巴按 `variant` 轮转取样 —— 「换一批」时模型看到的是**不同的候选**，不是同一批歌换顺序。`DAILY_RULE_VERSION` 6→7，旧缓存（那批退回规则的结果）作废重算。
- 回执容错三级（`parsePicks`）：① 原样 `JSON.parse`；② 失败先 `repairJsonText` 再试（裸控制字符逐个换空格、尾逗号去掉，**逐字符实现**而不是正则字符类，避免 `no-control-regex`）；③ 再失败 `salvagePicks` 用正则捞 `"index": N`（及其后紧跟的 `reason`）或 `"picks":[3,17,42]` 纯数字数组，`title`/`summary` 用 `salvageField` 捞。另外 `extractJsonArray` 支持模型直接回一个裸数组。全都捞不到才算失败。
- 失败重试一次（`askModelForPicks`，`AI_PICK_ATTEMPTS=2`）：第一次失败后追加一条「上一次的输出不是合法 JSON（可能有裸换行、多余逗号或多说了话）…」并以 0.5 温度重试；两次都不行才退回规则并写 `notice`。**网络错误不在 JS 侧重试**（`ai_local.rs` 内部已有 3 次退避重试）。
- ~~提示词加两句防「照抄」：「清单的序号顺序是规则粗排的结果，不代表推荐优先级：请按主题与风格重新组织」「不要直接照抄前 50 首，也不要只挑常听歌手的歌」。~~ **这两句在 v1.15 已删除** —— 实测它们让模型为了「不一样」去凑风格拼盘，把无关的英文歌 / 冷门网络流行塞进歌单，正是用户说的「像随机选」。现行口径见 §0.3-O。
- 页面：`DailyRecommendResult.model` 记录本次用的模型名，页头小字渲染成 `2026-10-23 · 本地模型精选 · deepseek-v4.1-flash · 心动` —— 换模型后能直接对比，也不会再出现「写着 AI、其实是规则」却看不出来的情况（退回规则时 `model` 为空）。
- 真实模型实测（`_tmp/probe150.mjs`，库里的真实 key/模型、150 首候选 + 新提示词，跑了 3 轮）：3/3 `HTTP 200`、`finish=stop`、JSON 解析成功，耗时 7.4–9.5 s；`picks` 分别 **50 / 51 / 51** 条，其中**落在规则前 50 名之外的有 22 / 23 / 37 条**（即与规则模式歌单的重合度从 100% 降到 26%–74%，索引范围最远用到 115/141）。顺带发现模型偶尔多给一两首（要 50 给 51），结果组装时按 `DAILY_TARGET` 截住。
- 测试：`tests/daily-recommend.test.ts` 65 条（新增 `parsePicks 容错` 7 条 + `pickAiPool` 3 条）、`tests/daily-recommend-generate.test.ts` 32 条（新增「候选池给到 150 首」「第一次回执格式坏了会重试一次」「两次都拿不到序号才退回规则」「模型多给了一两首时按目标条数截住」）。验收：`npx tsc --noEmit` 干净、全量 88 files / 868 tests 全绿、`npm run build` ✓、改动文件 eslint 无告警。

**O. AI 推荐「像随机选」：从求多样改成求贴合（v1.15 · 2026-10-24）**

- **现象与证据**：用户 2026-10-23 22:32 起连续三次追问「AI 推荐怎么那么像随机选」。直接查 `%APPDATA%\QuietMusic\data\music.db` 的 `settings.dailyRecommend.cache`：当天 `mode=local`、`model=deepseek-v4.1-flash`、`title=心动古风·华语慢听`、`profileText=华语 · 三四分钟 · 常听 314 位歌手 · 常听古风`；前 46 首确实是古风 / 华语抒情，**第 47–50 首是 `5:20AM - 刀酱`、`Everywhere We Go - 陈冠希/MC仁/厨房仔/应采儿`、`One Last Time - Ariana Grande`、`Control - Zoe Wees`** —— 与画像完全无关的英文歌。摘要里那句「按古风、深情、轻快与混搭风格铺排」正是模型对「分散风格」的理解。
- **根因（四个，全在 app 侧）**：
  1. **提示词在要求「多样」而不是「贴合」**：`buildPrompt` 写了「清单的序号顺序是规则粗排的结果，不代表推荐优先级：请按主题与风格重新组织」「不要直接照抄前 50 首」「尽量分散在不同歌手和不同风格」。小模型对「分散」的理解就是「凑风格种类」—— 它会把池子尾部的弱匹配歌挑上来，只为让语种 / 风格不重样。
  2. **候选行没有证据**：旧行只有 `歌名 - 歌手（专辑 / 语种）`。模型看不到「这首你收藏过」「这个歌手你常听」「这首你单曲循环过 12 次」，只能按歌名猜贴合度 —— 猜错与随机无异。
  3. **温度过高**：`aiLocalChat(payload, 0.8)`，同一份候选池两次能给出差异很大的歌单；重试还是 0.5。推荐不是写诗，0.8 的「创造力」在这里就是噪声。
  4. **打散破坏模型排序**：`spreadItemsBySinger` 是贪心重排（每步取「第一个不同歌手」），模型按贴合度排好的顺序会被整段打乱；用户看到的第 2、3 首经常是池子里 20 名开外的歌。
- **修法**（`src/lib/daily-recommend.ts`）：
  1. **证据层** `evidenceSnapshot()` / `trackEvidence()` / `evidenceText()`：从 `favoriteTracks` / `playlistTracks` / `topTracks` 的播放次数 / `topSingers` / 画像（`singers`、`albums`、`mainLang`）算出每首候选的证据，行尾最多 3 条：`已收藏` → `听过N次` → `常听歌手`（没有则 `收藏歌手`）→ `常听专辑` → `非主语种`。括号里固定带时长带（旧提示词让模型「按时长判断」，却从没给过时长数据）。
  2. **语种下限**：画像主语种定得下来时写「他平时主要听华语：50 首里请至少有 40 首是华语」。「别挑奇怪的歌」小模型听不懂，「至少 40 首」它听得懂。探索口味换成「可以换歌手换风格，但别整张歌单都跳到别的语种去」。
  3. **规则改写**：用 ①②③④ 开头（`1. ` 会和候选行的「序号. 歌名」冲突，模型和测试的行解析都会数错）。心 / 熟口味五条：越靠前越贴合 → 不要为「看起来不一样」塞无关歌 → 整张歌单一个主题 → 同歌手 ≤3、勿重复 → 理由必须落到画像。system 加一句「你的目标是让这份歌单听起来像同一个人按同一套口味挑出来的，而不是随机抽样」。
  4. **温度**：`AI_PICK_TEMPERATURE = 0.4`、`AI_PICK_RETRY_TEMPERATURE = 0.2`。
  5. **结果侧依据校验** `filterAiPicks(items, pref, taste)`：非 `explore`、且画像已成形（`sampleSize > 0` 或 `mainLang !== "und"`）时，剔掉「本地零证据且非主语种」的歌（`hasProfileGrounding` = 已收藏 / 听过 / 常听歌手 / 收藏歌手 / 常听专辑 / 主语种；时长带单列不算依据）；被剔掉的歌记进 `used` 不再补回，补齐循环遍历 `rulePicked`（150 首）直到 50 首 —— 页面不会少行。画像没成形时不硬筛（新用户不砍半），`explore` 直接放行。
  6. **打散改最小相邻交换**：只处理「相邻同歌手」，向后找第一首不同歌手的歌交换一次；没有冲突时原样返回，第一首永远不动。
  7. **中段穿插封顶**（`DAILY_AI_OFF_CORE_MAX = 12`）：只删凑风格的指令会让模型变成「照抄规则前 50 首」，那又回到 R27 修掉的「AI 推荐和规则推荐一模一样」。折中写进提示词第 ⑤ 条：从第 51–90 首里挑 6–10 首换进来（规则前 90 首都算贴合，只是播放次数低），播放顺序按「开场 → 沉浸 → 收束」自己排。实测小模型会超额（要 6–10 给 30），所以 app 侧 `limitAiPicks()` 硬封顶：`index > DAILY_TARGET` 的最多留 12 首，且每首都要过 `hasProfileGrounding`。
  8. **缓存作废**：`DAILY_RULE_VERSION` 7→8，当天旧结果自动重算。
- **真实模型验证**（150 首合成池：前 60 古风 + 70 华语流行 + 尾部 20 首英文，画像「华语古风」；用库里 `ai.*` 配置直连 `deepseek-v4.1-flash`，温度 0.4，跑两轮，闸门与补齐逻辑与 `generateDailyRecommend` 一致）：两轮**最终 50 首全部是华语、英文歌 0 首**；模型回执 51 / 38 首，过闸后 40 / 38 首，规则补 10 / 12 首；中段穿插 12 / 8 首（正好卡在上限内）；与规则前 50 首重合 38 / 42 首 —— 既没有随机歌，也不是纯规则复读。改前的对照是同一天真实缓存里第 47–50 首的英文歌。
- **测试**：`tests/daily-recommend.test.ts` 78 条（新增「候选行带本地行为证据」「主语种定得下来时给可对账的语种下限，无关歌标非主语种」「顺序本来就没有相邻撞歌手时原样保留」「只有相邻撞歌手时才动一两首」+ `filterAiPicks` 4 条 + `limitAiPicks` 4 条）、`tests/daily-recommend-generate.test.ts` 34 条（新增「提示词改成贴合优先」「模型硬挑一首与画像无关的歌 → 剔掉并补满 50 首」；重试温度断言 0.5→0.2 并新增首次 0.4）。另新增 `tests/search-tab-switch.test.tsx` 7 条（搜索页页签切换回归：URL 唯一真源、迟到应答丢弃、翻页后切页签回第 1 页）。验收：`npx tsc --noEmit` 干净、全量 **89 files / 890 tests** 全绿。
- **待用户确认**：三重收口后最终观感要用户重新生成一次看真实结果（旧缓存已因版本号 +1 失效自动重算）；中段 12 首上限如果仍显多/显少，调 `DAILY_AI_OFF_CORE_MAX` 一个常量即可。

**P. 风格更多变、维度更多：先扩候选池，再按风格线配额（v1.16 · 2026-10-24）**

- **现象与证据**：v1.15 收口后，用户 2026-10-24 08:03 反馈「风格能够在多变一点吧，而不是只有那么一个两个，推荐的维度可以在多一点。因为你的数据来源是历史和搜索出来的，AI 主要是在你的结果里面选歌，那么你的搜索维度和结果就非常重要」。查当天缓存（v7）：50 首 = 16 古风 + 14 华语抒情 + 11 冷门网络流行 + 5 kg 古风 + 4 英文歌 —— **两条主线吃掉 30 首**，其余是同一批种子歌手的边角料。提示词在 v1.15 已经改成「贴合优先」，所以这次的问题不在提示词，而在**候选池的取数维度**。
- **根因（全在取数侧）**：
  1. `buildCandidatePool` 的 6 条路（收藏/歌单、按歌手、跨源按歌手名、最新、按专辑、风格分类歌单）全部从「画像里已有的东西」长出来 —— 同一个画像永远长回同一片歌；`pickStyleCategories` 又只取 `STYLE_CATEGORY_MAX`=2 个分类 × `STYLE_PLAYLIST_MAX`=2 张歌单，等于只给两条线。
  2. 规则排序只按「和画像的贴合度 + 同歌手/语种 MMR」，没有「风格线」概念：池子里就算有粤语、纯音乐，只要分数略低就排不进前 50。
  3. 结果闸门（`filterAiPicks`）只认「主语种 / 已有证据」，画像里占比 8% 的次要语种会被当成「非主语种」硬剔 —— 维度路刚带回来的歌反而进不了终选。
  4. AI 只做「在给定清单里挑」：池子里没有的风格，提示词再怎么写也变不出来。用户那句「AI 主要是在你的结果里面选歌，那么你的搜索维度和结果就非常重要」已经把根因说透了。
- **修法**：
  1. **维度规划与采集**（新模块 `src/lib/recommend-dimensions.ts`）：`planDimensionQueries()` 按 画像风格标签 → 歌单名 → 画像里的次要语种（占比 ≥ `LANG_AFFINITY_MIN`=5%）→ 相邻风格词（古风→国风/戏腔/民乐…）→ 按 `variant` 轮换的兜底词（3 个；explore 4 个）→ 用户搜索历史（≤3 条）生成 ≤10 条查询。`collectDimensionLanes()` 三路采集：**榜单**（`getCharts` 取 ≤5 张，榜单名天然带风格/年代语义，每榜 ≤60 首）、**关键词跨源搜索**（`searchManyBatches`，每词 ≤24 首）、**风格歌单**（`searchPlaylists` + `getPlaylistDetail`，2 个 tag/genre 词 × 20 首）；全部 try/catch 兜底，单路失败不影响其它路。每条曲目都带「风格线」label（`laneOf: Map<trackKey, string[]>`）—— 这是配额、提示词、结果展示共用的 provenance。
  2. **池子合并**：`buildCandidatePoolWithLanes()` 并行跑原 6 路与维度层（`local` 源直接跳过，不为一个必失败的调用白等超时；维度层异常退化为空），按 `trackKey` 去重，返回 `{ tracks, laneOf, affinityLanes }`；`buildCandidatePool` 保留为它的 `Track[]` 包装。
  3. **规则排序按线配额**：`diversifyByLanes(ranked, laneOf, target)` 在 `rankCandidates()` 之后做「七成保贴合、三成给风格线」—— 先收下排名前 `target - round(target × 30%)` 首作底盘，再按线的首个出现顺序给最多 `LANE_DIVERSITY_MAX`=5 条线各补到 `floor(30% × target / 线数)` 首（底盘里已有的计数在内），最后按原序补满；没有风格线时退化为 `ranked.slice(0, target)`。之后 `interleaveByLanes()` 按线交织排展示顺序（权重 4/2/2/1）；未标线的曲目补成 `"常规"` 线（不能留成 `__` 前缀，否则会被当兜底线沉到末尾）。
  4. **提示词 v9**：候选行括号最前面加 `风格线：古风`；画像段加「画像里的语种分布：华语 82%、日语 8%」；新增风格线规则「这张歌单要覆盖 3–5 条不同的「风格线」（候选里一共 N 条：古风（62 首）…）：「古风」占一半左右，再挑 2–4 条相邻的线各 4–10 首，线内连贯线间有别」；候选线 ≤3 条时按实际条数说（避免指向不存在的线）；explore 要求其中至少 2 条平时不常听、每条线 ≥3 首；title / summary 要写出多风格结构（例「古风打底，掺几首粤语和纯音乐」）。规则仍用 ①②③ 编号，不与候选行的「序号. 歌名」冲突。
  5. **闸门放宽 + 结果可解释**：`TrackEvidence` 增 `langAffinity`（该语种在画像里占比 ≥ `LANG_AFFINITY_MIN`），只有「画像里完全没出现过的语种」才标「非主语种」；`hasProfileGrounding()` 认 `langAffinity || laneGrounded`，`filterAiPicks` / `limitAiPicks` 都接受 `{ laneOf, affinityLanes }`（旧 3/4 参调用不变）。结果新增 `styleLanes`（`laneCoverage()` 现算、最多 5 条、按条数降序），页面在「口味画像」下方渲染「本期风格」chips。`DAILY_RULE_VERSION` 8→9，当天旧缓存自动重算。
- **真实模型验证**（200 首合成池：古风 70 / 华语流行 60 / 粤语 25 / 纯音乐 25 / 日语 20，前 75 首为主风格头部；画像古风 + 华语流行；真实 `deepseek-v4.1-flash`，温度 0.4；闸门、补齐、交织逻辑与 `generateDailyRecommend` 一致，两轮）：
  - 模型正常回执那轮：回 50 首 → 其中 22 首在规则前 50 之外 → `limitAiPicks` 收到 40 首（中段 12 首封顶规则内）→ `filterAiPicks` 全留 40 首 → 规则补 10 → **最终 50 首覆盖 4 条线（古风 25 / 华语流行 13 / 粤语 8 / 纯音乐 1）**，`title = 古风打底，掺几首粤语与纯音乐`，与规则前 50 重合 22 首（模型真在选，不是复读）。
  - 模型回空那轮：走规则兜底，最终 50 首仍覆盖 4 条线（古风 18 / 粤语 10 / 华语流行 8 / 纯音乐 5）—— **即使模型不出结果，配额与交织也让风格线出现在结果里**。
  - 对照：改前同一天真实缓存只有 2 条主线（古风 16 + 华语抒情 14）。两次重跑里各有一轮模型 `content` 为空（0 字符，不是 JSON 解析问题），app 侧有一次纠正重试 + 规则兜底，不影响出结果。
- **测试**：新增 `tests/recommend-dimensions.test.ts` 25 条（维度规划 / 三路采集 / 交织 / 覆盖统计）、`tests/daily-recommend-page.test.tsx` 4 条（chips 渲染与空态）；`tests/daily-recommend.test.ts` 84 条（新增 v9 提示词风格线 + 语种分布、`filterAiPicks` 线依据放宽、`diversifyByLanes` 4 条）、`tests/daily-recommend-generate.test.ts` 36 条（新增「维度路：榜单把新风格带进候选池」2 条）。验收：`npx tsc --noEmit` 干净、全量 **91 files / 927 tests** 全绿。
- **待用户确认**：真机「换一批」看是否真的多出几条线；线数上限（`LANE_GOAL_MAX` / `LANE_DIVERSITY_MAX` = 5）与配额（`LANE_QUOTA_SHARE` = 0.3）都是常量，嫌多嫌少调这两个。

**Q. 多源聚合接口一律下沉音源包（v1.17 · 2026-10-24）**

- **需求原话**：「这次有没有新增的聚合接口，后面所有使用多个音源的聚合接口必须放到音源包里面」。要求是**接口住哪**，不是改哪个功能：凡「一次要打多个音源、再把结果合成一份」的能力，都只能在数据包里实现，宿主一次 invoke 拿成品。
- **审计结论**：本次 v1.16（风格更多变）没有新增聚合接口 —— `src/lib/recommend-dimensions.ts` 只调用包侧 `searchManyBatches`（数据包 `searchMany`）与单源的 `getCharts` / `getChartDetail` / `searchPlaylists` / `getPlaylistDetail`（都只打当前音源），前端没有逐源 fan-out。但历史上有**三处宿主侧聚合**没下沉干净：
  1. `getAllLatestSongs`：绕过包 `allLatest`，用 `getSourceRegistry()` 逐源调 `latest` 再在宿主交错合并（最新音乐页 + 每日推荐 `latest` 路每次都跑）。根因是包 `allLatest` 把多源结果展平成 `MusicInfo[]`，**条目不带 `platform`**，而取链、封面、跳转都靠 platform 归属 —— 裸 `MusicInfo` 一道混合就没法归谁了。
  2. `searchManyBatches`：包缺 `searchMany`（< `META_REVISION` 6）时退回宿主 `fanOutSearch`（worker 池 + 逐词逐源扇出）。
  3. `searchMergedPage`：包缺 `searchMerged`（< 7）时退回宿主 `localMerge()`（`searchAllBatches` + `mergeAggregateTracks`）。
- **为什么必须住包内**：并发度、超时预算、单源失败隔离、去重与排序口径都属于「怎么打多个源」，各端（PC / 安卓 / 以后别的端）共用一份才不会漂移；放在宿主还意味着每次「最新 / 聚合搜索」都要前端先拉注册表、再自己算交错与超时，等于把音源层的编排知识复制到 UI 层。**降级路径本身也是重复实现**：`fanOutSearch` / `localMerge` 与包内实现语义必须永远对齐，改一边忘一边就是静默漂移 —— 用户看到的是「有时重复、有时少歌」。
- **修法**：
  1. **包侧**（`qt-sources`，`META_REVISION` 7→8）：`allLatest` 每条曲目盖 `platform`；交错展平抽成纯函数 `interleaveLatestBatches(batches, limit)`（逐轮取各源第 i 首、`out.length >= limit` 立即返回、不改写入参），`allLatest` 入口只负责 `allLatestBatches` + 展平。入口名与返回结构（`{ list }`）不变，**旧宿主不读新字段则行为不变**。
  2. **宿主**：`getAllLatestSongs(limit, offset)` 改为一次 `sourceCall("allLatest")` 的薄包装 —— 校验 `list` 形状、逐条读 `platform`（`undefined` / `"local"` 跳过，按 `toAppTrack` 映射），到 `limit` 截断；缺入口抛「数据包版本过旧」；旧包（REV 7，入口在但没 platform）抛「数据包版本过旧：缺少带 platform 的 allLatest」—— 让用户去更新数据包，而不是静默扇出。`buildCandidatePool` 的 `latest` 路本来就有 `.catch(() => [])`，拿不到最新流不会让每日推荐整单失败。
  3. **删除旧包降级**：`searchManyBatches` / `searchMergedPage` 缺入口时统一抛 `packOutdated(...)`（消息含「数据包版本过旧…请到「设置 → 音源包」更新数据包后重试」），删 `searchManySupported` / `searchMergedSupported` / `fanOutSearch` / `mergeSearchGroups` / `localMerge`；`AggregateSearchResult` 去掉无人消费的 `merged`，`MergedSearchOptions` 去掉 `dropJunk`。
  4. **删除 app 侧合并实现**：`src/lib/aggregate-merge.ts`（`mergeAggregateTracks` / `isJunkTrack` / `normText` / `songKey`）整体删除；搜索页跨页去重仍需要 `songKey`，迁到新叶子模块 `src/lib/song-key.ts`（口径必须与包侧 `src/actions/merge-search.ts` 一致，头注释写明）；`tests/aggregate-merge.test.ts` 删除，`tests/song-key.test.ts` 继承 13 条键口径用例。
- **测试**：qt-sources 新增 `tests/aggregate-latest.test.ts` 6 条（交错顺序、platform 归属、limit 封顶、空批次不占位、不改写入参、空输入）；qt-pc `tests/source-scripts-search-many.test.ts` 5 条、`tests/source-scripts-search-merged.test.ts` 6 条、`tests/source-scripts-source-filter.test.ts` 5 条全部改为「应答映射 + 缺入口报版本过旧」，不再断言降级；`tests/song-key.test.ts` 13 条。验收：qt-pc 全量 **91 files / 886 tests** 全绿、`tsc --noEmit` 0 错、eslint 改动文件 0 错；qt-sources `tsc --noEmit` 0 错、`aggregate-latest` 6/6 过（该包另有 3 条真网络外链用例失败，属既有环境问题，与本次改动无关）。
- **数据包重装**：`sources.config.json` meta 包 `versionCode 2026102201 → 2026102401` / `versionName 2026.10.22.1 → 2026.10.24.1`，`node scripts/build-sources.mjs` 重打（ed25519 签名在包内，245 KB），覆盖到 `%APPDATA%\QuietMusic\source-bundle\install\meta-official\meta-bundle.js` 并同步 `state.json` 的版本号（加载路径不验签，安装流程才验）；**已装好的旧包不更新则 `getAllLatestSongs` 会提示升级**。
- **待用户确认**：重启 App 后看「最新音乐」与每日推荐是否正常（包内交错口径与旧宿主实现一致，顺序应无变化）；如果暂时不想更新数据包，可以装回旧 `meta-bundle.js.prev` 再改 `state.json` 回 2026102201，但「最新 / 聚合搜索」会按「版本过旧」提示 —— 这是有意为之，不再静默降级。

**R. 详情页 hero：左封面 / 右内容，内容不得高于封面（v1.18 · 2026-10-24）**

- **需求原话**：「把每日推荐和歌单详情模板类似的，左边图片，右边内容，高度不要超过图片，内容全部往右边搭，否则很丑」。
- **问题**：两页 hero 其实早就是「左封面右内容」，但右侧行数太多（每日推荐：元信息 / 标题 / 共 N 首 / 摘要 3 行 / 口味画像 / 本期风格 / 口味按钮 / 操作按钮 ≈ 229px），把页头撑得比 144px 封面高 —— 封面只有上半截，下面挂着纯色空白，所以「丑」；歌单详情简介 clamp-3 时内容 161px 也会把 144px 封面比下去。
- **修法（两页共用一套）**：
  1. 封面 `h-36 w-36` → `h-44 w-44`（176px），**封面高度就是 hero 高度**；
  2. 每日推荐：元信息与「共 N 首」并成一行（`truncate` 收住长模型名）、摘要 `line-clamp-2`、口味画像与「本期风格」chips 并排一行（画像 `truncate` + `title` 放全文、chips `whitespace-nowrap`）、口味按钮组与播放 / 换一批 / 设置同一行；
  3. 歌单详情：简介 `line-clamp-2`；
  4. 两页内容列保持 `flex-col justify-end`（底对齐封面底边），不新增行、不往下溢出。
- **结果与验证**：每日推荐右侧约 170px、歌单详情约 164px，均 ≤ 176px —— hero 高度由封面决定，图片旁边不再有空白条；`tsc --noEmit` 0 错、eslint 改动文件 0 错、全量 **91 files / 886 tests** 全绿；`tests/daily-recommend-page.test.tsx` 4 条仍过（「口味画像 → 本期风格 → 推荐口味」的 DOM 顺序未变）。
- **未动**：歌手页 / 专辑页保持 144px 那套（右侧本来就只有 4 行，不超）；每日推荐页无 BackButton 行，与带返回键的详情页保持各自排版。

**S. AI 模式全局化：三种模式同时作用于「每日推荐」与「音乐助手」（v1.19 · 2026-10-24）**

- **需求原话**：「这个需要完全支持音乐助手，每日推荐。选择哪个全局都得使用这个模式」（附设置页「推荐方式」那一行的截图，三个按钮：纯规则 / 本地模型精选 / 服务端 AI）。
- **问题**：设置里的「推荐方式」只有每日推荐在读（键 `dailyRecommend.mode`），而且「服务端 AI」在每日推荐里被 `effectiveMode()` 直接降级成规则，只弹一句「当前页面不支持服务端 AI 精选」；音乐助手（`/ai-assistant`）固定走 astral 服务端会话，从不读这个设置 —— 「三选一」在一半页面上是假的。
- **修法**：
  1. 新增 `src/lib/ai-mode.ts` 作为模式的唯一来源（`AiEngineMode = "rule" | "local" | "server"`、标签、各模式一句话说明、`AI_MODE_OPTIONS`、`parseAiMode` / `readAiMode` / `saveAiMode`），键沿用 `dailyRecommend.mode` 不迁移；`daily-recommend.ts` 只做别名 re-export（`DailyRecommendMode` / `DAILY_MODE_LABEL` / `parseDailyRecommendMode` / `readMode` / `saveMode` / `effectiveMode`），`effectiveMode` 改为恒等。
  2. 每日推荐的服务端模式真调用：新增 `src/lib/ai-server-picks.ts` 的 `askServerForPicks()` —— 校验登录 → 取 `MUSIC` 智能体 → 建一次性会话 → 把 `buildPrompt()` 的 system/user 拼成一条消息发出（system 加 `【系统设定】` 前缀，上下文带前 150 首候选）→ 每 600ms 轮询事件到终态（总超时 90s）→ 正文走 `parsePicks`，正文不是 JSON 时用 `song_list` 块里的曲目按 `trackKey` 对回候选池序号；`finally` 删除会话。失败一律抛错，由 `generateDailyRecommend` 退回规则并在 notice 里说明原因（「服务端 AI 调用失败（…），已退回规则推荐。」），不静默兜底；失败落盘的结果按 `requested` 命中缓存，不会每次进页面都重搜。
  3. 音乐助手补本地两种模式：新增 `src/lib/ai-assistant-local.ts` 的 `runAssistantTurn()` —— rule 用风格词表 + 歌名/歌手点名 + 画像相似度打分（同歌手最多 2 首、取前 8 首），local 用「只输出 `{"reply", "picks"}`」的 JSON 契约调 `aiLocalChat`（温度 0.6），解析失败或模型异常整体回退 rule，永不抛错；`src/hooks/useAiChat.ts` 增加 `mode` / `modeHint`，非 server 模式在 `init()` 里不拉智能体与会话列表，`send()` 前重读一遍模式（设置页刚改也能生效），本地回合把结果拼成 `song_list` 块（页面上的播放 / 加入队列按钮沿用既有渲染，不需要分支）。
  4. 页面与文案：音乐助手页非 server 模式隐藏会话侧栏、折叠按钮与 agentCode 徽标，消息区上方显示模式横幅（含「设置 → AI 可切换」）；设置页「推荐方式」改「AI 模式」，每个模式下方一行说明，服务端未登录时提示「当前未登录服务端，实际会退回规则。」；每日推荐页链接文案改「AI 模式设置」。
- **结果与验证**：三种模式在「每日推荐」与「音乐助手」两侧都生效；服务端模式在每日推荐里走真会话（运行时失败才退回规则），本地模式两侧共用同一套候选准备与解析思路。`npx tsc --noEmit` 0 错、eslint 改动 13 个文件无 error/warning、全量 **96 files / 937 tests** 全绿（新增 `tests/ai-mode.test.ts` 7、`tests/ai-server-picks.test.ts` 9、`tests/use-ai-chat-modes.test.tsx` 5、`tests/ai-assistant-local.test.ts` 18、`tests/ai-assistant-modes.test.tsx` 11 条）。
- **注意**：`AiChatMessage` / `song_list` 块形状沿用服务端口径（`data.items` 是 `AiMusicCandidate[]`），本地回合只是自己造了一个同样的块，所以 `MessageBubble` 与播放动作不需要分支；模式切换对已生成的结果不追溯（每日推荐点「换一批」、助手下一条消息即生效）。

**T. 音乐助手本地模式补齐：左侧历史对话 + 20 首上限（v1.20 · 2026-10-24）**

- **需求原话**：「规则模式怎么左边不显示历史对话，然后每次只有8首，我要20首也是8首」（附「纯规则」模式截图：页头写着「按关键词规则选歌、不联网、不调模型」，左侧空白、结果块「为你找到的歌 8 首」）。
- **问题**：三处硬缺口叠加 ——
  1. `useAiChat.init()` 在 `mode !== "server"` 时直接 return，不拉会话列表；`AiAssistantPage` 又按 `serverMode` 把侧栏、折叠按钮一起隐藏，所以规则/本地模式左边永远空着，也没有「本地历史」可显示。
  2. `src/lib/ai-assistant-local.ts` 的 `MAX_SONGS = 8` 写死（`pickRuleSongs` / `mapPicks` / prompt 三处），用户说「20 首」也只会给 8 首。
  3. `MAX_PER_SINGER = 2` 对任何歌手都生效，用户点「周杰伦」时最多只出 2 首，剩下的名额被冲淡。
- **修法**：
  1. 新增 `src/lib/ai-assistant-history.ts`：本地会话存储（键 `quietmusic.ai-assistant.local-history.v1`，最多 30 个会话 × 40 条消息，超出丢最旧），`createLocalConversation` / `appendLocalMessages` / `listLocalConversations` / `loadLocalMessages` / `removeLocalConversation`；会话按 `lastMessageTime` 倒序（时间并列按 `id` 倒序兜底 —— 初版比较器在并列时两边都返回 -1，排序不稳定导致侧栏顺序错乱，已修）；消息还原成 `AiChatMessage`（`id` 用本地会话 id，`status: "COMPLETED"`，`blocks` 原样保留 `song_list`）。
  2. `useAiChat`：非 server 模式 `init` 读本地历史填侧栏；`selectConversation` 同步读本地消息；`removeConversation` 只删 localStorage；`sendLocal` 成功后把用户这句与助手回复一起写回历史（首条自动建会话），并刷新会话列表。
  3. 侧栏对三种模式都渲染（标题「历史对话」、空态「还没有对话」、折叠按钮文案改「收起历史对话 / 展开历史对话」），只有 server 模式保留智能体编号徽标。
  4. 引擎：`MAX_SONGS = 20` + `DEFAULT_SONG_COUNT = MAX_SONGS`；新增 `requestedSongCount(text)` 解析「20 首 / 二十首 / 5 首」（clamp 1..20，没点数量就按 20）；新增 `namedSingers(candidates, named)` 找出用户点名的歌手并对其放松同歌手配额；`count` 一路传到 `pickRuleSongs` / `buildLocalMessages`（prompt 里「最多 N 个」）/ `parseLocalReply` / `mapPicks` / `runLocalTurn`；答复文案随实际首数变化。
- **结果与验证**：规则/本地模式左侧有可切换、可删除、持久化的历史对话；默认 20 首、说「5 首」给 5 首、点名歌手可以给更多。`npx tsc --noEmit` 0 错、eslint 改动文件干净、全量 **97 files / 957 tests** 全绿（新增 `tests/ai-assistant-history.test.ts` 11 条、`tests/use-ai-chat-modes.test.tsx` 5→8 条、`tests/ai-assistant-local.test.ts` 17→23 条）。
- **注意**：本地历史与服务端会话是两套存储，切换模式时侧栏内容随之切换（不迁移、不混用）；引擎与服务端解析仍共用 `song_list` 块形状。

---
**U. AI 接口配置改成「供应商列表 → 详情」主从 UI（v1.21 · 2026-10-24）**

**需求（用户 2026-10-24）**

> 把本地模型精选下面 AI 配置的内容换成类似于截图这样的 UI，外面只展示一个列表，点进去进行配置 api 和密钥、模型等等内容。

设置页原来的「接口配置」是一排平铺表单：一套下拉切换当前生效接口、一个明文 API Key 输入框、一个模型字符串。配置两套 API（比如主用 OpenAI 兼容、备用 Anthropic）、给同一个接口存第二把 Key、或者试几个模型时，要么改代码要么互相覆盖；用户希望像主流客户端那样「外面是供应商列表，点进去是详情」。

**弹窗（2026-10-24 追加）**

> 能改为弹窗模式吗，不是这种一个页面展开的。

设置页 `AiSection` 里只留一行「接口配置」入口：说明文字 + 右侧「管理供应商…」按钮；点开才挂载弹窗 `AiProvidersDialog`（`createPortal` 到 `document.body`，`role="dialog"` / `aria-modal` / `aria-labelledby`，`max-w-3xl`、`max-h-[calc(100dvh-2rem)]`，标题「AI 供应商」+ 副标题说明「第一把密钥、第一个模型生效」，点遮罩 / 按 Esc / 点右上角关闭）。弹窗内容就是本节的列表态与详情态，状态与保存逻辑都在 `AiProvidersPanel` 里，关掉弹窗不会丢已保存的配置。

**列表态**

- 每行：拖拽点（视觉保留）/ 图标方块 / 名称（空则地址主机名）/ 缩写地址 / 协议 / `N 个模型` / 掩码 Key / 生效开关 / 箭头。
- 顶部「查找供应商」按名称与地址过滤；右上「添加供应商」直接进空白详情。
- 生效开关直接调 `ai_local_save_config` 换 `activeId`，不要求先进详情。
- 至少保留一个供应商；删最后一个会提示而不是强行删空。

**详情态**

- 基础：名称（占位 `例如 官方 / 中转 / 本机`）、ID（自动生成，只读展示）、Base URL（占位 `https://api.openai.com/v1`）。
- 协议四选一 + 「检测协议」按钮：按 `baseUrl` 试 `/models` 判断是哪种（结果只提示，不阻止保存）。
- 账号 · 密钥（第一把生效）：每把一把掩码行，可删、可「设为使用中」（置顶）；输入框新增 Key，保存时走 `addKeys`；「清空」= 把所有已存 Key 标 `removeKeyIndexes` 且 `apiKey: ""`。
- 图标：8 个内置图标 + 上传图片（data URL）；「清除图标」回退首字母方块。
- 跳过证书校验：内网自签网关用，透传 `skipCertVerify`。
- 模型：`获取列表` 拉 `/models`，chips 多选；「全选 / 全不选 / 仅所选」切视图；第一项是默认模型，文案提示「第一个「X」是默认模型」。
- 底部：移除（新建时禁用）/ 复制（同配置改名）/ 取消 / 保存。

**保存语义**

- 前端把当前列表整体映射成 `AiProfileInput[]`（`id` 为空的项 = 新建，由 Rust 生成 id），连同期望的 `activeId` 一起 `ai_local_save_config`。
- 详情态只改一个供应商时，其它供应商原样回传（不丢 Key：`keys` 不传即保留）。
- Key 的三条增量字段：`addKeys` 追加、`removeKeyIndexes` 按已存下标删除、`activeKeyIndex` 置顶；同时出现「删除」与「置顶」时以前者为准（下标会漂，置顶不生效）。
- 新增供应商保存后如果没被设成生效，会再补一次 `save_config` 把它设为 `activeId`（用户刚配完就是想用它）。

**Rust 侧（`src-tauri/src/ai_local.rs`，885 → ~1630 行）**

- `AiProfile` 增：`protocol`（openai / openai-responses / anthropic / gemini，缺省 openai）、`keys: Vec<String>`（第一把生效，`apiKey` 与 `keys[0]` 双向同步）、`models: Vec<String>`（`model = models[0]`）、`icon`、`skipCertVerify`。
- 协议分派：OpenAI `/chat/completions`（Bearer）、OpenAI Responses `/responses`（`input` / `max_output_tokens` 形状不同）、Anthropic `/v1/messages`（`x-api-key` + `anthropic-version`，`system` 独立字段、`max_tokens` 必填）、Gemini `generateContent`（`x-goog-api-key`、`systemInstruction`、`contents`/`parts`）。
- 端点识别：用户可能填 `https://api.openai.com` 或带 `/v1` 或带完整 `/chat/completions`，统一归一后拼协议路径；`/models` 也做同样归一。
- 查看接口永远不回 Key 明文，只回 `keyMasks` / `keyMask`（`≤4` 字符的 Key 整串打码）。
- `ai_local_test` / `ai_local_list_models` 增加 `protocol` / `skipCertVerify` 可选参数。

**验证**

- `cargo check --all-targets`：0 error 0 warning；`ai_local.rs` 5 条单测过（含 Key 掩码、增量保存、协议别名归一）。
- `tests/settings-ai-providers.test.tsx` 10 条：列表展示 / 搜索 / 行内切生效 / 改名保存形状 / `addKeys` / `removeKeyIndexes` / `activeKeyIndex` / 获取模型点选 / Base URL 为空拦截 / 新增后追加并生效。
- 全量 `npx vitest run`：98 files / 968 tests 全过；`tsc --noEmit` 0 错；eslint 干净。

**注意**

- 「检测协议」只是探测 `/models` 是否可达并猜协议，不保证该 baseUrl 一定支持所选协议的对话接口；真正的握手失败在「测试连接」或下一次对话时才暴露。
- 明文 Key 只在用户当场输入时存在于内存与本机 settings（`ai.profiles`），界面与 `ai_local_config` 都只给掩码。
- 老配置（只有 `baseUrl` + `model` + `apiKey`）自动按 openai 协议、单 Key、单模型读出来，不需要迁移步骤。

---



**V. 所有歌曲列表页加「排序」（v1.22 · 2026-10-24）**

- **需求（用户原话）**：「所有歌曲列表的页面，需要和qt-uniappx一样，增加一个排序的功能，如歌单详情啊等等」。
- **对标**：qt-uniappx 的歌单/榜单/专辑详情页用一个动作面板给 7 个合并选项 —— 默认顺序 / 按歌曲名·正序·倒序 / 按专辑名·正序·倒序 / 按歌手名·正序·倒序；排序只作用于「搜索过滤后的可见列表」，播放全部与批量管理共用同一顺序。
- **实现**：`src/lib/track-sort.ts`（选项表 + `parseTrackSort` + `sortTracks`）与 `src/components/TrackSortSelect.tsx`（一个 `<select>`，`aria-label="排序方式"`）。排序是**纯展示顺序**：不改 `items` 本身，不写缓存；默认「默认顺序」即接口给的顺序（歌单/推荐各有自己的语义，排序只覆盖用户主动选择）。
- **接入页面**：`PlaylistDetailPage`（歌单/榜单/专辑详情）、`AlbumPage`、`ArtistPage`、`DailyRecommendPage`、`HistoryPage`、`LocalMixPage`；每页统一替换「播放全部 / `BatchBar` / `TrackList`」三处，排序发生在 `visibleSongs` / `visibleTracks` / `songs` / `tracks` 之上。
- **不接的页面与原因**：`SearchPage`（分页结果，翻页顺序由接口决定）、`DailyPage`（分页流）、`AudioProgramPage`（无限下拉）、`DownloadsPage`（`TaskRow` 任务列表、不是曲目列表）、`QueuePanel`（队列顺序本身就代表播放顺序）；`LibraryPage` 已有排序 UI，保持不动。
- **验证**：`tests/track-sort.test.ts` 6 条（选项与默认值、解析、默认顺序浅拷贝、歌名正倒序、专辑正倒序互逆、歌手同名内按歌名收敛）；全量 **99 files / 974 tests** 全绿；`tsc --noEmit` 0 错；eslint 干净。

**W. 排序改成两个弹窗 + 每日新歌接入；音乐助手全量开放、服务端 AI 仅管理员（v1.23 · 2026-10-24）**

- **需求（用户原话）**：「音乐助手不再需要管理员权限了，但是服务端 AI 需要管理员权限才展示和允许使用（看后端是否满足控制条件，可以由后端建议，前端隐藏）。每日新歌也要支持排序。排序格式换一下，换成两个弹窗，上面显示按歌曲名、按专辑名、按歌手名，下面显示正序、倒序。默认顺序都不勾选。」本节修订 §V 的控件形态与接入页面，并记录助手侧权限口径。
- **排序控件**：`src/components/TrackSortSelect.tsx` 保留 `{ value, onChange, label? = "排序方式", className? }` 契约，内部改成上下两个 `Popover`（来自 `src/components/common/Popover.tsx`，外层 `role="group"`，弹层 `role="listbox"`、选项 `role="option"` + `aria-selected` + `Check`）：
  - 上「排序字段」按钮（`aria-label="排序字段"`）：按歌曲名 / 按专辑名 / 按歌手名；
  - 下「排序方向」按钮（`aria-label="排序方向"`）：正序 / 倒序，未选字段时 `disabled`（提示「先在上面选排序字段」）；
  - 默认 `value === "none"`：两个按钮显示占位「排序」/「方向」，方向按钮置灰 —— **默认都不勾选**；再点一次已选字段 = 取消排序回 `none`；选方向复用当前字段拼成 `album-desc` 之类。
  - 数据源：`src/lib/track-sort.ts` 新增 `TRACK_SORT_FIELDS`（`{key: "name"|"album"|"singer", label}` 三项）、`TRACK_SORT_DIRECTIONS`（`{value: "asc"|"desc", label, desc}`）、`trackSortValue(key, desc = false): string`（`none` → `"none"`，否则 `${key}-${desc ? "desc" : "asc"}`）；`TRACK_SORT_OPTIONS` / `parseTrackSort` / `sortTracks` 编码不变，6 个既有页面（歌单/专辑/歌手/每日推荐/最近播放/我的混合）零改动。
- **每日新歌**：`src/components/discovery/DailyPage.tsx` 加 `const [sortValue, setSortValue] = useState(DEFAULT_TRACK_SORT)`、`parseTrackSort(sortValue)` 与 `sortedSongs = useMemo(() => sortTracks(songs, sortKey, sortDesc), [songs, sortKey, sortDesc])`；hero 右端从单行 `BatchBar` 改为 `flex shrink-0 flex-col items-end justify-end gap-2 pb-1`，上放 `<TrackSortSelect>`、下放 `<BatchBar embedded tracks={sortedSongs} …/>`（封面仍 `h-36`，高度不出封面）；「播放全部」改成 `playQueue(sortedSongs, 0)`，`TrackList` 的 `tracks` 也换成 `sortedSongs` —— 播放顺序、批量管理范围、列表显示三者一致。`DailyPage` 是分页流（`usePagedList` scroll），排序只作用于已加载的 `songs`，不改分页请求。至此唯一不接排序的页面只剩搜索 / 音频节目 / 下载任务 / 播放队列。
- **助手入口全量开放**：`src/components/layout/Sidebar.tsx` 删掉 `canUseMusicAssistant(profile)` 门禁与 profile 订阅，「助手 → 音乐助手」对全部用户（含未登录）始终渲染；`src/stores/auth.ts` 移除 `MUSIC_ASSISTANT_PERM` / `canUseMusicAssistant`，只留 `hasPermission` / `isAdmin`。与移动端 `isQtAdmin` 同口径：**只有「服务端 AI」是管理员专属**。
- **服务端 AI 仅管理员（三层）**：① 展示层 —— `src/lib/ai-mode.ts` 新增 `resolveAiMode(mode, canUseServer)`（`server` + 非管理员 → `rule`）与 `aiModeOptionsFor(canUseServer)`（非管理员过滤 `server` 项）；设置页 `AiSection` 的 `Segmented` 用 `aiModeOptionsFor(isAdmin(profile))`，库里有 `server` 但非管理员时显示 `rule` 并提示「服务端 AI 仅管理员可用，当前按纯规则运行。」，`pickMode` 再收一次口；同时修掉 `AiSection` 从不回读 `readAiMode()` / `readTaste()` 导致「永远显示纯规则」的旧 bug（读回前显示「载入中…」，带 unmount 守卫）。② 逻辑层 —— `src/hooks/useAiChat.ts` 的 `init()` / `send()` 读到模式后 `resolveAiMode(…, isAdmin(profile))`：非管理员不拉 `astralAiAgents`、不建服务端会话、`send` 走本地回合，`mode` / `modeHint` 显示 `rule`；`profile` 异步恢复后 init 依赖变化自动重跑。③ 执行层 —— `src/lib/ai-server-picks.ts` 的 `askServerForPicks()` 入口先判 `isAdmin(useAuthStore.getState().profile)`，非管理员直接 throw「服务端 AI 仅管理员可用」，不建会话不发消息；`src/lib/daily-recommend.ts` 的 `readMode()` 返回收敛后的**有效模式**、`generateDailyRecommend` 对显式 `options.mode` 再 `resolveAiMode` 一次，`requested` 也记收敛后的 `rule`（否则非管理员每天对不上当日缓存、反复重算），规则分支 notice 写「服务端 AI 仅管理员可用，已按纯规则推荐。」。
- **后端结论**：astral 没有「服务端 AI」专用权限码（`AiPlugin` 只有 `user:ai:music:use` 等；`AiAccessService.requireForClient` 按智能体声明的权限码 + 客户端默认权限校验，超管 `*:*:*` 天然通过），且 `V20261001005__app_user_role_and_permissions.sql` 已给普通 App 用户 `APP_USER` 授予全部 `user:%` 权限 —— 即**普通用户本来就能用音乐助手**，后端无需改动；前端用 `profile.permissions` 里的 `admin:qt:admin` 判管理员，后端仍按智能体权限码独立校验，**前端隐藏不是安全边界**。
- **测试**：`tests/track-sort.test.ts` 6→10 条（弹窗数据源顺序、`trackSortValue` 正反向与 `none`、默认不勾选）；新增 `tests/track-sort-select.test.tsx` 6 条（初值两个占位 + 方向禁用、选字段出 `album-asc`、选方向出 `album-desc`、再点字段回 `none`、受控回填、`listbox` 无障碍）；新增 `tests/daily-page-sort.test.tsx` 3 条（默认保持原顺序、排序后播放全部与批量条一致、排序不改分页参数）；AI 侧 `tests/sidebar-assistant-entry.test.tsx` 重写为「未登录 / 普通用户 / 管理员都展示」、`tests/auth.store.test.ts` 删旧 `canUseMusicAssistant` 用例、`tests/ai-mode.test.ts` 补 `resolveAiMode` / `aiModeOptionsFor`、`tests/use-ai-chat-modes.test.tsx` 补「非管理员存过 server 仍走本地」、`tests/daily-recommend-generate.test.ts` 补「非管理员 server → rule + notice」、`tests/ai-server-picks.test.ts` 补「非管理员 rejects」。
- **验证**：全量 **101 files / 990 tests** 全绿；`pnpm typecheck`（`tsc --noEmit`）0 错；`pnpm lint`（`eslint .`）干净；未改 Rust 与 astral，桌面端实机交互（弹层位置、hero 高度）建议用户跑一次 `pnpm tauri dev` 目视确认。

**X. 账户歌单同步：从「差集收藏」到「全量清单 + 已收藏标记 + 可取消收藏」（v1.24 · 2026-10-27）**

- **需求（用户原话）**：「同步歌单改为返回全部的歌单，如果本地已经收藏了则显示已收藏，同时允许这些取消收藏。」R39 上线时弹窗只列平台侧**缺失**的歌单（`accountSyncPreview` 返回 `{ missing, total }`），用户看不到「已经收藏了哪些」，也无法在同一个入口把本地收藏去掉。本节把入口从「单向补缺」改成「双向对齐」。
- **lib 契约变更（`src/lib/source-playlist-sync.ts`）**：`AccountSyncPreview` 由 `{ missing, total }` 扩为 `{ rows, missing, total }`，新增 `AccountSyncRow { playlist: SourceAccountPlaylist; favorited: boolean }` —— `accountSyncPreview(source)` 先 `Promise.all([accountPlaylists(source), ipc.listMyPlaylists()])`，用「同平台 pid 集合」（`mine.filter(p => p.platform === source).map(p => p.pid)`）逐行标 `favorited`，`rows` 保持平台返回顺序；`missing` 由 `rows` 派生（`!favorited`）继续供登录后自动触发判断，语义不变，所以 `SourceAccountsPage.maybeAutoSync`（missing>0 才弹窗）与 `onDone` 刷新逻辑**零改动**。
- **新增 `uncollectAccountPlaylists(source, picks)`** → `{ removed, skipped, failed }`：逐个 `ipc.isPlaylistFavorited` 预检（**预检失败按「已收藏」继续**，因为 `unfavoritePlaylist` 对不存在项是幂等空操作，宁可多试一次也别因预检抖动静默不动），再 `ipc.unfavoritePlaylist(source, id, name, picUrl)`；顺序执行不并发轰炸，单个失败只计数 + `console.warn` 不中断。**只删本地收藏关系，不碰平台侧**（Rust `cmd_unfavorite_playlist` 只做 `remove_liked_playlist` + `push_like_playlist(..., "remove")`）。
- **弹窗重写（`src/components/mine/SourcePlaylistSyncDialog.tsx`）**：列表数据源从 `missing` 改成 `rows`，**平台侧全部歌单都列**；已收藏的行尾加徽标 `<span className="shrink-0 rounded border border-primary/40 px-1.5 py-0.5 text-[10px] leading-none text-primary">已收藏</span>`。勾选语义统一为「希望它在本地我的歌单里」——加载完成后 `setChecked(new Set(rows.map((_, i) => i)))` **默认全勾**，取消勾选已收藏项即表示要取消收藏。`toCollect` / `toRemove` 由 `useMemo` 从 `rows + checked` 派生：`want && !favorited` 进 `toCollect`、`!want && favorited` 进 `toRemove`。底部按钮由「收藏所选（N）」改为「应用更改（{changeCount}）」（`disabled={busy || changeCount === 0}`，busy 时「同步中…」），点击 `runCollect().then(runRemove)` 先收藏再取消收藏，toast 汇总「已收藏 X 个，已取消收藏 Y 个歌单」（`parts` 为空时「没有变化」），任一侧 `failed > 0` 走 `toastError(…，N 个失败，可稍后重开同步重试)`；全选框文案改「全选（平台侧 {total} 个，已收藏 {favoritedCount} 个）」。说明文案同步改成「拉取该账户在平台侧的全部收藏歌单：勾选 = 收藏到本地「我的歌单」，把「已收藏」的取消勾选即从本地移除（只改本地收藏，不影响平台侧）。」
- **测试**：`tests/source-playlist-sync.test.tsx` 34 条（22 → 34）——preview 组断言 `rows` 全量与 `favorited` 序列（`[true,false,false,false]`）且 `missing` 仍只留未收藏；新增 `uncollectAccountPlaylists` 4 条（参数正确 / 本来没有→skipped / 预检失败按已收藏继续 / 单失败只计 failed）；弹窗组重写 8 条（全部列出 + 「已收藏」徽标 + 「全选（平台侧 2 个，已收藏 1 个）」+ 「应用更改（1）」、勾选缺失→`playCount: "5"`、取消勾选已收藏→`unfavoriteCalls` + toast「已取消收藏 1 个歌单」、同时收藏与取消收藏→toast「已收藏 1 个，已取消收藏 1 个歌单」、全部已收藏全勾→「应用更改（0）」disabled、空态、旧包错误原样展示、failed>0 走 `toastError`）。
- **验证**：全量 **106 files / 1065 tests** 全绿；`tsc --noEmit` 0 错。未改 Rust / qt-sources / 移动端，`unfavoritePlaylist` IPC 与后端行为保持不变。

**Y. 同步歌单「已登录却报未登录」：把开关状态变成可操作提示（v1.24 · 2026-10-27）**

- **问题（用户原话）**：「bili 已经登录了，点击同步歌单报错说未登录」。
- **根因链**：账号页显示「已登录」只看 `SOURCE_AUTH_ACCOUNTS_KEY` 里有没有该源账号（`readSourceAuthAccounts`）；而数据包能不能读平台侧歌单，取决于宿主有没有把凭据灌进数据包 meta 面——`applySourceAuthForSource(source)` 只在 `useMeta === true` 时才 `authSetCredential`。R40 把「登录后同步歌单」开关删掉（默认开启）后，用户完全可以把「数据请求使用登录态」关掉，此时账号还在、登录态注入没了，`accountPlaylists` 必然抛「未登录」。两句真话叠在一起就是误导：账号页说「已登录」，弹窗说「未登录」。
- **不选的方案**：① 同步时临时强制注入凭据、用完再撤——绕过用户显式关闭的开关，且要处理并发/失败回滚，复杂度高；② 把包侧错误文案改写成「请检查数据面开关」——包侧不该知道宿主开关语义，且登录真的失效时文案会再次误导。选「前置检查 + 可操作提示」：错误在宿主侧产生、可识别，UI 能给出一次点击的修复路径。
- **lib（`src/lib/source-playlist-sync.ts`）**：新增
  - `class AccountSyncNeedsMetaLoginError extends Error`（`name = "AccountSyncNeedsMetaLoginError"`、`readonly source: string`）；
  - `isAccountSyncNeedsMetaLoginError(err): err is …`（`instanceof` 判型）；
  - `assertAccountSyncMetaLogin(source)`：`Promise.all([readSourceAuthAccounts(), readSourceAuthTogglesFor(source)])`，`accounts[source] !== undefined && !toggles.useMeta` → 抛错；
  - `accountSyncPreview()` 第一行 `await assertAccountSyncMetaLogin(source)`（在 `accountPlaylists` 之前，**不调数据包**）；
  - `autoSyncMissingAfterLogin()` 包一层 try/catch：该错误 → `return []`（登录成功不弹误导弹窗），其余错误照旧上抛。
- **弹窗（`src/components/mine/SourcePlaylistSyncDialog.tsx`）**：预览从一次性 `useEffect` 改成 `const loadSeq = useRef(0)` + `const load = useCallback(…)`：每次 `load()` 递增序号，应答回来 `seq !== loadSeq.current` 直接丢弃（一键重试与换源都不会被旧应答覆盖）；`catch` 里 `isAccountSyncNeedsMetaLoginError(e) ? setMetaLoginOff(true) : setError(errMsg(e))`。新增 `metaLoginOff` / `enabling` 两个 state 与 `enableMetaAndRetry()`：`setSourceAuthToggle(props.source, "meta", true)` → `props.onMetaLoginEnabled?.(props.source)` → `load()`，失败 `toastError("开启失败：…")`。渲染分支顺序 `loading → metaLoginOff → error → total === 0 → 列表`，面板文案「该账户已登录，但「数据请求使用登录态」是关闭的——读取平台侧歌单需要用它把凭证交给数据请求，关闭时只会报「未登录」。」+ 按钮「开启并使用登录态同步」（enabling 时「开启中…」并禁用）；该态下底部主按钮不渲染、左键文案 `loading || error !== null || metaLoginOff ? "关闭" : "取消"`。
- **页面（`src/components/mine/SourceAccountsPage.tsx`）**：「同步歌单」按钮加 `title`，`tg.useMeta` 时「拉取平台侧全部收藏歌单，与本地「我的歌单」对比」，否则「已登录，但「数据请求使用登录态」未开启：点开后会提示一键开启再同步」；弹窗新增 `onMetaLoginEnabled` 回调 → `readSourceAuthTogglesFor(source)` 后 `setToggles`，卡片开关与弹窗状态立刻一致；数据请求备注改为「搜索/歌单/歌词等数据请求带上该源凭据（如B站登录后才能取AI字幕歌词）。同步歌单也依赖此项，关闭时同步会报「未登录」。」
- **测试**：`tests/source-playlist-sync.test.tsx` 34 → 42 条：新增 helper `seedAccount()` / `seedToggles(source, useMeta, usePlay)`（直接写 `SOURCE_AUTH_ACCOUNTS_KEY` / `SOURCE_AUTH_TOGGLES_KEY`）；lib 组「已登录 + 数据面关 → 抛可识别错误且 `scriptsState.calls` 为空」「数据面开 → 正常拉清单」「无账号时不拦（包侧「未登录」是真的没登录）」；autoSync 组「数据面关 → 静默 `[]`」；弹窗组「面板出现 + 一键开启 → `onMetaLoginEnabled("bili")` + 开关落库 `{useMeta:true,usePlay:false}` + 自动重试渲染歌单」「数据面开 → 不出面板」；页面组「同步按钮 `title` 含「未开启」→ 点开弹窗 → 一键开启 → 关闭后展开卡片，数据面开关 `aria-checked` 变 `"true"`」；弹窗组另有一条「数据面开着但仍回「未登录」→ 错误文案之下补「通常是登录态已失效，请在账号卡上重新登录」」。原「只有启用时才能同步歌单」断言改为新备注文案（弹窗 renderDialog helper 顺带返回 `onMetaLoginEnabled`）。
- **验证**：全量 **106 files / 1073 tests** 全绿、`tsc --noEmit` 0 错、eslint 干净。未改 Rust / qt-sources / 移动端。

---

## 1. 设计目标

### 1.1 核心目标

1. 使用 Tauri 2 构建轻量桌面壳。
2. 使用 React 19 + Tailwind CSS v4 + shadcn/ui 构建现代界面。
3. 将音频播放、扫描、频谱、系统集成交给 Rust 实现。
4. 通过 SQLite 管理歌单、收藏、历史、扫描结果和设置。
5. 支持完整皮肤自定义体系。
6. 支持独立桌面歌词窗口。
7. 通过音源脚本引擎（音源包）支持多音源聚合与后续扩展。
8. 保持 Windows 10/11 下的高性能和稳定性。

### 1.2 架构原则

| 原则 | 说明 |
|---|---|
| 前端轻 | React 只负责界面和交互 |
| Rust 重 | 音频、文件、系统集成、数据层由 Rust 处理 |
| 单向数据流 | Rust 推送状态，前端订阅渲染 |
| 音源抽象 | 所有音乐来源统一走音源脚本引擎的契约接口（`src/source-scripts/qt-contract/contract.ts`），第三方实现以音源包形式按需安装（仓库不内置） |
| 跨音源聚合下沉音源包 | v1.16 定死：凡要同时打多个音源的接口（聚合搜索 / 多关键词搜索 / 合并去重排序 / 最新歌曲 / 榜单 / 热词）**一律在音源包内实现**，宿主一次 invoke 取结果，不允许在前端逐源 fan-out 再本地合并（并发、预算、逐源失败隔离、去重口径都属音源层，各端共用一份）。宿主只做展示、缓存与分页触发。老包缺入口时应提示升级数据包，不得在前端补一套 |
| 主题 token 化 | 所有视觉参数通过 CSS Variables 控制 |
| 数据分层 | 永久数据、缓存数据、内存数据明确分离 |
| 可降级 | 高级视觉效果可关闭，核心播放优先保障 |

---

## 2. 总体架构

## 2.1 架构图

```text
┌────────────────────────────────────────────┐
│              React 主窗口 UI                │
│ 首页 / 搜索 / 歌单 / 榜单 / 新歌 / MV       │
└──────────────────┬─────────────────────────┘
                   │ Tauri invoke / event
┌──────────────────▼─────────────────────────┐
│                 Tauri 2 IPC                 │
└──────────────────┬─────────────────────────┘
┌──────────────────▼─────────────────────────┐
│                 Rust Core                   │
│  ┌──────────────────────────────────────┐  │
│  │              音频引擎                 │  │
│  │  播放 / 暂停 / seek / 队列 / 无缝播放  │  │
│  │  淡入淡出 / EQ / 频谱 / 输出设备       │  │
│  └──────────────────────────────────────┘  │
│  ┌──────────────────────────────────────┐  │
│  │            音源适配层                  │  │
│  │ wyy / qq / kw / kg 四大音源 Rust Provider │  │
│  └──────────────────────────────────────┘  │
│  ┌──────────────────────────────────────┐  │
│  │            Astral 服务层               │  │
│  │  账号 / 收藏同步 / 反馈 / 通知 / 统计    │  │
│  └──────────────────────────────────────┘  │
│  ┌──────────────────────────────────────┐  │
│  │            元数据处理                  │  │
│  │  lofty / 封面 / LRC / 逐字歌词          │  │
│  └──────────────────────────────────────┘  │
│  ┌──────────────────────────────────────┐  │
│  │              数据层                    │  │
│  │  SQLite / 缓存目录 / 设置 / 日志        │  │
│  └──────────────────────────────────────┘  │
│  ┌──────────────────────────────────────┐  │
│  │            系统集成                    │  │
│  │  托盘 / 快捷键 / 媒体键 / 自启动 / 更新 │  │
│  └──────────────────────────────────────┘  │
└────────────────────────────────────────────┘
```

## 2.2 前后端职责划分

| 职责 | 归属 |
|---|---|
| 页面布局和路由 | React |
| 播放控制 UI | React |
| 歌词渲染 | React / 桌面歌词窗口 |
| 主题应用 | React |
| 音频解码播放 | Rust |
| 四大音源 HTTP 请求、请求头、签名和响应归一 | Rust |
| Astral HTTP 请求、satoken 和自动刷新 | Rust |
| 下载队列和离线文件管理 | Rust |
| 播放队列逻辑 | Rust |
| 文件扫描 | Rust |
| 元数据读取 | Rust |
| SQLite 读写 | Rust |
| 桌面歌词窗口管理 | Rust |
| 托盘、快捷键、媒体键 | Rust |
| 更新下载和安装 | Rust + Tauri Updater |
| 频谱计算 | Rust |
| 频谱渲染 | React Canvas |
---

## 2.3 现有接口基线与移植策略

### 2.3.1 扫描结论

| 目录 | 结论 |
|---|---|
| `qt-uniappx` | 已实现四大音源 `wyy / qq / kw / kg` 的搜索、歌单、榜单、新歌、MV、歌词、播放地址、封面补全、换源和音质选择 |
| `qt-uniappx` | 已实现本地歌单、最近播放、下载队列、收藏同步、Astral 账号、反馈、通知、更新和统计 |
| `astral` | 已实现轻听账号、收藏增量同步、签到、反馈、消息、更新、GitHub 加速和匿名统计 |
| `astral` | 不提供音乐内容代理，音乐内容请求仍在客户端音源适配层完成 |

### 2.3.2 PC 架构决策

1. **音乐内容请求全部下沉 Rust**
   - 移动端的 `services/music-api.ts` 不能直接在 React WebView 中复用。
   - PC 需要将四大音源适配逻辑移植为 Rust Provider。
   - Rust 负责 User-Agent、Referer、Cookie、签名、编码、重试、超时和缓存。
   - React 只消费统一后的 JSON 模型。

2. **Astral 服务直接复用**
   - 账号、收藏、反馈、通知、统计继续请求现有 `/api/v1/app/**`。
   - PC 不新建账号体系。
   - 认证继续使用 `satoken` 请求头。
   - 响应继续按 `QtRestResp{code,msg,data}` 和 `Result{code,msg,data}` 解析。

3. **数据模型保持兼容**
   - 前端内部可以使用 `Track / Playlist / Artist / Album`。
   - 与 Astral 收藏接口交互时保留 `platform` 字段名。
   - 源 ID 保持 `wyy / qq / kw / kg`。
   - 收藏游标继续使用 `updatedSeq`。

4. **移动端行为保留**
   - 播放地址 10 分钟失效。
   - 音质支持 `128 / 320 / flac`。
   - 支持手动换源和跨音源替代。
   - 本地歌单与收藏歌单分离。
   - 最近播放与播放次数独立记录。

### 2.3.3 Rust 移植范围

来自 `qt-uniappx/services/music-api.ts` 的能力：

| 分类 | 方法 |
|---|---|
| 发现 | `playlistCategories`、`recommendations`、`latest`、`allLatest` |
| 榜单 | `charts`、`allCharts`、`chartDetail` |
| 搜索 | `search`、`allSearch`、`searchPlaylists`、`searchAlbums` |
| 歌手 | `searchArtists`、`artistSongs` |
| 歌单 | `playlist` |
| 热词 | `hotWords`、`allHotWords` |
| MV | `videos`、`videoUrl` |
| 歌词 | `lyrics`、`lyricTranslation` |
| 播放 | `playUrl`、`invalidatePlayUrl` |
| 封面 | `songCover` |

来自 `qt-uniappx/services/http.ts`、`kw-encode.uts`、`kg-sign.ts` 的能力：

1. 直连音源请求
2. 酷我请求编码
3. 酷狗签名
4. 响应 JSON 归一
5. 请求重试
6. 播放地址缓存

### 2.3.4 Astral HTTP 客户端设计

Rust 侧建立一个独立 `AstralClient`：

```text
AstralClient
 ├─ base_url
 ├─ satoken
 ├─ refresh_queue
 ├─ QtRestResp 解析
 ├─ Result 解析
 ├─ 401 自动刷新
 ├─ 请求重试
 └─ 日志脱敏
```

必须实现：

1. 登录后保存 token。
2. 请求前自动附带 `satoken`。
3. 收到 401 时调用 `/app/user/refresh`。
4. 刷新期间的请求进入等待队列。
5. 刷新失败后清理 token 并广播登出事件。
6. token 和敏感信息不写入日志。

### 2.3.5 接口适配状态

| 项目 | 当前状态 | PC 设计 |
|---|---|---|
| 通知渠道 | 后端已支持 `channel=app/pc/web/all` | 消息接口固定传 `channel=pc` |
| 统计平台 | 后端已支持 `ut=app-android/app-ios/app-windows/app-linux/app-macos/web` | 统计事件按编译目标传 `ut=app-windows` / `app-linux` / `app-macos`（见 `astral.rs` 的 `CLIENT_UT`） |
| 更新平台 | 后端已支持 `type=1101/1102/1103/1104/1105` | 更新和官方版本校验按编译目标传 `type=1103/1104/1105`（见 `app_config.rs` 的 `UPDATE_TYPE`） |
| 反馈平台 | 统一客户端系统头 `X-App-Ut`（三平台取值，同 `ut`） | PC 每个 astral 请求都在 Rust 收口处带 `X-App-Ut`（按 `target_os` 三选一） |
| Astral 不代理音乐内容 | 音乐内容仍在客户端适配层请求 | PC Rust Provider 直连现有音源接口 |
| 当前音源接口为公开接口 | 与现有移动端保持一致 | 第一版仅限个人学习交流，商业发行需替换为官方或授权接口 |
---

## 3. 技术选型

## 3.1 前端

| 技术 | 版本 | 用途 |
|---|---|---|
| React | 19 | UI 框架 |
| TypeScript | 5.x | 类型系统 |
| Tailwind CSS | v4 | 样式系统（CSS-first，`@tailwindcss/vite`） |
| shadcn/ui | 最新 | 基础组件（源码复制，不作为运行时依赖） |
| Radix UI | 最新 | 无障碍交互组件 |
| Zustand | v5 | 全局 UI 状态 |
| TanStack Router | v1 | 路由 |
| TanStack Query | v5 | 异步数据管理 |
| `@tanstack/react-virtual` | v3 | 虚拟列表（§12.3 的实现依赖，原文缺失） |
| `dnd-kit` | 最新 | 歌单 / 队列拖拽排序（§3.5 需求依赖，原文缺失） |
| `tw-animate-css` | 最新 | Tailwind v4 下替代 `tailwindcss-animate` |
| lucide-react | 最新 | 图标 |
| Vitest + Testing Library | 最新 | 前端单测（§20.2 的执行载体） |

前端使用的 Tauri JS 包：`@tauri-apps/api`，以及 `plugin-dialog`、`plugin-opener`、`plugin-os`、`plugin-global-shortcut`、`plugin-updater`、`plugin-window-state`、`plugin-autostart`（按启用的 Rust 插件一一对应）。

## 3.2 Rust

| 技术 | 用途 |
|---|---|
| tauri 2 | 桌面应用框架 |
| rodio | 播放图（Sink / Source / 音量 / seek） |
| cpal | 输出设备枚举与流创建（经 rodio 间接使用） |
| symphonia | 解码（通过 rodio 的 `symphonia-all` feature 启用） |
| lofty | 音频元数据与内嵌封面读取 |
| serde / serde_json | 序列化 |
| reqwest | Astral 与音源 HTTP 请求（`rustls-tls` + `cookies` + `stream`） |
| tokio | 异步任务、并发请求、下载队列 |
| biquad | 均衡器滤波器（rodio 无内置 EQ，原文缺失） |
| rustfft | 频谱分析 |
| ringbuf | 音频线程 → 分析线程的无锁采样传递（原文缺失） |
| souvlaki | Windows SMTC 系统媒体控制（原文只提需求未定实现，缺失） |
| keyring | Windows 凭据管理器读写 satoken（§17.1 依赖，原文缺失） |
| image / palette | 封面缩略图与取色 |
| pinyin | 中文库拼音 / 首字母搜索（§8.6 依赖，原文缺失） |
| rusqlite | SQLite（`bundled` + `functions`；FTS5 需开启 `bundled-full` 或确认编译带 FTS5） |
| notify | 文件夹监听 |
| walkdir | 目录遍历 |
| tracing / tracing-appender | 日志与滚动文件 |
| tauri-plugin-updater | 应用更新（备选实现） |
| tauri-plugin-autostart | 开机自启动 |
| tauri-plugin-global-shortcut | 全局快捷键 |
| tauri-plugin-single-instance | 单实例 |
| tauri-plugin-window-state | 主窗口位置 / 尺寸持久化（替代自研 `window-state.json`） |
| tauri-plugin-dialog / opener / os | 文件选择、打开目录、系统信息 |
| windows | 少量 Win32 调用（光标位置轮询、任务栏缩略图工具栏） |

> 具体依赖版本在项目初始化时以当时最新稳定版为准，锁定精确版本并提交 `Cargo.lock` / `pnpm-lock.yaml`。

## 3.3 依赖能力边界（必须在需求阶段确认）

| 事项 | 结论 |
|---|---|
| 解码格式 | symphonia 覆盖 MP3 / FLAC / WAV / OGG(Vorbis) / AAC(ADTS) / M4A(ALAC、AAC in ISO-MP4)，满足 §3.3 需求全部「必须」项 |
| **不支持**的格式 | APE、WMA、DSF/DFF、TAK。若后续要支持，需外挂解码器或 FFmpeg，属范围外 |
| rodio 的 seek | `try_seek()` 对 MP3/FLAC 可用；MP4/AAC 容器上的精度较差，需要按需重建解码器兜底 |
| rodio 的 EQ / 频谱 | **均无内置能力**，需自行实现 `Source` 包装器（§7.7、§7.8） |
| 输出设备热切换 | cpal 不支持在既有流上换设备，必须重建输出流（§7.9） |
| Windows 构建前置 | 需 Rust MSVC 工具链 + VS Build Tools（C++ 桌面开发）+ WebView2 Runtime（Win11 内置，Win10 需引导安装） |

---

## 4. 窗口设计

## 4.1 主窗口

| 配置项 | 设计 |
|---|---|
| 窗口类型 | 无边框窗口 |
| 默认宽度 | 1200 |
| 默认高度 | 760 |
| 最小宽度 | 980 |
| 最小高度 | 640 |
| 标题栏 | 前端自定义 |
| 窗口控制 | 最小化、最大化、关闭 |
| 位置记忆 | 保存位置和大小 |
| 关闭行为 | 默认最小化到托盘 |
| DPI | 支持系统缩放 |
| 多显示器 | 支持在副屏显示 |

### 窗口状态持久化

使用 `tauri-plugin-window-state` 持久化主窗口位置 / 尺寸 / 最大化状态，不再自研 `settings/window-state.json`（自研方案要额外处理副屏拔出、DPI 变化、坐标越界，插件已覆盖）。

需要额外自管的只有一项：**窗口恢复时校验目标显示器是否仍存在**，不存在则回落到主显示器居中。

### 无边框窗口的代价与对策（原文未评估）

`decorations: false` 会同时失去 Windows 的原生能力，必须显式补齐，否则会被用户当成 Bug：

| 失去的能力 | 对策 |
|---|---|
| 边缘拖拽调整大小 | 四边 + 四角共 8 个 6px 命中区，调用 `window.startResizeDragging(direction)` |
| 标题栏拖动 / 双击最大化 | 拖动区用 `data-tauri-drag-region`；双击事件自行切换 `toggleMaximize()` |
| Win11 Snap Layouts（悬停最大化按钮弹出布局） | 无边框下不可用。方案 A：接受缺失；方案 B：引入 `tauri-plugin-decorum` 保留原生按钮区。**建议 v1 选 A 并在需求中标注** |
| 窗口圆角与投影 | Win11 由 DWM 自动圆角；Win10 需自绘 1px 边框，避免与白色背景融为一体 |
| 最大化时贴边 | 监听最大化状态，最大化时移除窗口圆角与外边距（否则会露出桌面） |

### tauri.conf.json 骨架（关键字段）

```json
{
  "productName": "QuietMusic",
  "identifier": "com.qt.quietmusic",
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "轻听",
        "width": 1200, "height": 760,
        "minWidth": 980, "minHeight": 640,
        "decorations": false,
        "transparent": false,
        "dragDropEnabled": true,
        "visible": false
      }
    ],
    "security": {
      "csp": "default-src 'self'; img-src 'self' asset: http://asset.localhost qtres: data: blob:; media-src 'self' asset: http://asset.localhost qtres: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' ipc: http://ipc.localhost",
      "assetProtocol": { "enable": true, "scope": ["$APPDATA/**", "$APPCACHE/**"] }
    }
  },
  "bundle": {
    "targets": ["nsis"],
    "windows": {
      "nsis": { "installMode": "perUser", "languages": ["SimpChinese"] },
      "webviewInstallMode": { "type": "downloadBootstrapper" }
    }
  }
}
```

说明：

1. `identifier` 决定数据目录实际落点为 `%APPDATA%\com.qt.quietmusic\`，与 §8.1 的 `QuietMusic` 命名需二选一，**建议统一用 identifier**，文档中的 `%APPDATA%/QuietMusic/` 改为示意。
2. `visible: false` + 前端首帧渲染完成后 `show()`，避免白屏闪烁（§18.1 启动优化的必要条件）。
3. `productName` 用 ASCII，避免安装路径与注册表键出现中文；界面标题用中文「轻听」。
4. 网络请求全部在 Rust 侧发起，因此 `connect-src` 不需要放开任何外部域名，这是把 Provider 下沉 Rust 的额外收益。
5. `dragDropEnabled: true` 用于「拖拽音频文件到窗口即播放」（见 REQUIREMENTS §3.21）。

## 4.2 桌面歌词窗口

| 配置项 | 设计 |
|---|---|
| 窗口类型 | 独立 WebviewWindow |
| 背景 | 透明 |
| 置顶 | 开启 |
| 任务栏 | 不显示 |
| 可拖拽 | 是 |
| 鼠标穿透 | 支持锁定 |
| 尺寸 | 默认 900×140 |
| 位置 | 用户可调整并记忆 |

### 桌面歌词窗口配置

```json
{
  "visible": true,
  "locked": true,
  "x": 120,
  "y": 940,
  "width": 900,
  "height": 140,
  "fontSize": 24,
  "fontWeight": 700,
  "opacity": 0.9,
  "backgroundOpacity": 0,
  "stroke": false,
  "shadow": true,
  "gradient": ["#5b8cff", "#b18cff"],
  "lineMode": "two-lines",
  "offset": 0
}
```

### 窗口创建参数（Tauri，运行时创建而非配置文件声明）

桌面歌词窗口不写进 `tauri.conf.json` 的 `windows` 数组，而是在用户首次开启时由 Rust 动态创建，避免冷启动即创建透明置顶窗口拖慢启动。

```rust
WebviewWindowBuilder::new(app, "lyrics", WebviewUrl::App("index.html#/lyrics".into()))
    .title("轻听桌面歌词")
    .inner_size(900.0, 140.0)
    .decorations(false)
    .transparent(true)       // 必须与 decorations(false) 同时使用
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)           // 透明窗口保留阴影会出现灰色矩形
    .resizable(true)
    .focused(false)          // 创建时不抢焦点，避免打断用户输入
    .visible(false)          // 首帧就绪后再 show()
    .build()?;
```

Windows 平台注意事项（原文未覆盖，均为实测坑点）：

1. **`transparent: true` 必须搭配 `decorations: false`**，否则 Windows 下会出现黑色背景块。
2. 透明窗口内**不能**使用 `backdrop-filter` 做毛玻璃，Win 上 WebView2 对透明层的 backdrop 支持不稳定；需要毛玻璃时改用 `window_effects` 的 Acrylic，且此时 `transparent` 需要让位。**桌面歌词默认走全透明 + 文字描边，不用毛玻璃**。
3. `always_on_top` 会被其他应用的全屏独占（游戏、视频全屏）覆盖，这是系统行为，不视为缺陷；可选提供「检测到前台全屏时自动隐藏」开关（P3）。
4. 多显示器下 `x/y` 是虚拟桌面坐标，可能为负值；恢复位置前必须校验落点仍在某个显示器可见区域内。
5. DPI 变化（跨屏拖动）时窗口尺寸按逻辑像素保持，字体不需要额外缩放。
6. 歌词窗口的 capability 单独授权，只允许订阅歌词与播放位置事件（§17.4）。

## 4.3 迷你播放器窗口

作为后续扩展形态，本期仅保留设计空间。

| 能力 | 说明 |
|---|---|
| 小窗口 | 只显示封面、歌名、基础控制 |
| 可拖拽 | 支持拖动 |
| 可切换 | 主窗口与迷你模式互切 |
| 队列 | 提供简化队列入口 |

---

## 5. 页面与交互设计

## 5.1 全局布局

```text
┌──────────────────────────────────────────────────────┐
│ 标题栏：Logo / 音源切换 / 搜索 / 窗口控制              │
├───────────────┬──────────────────────────────────────┤
│               │                                      │
│   侧边栏       │               内容区                 │
│               │                                      │
│  首页          │ 搜索 / 歌单 / 榜单 / 新歌 / MV      │
│  全部音源      │
│  网易云 / QQ   │
│  酷我 / 酷狗   │
│  本地音乐      │
│  歌单          │                                      │
│  收藏          │                                      │
│  最近播放      │                                      │
│  设置          │                                      │
│               │                                      │
├───────────────┴──────────────────────────────────────┤
│ 播放条：歌曲信息 / 控制 / 进度 / 音量 / 队列 / 歌词     │
└──────────────────────────────────────────────────────┘
```

## 5.2 路由设计

原文路由表缺失 §19.1 已声明的 `charts / daily / artist / mv / downloads / messages / feedback / profile / stats` 等 feature，此处补全。除歌词窗口外全部挂在主窗口 `AppShell` 下。

| 路由 | 页面 | 说明 |
|---|---|---|
| `/` | 首页 | Hero（当前音源 + 每日新歌/歌单广场/热门榜单/本地音乐快捷入口）、榜单精选（列数按内容区实测宽度自适应，2~5 列 × 2 排；卡片与 `/charts` 共用）、新歌速递、推荐歌单（后两者同为一行横向滚动卡片，条数一致）、**为你整理**（本机收听记录生成的固定五类合辑，详见 §5.2「为你整理」） |
| `/daily` | 每日新歌 | 当前音源的**最新歌曲流**（`get_latest_songs`，滚到底自动续页，`LATEST_PAGE_SIZE` = 50）。与「每日推荐」是两个功能，入口相邻但分开：这里跟"你"没关系，谁发新歌就有什么 |
| `/daily-recommend` | 每日推荐 | 按**本机播放历史 + 收藏**挑的跨源推荐（`@/lib/daily-recommend`），跨天变化、屏蔽生效、可本地模型精选，详见 §5.2「每日推荐」。**与 `/daily` 不是一回事**：原文把这行写成「对齐移动端 `pages/daily`」，实际移动端 `pages/daily` 就是最新歌曲流，对应的是本表的 `/daily` 行 |
| `| `/search?q=&type=&scope=` | 搜索页 | **`q` 为空时的落地页 = 搜索首页**：搜索历史 + 热门搜索（不放热门歌单），输入框自动聚焦，页签栏不渲染（见 §0.3-M）；有 `q` 时才是结果视图：歌曲 / 歌单 / 歌手 / 专辑 分页签，`scope=current\|all`。`all`（聚合）**只查**「设置 → 音源包 → 聚合搜索音源」里勾选的源（未勾选的不发请求，见 §0.3-I），结果由数据包 `searchMerged` 合并去重成**一条**按相关性排序的列表、**不按源分组**（行尾只有源标），分页收尾用包回的 `full`（见 §0.3-J）；歌曲页签右端有「播放全部」（已加载的整批 `playQueue` 起播）；`current` 不受该设置影响 |
| `/playlists` | 歌单广场 | 分类 + 分页推荐歌单 |
| `/playlist/:platform/:id` | 歌单详情 | **必须带 platform**，否则跨音源同 ID 会撞车（原文缺失） |
| `/charts` | 排行榜列表 | 跟随当前音源（不做全源聚合）；**与首页「榜单精选」共用同一套卡片版式** —— `ChartSpotlightCard`（左封面 + 右前三首）配 `useSpotlightColumns` 按内容区实测宽度取 2~5 列，区别只是这里铺当前音源的全部榜单、不限排数。曲目**按可视区懒加载**（`IntersectionObserver`，前留 240px）：chartDetail 契约没有 limit、一次就是整榜（包内最多 200 条），二十几张卡照首页那样全量并发会在进页瞬间甩出二十几个整榜请求。详情缓存 `@/lib/chart-detail` 与首页共用，从首页「全部榜单」进来不必重拉 |
| `/chart/:platform/:id` | 榜单详情 | 榜单歌曲（与 `/playlist/:platform/:id` **共用同一页面组件**，`kind="chart"` 分叉取数：getCharts 找名字与配图 → getChartDetail 取曲目；无歌单级收藏红心，曲目行带名次） |
| `/artist/:platform/:id` | 歌手页 | 歌手歌曲（进页一次拉完全部，不分页滚动）；页头与歌单 / 榜单详情页同构 hero（方形封面 + 模糊铺底 + 右端批量条），批量收藏 / 下载与详情页同位置 |
| `/album/:platform/:id` | 专辑页 | 专辑曲目（按专辑名搜索并过滤，滚动续页）；页头与歌手 / 歌单详情页同构 hero（方形封面 + 模糊铺底 + 右端批量条），批量收藏 / 下载与详情页同位置 |
| `/library` | 本地音乐 | 本地歌曲列表 |
| `/library/folders` | 文件夹视图 | 按目录查看 |
| `/my/playlists` | 我的歌单 | 本地歌单管理（原「收藏」已并入本页）；「导入」用 `ClipboardPaste` 而非 `Import`（后者 16px 下与「下载」同形），两组行尾的移除入口都用**实心红心**（与详情页「恒为已收藏态」红心同观感）；本地歌单是删除、走二次确认，在线歌单是「取消收藏」、不动歌、一次点击 |
| `/my/playlist/:id` | 本地歌单详情 | 本地歌单曲目（与 `/playlist/:platform/:id` **共用同一页面组件**，platform 传 `local` 分叉；曲目行只有「收藏」红心，取消勾选当前歌单即从本歌单移除；页头红心恒为已收藏态，点它 = 二次确认后删除歌单并回本页） |
| `/history` | 播放历史 | 最近播放与完整历史 |
| `/downloads` | 下载管理 | 下载队列与已完成；全选 + 批量暂停 / 继续 / 取消 / 删除，工具栏全部暂停 / 全部继续 / 清理已完成（批量口径见 §13.4）。**已完成的条目本身就是一首本地曲目**：点标题或行内「播放」按钮直接播磁盘文件（`DownloadTask.filePath` 转成 `platform: "local"` 的 Track，id 即绝对路径，Rust 引擎走 `PlaySource::Local`，不联网取址），行内另有「加入播放队列」，工具栏有「播放全部已完成」；未完成 / 无 `filePath` 的行不提供播放入口 |
| `/playing` | 播放页 | 大封面、滚动歌词、频谱、队列预览 |
| `/mix/:key` | 合辑详情 | 「为你整理」某类合辑的完整曲目（`key` 来自 `list_local_mixes` 的返回）；取不到该 key 直接报错，不回落成空列表 |
| `/stats` | 听歌报告 | 本地播放统计（对齐移动端 `pages/stats`，原文缺失）；概览保留累计时长、有效播放、听过歌曲、**活跃天数**、常听歌手、最近播放和完播率；支持完整歌曲 / 歌手 / 音源明细，按播放次数或实际收听时长排序，分页查看，歌手与音源可下钻到其歌曲，歌曲可播放；**听歌趋势**按「今天 / 近 7 天 / 近 30 天」×「歌曲 / 歌手 / 音源」给逐日柱状趋势、窗口总量（次数 / 时长 / 活跃天数 / 曲目数）与 Top 10，点某一行或「查看全部」按同一窗口下钻明细（`get_listen_report` 带 `days`，分组与排序口径与日榜同源）；**常听歌手显示真实头像、音源分布显示官方 logo**（`public/static/source/*.png`，与移动端 `static/source/` 同一套文件；头像经音源包 `artistSongs` → `searchArtists` 现取，走 qtres 代理加载，取不到回退名字首字并缓存空结果）；读库失败提供重试；首次打开会把升级前只有累计值、没有按天明细的存量播放统一计入当天（`seed_listen_days`，只补差额、可重复调用），设置页可「清除听歌统计」（`clear_listen_stats`，不可撤销、两击确认）。周报、月报暂缓（2026-10） |
| `/feedback` | 意见反馈 | 提交、我的、公开反馈 |
| `/profile` | 个人中心 | 资料、签到、退出登录 |
| `/login` | 登录 / 注册 | 含邮箱验证码、忘记密码（`changePass`） |
| `/settings/:section` | 设置 | `general \| appearance \| desktop-lyric \| playback \| player-bar \| sound \| download \| network \| ai \| dislike \| source-package \| shortcut \| about`（标签顺序即 `SECTION_TITLES` 的键顺序，`general` 在最前）。`ai` 分节只管「模型接口怎么连」（`ai.profiles` 多档地址 + `ai.activeProfile`），不绑定某个功能：眼下给「每日推荐」用，后续接别的 AI 能力不再加分区；`network` 对应 §3.21.6 的代理与超时 |
| `/onboarding` | 首次启动引导 | 对齐 REQUIREMENTS §5.1，原文缺失 |
| `/lyrics` | 桌面歌词 | **仅供歌词窗口加载**，不在主窗口导航中出现 |

路由约定：

1. 所有涉及音源内容的详情页路由都携带 `platform`，与 §6.6 数据模型的 `platform` 字段一一对应。
2. 搜索关键字走 URL query，保证前进 / 后退可复现结果。
3. `/playing` 与 `/lyrics` 共用歌词渲染组件，但状态来源不同（见 §10.2）。
4. 设置页的标签顺序由 `SettingsPage.tsx` 的 `SECTION_TITLES` 键顺序决定，`general` 在首位；标题栏设置入口固定跳 `general`。各分节内容用 `max-w-4xl`（896px）而非旧的 `max-w-xl`（576px）：1200px 默认窗口下内容区可用约 930px，576px 会只占左半屏、右侧大片留白。
5. 歌单详情 / 榜单详情 / 每日新歌 / 歌手页 / 专辑页共用 `BatchBar`（全选 + 批量下载 + 批量收藏），**位置在页头右侧**：歌单 / 榜单 / 歌手 / 专辑的 hero 里与「播放全部」同一行（hero 底部、右端对齐），每日新歌里与标题行末端的「播放全部」并排；页面传 `embedded` 接管外框，列表上方不再单独占一行。批量下载并发上限 3（放开会被音源 / CDN 当爬虫，同设置页 `downloadConcurrency` 的口径），本地曲目跳过。批量收藏与单曲红心**同一套逻辑**：点开是本地歌单清单，整批已在该歌单里 → 这一下是批量取消收藏（`remove_tracks_from_playlist`）；否则是批量收藏，**已在里面的自动跳过、只加缺的那些**（`add_tracks_to_playlist`，后端 `ON CONFLICT DO NOTHING` 返回真实新增数）。没有独立的「批量取消收藏」按钮，也没有批量「整首取消（跨所有歌单连坐）」入口，那交给单曲红心。条上的红心与单曲红心同观感：整批都已收藏（`is_liked_song` 口径，挂在任一歌单下即算）就实心高亮 —— 勾了歌看勾上的这批，一首没勾看整张列表（所以本地歌单进去天生实心）。动作回执（「已收藏 N 首到「歌单名」」）**不写在条子里**：文案长短会把页头那排控件推来推去（用户 m09470），统一走全局右上角轻提示 `stores/toast` + `common/ToastHost`（挂 `AppShell`，3 秒自动淡出、整层 `pointer-events-none`），对布局零影响。

### 为你整理

首页的本机区块：**只用本机收听记录和收藏**生成固定五类合辑，与在线音源无关，切换音源不影响它。取数是 `list_local_mixes`（Rust `recommend.rs` 的 `build_mixes`），点卡片进 `/mix/:key` 看完整曲目。

| key | 标题 | 出场条件（每类都要 ≥ `MIN_TRACKS` = 5 首） |
|---|---|---|
| `recent` | 最近在听 | 最后一次播放（`play_stats.last_played_at`）落在最近 14 天内（`RECENT_WINDOW_MS`） |
| `most_played` | 循环最多的歌 | 全历史播放次数 ≥ 2（`MOST_PLAYED_MIN_PLAYS`） |
| `favorite_picks` | 收藏里的常客 | `liked_songs`（`deleted_at IS NULL`）× `play_stats`（`play_count ≥ 1`）的交集；从没播过的收藏不进榜，已删除的收藏不算 |
| `late_night` | 深夜歌单 | 最后一次播放（`play_stats.last_played_at`）落在本地 22:00–次日 06:00（`NIGHT_START_HOUR` / `NIGHT_END_HOUR`），与当前钟点无关 |
| `nostalgic` | 久未重温 | 听过 ≥ 3 次（`UNHEARD_MIN_PLAYS`）且 30 天没再碰（`UNHEARD_WINDOW_MS`），最久没听的排最前 |

- **五类统一读累计表 `play_stats`**，外加一张 `liked_songs`，没有一路读 `play_history`。这不是随手选的：`play_history` 一首歌只留最近一条、时间戳与 `play_stats.last_played_at` 本是同一个，但它只留 20 来行而统计表覆盖全部有效播放的曲目，精度天然更差；更重要的是「清除听歌统计」现在连它一起清，两边同源同命，不会出现「清完统计首页还在推荐歌」。
- **整区的出场门槛是「五类中至少 2 类」，不是五类全齐**（`LocalMixSection.tsx` 的 `MIN_SHOWN_MIXES`）。五类各有各的门槛：新用户还没在深夜听过歌、旧歌没攒够 30 天、收藏还没归进现存歌单；硬凑五类会让这一区长期消失，攒了半年的记录也换不来一张卡。反过来只出一类又像数据坏了，所以折中取 2 —— 凑够两类就展示，凑不满整区不渲染，不摆半成品区域。
- 单类不足 5 首时该类不生成（`finish_mix` 返回 `None`），但**不影响其余类照常出场**。
- 每类最多取 `MAX_TRACKS` = 20 首；卡片封面取前 3 张非空图。
- 移动端同规则的实现是 `qt-uniappx/services/local-mixes.ts`（`MIN_SONGS` / `finish()` / `shouldShowLocalMixes`），两端门槛与条件必须保持一致。移动端五类**全部**只读听歌统计存档，而它的「清除听歌统计」会把整份存档清空，所以移动端天然同源、不会出现本节记的 PC 那个不一致。差异一处：移动端「收藏里的常客」还要求收藏带 `pids` 且该歌单仍在现存本地歌单里，避免已删除的歌单把收藏「复活」。

### 每日推荐

实现 `src/lib/daily-recommend.ts`（流程与缓存，纯逻辑可单测）+ `src/lib/music-style.ts`（风格画像）+ `src/lib/recommend-rank.ts`（打分与多样性）+ `src/components/discovery/DailyRecommendPage.tsx`（渲染）。**它和「每日新歌」（`/daily`）不是一回事**：那个是音源的最新歌曲流，跟用户没关系；这个是从**本机播放历史 + 收藏**里推，跨源、跨天变化、屏蔽生效。

**排序口径是「风格」而不是「歌手」**（v1.6 起）：音源契约没有 genre 字段（见 §0.3-F），风格由语种、时长带、专辑、歌单名、真实收听质量这些本地可算的信号推导成一份**口味画像**，再按画像给候选打多维分 —— 单曲的歌手只是其中一个维度，`explore` 口味下甚至是负分项。**没有播放记录也没有收藏时也不再是空页面**（v1.7 起）：页头让用户点 2–4 个平台风格分类当初始画像种子，不选也能看一批兜底内容 —— 见 §0.3-G 与下面「冷启动」小节。

#### 三种推荐方式（`dailyRecommend.mode`）

| 值 | 名称 | 做法 | 依赖 |
| --- | --- | --- | --- |
| `rule` | 规则推荐 | 本地算，无网络请求 | 无 |
| `local` | 本地模型 | 规则先出候选池 → 交本地模型（`ai_local`）挑序号 → 结果按歌手打散 | 设置页「AI」分节配好的接口 |
| `server` | 服务端 AI | 走 Astral 音乐助手 | 已登录 |

`local` 是默认值。**三种方式都只有「规则 + AI 排序」两层，AI 永远只做挑选和排序，不负责生成歌曲** —— 歌名 / 歌手 / 封面全部来自音源真实返回值，模型只回一串候选序号（`{"picks":[1,5,3,…]}`）。这样模型胡说八道最多是"挑得不好"，不会推出一首不存在的歌。

模型挑得不够（少于 `DAILY_AI_MIN_PICKS` = 3 首）或整段回执解析失败时，**不报错、退回规则推荐**，并在结果里带一条 `notice`（页面用全局 toast 弹出，不占页面布局），文案形如「本地模型调用失败（原因），已退回规则推荐。」。

#### 三种口味（`dailyRecommend.taste`）

| 值 | 名称 | 单歌手上限 | 候选池侧重 | 排序侧重 |
| --- | --- | --- | --- | --- |
| `heart` | 心头好 | 3 | 收藏（⓪）+ 同专辑兄弟（④）+ 风格歌单（⑤） | 收藏 / 同专辑 / 主语种重奖，常听歌手 +8，新歌手 +3 |
| `familiar` | 老熟人 | 5 | 只加同专辑兄弟（④） | 常听歌手权重最高（+10），新歌手只 +1 |
| `explore` | 换换口味 | 1 | 风格歌单（⑤，故意挑画像**不**匹配的分类）+ 最新流（③） | 常听歌手倒扣（−4），新歌手 +9，全新语种 +6 |

**三种口味都会把同一歌手的歌摊开**，只是摊开的力度不同（单歌手上限 3 / 5 / 1）。没有"不摊开"的档位 —— 一屏 50 首里连着五首同一个人的歌，用户第一反应是"这功能坏了"。摊开由两层保证：MMR 选择时相似度就惩罚同歌手/同专辑，配额是硬上限，最后还有一遍相邻打散。

#### 风格画像与打分引擎（v1.6）

**为什么不直接读风格标签**：音源契约 `MusicInfo`（`src/source-scripts/qt-contract/contract.ts`）与本地 `Track`（`src/types/index.ts`）都**没有** genre / 年代 / 语种字段，音源包也不下发。所以画像全部从本地事实推导，只用五个信号源：

| 信号 | 来源 | 作用 |
| --- | --- | --- |
| 语种 | 标题 / 歌手 / 专辑的字符集（假名 > 谚文 > 汉字 > 拉丁，都没有给 `und`） | 主语种 / 次要语种 / 全新语种 |
| 时长带 | `duration`：`short` < 150s、`normal` 150–240s、`long` 240–330s、`epic` ≥ 330s | 判断口味节奏是否接近 |
| 专辑 | `歌手键\|专辑名` | 同专辑直接重奖（专辑是最强的风格代理） |
| 歌单名 | 用户自己建的歌单名 | 唯一的人工风格自述，抽风格词做画像标签 |
| 收听质量 | `play_stats` 的 `play_count` / `total_played_ms` / `last_played_at` | 算完播比 / 复听率 / 新鲜度 → `affinity`；`skipped` 扣分 |

画像 `StyleProfile`（`buildStyleProfile`）：`langs` / `bands` 是 Σ=1 的分布，`singers` / `albums` 是最大值归一化的相对权重，`mainLang` / `mainBand` 是主导项（主语种份额 < 0.34 时 `mainLang` 给 `und`，**不硬下结论**），`tags` 是歌单名抽出的风格词，`sampleSize` 是样本数。页面摘要下方有一行「口味画像：…」，让用户知道系统从哪几个维度判断 —— 推荐理由不透明时，用户只会觉得"又在瞎推"。

行为质量里最关键的是**完播比**：`completion = totalPlayedMs / (playCount × 时长)`。旧实现只用播放次数排行，导致「点开听 20 秒就切」和「一遍遍听完」同分；现在 `affinity = 0.5×完播 + 0.3×复听 + 0.2×新鲜度`，播放 3 次以上但完播比 < 0.4 的标 `skipped` 额外 −8。**没有改 Rust**：`total_played_ms` 本来就在 `play_stats` 里，从 IPC 回来就能算，不必新增 `finished_count`。

打分（`scoreCandidates`）按口味查权重表：

| 特征 | heart | familiar | explore |
| --- | --- | --- | --- |
| 已收藏（本身在收藏 / 歌单里） | +9 | +5 | +2 |
| 同专辑（画像里有权重的） | +10 × 权重 | +6 × 权重 | +3 × 权重 |
| 主语种 | +7 | +6 | +4 |
| 次要语种 | +2 | +2 | +2 |
| 全新语种 | −5 | −4 | **+6** |
| 主导时长带 | +2 | +2 | +1 |
| 常听歌手 | +8 × 歌手权重 | +10 × 歌手权重 | **−4 × 歌手权重** |
| 新歌手 | +3 | +1 | **+9** |
| 没听过 | +4 | +2 | +6 |
| 行为质量 | +4 × affinity | 同左 | 同左 |
| `skipped` | −8 | −8 | −8 |
| 近 7 天推过 | −20（降权，不排除） | 同左 | 同左 |
| 抖动 | 至多 1.5（按日期 + 曲目键哈希） | 同左 | 同左 |

「常听歌手」的权重来自两处合并：画像 `singers`（加权结果，样本太少的歌手会被丢掉）与歌手榜 + 最近播放（`familiarSingers`，覆盖全部历史但粒度粗）—— 后者**只算一半分量**（`FAMILIAR_SINGER_FALLBACK` = 0.5）。这样「只听了 3 次的老熟人」不会被当成新歌手，也不会因为榜单粒度粗就拿到满权重。

多样性选择（`selectDiverse`）用 MMR：每步取 `score − λ × 与已选各项的最大相似度`，相似度 = 同歌手 0.4 / 同专辑 0.2 / 同语种 0.25 / 同时长带 0.15，λ 缺省 heart 0.6 / familiar 0.4 / explore 0.9。硬配额：同歌手 3 / 5 / 1，同语种 `max(2, ⌈target × 0.6⌉)`（`und` 不计、0 = 不限）。

**配额放宽分两阶段，先语种后歌手**。池子全是华语时（华语库很常见），语种上限会先把结果卡住；旧写法这时连歌手配额一起放宽，"同一个歌手霸屏"就复现了 —— 实测 5 首周杰伦 + 4 首其他的池子、target 6，旧逻辑选出 4 首周杰伦（上限 3，且尾部两首相邻）。现在先把语种上限 ×2 逐级放到底，仍然不够才动歌手配额；`explore` 两级都不放宽，池子不够就少推，诚实于口味。

打散（`spreadAdjacentSinger`）保留：只调顺序不增删，**第一首钉住** —— 它是 MMR 的最高分，也是用户打开页面第一眼看到的那首。

**推荐理由按事实分级**（`reasonFor`，规则链路与模型链路共用同一个函数）：

| 命中 | 文案 | 口径 |
| --- | --- | --- |
| 已收藏 | 你收藏里的歌 | 收藏是用户自己按的按钮，最硬 |
| 同专辑 | 同专辑《…》 / 和你常听的专辑相近 | 专辑是风格代理 |
| 常听歌手（有播放证据） | 你常听 X | 播放记录或歌手榜里有这个人 |
| 只收藏过这个歌手 | 和你的收藏口味相近 | **收藏 ≠ 听过**，说成"常听"就是编故事 |
| 新歌手 + 主语种 | 新歌手，和你的华语口味接近 | 语种名取 `MUSIC_LANG_LABEL` |
| 主语种 | 符合你常听的华语 | |
| 没听过 | 你没听过，换个口味试试 | 查得到"没听过"这个事实才这么说 |
| 兜底 | 换一批看看 | 什么事实都没有，不编造 |

#### 生成流程

1. **读偏好**（`loadPreference()`）：七路并发 —— `getTopSingers(12)` / `getTopTracks(200)`（`play_stats` 排行，带 `playCount` / `totalPlayedMs` / `lastPlayedAt`）/ `listHistory(50)` / `listFavorites` / `listDislikes` / `loadPlaylistTracks()`（同时返回歌单名 —— 画像是靠它拿"用户自己说的风格"）/ `readStyleSeeds()`（用户手选的风格种子）。歌手串按 `[/、,，&＆;；]+` 拆开入种子，上限 `SEED_SINGER_MAX` = 8；最近播放取 `RECENT_SEED_MAX` = 12 首。随后 `trackQuality` 把收听统计折成完播 / 复听 / 新鲜度，`buildStyleProfile` 出画像 —— 它的 `playlistNames` 入参是「歌单名 + 风格种子」两串拼起来的，种子因此直接进 `tags`。
2. **建候选池**（`buildCandidatePool()`）：按口味裁剪后并发，按 `trackKey` 去重 ——
   - ⓪ 收藏（仅 `heart`）：收藏曲目 + 最近 6 个歌单里的曲目（每单取前 `PLAYLIST_TRACKS_MAX` = 80）；
   - ① `getArtistSongs`：每个种子歌手在当前音源取 `SONGS_PER_SINGER` = 20 首；
   - ② `searchManyBatches`（数据包 `searchMany` 入口，见 §0.3-H）：种子歌手跨源搜索，每歌手 `CROSS_SOURCE_PER_SINGER` = 20 首；按 `SEARCH_CONCURRENCY` = 3 个歌手一块调用 —— 并发、单源超时与逐词失败隔离由数据包做，块间串行，单块失败只影响这一块；装在旧数据包上时自动退回 app 侧扇出；
   - ③ `getAllLatestSongs`（仅 `explore`；冷启动也走）：当前音源最新流前 120 首；
   - ④ **同专辑兄弟**（`heart` / `familiar`）：从收藏 + 歌单 + 最近播放里收集最多 `ALBUM_SEED_MAX` = 4 张专辑，`searchAlbums` 按「歌手 专辑」找到那张 → `getAlbumDetail` → 每张取前 `ALBUM_TRACKS_MAX` = 30 首。专辑是最强的风格代理，同一张专辑的歌几乎必然同风格；
   - ⑤ **风格歌单**（`heart` / `explore`；冷启动也走）：`getPlaylistCategories` 拿平台分类（华语 / 摇滚 / 民谣 …）→ `pickStyleCategories` 挑 `STYLE_CATEGORY_MAX` = 2 个（`heart` 挑与画像匹配的；**`explore` 挑不匹配的**，那才是真换口味）→ `getRecommendations` → `STYLE_PLAYLIST_MAX` = 2 张歌单 → `getPlaylistDetail` → 每单前 `STYLE_PLAYLIST_TRACKS_MAX` = 40 首。
3. **过滤与降权**：`listDislikes` 里的直接排除（引擎的 `disliked` 布尔数组，硬排除）；近 `DAILY_HISTORY_DAYS` = 7 天推荐过的降权 20 分而**不是硬排除**（降权由引擎做，见权重表的「近 7 天推过」行）—— 每天 50 首 × 7 天 = 350 首，硬排除会把候选池掏空，最后变成"今天没歌可推"。
4. **排序**（`rankCandidates()`）：`scoreCandidates` 按画像 + 口味打多维分 → `selectDiverse` 做 MMR 与两阶段配额放宽（详见上「风格画像与打分引擎」）→ 有 `variant` 时轮转队首歌手（同一天多次点"换一批"不会每次都是同一批开头）。凑不满 50 首时逐级放宽配额，`explore` 不放宽：池子不够就少推。
5. **本地模型精选**（仅 `local`）：规则排序按 `target = max(DAILY_TARGET, DAILY_AI_POOL_MAX)` 排出 **150** 首，再由 `pickAiPool` 定池（前 `DAILY_AI_CORE` = 90 首必进，剩余 60 个名额从尾巴按 `variant` 轮转取样），`pickCount = min(DAILY_TARGET, 池大小)` = 50。提示词（v1.15 重写，见 §0.3-O）给模型的是**能对账的东西**，不是「发挥空间」：① 每首候选 `序号. 歌名 - 歌手（专辑 / 语种 / 时长带；已收藏·听过N次·常听歌手·常听专辑·非主语种）`，证据最多 3 条；② 口味画像一句话 + 风格标签 + 主时长带 + 常听歌手 + 最近在听；③ 主语种定得下来时给硬下限「50 首里请至少有 40 首是华语」（explore 换成「别整张歌单都跳到别的语种去」）；④ 规则 ①②③④⑤⑥ 开头：越靠前越贴合 → 不要为「看起来不一样」塞无关歌 → 整张歌单一个主题 → 同歌手 ≤3 / 勿重复 → 从第 51–90 首里换进 6–10 首（有证据的）、顺序按「开场 → 沉浸 → 收束」自己排 → 理由落到画像。**不再要求「别照抄前 N 首」「尽量分散风格」** —— 那两句是「像随机选」的源头；但也不许整份照抄（那就退化成纯规则），所以给中段穿插这道口子、由 app 侧 `limitAiPicks` 封顶 12 首。温度 `AI_PICK_TEMPERATURE` = **0.4**，重试 `AI_PICK_RETRY_TEMPERATURE` = **0.2**。模型回执经 `parsePicks` 三级容错（原样 → `repairJsonText` → `salvagePicks`/`extractJsonArray`）后仍做硬校验（序号必须是 `1..poolSize` 的整数、不能重复、越界/重复/布尔值直接丢），解析失败追加一条纠正消息重试一次；解析出的条目先过 `limitAiPicks`（中段最多 `DAILY_AI_OFF_CORE_MAX` = 12 首、每首需有画像依据）与 `filterAiPicks`（非 explore 且画像已成形时剔掉「本地零证据且非主语种」的歌，被剔的记进 `used` 不补回），再 `spreadItemsBySinger` 打散，模型只挑了几首就用 `rulePicked` 顺序补齐到 50，多给了则截断到 50；结果带 `model` 字段显示在页头。
**v1.16 增补（候选池扩维 + 风格线配额，见 §0.3-P）**：喂给模型的池子不再只有「种子歌手 + 收藏/歌单 + 风格分类」这几条路。

- **取数**：`buildCandidatePoolWithLanes()` 并行跑原 6 路与维度层 `collectDimensionLanes()`（榜单 / 关键词跨源搜索 / 风格歌单，关键词来源含用户搜索历史；`local` 源直接跳过维度层、异常吞掉退化为空），按 `trackKey` 去重，返回 `{ tracks, laneOf, affinityLanes }`；`laneOf` 是每首候选的「风格线」provenance（`trackKey → string[]`，第一条是主线）。
- **排序**：规则排序（`rankCandidates`，`target = max(50,150)`）之后先 `diversifyByLanes(ranked, laneOf, target)` 按「七成贴合底盘 + 三成风格线」补位（最多 `LANE_DIVERSITY_MAX` = 5 条线、每条线份额 `LANE_QUOTA_SHARE` = 30%），再 `interleaveByLanes()` 按线交织排展示顺序（权重 4/2/2/1；未标线的歌补成 `CORE_LANE = "常规"`，避免被当成 `__` 兜底线沉底）；没有风格线时两个函数都退化为原顺序。
- **提示词**：候选行括号最前面加 `风格线：古风`；画像段加「画像里的语种分布：华语 82%、日语 8%」；心 / 熟口味第 ② 条变成「这张歌单要覆盖 3–5 条不同的「风格线」（候选里一共 N 条：…）：「古风」占一半左右，再挑 2–4 条相邻的线各 4–10 首」（候选线 ≤3 条时按实际条数说，避免指向不存在的线）；explore 要求其中至少 2 条平时不常听、每条线 ≥3 首；title / summary 要求写出多风格结构。
- **闸门放宽**：`LANG_AFFINITY_MIN` = 5% —— 画像里出现过的次要语种不再被标「非主语种」；`filterAiPicks(items, pref, taste, { laneOf, affinityLanes })` 与 `limitAiPicks(..., lanes)` 对「有风格线依据」的歌放行（`hasProfileGrounding` 认 `langAffinity` 与 `laneGrounded`）。
- **展示**：结果带 `styleLanes`（`laneCoverage()` 现算，最多 5 条、按条数降序），页面在「口味画像」下方渲染「本期风格」chips（`古风 22` / `粤语 7`）。
- **版本**：`DAILY_RULE_VERSION` 8→9，当天旧缓存自动重算。

6. **同歌手打散**（`spreadItemsBySinger()`）：模型给的顺序可能把同歌手连在一起，但**只做最小相邻交换** —— 第一首原地不动（保住"今天第一首"的稳定感），遇到相邻同歌手才向后找第一首不同歌手的交换一次；原本没有相邻冲突时顺序原样保留（v1.15 之前的贪心重排会把模型按贴合度排好的顺序整段打乱，也是「随机感」来源之一）。只调顺序，不增删。
7. **落缓存 + 回执**：结果写 `dailyRecommend.cache`，标题 / 摘要由本地模板生成，`profileText`（画像一句话）随结果带给页面。

#### 冷启动：先让用户点风格（v1.7）

画像需要样本，而新用户没有样本 —— 旧逻辑这时直接返回空结果，功能第一次打开就是死的（详见 §0.3-G 的来由）。现在：

- **触发条件**（`generateDailyRecommend`）：`pref.topSingers.length === 0 && !hasSaved && (pref.styleSeeds?.length ?? 0) === 0` —— 三样都没有（听过、收藏、手选风格）才算冷启动；只要有任何一样，就按正常画像推荐。
- **页头**（`DailyRecommendPage`）在摘要与列表之间渲染「你爱听什么风格？」区块：chip 来自音源平台分类（`getPlaylistCategories` → `pickStyleOptions`，去脏去重、最多 `STYLE_OPTION_MAX` = 12 个、**保持平台给的顺序** —— 平台把大分类排前面比我们猜的可靠）。多选上限 `DAILY_STYLE_SEED_MAX` = 4，选中态用 `aria-pressed` + 主色描边。
- **点「按这些风格生成（N）」**：`saveStyleSeeds` → `clearTodayResult()` → `generate(true)`。**清缓存是必须的**：否则 `loadTodayResult` 会原样返回当天那份冷启动结果，用户点了半天没反应。
- **不选**：下面的兜底内容照常可播，`notice` 为 `null` 不弹 toast；音源不提供分类时区块改成一句说明（见下面「空状态与降级文案」），不会空白。
- **冷启动不走本地模型**：`if (mode !== "local" || coldStart)` 走规则分支 —— 没有画像时让模型挑"符合你口味的"，等于让它编。
- 结果带上 `coldStart` / `styleOptions` / `styleSeeds` 三个字段（`DailyRecommendResult`），页面据此决定是否渲染 chip；`profileText` 在冷启动时为空，用户选了种子之后变成「你选的风格：摇滚 · 电子」（`describeProfile` 在 `sampleSize === 0` 但 `tags` 非空时不再说"口味还不明显"—— 亲手点的风格不能说他没口味）。

#### 缓存与失效

缓存结构 `DailyCacheStore { v, days: [{date, mode, keys}], today }`：

- **命中条件**（`loadTodayResult(mode, taste)`）：`today.date === 今天` && `cache.v === DAILY_RULE_VERSION` && `items` 非空 && 有效 mode 一致 && taste 一致。任一不符就重算。
- **当天多次"换一批"是合并而非覆盖**：`saveResult` 把新一批的 `keys` 并入 `days[今天]`，跨天只保留 `DAILY_HISTORY_DAYS` 天。这样"今天推过的"判断不会因为刷新而失忆。
- `DAILY_RULE_VERSION` 每改一次排序 / 打散逻辑就要 +1，否则旧缓存会让新逻辑看不到效果（冷启动这版是 **6**：结果多了 `coldStart` / `styleOptions` / `styleSeeds` 三个字段，且"没记录就空页面"的旧结果必须作废）。
- 冷启动结果同样落缓存；用户点完风格要 `clearTodayResult()` 再强制重算（只清 `today`，`days` 里的历史保留 —— 换一批的降权记忆不该被一次冷启动清掉）。
- keep-alive 页面重新激活时会重校验一次（跨天、改了设置项都要能自动换掉旧结果），不能只在首次挂载时算。

#### 空状态与降级文案

| 情形 | 文案 |
| --- | --- |
| 没有播放记录也没收藏（冷启动） | 页头「你爱听什么风格？」+ 风格 chip；不选也照常展示兜底内容，**不弹 toast**（冷启动不是错误，别用报错语气说话） |
| 冷启动但音源不提供分类 | 「当前音源没有提供风格分类，先听下面这批；听几首之后推荐就会开始像你。」 |
| 候选池为空 | 「音源搜索没有结果，检查一下音源包是否正常。」 |
| 候选都推过了 | 「候选池里的歌最近都推荐过（或被屏蔽），已无新歌可推。」 |
| 服务端 AI 不可用 | 「当前页面不支持服务端 AI 精选，已按规则推荐。」 |
| 本地模型失败 | 「本地模型调用失败（原因），已退回规则推荐。」 |

入口**不依赖任何音源能力位**（不像「每日新歌」要看 `latest`），没记录时页内先让用户点风格（冷启动）并照常给兜底内容，不隐藏侧边栏入口。

## 5.3 标题栏

组成：

1. 应用 Logo
2. 当前音源切换器
3. **搜索入口按钮**（不是输入框）：点击打开独立的搜索页 `/search`（落地页 = 搜索历史 + 热门搜索），输入统一在搜索页里做（见 §0.3-M）
4. 返回 / 前进按钮（可选）
5. 主页按钮
6. 设置入口（跳 `/settings/general`，即「通用」；不是「外观」）
7. 最小化按钮
8. 最大化 / 还原按钮
9. 关闭按钮

## 5.4 侧边栏

**原文冲突修正**：原设计把「网易云 / QQ / 酷我 / 酷狗」同时放进侧边栏导航和标题栏音源切换器，等于同一状态有两个入口，切换后两处都要同步高亮，且「点侧边栏的酷狗」和「用切换器选酷狗」语义无法区分。

结论：**音源是全局状态，只保留标题栏切换器一个入口**；侧边栏只做内容导航。

侧边栏分组：

### 在线（跟随当前音源）

- 首页（`/`）
- 每日推荐（`/daily-recommend`）
- 每日新歌（`/daily`）
- 歌单广场
- 排行榜

**「每日推荐」与「每日新歌」是两个功能，入口刻意相邻但分开**（`Sidebar.tsx` 的 `ONLINE_ITEMS` 注释同口径）：

- 每日新歌 = 当前音源的**最新歌曲流**，跟"你"没关系，谁发新歌就有什么（对应移动端 `pages/daily`）；
- 每日推荐 = 按**你自己的播放历史 + 收藏**挑的，跨源、跨天变化、屏蔽生效、可本地模型精选；没有播放记录时用风格种子冷启动（§5.2「冷启动」）。

显隐口径也不同：每日新歌按当前音源的 `latest` 能力显隐（本地音源整组禁用），每日推荐**不依赖**任何音源能力位 —— 它要的是「有播放记录」，没记录时页内给冷启动引导（风格 chip + 兜底内容），入口不做隐藏。

### 我的

- 我的歌单（原「收藏」已并入）
- 本地音乐
- 下载管理
- 最近播放
- 听歌报告

### 助手

- 音乐助手（`/ai-assistant`）

**全量开放（2026-10-24）**：这一组对全部用户（含未登录）始终渲染，不再要求 `user:ai:music:use` —— `Sidebar` 已删掉 `canUseMusicAssistant` 门禁，`stores/auth.ts` 也移除了该 helper。与移动端 `isQtAdmin` 同口径：**只有「服务端 AI」模式是管理员专属**（`isAdmin(profile)` 即 `admin:qt:admin` / `qt_admin`）。设置页用 `aiModeOptionsFor(isAdmin(profile))` 过滤掉 server 选项，`resolveAiMode()` 把库里残留的 server 收敛成 rule，`useAiChat` 的非管理员不拉 `astralAiAgents`、`askServerForPicks()` 入口直接拒绝。后端 `AiPlugin` 没有「服务端 AI」专用权限码（App 用户默认持有全部 `user:%`），仍按智能体权限码 + 客户端默认权限独立校验 —— **前端显隐不代替后端校验**。见 R37 / §0.3-W。

### 我的歌单

- 本地歌单列表（可拖拽排序）
- 新建歌单按钮

### 底部固定区

- 消息中心（带未读角标）
- 设置
- 账号头像（未登录显示「登录」）

交互细则：

1. 侧边栏可折叠为 64px 图标条，折叠状态持久化。
2. 「在线」分组标题右侧显示当前音源名，点击等价于打开标题栏切换器，避免用户在侧边栏找不到音源。
3. 未登录时「收藏」仍可用（本地收藏），登录后与 Astral 合并（§8.5）。
4. 在线导航固定保留「首页 / 每日新歌 / 歌单广场 / 排行榜」的顺序和占位。本地模式下四项均置灰、标记「不可用」且不触发跳转，悬停说明可切换在线音源；「我的」分组仍正常可用。在线音源明确不支持的功能同样置灰保留，折叠后保留禁用图标和提示。

## 5.5 播放条

```text
┌──────────────────────────────────────────────────────┐
│ 封面 │ 歌名 / 歌手 │ 上一首 播放 下一首 │ 进度条 │ 音量 │ 队列 歌词 频谱 │
└──────────────────────────────────────────────────────┘
```

### 播放条组件

| 组件 | 功能 |
|---|---|
| TrackInfo | 封面、标题、歌手 |
| SourceBadge | 当前音源标识，点击可换源 |
| QualityButton | 音质选择：128 / 320 / FLAC |
| TransportControls | 播放、暂停、上一首、下一首 |
| ProgressBar | 进度显示和拖动 |
| VolumeControl | 音量和静音 |
| PlayModeControl | 播放模式切换 |
| QueueButton | 打开播放队列 |
| LyricButton | 开关桌面歌词 |
| SpectrumToggle | 开关频谱 |

播放队列的开启态**只点亮按钮本身**：`QueueButton` 走 `ControlButton` 的 `emphasis`，
展开时和「桌面歌词」开启态同一套填充（`bg-primary/60` + `text-primary-foreground` +
`shadow-[0_2px_8px_color-mix(...)]`），收起时回到 hover 浅底那一套。用户口径
（m04741）：「我要和左边桌面歌词打开后效果一样就行」。
播放条**整条底色不随队列开关变化**，恒为半透明 `bg-card/70`（下垫 `backdrop-blur-xl`
独立层）。曾经试过两种「整条变色」方案均被否决，勿再重试：①把 `bg-card/70` 做成不透明的
`bg-card` —— 浅色主题下 `--card` 是纯白 `oklch(1 0 0)`、`--background` 几乎同色，
是视觉 no-op（实测反馈「打开了没有变色」）；②整条换 `bg-secondary` 加投影 ——
能看见，但不是用户要的东西（「和刚刚有什么区别」）。
播放页不渲染队列面板（`AppShell` 里 `!isPlayingPage` 才挂 `QueuePanel`），且那里的播放条
走封面色渐变，不受此开关影响。回归测试 `tests/playerbar.queue-button.test.tsx`。

**播放页禁用队列按钮**（用户 m04913「增加在播放页时不允许点击播放列表按钮」）：
`QueueButton` 在 `isPlayingPage` 时 `disabled` + 去掉 `emphasis`（铺主色会读成「队列正开着」，
而播放页根本没有队列可开），`aria-label` 改为「播放队列（播放页不可用）」，样式走
`cursor-not-allowed opacity-40 hover:bg-transparent`。回归测试同上文件最后三条用例。

**长列表滚动**（用户 m05249「长列表右边的进度条无法下滑，导致滚轮滚动很慢；也没有回到顶部的按钮」）：

1. **滚动条加宽加亮**（`src/index.css`）：6px / 18% 不透明度 → 10px / 35%（hover 55%、
   按下 75%），thumb 留 2px 透明内衬，视觉粗细仍是那条细线、**命中区按 10px 算**。
   原先太细太淡，鼠标抓不住，拖不动就只能靠滚轮，于是「滚动很慢」。
   加宽后槽位变化会挤动内容，故给所有纵向滚动容器统一加 `scrollbar-gutter: stable`
   （`@layer base` 里 `:where(.overflow-y-auto, .overflow-auto)`，不再由各页面自己写）。
2. **滚轮加速**（`src/hooks/useContentScroll.ts`）：位移按 `WHEEL_FACTOR = 2.2` 放大，
   `deltaMode=LINE` 先按 40px/行折算，单次封顶 600px。用**倍数**而不是固定步长，
   是因为触控板每次事件只有几像素但触发很密，固定步长会变成「一格飞一屏」。
   取**最内层**纵向滚动容器，保持「内层吃到底也不连带滚外层」的默认语义；
   遇到**横向可滚容器直接让路**（`lib/scroll.ts` 的 `deferToHorizontal`），否则会抢在
   `HorizontalScroller` 前面把整页滚走，首页卡片行就永远横滚不了。
3. **回到顶部**：`components/layout/ScrollTopLayer.tsx` 挂在 `<main>` 里，滚过一屏的
   60%（最多 240px）才出现，点击 `scrollTo({ top: 0, behavior: "smooth" })`。
   位置固定在**内容区**右下角 —— 播放队列是 `<main>` 的兄弟节点，面板展开时按钮
   自动停在面板左侧，不会钻到面板底下。

   两件事都在内容区根节点上用**原生捕获监听**完成（`scroll` **不冒泡**，只有捕获
   阶段能在祖先上收到），十几个长列表页面因此不必逐个挂 ref、逐个改。
   回归测试 `tests/content-scroll.test.tsx`。


（`draggable` / `dragover` / `drop`）。原因（用户 m04913「拖拽排序无反应」的根因）：
Tauri 在 Windows 上会把自己注册的 OLE `IDropTarget` 装到窗口的每个子 HWND 上
（`wry` 的 `drag_drop.rs` 用 `EnumChildWindows` 逐个 `RevokeDragDrop` + `RegisterDragDrop`），
该 target 只认 `CF_HDROP`（外部文件拖入），页面内的 `dragstart` / `dragover` / `drop` 全被
压掉。本项目没有任何文件拖入消费方（`src-tauri/src` 里 grep `FileDrop|DragDrop` 零命中），
因此 `tauri.conf.json` 的 `dragDropEnabled: true` 是纯负担 —— 但改它要重编译 Rust 侧，
故前端绕开：行上挂 `data-queue-index`，按下后位移越过 4px 阈值才进入拖动态，
落点用 `document.elementFromPoint` 做真实命中测试（**不能**用回调自带的下标 ——
`setPointerCapture` 之后 `pointermove` 全部重定向到起始行，拿到的永远是起点），
抬手提交 `ipc.queueMove(from, to)`。回归测试 `tests/queue-panel-drag.test.tsx`。

## 5.6 首次启动免责声明 / 开源通知

装完**第一次启动**弹一次（不是每次启动）：三段正文 —— ①这是什么 ②请这样使用
（仅供个人自用、不得商用、不得批量抓取再分发）③开源与免费（全部功能免费、源码
Apache-2.0 + 补充条款，**见到以本项目名义收费的版本即不是本项目**）。
文案与官网《用户协议》《隐私政策》同源，不要各写一份；此处**不写服务端保留期**
——那属于隐私政策的口径，写在客户端就成了承诺。

**文案由后端下发，代码里不存正文。** 改一句话不用发版、不用等审核；代价是离线时
拿不到声明就不弹（见下表「读不到」一行）。下发通道**复用现有公告系统** `sys_notice`，
不建新表也不新增端点：后台「消息管理」里发一条开屏公告，额外填两个字段
`read_seconds`（读秒）与 `terms_version`（条款版本号）即可。

| 字段 | 作用 |
|---|---|
| `display` 含 1 | 走开屏位；客户端只从开屏公告里挑声明 |
| `terms_version` 非空 | **判定「这条是免责声明」的唯一依据**。客户端记住已接受的版本，值一变就再弹一次 |
| `read_seconds` | 确认键读满多少秒才可点；NULL 或 0 = 立即可点。客户端夹在 **0..60**：这个弹窗全屏无关闭键，读秒就是唯一能锁住用户的开关 |
| `channel` | **服务端强制改写为 App 六端**（`app-android,app-ios,app-windows,app-linux,app-macos,app-harmony`，不含 `web`），后台选什么都无效。原因：各端 `X-App-Ut` 跟着编译目标走，少勾一个平台那个平台的用户就永远收不到声明。qt-uniappx 也已支持这套字段（判定逻辑与本端同构），所以手机端同样由它认领 |
| `dialog_closable` | **服务端强制改写为 1（可关闭）**。3.0.7 及以前的老 APK 不认识 `terms_version`，会把声明当普通开屏公告；若不可关闭，那个弹窗点「我知道了」执行的是 `exitApp()`，用户点一下 App 直接退出。新版客户端（PC / uniappx）本来就不走那条路，对这个值是零依赖 |
| `title` / `content` | 标题与正文；`content` 是富文本，客户端用 `lib/richText` 白名单渲染（**不走 `innerHTML`**），`script`/`iframe`/`style` 与行内事件会被过滤，外链只放行 `http(s)` 并走 `ipc.openExternalUrl` |

为什么不新增 `scene` 常量来标记：`scene` 被服务端 `NotifyEventRegistry.isFeedbackReply()`
等规则强约束，塞自家枚举会牵连反馈回复通知的全平台投放逻辑。用「开屏位 + 版本号非空」
这个组合判定，对后端零侵入。

| 环节 | 实现 |
|---|---|
| 是否弹 | `settings.disclaimer.acceptedAt` 存 `{termsVersion, acceptedAt}`；版本号一致就不再弹；卸载重装 = 新库 = 重新弹 |
| 状态 | `stores/disclaimer.ts`：`pending`（null 还没读库 / true 要弹 / false 不弹）+ `reopened`（设置页主动重看）+ `notice`（后端下发的那条） |
| 读秒 | 时长取 `readSeconds`，**客户端夹在 0..60**（后台表单 `max=60` 也拦一道）；「请阅读（3s）」→「我知道了」；每次打开都重新读满 |
| 落库 | 确认后写 `{termsVersion, acceptedAt}`；**写失败也照样放行** —— 最多下次再弹一次，不把人拦在弹窗里出不去 |
| 老用户 | 升级前写入的裸 ISO 字符串（`"2026-10-18T03:00:00Z"` 这种）当作**已接受**，新增版本号机制不打扰他们 |
| 没下发 | 后端没给声明就**不弹**。**不留硬编码兜底文案** —— 「后台改了文案却还弹旧的」正是本设计要消灭的坑 |
| 官网地址 | 走 `useOfficialSiteUrl()`（私有配置，源码与文档里都不能出现自有域名）；未配置时降级为「见官网」纯文字，不给死链接 |
| 入口 | `AppShell` 的「对话框」层**最先挂**，盖住更新弹窗等；引导跳转等 `pending === false` 才走，避免两场首启动流程叠在一起 |
| 与公告弹窗互斥 | `qt-NoticeDialog` 的 `normalizeSplashNotices` 把「`termsVersion` 非空」的公告过滤掉，否则两个开屏弹窗会叠着弹 |
| 复查 | 设置「关于」里的「重新查看免责声明」：`reopen()` 只展示，**不改**已记录的接受时刻；取不到声明时返回 false，设置页据此提示一句，不留下「点了没反应」的死按钮 |

读不到库、接口挂了都按「不需要展示」处理：宁可这次不弹，也不让用户卡在弹窗前出不去。
回归测试 `tests/first-run-disclaimer.test.tsx`（17 条：文案来自后端 / 读满才可点 /
读秒为 0 立即可点 / 读秒被夹在 0..60 / 同版本不弹 / 版本变了重新弹 / 老裸 ISO 记录不弹 /
没下发不弹 / 接口挂了不弹 / 重看要重新读秒且不写标记 / 重看取不到声明返回 false /
外链走系统浏览器 / 公告弹窗排除声明 / `pickDisclaimer` 筛选与兜底 /
`disclaimerVisible` 三条）。
后端口径由 `astral-plugin` 的 `FeedbackNoticeDisclaimerFieldsTest`（12 条）守着：
编辑时两列必须写进白名单、清空要真的落 NULL 而不是被 `updateStrategy=NOT_NULL` 跳过、
读秒在新增与编辑两条路径上都被夹进 0..60、免责声明的渠道被强制改成 App 六端、
声明的 `dialog_closable` 被强制顶回 1（这两条新增与编辑两条路径都验；普通公告的
渠道与 `dialog_closable` 都原样保留）。

后端要发的这条声明怎么填，见后台「消息管理」页的**「免责声明」按钮**：它会把
标题、开屏位、App 六端渠道、`dialogClosable=1`、`readSeconds=3`、`termsVersion`
与三段正文一次填好，运营改完再点发布。模板正文写在 `astral-front` 的
`NoticeManagement.tsx` 的 `DISCLAIMER_TEMPLATE`，与本节口径同源。

移动端（`qt-uniappx`）的实现见其 `stores/disclaimer.ts` 与
`uni_modules/qt-ui/components/qt-first-run-disclaimer/`：判定判据与本端同构
（开屏位 + `termsVersion` 非空），存储介质是 uni storage 而不是 SQLite，
接受记录键为 `qt-disclaimer-accepted`。两侧共用同一套后端口径，改任一侧都要回头看另一侧。

---

## 6. 音源切换设计（Music Source）

## 6.1 当前音源范围

PC 版第一版严格对齐 `qt-uniappx` 当前支持的四大音源：

| 源 ID | 音源 | 默认显示名 | 当前能力来源 |
|---|---|---|---|
| `wyy` | 网易云音乐 | 音源一 | `qt-uniappx/services/music-api.ts` |
| `qq` | QQ音乐 | 音源二 | `qt-uniappx/services/music-api.ts` |
| `kw` | 酷我音乐 | 音源三 | `qt-uniappx/services/music-api.ts` |
| `kg` | 酷狗音乐 | 音源四 | `qt-uniappx/services/music-api.ts` |

WebDAV、自建音乐服务、咪咕等不进入第一版实现，只保留 Provider 架构扩展位。

## 6.2 音源切换入口

音源切换器位于标题栏中间区域，显示当前音源名称和图标。

支持三种模式：

1. 当前音源模式
2. 全部音源聚合模式
3. 音源设置入口

切换规则：

1. 切换后当前播放不中断。
2. 首页、搜索、歌单广场、排行榜、新歌、MV 数据按新音源刷新。
3. 聚合模式用于 `allCharts`、`allLatest`、`allHotWords`、`allSearch`。
4. 单个音源请求失败时，聚合结果继续返回其他音源数据。
5. 音源状态在 UI 中显示为可用、请求中、失败。
6. 音源状态与 Astral 账号登录状态分离。
7. **聚合搜索（`scope=all` / AI 找歌 / 手动换源 / 每日推荐跨源）只在「聚合搜索音源」勾选的源里进行**：设置项是 `search.aggregateSources`（设置 → 音源包，动态按数据包下发的源渲染），未勾选的源在数据包侧就不发请求，门面再过滤一遍作答旧包兜底。单源模式（某源页签、榜单、歌单、歌手页）不受影响，见 §0.3-I。

## 6.3 Provider 抽象

前端不直接请求音源接口。所有音源请求都由 Rust Provider 统一处理，原因：

1. Rust 可以设置 User-Agent、Referer、Cookie 等请求头。
2. Rust 可以实现酷我编码、酷狗签名等现有移动端兼容逻辑。
3. Rust 可以绕开 WebView CORS 限制。
4. Rust 可以统一缓存、重试、超时和播放地址失效策略。
5. Rust 可以将不同音源的响应归一为统一模型。

```ts
export type SourceId = 'wyy' | 'qq' | 'kw' | 'kg'

export interface MusicSourceProvider {
  id: SourceId
  name: string
  displayName: string
  status: 'available' | 'loading' | 'error'
  capabilities: ProviderCapabilities
}

export interface ProviderCapabilities {
  playlistCategories: boolean
  recommendations: boolean
  latest: boolean
  charts: boolean
  chartDetail: boolean
  playlistDetail: boolean
  searchSong: boolean
  searchPlaylist: boolean
  searchArtist: boolean
  searchAlbum: boolean
  artistSongs: boolean
  mvList: boolean
  mvUrl: boolean
  lyric: boolean
  lyricTranslation: boolean
  playUrl: boolean
  cover: boolean
}
```

## 6.4 Rust Provider Trait

> ⚠️ **本节已作废（2026-09-27）**：`MusicProvider` trait / `ProviderRegistry` 在代码中已完全不存在，
> 音源访问改由前端音源脚本引擎（音源包）承担。见 §0.3-A。下文保留仅为记录当时的取舍过程。

**原文问题**：`trait` 里直接写 `async fn` 在 Rust 中不是对象安全的，无法 `Box<dyn MusicProvider>` 或放进 `HashMap<SourceId, Arc<dyn MusicProvider>>` 做运行时分发；同时所有方法返回裸 `Vec<T>` / `Option<T>`，会把 §6.10 要求的错误分类（网络失败 / 超时 / 格式异常 / 无结果）全部压成空值，前端无法区分「没搜到」和「音源挂了」。

修正后签名：

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceId { Wyy, Qq, Kw, Kg, Local }

#[derive(Debug, thiserror::Error, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProviderError {
    #[error("网络请求失败")]        Network { message: String },
    #[error("请求超时")]            Timeout { after_ms: u64 },
    #[error("响应格式异常")]        Decode  { message: String },
    #[error("音源限流或风控")]      RateLimited,
    #[error("该能力不支持")]        Unsupported,
    #[error("无可用播放地址")]      NoPlayableUrl,
    #[error("无结果")]              Empty,
}

pub type ProviderResult<T> = Result<T, ProviderError>;

#[async_trait::async_trait]
pub trait MusicProvider: Send + Sync {
    fn id(&self) -> SourceId;
    fn name(&self) -> &'static str;
    fn capabilities(&self) -> ProviderCapabilities;

    async fn playlist_categories(&self) -> ProviderResult<Vec<PlaylistCategory>>;
    async fn recommendations(&self, category: Option<&str>, page: u32) -> ProviderResult<Vec<Playlist>>;
    async fn latest(&self, limit: u32, offset: u32) -> ProviderResult<Vec<Track>>;
    async fn charts(&self) -> ProviderResult<Vec<Chart>>;
    async fn chart_detail(&self, chart: &Chart, page: u32, size: u32) -> ProviderResult<Vec<Track>>;
    async fn playlist(&self, id: &str, page: u32, size: u32) -> ProviderResult<Playlist>;
    async fn hot_words(&self) -> ProviderResult<Vec<String>>;

    async fn search_tracks(&self, kw: &str, page: u32, size: u32) -> ProviderResult<Vec<Track>>;
    async fn search_playlists(&self, kw: &str, page: u32, size: u32) -> ProviderResult<Vec<Playlist>>;
    async fn search_artists(&self, kw: &str, page: u32, size: u32) -> ProviderResult<Vec<Artist>>;
    async fn search_albums(&self, kw: &str, page: u32, size: u32) -> ProviderResult<Vec<Album>>;
    async fn artist_songs(&self, name: &str, page: u32, size: u32) -> ProviderResult<Vec<Track>>;

    async fn videos(&self, page: u32, size: u32) -> ProviderResult<Vec<Video>>;
    async fn video_url(&self, id: &str, quality: &str) -> ProviderResult<String>;

    async fn lyric(&self, track: &Track) -> ProviderResult<Lyric>;
    async fn play_url(&self, track: &Track, quality: Quality) -> ProviderResult<PlayUrl>;
    async fn cover(&self, track: &Track) -> ProviderResult<String>;
}
```

要点：

1. `#[async_trait]` 保证 `Arc<dyn MusicProvider>` 可注册到 `ProviderRegistry`，聚合调用用 `futures::future::join_all` 并发执行。
2. `chart_detail` / `playlist` 补上分页参数：移动端这两个能力在酷我、酷狗上本来就是分页拉取，原签名无法表达。
3. `ProviderStatus` 从 trait 中移除——状态是「最近一次调用的结果」，属于运行期数据，由 `ProviderRegistry` 维护并通过 `provider-status-changed` 广播，Provider 自身无状态。
4. `capabilities()` 返回常量，用于前端灰置不支持的入口（例如只有 `wyy` 有歌词翻译）。
5. 聚合调用的失败策略：单源 `Err` 只记录并广播状态，不影响其他源结果；全部失败才向前端返回错误。

## 6.5 现有 MusicApi 方法映射

| 现有 `MusicApi` 方法 | Rust Provider 方法 | 前端 IPC |
|---|---|---|
| `playlistCategories(source)` | `playlist_categories` | `get_playlist_categories` |
| `recommendations(source, category, page)` | `recommendations` | `get_recommendations` |
| `latest(source, limit, offset)` | `latest` | `get_latest_songs` |
| `allLatest(limit, offset)` | 聚合调用四个 Provider | `get_all_latest_songs` |
| `charts(source)` | `charts` | `get_charts` |
| `allCharts()` | 聚合调用四个 Provider | `get_all_charts` |
| `chartDetail(chart)` | `chart_detail` | `get_chart_detail` |
| `playlist(id, source)` | `playlist` | `get_playlist_detail` |
| `hotWords(source)` | `hot_words` | `get_hot_words` |
| `allHotWords()` | 聚合调用四个 Provider | `get_all_hot_words` |
| `search(keyword, source, type, page, size)` | 按类型调用搜索方法 | `search_music` |
| `allSearch(keyword, page, size)` | 聚合调用四个 Provider | `search_all_music_sources` |
| `searchPlaylists(...)` | `search_playlists` | `search_playlists` |
| `searchArtists(...)` | `search_artists` | `search_artists` |
| `artistSongs(...)` | `artist_songs` | `get_artist_songs` |
| `searchAlbums(...)` | `search_albums` | `search_albums` |
| `videos(page, size, source)` | `videos` | `get_videos` |
| `videoUrl(id, source, quality)` | `video_url` | `get_video_url` |
| `lyrics(song)` | `lyric` | `get_lyric` |
| `lyricTranslation(song)` | `lyric_translation` | `get_lyric_translation` |
| `playUrl(song, quality)` | `play_url` | `get_play_url` |
| `songCover(song)` | `cover` | `get_track_cover` |
| `invalidatePlayUrl(song, quality)` | `invalidate_play_url` | `invalidate_play_url` |

## 6.6 统一数据模型

### Track

```ts
export interface Track {
  id: string
  platform: SourceId
  title: string
  singer: string
  album: string
  picUrl: string
  url?: string
  urlFetchedAt?: number
  duration?: number
  musicId?: string
  likeSeq?: number
}
```

> `platform` 字段名必须与 Astral 收藏接口和移动端现有模型保持一致，UI 层可以显示为“音源”。

### Playlist

```ts
export interface Playlist {
  id: string
  platform: SourceId
  name: string
  picUrl: string
  playCount: string
  description?: string | null
  tracks?: Track[]
  likeSeq?: number
}
```

### Artist

```ts
export interface Artist {
  id: string
  platform: SourceId
  name: string
  picUrl: string
}
```

### Album

```ts
export interface Album {
  id: string
  platform: SourceId
  name: string
  artist: string
  picUrl: string
  publishTime?: number
}
```

### Chart

```ts
export interface Chart {
  id: string
  platform: SourceId
  name: string
  picUrl: string
  description?: string
}
```

### Video

```ts
export interface Video {
  id: string
  platform: SourceId
  name: string
  picUrl: string
  singer: string
}
```

## 6.7 播放地址与音质

沿用移动端行为：

1. 支持音质 `128`、`320`、`flac`。
2. 远程播放地址缓存 10 分钟。
3. `PlayUrl` 必须携带 `fetchedAt`。
4. 播放失败时作废缓存并重新获取。
5. 重取失败后提示“该歌曲暂时无法播放”。
6. 本地下载文件不应用 10 分钟失效规则。

```ts
export interface PlayUrl {
  url: string
  quality: '128' | '320' | 'flac'
  fetchedAt: number
  expiresAt: number
}
```

## 6.8 同歌换源与跨音源替代

当前移动端播放页已有换源逻辑，PC 需要保留并增强。

流程：

```text
当前歌曲播放失败 / 用户手动换源
   │
   ▼
使用 歌曲名 + 歌手 在目标音源搜索
   │
   ▼
返回候选列表
   │
   ├── 自动模式：取第一个可播放结果
   └── 手动模式：用户选择结果
   │
   ▼
替换 Track 的 id / platform / musicId / 封面 / 元数据
   │
   ▼
保持当前播放进度
   │
   ▼
获取新播放地址并继续播放
```

音质切换失败时的降级策略：

1. 先在当前音源重新获取目标音质。
2. 当前音源失败后，按 `wyy → qq → kw → kg` 顺序搜索替代版本。
3. 找到替代版本后获取目标音质播放地址。
4. 全部失败时提示“未找到可替代的歌曲”。

## 6.9 Astral 账号与音源的关系

Astral 账号不等同于音源账号。

| 类型 | 用途 | 当前状态 |
|---|---|---|
| Astral 轻听账号 | 收藏同步、反馈、签到、消息中心、头像资料 | 已有 `/api/v1/app/user/**` |
| 四大音源账号 | 登录网易云、QQ、酷我、酷狗 | 当前移动端未实现，PC 第一版也不实现 |

因此 PC 第一版：

1. 不提供音源平台登录。
2. 不保存音源平台 Cookie。
3. 不访问音源会员接口。
4. 只使用当前移动端已有的匿名公开接口能力。
5. Astral 登录只影响收藏同步、反馈、消息等服务能力。

## 6.10 播放可用性设计

当前音源接口没有统一的结构化错误码，PC 需要在 Provider 层归一：

| 状态 | 判定 |
|---|---|
| 可播放 | `play_url` 返回非空地址 |
| 暂不可播放 | 请求失败或返回空地址 |
| 音质不可用 | 指定音质取址失败 |
| 音源异常 | 网络失败、超时、响应格式异常 |
| 未找到替代 | 跨音源搜索无结果 |

处理策略：

1. 不可播放歌曲不进入播放状态。
2. 点击后显示“该歌曲暂时无法播放”。
3. 提供手动换源入口。
4. 可开启自动换源尝试。
5. 播放队列中的失效歌曲保留原位置并标记状态。

## 6.11 合规边界

1. 第一版沿用 `qt-uniappx` 当前公开音源接口，定位为个人学习交流。
2. 不绕过 DRM、会员限制、验证码或风控。
3. 不提供版权规避和破解功能。
4. 不将当前公开接口能力用于商业发行。
5. 后续商业发行前，应将 Provider 替换为官方或授权接口。

## 6.12 在线音频流式播放与本地缓冲（原文缺失的关键链路）

原文只写到「音频引擎解码」，但没有说明**网络音频如何喂给解码器**。这是整条播放链路最容易出问题的一环，必须定稿：symphonia 的解码器需要一个 `Read + Seek` 的输入，而 HTTP 响应体只有 `Read`，直接把响应流交给解码器会导致无法 seek、无法读取 FLAC 尾部元数据。

### 设计：HttpRangeReader（边下边播 + 磁盘缓冲）

```text
play_url
   │
   ▼
HEAD / 首个 Range 请求（bytes=0-）
   │  读取 Content-Length、Accept-Ranges、Content-Type
   ▼
在 cache/audio/ 下创建稀疏缓冲文件 <sha1(url)>.part
   │
   ├── 后台下载线程：顺序写入缓冲文件，更新「已就绪区间」位图
   └── HttpRangeReader（实现 Read + Seek）：
         read()  → 若目标区间已就绪则本地读；否则阻塞等待（带超时）
         seek()  → 落在未就绪区间且服务端支持 Range → 发起新 Range 请求并重定位下载点
   │
   ▼
rodio::Decoder::new(BufReader::new(HttpRangeReader))
   │
   ▼
Sink.append(source)
```

关键规则：

| 场景 | 处理 |
|---|---|
| 服务端 `Accept-Ranges: none` 或返回 200 而非 206 | 退化为「先下完再播」，播放前显示缓冲进度 |
| 首包超时（默认 8s） | 判定为不可播放，触发 `invalidate_play_url` + 重取一次 |
| 响应体空闲读超时（20s） | 连接假死（收下请求后既不发包也不关连接）→ 走断流重连；连续 3 次广播 `audio-error` |
| 播放中断流 | 已缓冲部分继续播放，同时后台重试；连续失败 3 次广播 `audio-error` |
| 缓冲区大小 | 单曲上限 512MB（覆盖 FLAC / flac24bit，实测单曲最大约 135MB），LRU 淘汰，总量上限在设置中可调（档位 1G/2G/4G/不限/自定义，默认 1GB） |
| 超单曲上限 | 首包 `content-length` 即判死，**不**作废地址重取（重取改变不了文件长度）→ 文案「该歌曲文件过大，暂不支持在线播放」，不计入弱网重试 |
| 与下载功能的关系 | 用户点「下载」时若缓冲文件已完整，直接 `rename` 到下载目录，不重复拉流 |
| 本地文件 | 直接 `File::open`，不进入该链路，也不参与 10 分钟失效判断 |
| 起播延迟目标 | 首包到达即起播，目标 < 800ms（不含取址耗时）；不等整曲下载完 |

HTTP 层超时的三个值互不替代，改一个必须复核另两个：`HTTP_TOTAL_GUARD`（120s，挂在
request 上，只兜「请求永不返回」）、`READ_IDLE_TIMEOUT`（20s，`BodyReader` 的空闲读
超时，真・判活）、`FIRST_PACKET_TIMEOUT`（8s，解码侧 `ensure_ready` 的用户可见首包
判活）。`reqwest::blocking` 没有空闲读超时选项，所以 20s 那层是把响应体挪进独立线程、
用有界通道 `recv_timeout` 实现的（`range_reader.rs` 的 `BodyReader`）。

事件补充：`audio-buffering { trackId, bufferedMs, downloadedBytes, totalBytes }`，前端用于进度条的二级缓冲条与「缓冲中」状态。

## 6.13 封面与 MV 资源访问（原文缺失）

音频走 Rust 没问题，但**图片和视频是 WebView 直接加载的**，这里存在原文未评估的两个硬约束：

1. 部分音源的封面 / MV CDN 校验 `Referer` 或 `User-Agent`，`<img src>` / `<video src>` 直连会 403。
2. 即使能直连，也等于把用户 IP 暴露给音源 CDN，并绕过了「网络请求统一走 Rust」的架构约定，CSP 也必须为此放开外部域名。

### 方案：自定义协议 `qtres://`

Rust 注册 `qtres` 协议（`tauri::Builder::register_asynchronous_uri_scheme_protocol`），前端一律使用 `qtres://cover/<base64url(原始URL)>` 与 `qtres://mv/<...>`：

| 能力 | 说明 |
|---|---|
| 请求头 | Rust 按音源补齐 `Referer` / `User-Agent`，与 Provider 复用同一套规则 |
| 封面缓存 | 命中 `cache/covers/<sha1>.<ext>`；未命中则拉取 + 落盘 + 生成 `@2x` 缩略图（列表用缩略图，播放页用原图） |
| MV / 视频 | **必须支持 Range 透传**，否则 `<video>` 无法拖动进度；把浏览器的 `Range` 头透传给上游，并原样回传 `206` + `Content-Range` |
| 失败兜底 | 返回内置占位图（1×1 透明或默认封面），不让 `<img>` 触发 onerror 抖动 |
| 白名单 | 只允许四大音源已知 CDN 域名 + Astral 域名，防止被歌词 / 皮肤等外部数据当作任意请求代理 |
| CSP | `img-src` / `media-src` 放开 `qtres:`，无需放开任何外部域名（见 §4.1） |

> 备选方案是在 `127.0.0.1` 上起临时 HTTP 代理，但会占用端口、需处理防火墙提示，且暴露给本机其他进程，**不推荐**。

---

## 7. 音频核心设计

## 7.1 模块划分

```text
audio/
 ├─ engine.rs        # 播放引擎
 ├─ queue.rs         # 播放队列
 ├─ output.rs        # 输出设备
 ├─ decoder.rs       # 解码封装
 ├─ gapless.rs       # 无缝播放
 ├─ crossfade.rs     # 淡入淡出
 ├─ equalizer.rs     # 均衡器
 ├─ spectrum.rs      # 频谱
 └─ media_control.rs # 系统媒体控制
```

## 7.2 播放状态

```rust
#[derive(serde::Serialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum PlaybackStatus { Stopped, Loading, Buffering, Playing, Paused, Error }

#[derive(serde::Serialize, serde::Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum PlayMode { ListLoop, OneLoop, Random }

/// 音质档位直接复用 provider 的类型：档位清单由音源包声明
/// （`128` / `320` / `flac` / `flac24bit` …），宿主只透传字符串，
/// 不再有第二份枚举与 `From` 转换。
pub use crate::provider::types::Quality;

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackState {
    pub track_id: Option<String>,
    pub source_id: Option<SourceId>,
    pub status: PlaybackStatus,
    pub position_ms: u64,
    pub duration_ms: u64,
    /// 已缓冲毫秒数，在线曲目用于进度条二级缓冲条
    pub buffered_ms: u64,
    pub volume: f32,
    pub muted: bool,
    pub play_mode: PlayMode,
    pub quality: Quality,
    /// 当前曲目在队列中的下标，前端队列面板高亮依赖它（原文缺失）
    pub queue_index: Option<usize>,
    pub queue_len: usize,
    /// 是否本地文件（决定是否走 10 分钟失效与缓冲逻辑）
    pub is_local: bool,
    pub url_fetched_at: Option<u64>,
    /// 当前实际播放地址（在线曲目才有；播放条调试面板展示用）
    pub play_url: Option<String>,
    /// 最近一次错误，供前端展示「该歌曲暂时无法播放」
    pub error: Option<String>,
    /// 睡眠定时剩余毫秒，None 表示未启用
    pub sleep_timer_ms: Option<u64>,
    /// true = 播完当前曲目后停止（无倒计时语义）
    pub sleep_after_track: bool,
    /// 播放倍速（0.5 ~ 2.0，1.0 = 原速）
    pub speed: f32,
    /// 当前曲目，播放条直接渲染，避免前端二次查询
    pub track: Option<Track>,
    /// 当前音频输出设备名（设置页显示用）
    pub output_device: String,
    /// 实际播放码率（kbps）：按**真正挂载的那条流**的总字节数 ÷ 时长换算。
    /// None = 测不出来（本地文件 / 服务端没给长度 / 时长未知），前端此时不显示
    /// 码率——显示 0 会被读成"码率极低"，那是假消息。
    pub bitrate_kbps: Option<u32>,
}
```

约定：

1. 所有跨 IPC 结构统一 `#[serde(rename_all = "camelCase")]`，前端 TS 类型与之一一对应，不做手工字段映射。
2. `Loading`（取址中）与 `Buffering`（已起播但等数据）必须区分：前者可取消，后者不可取消，UI 表现也不同。
3. `PlaybackState` 是**全量快照**，只在状态语义变化时推送；高频的进度更新走独立的轻量事件（§7.11）。

## 7.3 播放流程

```text
前端 play_track(trackId)　// 单曲播放：入队（队里已有则复用原位置）后开播，不清空列表
   │
   ▼
Rust 查询 Track
   │
   ├── local：直接读取本地文件
   └── online：检查播放地址缓存
   │
   ▼
缓存有效？
   ├── 是：继续播放
   └── 否：Provider 获取 play_url
   │
   ▼
获取失败？
   ├── 是：作废缓存 → 重新获取 → 仍失败则按失败分类处理（见 §7.12）
   └── 否：继续
   │
   ▼
音频引擎解码
   │
   ▼
输出到当前设备
   │
   ▼
推送 playback-state / position-changed
   │
   ▼
React 更新播放条和播放页
```

远程播放地址缓存规则：

1. 缓存键：`platform + trackId + quality`。
2. 有效期：10 分钟。
3. 缓存命中时必须使用缓存条目自身的 `fetchedAt`，不能刷新为当前时间。
4. 播放失败时调用 `invalidate_play_url`。
5. 本地文件不判断过期。
## 7.4 引擎线程模型（原文缺失，实现前必须定稿）

`cpal::Stream`（rodio 的 `OutputStream`）**不是 `Send`**，不能直接放进 Tauri 的 `State` 里跨线程共享。必须用「专属音频线程 + 命令通道」结构，否则编译期就会卡住。

```text
Tauri 命令 (任意线程)
   │  mpsc::Sender<AudioCmd>
   ▼
音频控制线程（独占 OutputStream + Sink，单线程内串行处理命令）
   │
   ├─ 下载/解码线程（每曲一个，产出 HttpRangeReader）
   ├─ 采样旁路 → ringbuf → 频谱线程（FFT）
   └─ Arc<RwLock<PlaybackState>> ← 供 get_playback_state 同步读取
         │
         └─ 变化时 app.emit("playback-state-changed", snapshot)
```

```rust
enum AudioCmd {
    Load { track: Track, url: PlaySource, start_at: Option<u64>, autoplay: bool },
    Play, Pause, Stop,
    Seek(u64),
    SetVolume(f32), SetMuted(bool),
    SetPlayMode(PlayMode),
    Preload(Track),                 // 无缝播放预解码
    SetOutputDevice(Option<String>),
    SetEq(Option<EqSettings>),
    SetCrossfade { enabled: bool, ms: u32 },
    SetSleepTimer(Option<u64>),
    Shutdown,
}
```

## 7.5 无缝播放（gapless）

实现路径：

1. **当前曲目一加载完成就预热下一首**：`mount_decoder` 末尾（地址/缓存/解码器都已就位）立刻为队列下一首发起预载——后台完成取址 + 首包探测 + 构建 `Decoder`，结果存进引擎侧 `PreloadSlot.ready`。不等播放圈轮询（非播放态那一圈要等满 1s）；`handle_cmd` 末尾也会补一次，所以「恢复播放 / 重新开无缝 / 弱网重载成功」同样是当场预热。暂停态加载（恢复现场、`autoplay=false`）不预热：预取会白占带宽，地址也可能等不到用就过期。
2. 预解码结果暂存为 `Option<Box<dyn Source>>`；当前曲目自然结束前，直接 `sink.append(next)` 到**同一个 Sink**，由 rodio 连续消费，不重建输出流——这是达到 <20ms 间隙的唯一可行路径。
3. 队列变更（切歌、清空、改播放模式、改音质、换输出设备、暂停）时丢弃预载结果并重算目标。刻意**不作废**的两条：`Seek` 与 `SetSpeed` —— 它们只作用于当前这条流，改不了下一首是谁、也改不了它的取链参数，作废只会白丢一次已取好的地址（随机模式下还会重掷骰子，表现为「拖了下进度条，下一首就换人」）。
4. 「随机播放」模式下，预热那一刻用 `fastrand` 掷一次骰并把**下标**一起存进 `PreloadSlot`；换曲时提交这个下标（`queue.index = Some(slot.index)`），不再重掷——随机结果在预热时就已经固定。
5. 预载失败（取链失败 / 首包超时 / 文件过大等）立刻作废槽位并在下一圈换目标重试，同一首最多 2 次（`PRELOAD_RETRY_LIMIT`）；用尽就不再预热，到点由 `advance` 现场取链，避免每 25ms 反复拉一次注定失败的流。
6. 无缝仅在**同采样率**曲目间生效；采样率不同必须重建输出流，此时退化为普通切歌并在设置中说明。
7. 单曲循环模式下不做预加载，直接 `seek(0)`。

## 7.6 淡入淡出（crossfade）

| 场景 | 行为 |
|---|---|
| 播放开始 | 音量从 0 线性渐变到目标音量 |
| 暂停 | 渐变到 0 后暂停（避免爆音） |
| 切歌（用户主动） | 旧曲淡出、新曲淡入 |
| 切歌（自然结束） | 由 §7.5 无缝接续，**不做**淡入淡出 |
| 拖动进度 | 不做，保持即时响应 |
| 停止 / 退出 | 淡出后停止 |

实现要点：淡入淡出与无缝互斥，同时开启时**淡入淡出优先**并自动禁用无缝（两者都要控制同一段尾部音频，不能叠加）。真正的交叉淡化需要两个 Sink 同时出声，因此实现上维护 `sink_a` / `sink_b` 双 Sink 轮换，各自 `set_volume()` 做斜坡。默认时长 300ms，可配 0–3000ms。

## 7.7 频谱采样链路

rodio **没有**输出采样的旁路接口，「从音频输出流获取采样数据」需要自己造：

```rust
/// 透明包装：转发所有采样，同时复制一份写入无锁环形缓冲
struct TapSource<S: Source<Item = f32>> { inner: S, tx: ringbuf::Producer<f32> }
```

链路：`Decoder → EqSource → TapSource → Sink`。

| 环节 | 设计 |
|---|---|
| 缓冲 | `ringbuf` 容量 8192 采样；写满即丢弃最旧数据，**绝不阻塞音频线程** |
| FFT | 独立线程，2048 点 Hann 窗，`rustfft` 实数变换 |
| 频段 | 输出 32 / 64 段（可配），按对数频率分箱（20Hz–16kHz） |
| 幅度 | 转 dB 后归一化到 0–1，做峰值保持 + 指数衰减（衰减系数可配） |
| 推送 | 默认 30 FPS；窗口不可见 / 播放页未打开 / 用户关闭时**完全停止 FFT 线程**（不是只停推送） |
| 事件 | `spectrum-data: Vec<f32>`，用 `f32` 数组而非对象，减少序列化开销 |

前端只做 Canvas 绘制与颜色映射，不做任何 DSP。

## 7.8 均衡器

rodio 无内置 EQ，实现为 `EqSource`：10 段 `biquad` peaking filter 串联（31 / 62 / 125 / 250 / 500 / 1k / 2k / 4k / 8k / 16k Hz），增益范围 ±12dB，另设总 preamp。

| 事项 | 设计 |
|---|---|
| 系数更新 | 参数变更时重算系数并热替换，不重建播放链，避免切歌 |
| 削波保护 | 总增益为正时自动衰减 preamp，或接软限幅器，防止 FLAC 上溢出爆音 |
| 预设 | 流行 / 摇滚 / 古典 / 人声 / 低音增强 / 自定义，存 `settings` 表 |
| 音量归一化 | 优先读文件内 ReplayGain / `R128_TRACK_GAIN` 标签（lofty 可读）；无标签则不做实时分析（实时 LUFS 计算成本过高，v1 不做） |

## 7.9 输出设备切换

cpal 无法在既有流上换设备，必须重建：

```text
记录当前 position / status
   │
   ▼
停止旧 Sink → drop 旧 OutputStream
   │
   ▼
按 device_id 建新 OutputStream + Sink（失败则回落默认设备并提示）
   │
   ▼
重建解码器 → seek 到记录位置 → 恢复原 status
```

补充：每 2s 轮询对比默认输出设备名（跟随默认模式），并检查当前设备是否仍在输出设备枚举里。WASAPI 只枚举 `DEVICE_STATE_ACTIVE` 端点，所以设备被拔掉 / 蓝牙断开 / 被禁用后名字会直接从枚举里消失 —— 这就是「被动移除」的判据。两条分支语义不同：

- **旧设备消失（被动移除）→ 暂停**：用户拔耳机想要的是停下，而不是把声音切到扬声器接着响。此时先按暂停结算（`finish_pause`：结算收听、落库、位置冻结），再重建到系统兜底设备并停在暂停态，写 `error` 文案并发系统通知（托盘播放时应用内错误条看不见）。这样用户按播放就能在兜底设备上续上，不必等看门狗 12s 软重载 + 12s 重建。旧设备消失时**不**以「能否取到默认设备名」为前提：只剩一个 USB DAC 时拔掉它，`default_output_device()` 会返回 `None`，以它为前提就会漏判。找不到任何输出设备时保留空设备名并进入 `Error` 状态，不崩溃（对应 REQUIREMENTS §4.3）。
- **旧设备还在、默认换了人（插入耳机 / HDMI）→ 保持原行为无缝续播**。固定设备模式下默认换人与本应用无关（流还挂在用户指定的设备上），不动。用户主动在设置页切换设备同样续播；但若选定的固定设备当前不在枚举里，则与被动移除同路径处理（暂停 + 说明）。

`rebuild_output` 记录迁移位置时：Playing 态取 `sink.get_pos()` 实时值，其余状态取快照 `position_ms` —— Loading 期间 sink 里还是**上一首**（新流要等 `mount_decoder` 才 clear），取实时值会把新曲定位到错误的地方。

## 7.10 播放地址缓存（修正：不落库）

缓存实现为 `Arc<RwLock<HashMap<PlayUrlKey, PlayUrl>>>`，**进程内存**，进程退出即失效。

```rust
struct PlayUrlKey { platform: SourceId, track_id: String, quality: Quality }
```

1. 键：`platform + track_id + quality`（与原文一致）。
2. 有效期 10 分钟，命中时使用条目自身的 `fetched_at`，不刷新。
3. 播放失败即 `invalidate` 并重取一次。
4. **不写入 SQLite**：播放地址是短时凭据，落库既无收益（重启必然过期）又扩大泄露面。这与移动端 `types/music.ts` 中 `urlFetchedAt` 的注释（不持久化）保持一致。
5. 本地文件路径不进该缓存，直接从 `tracks.local_path` 读。

## 7.11 时间轴精度（如何达成 50ms 同步误差）

| 层 | 频率 | 说明 |
|---|---|---|
| Rust `sink.get_pos()` | 250ms | 发 `position-changed { positionMs, monotonicMs }`，`monotonicMs` 为发送时刻单调时钟 |
| 前端插值 | `requestAnimationFrame` | `pos = lastPos + (performance.now() - lastRecvAt)`，播放中才插值 |
| 校正 | 每次收到 tick | 若插值值与真实值偏差 > 120ms 则硬跳，否则在 200ms 内平滑收敛，避免歌词抖动 |
| seek / 切歌 | 立即 | 立即发一次 tick，取消插值 |

误差来源与预算：音频输出缓冲延迟（约 20–40ms，可用固定偏移补偿）+ 事件传递（<5ms）+ 插值误差（<16ms），合计可控在 50ms 内。**桌面歌词窗口必须自行插值**，不能依赖主窗口转发（见 §10.2）。

## 7.12 播放失败分类与自动切歌熔断（2026-10-03 弱网修复）

播放失败分**环境**与**内容**两类，二者的处置相反，混在一起会把网络波动放大成「疯狂不可用」：

| 分类 | 判定来源 | 处置 |
|---|---|---|
| 环境（`stalled`） | 取链桥超时 / 引擎相位未就绪 / emit 失败 / 前端 `[网络]` 标记 | **不计熔断**，指数退避原地重试同一首（3s → 6s → 12s，上限 20s，最多 3 次） |
| 内容 | 引擎确实返回「无可用播放地址」（跨源全灭、地址失效） | 计入 `fail_streak`，跳过到下一首 |

前端 `[网络]` 标记的判定（`qt-sources/src/actions/play-url.ts`）有两个来源，缺一不可：

1. **trace 判据** `isNetworkOnlyFailure`：整链全灭且没有任何一条线路拿到过实质响应。白名单含「超时未返回 / 预算耗尽未跑 / 请求超时 / 超时 / err: / 死链」。**「空」故意不在白名单**——`searched: true` 的空是「搜索跑通了、目标平台确实没有这首」，属内容问题；弱网导致的搜索失败走「超时未返回」分支。
2. **耗时判据**（2026-10-03 用户日志复盘补）：`budget.remainingMs <= budget.totalMs * 0.08` 即**预算烧光**。用户实测日志「`ERROR 自动取址失败: 无可用播放地址` 每 5s 一条」正是链跑满预算仍无地址，而 trace 里可能一条超时都没有（档内答空 + 跨源答空），单靠 trace 措辞判不出网络问题。耗时是客观事实，留 8% 余量避免「秒答空」被误判。

熔断：`fail_streak >= FAIL_STREAK_LIMIT`（5）→ 关闭 `auto_next` 并发系统通知。修复前**所有**失败一律计数，弱网下每首约 5s（取链链内预算 `CHAIN_BUDGET_MS`）失败，连挂 5 首约 25s 就把自动切歌关死，且熔断是**单向门**——网络恢复后没人把播放拉回来，用户体感是「整晚放不回来」。

配套的恢复探测：熔断后按 15s → 120s 退避**真的取一次链**判恢复（最多 8 次），成功后重开 `auto_next` 并把当前曲重新拉起。

取链超时分层（不变量：外层必须严格大于内层）。链内预算为「原源搜索 5s + 换源兜底 4s」两段（`IN_TIER_MS` = 5000，跨源 reserve = 4000）：

```text
CHAIN_BUDGET_MS 9s + CHAIN_GRACE_MS 250ms = 9250ms（链内预算，四端共用 chain.json）
      < RESOLVE_TIMEOUT_MS 9.5s（前端引擎等待 = 9250ms + 250ms 调度余量）
      < ASK_TIMEOUT 14s（Rust 桥等待 = 9.5s + 4.5s，含 set_resolved_play_url
                         与 resolve_play_url_reply 两次 IPC 往返）
```

修复前 `ASK_TIMEOUT` 与 `RESOLVE_TIMEOUT_MS` **相等**（都是 15s），前端必然在被判超时之后才把答案送回来，慢取链 100% 被丢弃——这是用户所说「15S 不对」的直接来源。App 侧同口径：`URL_FETCH_BUDGET_MS` 10s（硬上限）< `PLAY_TIMEOUT_MS` 12s < 原生 `RESOLVE_TIMEOUT_SECONDS` 15s。

另有播放位置冻结看门狗：位置 12s 不动 → 软重载；再 8s 不动 → 重建输出流；累计 3 次 → 报错并系统通知。`STALL_POS_TIMEOUT` 必须大于 `range_reader::FIRST_PACKET_TIMEOUT`（8s），否则会把正常的首包等待误判成冻结。

---

## 8. 数据存储设计

## 8.1 数据目录

根目录按平台取自系统数据目录，再固定拼一层 `QuietMusic/`（`src-tauri/src/app_paths.rs`）：

| 平台 | 数据根 | 日志根 |
|---|---|---|
| Windows | `%APPDATA%/QuietMusic/` | 同左 `logs/` |
| Linux | `$XDG_DATA_HOME/QuietMusic/`（缺省 `~/.local/share/QuietMusic/`） | `$XDG_STATE_HOME/QuietMusic/logs/`（缺省 `~/.local/state/QuietMusic/logs/`） |
| macOS | `~/Library/Application Support/QuietMusic/` | `~/Library/Logs/QuietMusic/` |

非 Windows 不使用 Tauri 的 `app_data_dir()`（那是 `<identifier>` 口径）也不用 `app_cache_dir()`
（缓存目录会被系统清理，不能放数据库）；Windows 保留 3.0.3 之前 `LightListen` 旧目录的整目录改名迁移。

```text
<数据根>/
 ├─ data/
 │   └─ music.db
 ├─ cache/
 │   ├─ covers/
 │   ├─ lyrics/
 │   └─ waveform/
 ├─ themes/
 │   ├─ default-light.ltskin.json
 │   └─ default-dark.ltskin.json
 ├─ logs/
 │   └─ app.log
 ├─ settings/
 │   └─ window-state.json
 └─ backups/
     └─ music-2026-09-05.db
```

## 8.2 数据分层

| 层 | 保存内容 | 生命周期 |
|---|---|---|
| SQLite | 歌单、收藏、历史、扫描结果、设置 | 永久 |
| Cache | 封面、歌词缓存、波形 | 可删除可重建 |
| Memory | 播放状态、UI 状态 | 进程内 |
| Logs | 运行日志、错误日志 | 保留最近 30 天 |

## 8.3 SQLite 表设计

### tracks

在线歌曲与本地歌曲统一入库。`id` 使用 `platform:原始id` 生成，保证跨音源唯一。

**修正（R1）**：原设计包含 `url` 与 `url_fetched_at` 两列。播放地址是 10 分钟即失效的短时凭据，落库后重启必然过期，只会带来「读到脏地址 → 播放失败 → 再取址」的额外分支，且扩大了泄露面。改为**只放进程内缓存**（§7.10），表中去掉这两列。

```sql
CREATE TABLE tracks (
  id            TEXT PRIMARY KEY,          -- platform:原始id，如 wyy:1234567
  platform      TEXT NOT NULL,             -- wyy / qq / kw / kg / local
  title         TEXT NOT NULL,
  singer        TEXT NOT NULL,
  album         TEXT NOT NULL,
  pic_url       TEXT,
  duration_ms   INTEGER,
  music_id      TEXT,                      -- 音源侧二级 ID（kw 的 musicrid、kg 的 hash 等）
  -- 本地文件属性（在线曲目为 NULL）
  local_path    TEXT,
  file_size     INTEGER,
  format        TEXT,
  sample_rate   INTEGER,
  bit_rate      INTEGER,
  mtime         INTEGER,                    -- 增量扫描依据（§13.2 要求，原文表中缺失）
  content_hash  TEXT,                       -- 可选，用于重命名/移动识别
  -- 排序与检索
  title_pinyin  TEXT,                       -- 全拼，用于拼音搜索与排序（§8.6）
  title_initial TEXT,                       -- 首字母缩写，如「qingting」→「qt」
  missing       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX idx_tracks_platform ON tracks(platform);
CREATE INDEX idx_tracks_singer   ON tracks(singer);
CREATE INDEX idx_tracks_album    ON tracks(album);
CREATE INDEX idx_tracks_missing  ON tracks(missing);
CREATE UNIQUE INDEX uk_tracks_local_path ON tracks(local_path) WHERE local_path IS NOT NULL;
```

`platform` 保存 `wyy / qq / kw / kg` 或 `local`，与 Astral 收藏接口的 `platform` 字段直接兼容。

**入库时机**：在线曲目只在「进入队列 / 被收藏 / 被加入歌单 / 产生播放历史」时落库，搜索结果与榜单列表**不入库**，否则 `tracks` 会被浏览行为迅速膨胀到几十万行。

### playlists

```sql
CREATE TABLE playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  cover_path TEXT,
  is_smart INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  is_favorite INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### playlist_tracks

```sql
CREATE TABLE playlist_tracks (
  playlist_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, track_id),
  FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
  FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);

CREATE INDEX idx_playlist_tracks_position
ON playlist_tracks(playlist_id, position);
```

### liked_songs

与 Astral `qt_like_song` 对齐，用于收藏增量同步。

```sql
CREATE TABLE liked_songs (
  id TEXT PRIMARY KEY,
  uid INTEGER NOT NULL,
  sid TEXT NOT NULL,
  platform TEXT NOT NULL,
  name TEXT NOT NULL,
  singer TEXT NOT NULL,
  album TEXT NOT NULL,
  hash TEXT,
  deleted_at INTEGER,
  updated_seq INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(uid, platform, sid)
);

CREATE INDEX idx_liked_songs_uid_seq ON liked_songs(uid, updated_seq);
```

### liked_playlists

与 Astral `qt_like_playlist` 对齐。

```sql
CREATE TABLE liked_playlists (
  id TEXT PRIMARY KEY,
  uid INTEGER NOT NULL,
  pid TEXT NOT NULL,
  platform TEXT NOT NULL,
  name TEXT NOT NULL,
  pic_url TEXT,
  is_import INTEGER DEFAULT 0,
  deleted_at INTEGER,
  updated_seq INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(uid, platform, pid)
);

CREATE INDEX idx_liked_playlists_uid_seq ON liked_playlists(uid, updated_seq);
```
### play_history

```sql
CREATE TABLE play_history (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL,
  played_at INTEGER NOT NULL,
  played_duration_ms INTEGER NOT NULL,
  completed INTEGER DEFAULT 0,
  FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);

CREATE INDEX idx_play_history_time ON play_history(played_at DESC);
```

### play_stats

v1 建表，v15 补 `finished_count`（下方为**当前**完整形态）：

```sql
CREATE TABLE play_stats (
  track_id TEXT PRIMARY KEY,
  play_count INTEGER NOT NULL DEFAULT 0,
  -- 其中完整听完的次数（v15）；老数据的完播情况当年没记，补列时归 0
  finished_count INTEGER NOT NULL DEFAULT 0,
  last_played_at INTEGER NOT NULL,
  total_played_ms INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);

CREATE INDEX idx_play_stats_count ON play_stats(play_count DESC);
```

**结算口径（2026-11 修正，用户：累计时长要考虑一首歌是不是听完了）**：
旧口径是「起播即结算」——挂载成功就把整曲时长记进 `total_played_ms`、`play_count`
+1，中途跳过从不回写，于是「点开听 10 秒切掉」与完整听完在报告里完全一样，
累计时长与平均每次都被抬高。现在由 `audio/engine.rs` 的 `ListenSession`
按**真实收听**记账并在结束时结算（切歌 / 停止 / 播完 / 退出，另有每 30 秒的
定期落库兜底）：

- **时长**按墙钟累计，且只在内容位置**真的在推进**时计：暂停、缓冲卡住、
  拖动 seek 跳过的那一段都不算；倍速不影响（听 1 分钟就是 1 分钟）。
- **一次有效播放**（`play_count`）＝ 自然播完，或收听 ≥ 曲目时长一半**且**
  ≥ 30 秒（`db::store::counts_as_play`；时长未知时只认 30 秒门槛）。
- **完播**（`finished_count`）单独一列，只在自然播完时 +1，报告页用它算完播率。
- 同一首的**重载**（弱网原地重试 / 恢复现场 / 换音质续播）不重开会话，
  仍算同一次收听；`play_history` 仍在起播时写（最近播放语义），结束时回填
  `played_duration_ms` / `completed`。

规则本身放在 `db::store::stats`（`counts_as_play`），引擎只负责记账，
改口径不用碰音频线程。

### play_days

v18 建表。`play_stats` 只有每首歌的**累计**值，回答不了「最近在听什么」，趋势与窗口榜需要按自然日切片，于是每次结算在同一次事务里再累加一行：

```sql
CREATE TABLE play_days (
  track_id TEXT NOT NULL,
  -- 本地自然日 YYYY-MM-DD
  day TEXT NOT NULL,
  play_count INTEGER NOT NULL DEFAULT 0,
  total_played_ms INTEGER NOT NULL DEFAULT 0,
  last_played_at INTEGER NOT NULL,
  PRIMARY KEY (track_id, day),
  FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);

CREATE INDEX idx_play_days_day ON play_days(day DESC);
```

- **同源同刻**：`record_listen` 一次事务写 `play_stats` 与 `play_days` 两处，有效播放 / 完播 / 时长的口径完全一致，不存在两套数字对不上的可能。
- **日期用本地自然日**，与移动端 `listenDayKey` 同口径；不能用 UTC，否则东八区凌晨 0-8 点的播放会算进前一天。
- **窗口下界**与写入侧共用同一段 SQL 表达式（`listen_report.rs` 的 `window_start`），避免读写两侧各算一次日期而错开一天。
- **迁移不回填、首次进报告页补齐**：v18 迁移本身不写 `play_days`（老数据的按天分布毫无依据，在迁移里编一个分布比留空更不诚实）；存量播放由报告页首次打开时调用的 `seed_listen_days` 统一归到「今天」。该函数只搬「`play_stats` 累计 − `play_days` 已有之和」的**差额**（整笔搬会把今天已经按天记过的播放再加一遍），因此**天然幂等**、不需要 `daysSeeded` 之类的持久化标记，恢复备份后也能自动补齐。`play_overview.active_days` 只数 `play_days` 里 `play_count > 0 OR total_played_ms > 0` 的日子（全零补行不算活跃）。
- **听歌统计清除**：`clear_listen_stats` 是「清理缓存」勾选组里的一个选项（默认**不勾**），一次事务删掉 `play_stats`、`play_days` 与 `play_history` 三张表；因为不可再生，勾上后「清理」按钮要走两击确认（第一击只武装成「再点一次确认清除」，3 秒复位），且武装状态下**连可再生缓存也一起不执行** —— 用户点「清理」的心智是「清缓存」，不能顺手把累计删了。可再生缓存那几项仍是默认全勾、一次点击就执行。
- **统计与播放记录是一起清的**：两者本来就是同一份收听数据的两种看法（`play_history` 记最后一次播放、`play_stats` 记累计），只清一半会留下「统计归零、但最近播放还在」的反直觉状态，用户点完还得再去历史页清一次。收藏、歌单不受影响。随之归零的还有首页「为你整理」（§5.2，它读的就是 `play_stats`）与听歌报告。`play_days` / `play_stats` / `play_history` 都在 `backup.rs` 的 `TABLES` 里，导出/导入不会丢。
- 读它的两条路径：`get_listen_day_report`（逐日趋势 + 窗口总量 + Top N）与 `get_listen_report` 带 `days` 时（窗口内分页明细）。两者走同一段分组 / 排序 SQL，所以日榜上点进去看到的行必定对得上。

### download_tasks

v1 建表，v7 / v14 各补列（下方为**当前**完整形态）：

```sql
CREATE TABLE download_tasks (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  -- 请求档位：用户点下载时选的（128 / 320 / flac / 音源包声明的任意档）
  quality TEXT NOT NULL,
  -- v14：实测档位 —— 取址时按「实测字节 ÷ 时长」重标（只降不升）；
  -- NULL = 这次没测出来，UI 退回 quality 显示
  actual_quality TEXT,
  status TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  file_path TEXT,
  file_size INTEGER,
  error TEXT,
  -- v7：断点续传的 .part 临时路径与进度总长（完整性判定使用本次 HTTP 响应范围/长度）
  part_path TEXT,
  total_bytes INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);

CREATE INDEX idx_download_tasks_status ON download_tasks(status);
```

`quality` 与 `actual_quality` 并存是刻意的：前者是**用户意图**（去重键也用它，
`find_download_task` 按 `(track_id, quality)` 命中），后者是**实际交付**。
下载列表展示后者（`actualQuality || quality`）——请求 flac 而线路只回 320k mp3
时标请求档就是虚标。
### scan_dirs

```sql
CREATE TABLE scan_dirs (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  enabled INTEGER DEFAULT 1,
  last_scan_at INTEGER,
  created_at INTEGER NOT NULL
);
```

### providers

```sql
CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  config TEXT,
  status TEXT DEFAULT 'disconnected',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### pending_like_ops

```sql
CREATE TABLE pending_like_ops (
  id TEXT PRIMARY KEY,
  uid INTEGER NOT NULL,
  type TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_pending_like_ops_retry ON pending_like_ops(uid, next_retry_at);
```
### like_sync_state

```sql
CREATE TABLE like_sync_state (
  uid INTEGER PRIMARY KEY,
  cursor INTEGER NOT NULL DEFAULT 0,
  last_sync_at INTEGER,
  last_error TEXT
);
```
### themes

```sql
CREATE TABLE themes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT,
  is_active INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### settings

```sql
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### schema_migrations

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
```

### 补充表（原文缺失，但被 IPC / 需求直接依赖）

```sql
-- 歌词缓存：在线歌词不能每次切歌都重新请求（IPC load_lyric / §10.3 依赖）
CREATE TABLE lyrics (
  track_id     TEXT PRIMARY KEY,
  lrc          TEXT,                       -- 逐行 LRC
  word_lrc     TEXT,                       -- 逐字（yrc/qrc/krc 归一后的 JSON），无则 NULL
  translation  TEXT,
  romaji       TEXT,
  source       TEXT NOT NULL,              -- provider / embedded / file / manual
  fetched_at   INTEGER NOT NULL,
  FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);

-- 歌词偏移（IPC set_lyric_offset / get_lyric_setting 依赖）
CREATE TABLE lyric_settings (
  track_id   TEXT PRIMARY KEY,
  offset_ms  INTEGER NOT NULL DEFAULT 0,
  lyric_path TEXT,                          -- 用户手动关联的歌词文件
  updated_at INTEGER NOT NULL
);

-- 播放队列持久化（需求「记忆上次播放状态 / 恢复播放现场」依赖）
CREATE TABLE play_queue (
  position   INTEGER PRIMARY KEY,
  track_id   TEXT NOT NULL,
  FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);

-- 搜索历史（需求 §3.7 依赖）
CREATE TABLE search_history (
  keyword     TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,                -- current / all / local
  searched_at INTEGER NOT NULL
);

-- 统计上报失败队列（需求 §3.19「上报失败进入本地队列重试」依赖）
CREATE TABLE stat_queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  payload    TEXT NOT NULL,                 -- StatEventDTO 的 JSON
  retry      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
```

> `play_queue` 用 `position` 做主键便于整表替换；恢复现场所需的 `queue_index / position_ms / quality / play_mode / volume` 存入 `settings`。

## 8.4 数据迁移策略

1. SQLite 使用版本号迁移。
2. 应用启动时检查 `schema_migrations`。
3. 新版本迁移前自动备份数据库。
4. 迁移失败则回滚并提示用户。
5. 不允许直接删除旧字段，旧字段保留至少一个版本。

---

## 8.5 收藏同步设计

### 同步模型

沿用 Astral 现有收藏同步协议：

1. 每次收藏或取消收藏返回 `seq`。
2. `seq` 是用户维度递增游标。
3. 客户端保存本地 `cursor`。
4. 常规同步调用 `GET /app/user/like/changes?since=cursor`。
5. 首次登录或游标丢失时调用 `GET /app/user/like/list?page=&size=` 全量分页拉取。

### 启动同步流程

```text
应用启动
   │
   ▼
检查 Astral 登录状态
   ├── 未登录：只使用本地收藏
   └── 已登录：继续
   │
   ▼
读取本地 like cursor
   ├── 无游标：全量分页拉取
   └── 有游标：增量拉取
   │
   ▼
应用服务端变更
   │
   ▼
更新本地 cursor = maxSeq
```

### 本地收藏流程

```text
用户点击收藏 / 取消收藏
   │
   ▼
立即更新本地 UI 和 SQLite
   │
   ▼
写入 pending operation 队列
   │
   ▼
调用 Astral 单条接口
   ├── 成功：更新 likeSeq，移除 pending
   └── 失败：保留 pending，稍后重试
```

### 冲突处理

1. 以 `platform + id` 作为业务唯一键。
2. 本地记录与服务端变更都携带 `updatedSeq`。
3. 只应用 `updatedSeq` 大于本地记录的变更。
4. 相同 `updatedSeq` 时以服务端为准。
5. 删除使用软删除，不物理删除本地记录。
6. 待同步操作与远端变更冲突时，以时间较新的操作为准。

### 重试策略

1. 网络失败后保留待同步队列。
2. 使用指数退避重试。
3. 应用回到前台时触发一次同步。
4. 网络恢复事件触发一次同步。
5. 连续失败超过阈值后降低同步频率。
6. 用户手动刷新收藏时立即重试。

---

## 8.6 本地检索索引（原文缺失）

需求要求「10 万首规模、搜索 1 秒内返回本地结果」，仅靠 `LIKE '%kw%'` 无法达成（全表扫描且无法用索引）。设计如下：

```sql
CREATE VIRTUAL TABLE tracks_fts USING fts5(
  title, singer, album, pinyin, initial,
  content = 'tracks',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);
```

| 事项 | 设计 |
|---|---|
| 同步 | `tracks` 上建 INSERT / UPDATE / DELETE 触发器同步 FTS 表；批量扫描时先 `DROP` 触发器、导入完再重建并 `rebuild`，避免逐行开销 |
| 中文分词 | FTS5 的 `unicode61` 不做中文分词，因此中文靠 **前缀匹配 + 拼音列** 兜底：查询串同时按原文、全拼、首字母三路匹配后合并去重 |
| 拼音生成 | 入库时由 Rust `pinyin` crate 生成 `title_pinyin` / `title_initial`，多音字取常用读音，不追求 100% 准确 |
| 排序 | 命中优先级：标题精确 > 标题前缀 > 歌手 > 专辑 > 拼音 > 首字母；同级按 `bm25()` |
| 编译前置 | rusqlite 需确认启用 FTS5（`bundled-full`，或 `bundled` + `SQLITE_ENABLE_FTS5`）；缺失时降级为 `LIKE` 并在日志告警 |

## 8.7 外键与清理安全边界（原文风险点）

原文多张表使用 `FOREIGN KEY ... ON DELETE CASCADE` 指向 `tracks`。配合「清理失效文件」功能会造成**静默数据丢失**：删掉一行 `tracks`，会连带删除该曲目的歌单条目、播放历史、播放统计、下载记录。

约束：

1. `remove_missing_tracks` **只允许**把 `missing` 置 1，或删除「未被任何歌单 / 历史 / 下载引用」的行；被引用的行永不物理删除。
2. `PRAGMA foreign_keys = ON` 必须显式开启（SQLite 默认关闭），否则上述 CASCADE 根本不生效，会留下悬挂引用——这是比误删更隐蔽的问题。
3. `playlist_tracks` 删除歌单时 CASCADE 是期望行为；删除曲目时应改为 `ON DELETE RESTRICT`，由业务层显式处理。
4. 所有破坏性操作（清理失效、清空历史、重置数据、恢复数据库）执行前先落一份备份到 `backups/`，并在 UI 二次确认。
5. `restore_database` 必须校验目标文件是合法 SQLite 且 `schema_migrations.version` ≤ 当前程序支持版本，否则拒绝恢复。

## 8.8 配置项的唯一归属（原文存在双写风险）

原文同时存在 `settings` 表、`settings/window-state.json`、`themes` 表、`providers` 表，职责有重叠。定稿：

| 数据 | 唯一存放位置 |
|---|---|
| 用户偏好（音质、播放模式、音量、快捷键、EQ、下载目录、统计开关等） | `settings` 表 |
| 窗口位置 / 尺寸 / 最大化 | `tauri-plugin-window-state` 自有存储 |
| 桌面歌词窗口位置与样式 | `settings` 表（键 `lyric.window`），**不与主窗口混存** |
| 当前皮肤 ID + 外观模式 | `settings` 表；皮肤内容存 `themes/*.ltskin.json` 文件，`themes` 表只做索引 |
| 音源启用状态 | `settings` 表；`providers` 表在第一版**不建**（四大音源硬编码注册，无用户配置），留到 WebDAV 阶段再加 |
| Astral satoken / refreshToken | Windows 凭据管理器（§17.1），不入库 |
| AI 模型接口配置档（`ai.profiles` + `ai.activeProfile`） | `settings` 表，JSON。**Key 明文入库**，不走凭据管理器 —— 理由与代价见 §17.1「例外：AI 模型 Key」 |
| 每日推荐的推荐方式 / 口味（`dailyRecommend.mode` / `.taste`） | `settings` 表 |
| 每日推荐的风格种子（`dailyRecommend.styleSeeds`） | `settings` 表，JSON 数组。存**风格名**（如「摇滚」）而不是平台分类 id —— id 跨音源不稳定，名字是用户认得、也不会随音源漂移的东西 |
| 每日推荐的当天结果与历史（`dailyRecommend.cache`） | `settings` 表，JSON。属于**可再生的派生数据**，但随 `settings` 表一起进备份（`backup.rs` 的 `TABLES` 含 `settings`）；「清理缓存」的可选项（`lib/runtime-cache.ts` 的 5 类进程内缓存 + 音频 / 浏览器缓存 + 听歌统计）**不含它** —— 用户点「清理缓存」的心智是清可再生的临时文件，不该顺手把今天的推荐重置掉 |
| 聚合搜索只用哪几个源（`search.aggregateSources`） | `settings` 表，JSON 字符串数组（源 id）。**空值 / 未配置 = 全部音源**（一个都不勾不该变成搜不到）；「全选」也写空值，好让数据包以后新增的源自动参与。读侧带进程内缓存，解析失败按「全部」兜底，见 §0.3-I |

## 9. 主题与皮肤设计

## 9.1 主题系统架构

```text
主题 JSON 文件
   │
   ▼
Rust 读取并校验
   │
   ▼
前端 ThemeStore
   │
   ▼
转换为 CSS Variables
   │
   ▼
Tailwind + shadcn/ui 响应渲染
```

## 9.2 主题配置结构（修正 R7：拆分「外观偏好」与「皮肤定义」）

**原文问题**：`ThemeConfig.mode: 'light' | 'dark' | 'system'` 把「用户偏好」写进了皮肤文件，同时 `colors` 只有一套。结果是：

- 用户导入一个 `mode: 'dark'` 的皮肤，会连带覆盖他的「跟随系统」设置；
- 皮肤只有一套色板，切到系统深色时没有对应颜色，只能整体反色或直接失效。

修正为两层：**外观偏好（用户级、不随皮肤走）** + **皮肤定义（含 light/dark 两套色板）**。

```ts
/** 用户级外观偏好，存 settings 表，不随皮肤导入导出 */
export interface AppearancePreference {
  mode: 'light' | 'dark' | 'system'
  skinId: string
  followCoverColor: boolean     // 是否启用封面取色
  reduceMotion: boolean         // 低性能设备关闭动画
  fontScale: number             // 0.9 ~ 1.3
}

/** 皮肤定义，即 .ltskin.json 文件内容 */
export interface Skin {
  schema: 1                     // 结构版本，用于兼容判断
  id: string                    // 唯一标识，导入冲突时按 id 覆盖或改名
  name: string
  author?: string
  version: string
  /** 两套色板必填；单色板皮肤可让 dark 直接复用 light，但必须显式写出 */
  tokens: { light: SkinTokens; dark: SkinTokens }
  radius: number                // px，映射到 --radius
  fontFamily?: string           // 仅允许本地已安装字体名或内置字体名
  playerBar: { height: number; blur: boolean; opacity: number }
  background?: SkinBackground   // 背景图（原文缺失，见 §9.6）
  lyric: LyricStyle             // 应用内歌词默认样式（桌面歌词样式独立，见 §10）
}

export interface SkinTokens {
  // —— shadcn/ui 标准令牌（必须原名，否则 shadcn 组件不跟随皮肤）——
  background: string; foreground: string
  card: string; cardForeground: string
  popover: string; popoverForeground: string
  primary: string; primaryForeground: string
  secondary: string; secondaryForeground: string
  muted: string; mutedForeground: string
  accent: string; accentForeground: string
  destructive: string; destructiveForeground: string
  border: string; input: string; ring: string
  // —— 轻听业务扩展令牌 ——
  sidebar: string; sidebarForeground: string
  playerBar: string
  lyricActive: string; lyricIdle: string
  spectrumFrom: string; spectrumTo: string
}

export interface SkinBackground {
  image?: string                // 相对皮肤目录的路径，或用户本地绝对路径
  blur: number                  // 0 ~ 40 px
  opacity: number               // 0 ~ 1
  fit: 'cover' | 'contain' | 'tile'
  tint?: string                 // 叠加色，保证前景文字对比度
}

export interface LyricStyle {
  fontSize: number
  fontWeight: number
  opacity: number
  shadow: boolean
  stroke: boolean
  gradient: [string, string]
}
```

### 默认主题基线

PC 默认皮肤延续移动端品牌色（取自 `qt-uniappx/uni.scss` 与 `theme.json`）：

| Token | 浅色 | 深色 |
|---|---|---|
| primary | `#e5484d` | `#ff5c63` |
| background | `#f6f7f9` | `#12151c` |
| card | `#ffffff` | `#161a23` |
| foreground | `#191d26` | `#e8ecf7` |
| mutedForeground | `#6b7385` | `#8a93a6` |
| border | `#edeff3` | `#252a35` |
| sidebar | `#ffffff` | `#161a23` |

> 颜色值内部统一转 **OKLCH** 存储与运算（Tailwind v4 与 shadcn 默认色彩空间），皮肤文件允许写 hex / rgb / oklch，导入时归一。OKLCH 下调明度和做透明叠加不会出现灰脏色，这是选它的原因。

## 9.3 CSS Variables（修正 R6：必须使用 shadcn 令牌名）

**原文问题**：变量命名为 `--app-background` / `--app-primary`。shadcn/ui 的组件源码写的是 `bg-background`、`text-foreground`、`bg-primary`，这些工具类在 Tailwind v4 下解析到 `--color-background` / `--color-primary`。用 `--app-*` 自定义名会导致**所有 shadcn 组件完全不跟随皮肤**，只有自研组件生效——这是会在集成阶段才暴露的返工点。

正确做法：变量用标准名，再用 `@theme inline` 把变量桥接成 Tailwind 的颜色令牌。

```css
/* src/index.css */
@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));

:root {
  --radius: 0.75rem;
  --background: oklch(0.976 0.002 264);
  --foreground: oklch(0.219 0.017 267);
  --card: oklch(1 0 0);
  --card-foreground: var(--foreground);
  --primary: oklch(0.606 0.196 19.4);        /* #e5484d */
  --primary-foreground: oklch(1 0 0);
  --muted: oklch(0.962 0.004 264);
  --muted-foreground: oklch(0.512 0.021 265);
  --border: oklch(0.945 0.004 264);
  --input: var(--border);
  --ring: var(--primary);
  /* 业务扩展 */
  --sidebar: oklch(1 0 0);
  --player-bar: oklch(1 0 0 / 0.96);
  --player-bar-height: 84px;
  --lyric-active: var(--primary);
  --lyric-idle: var(--muted-foreground);
}

.dark {
  --background: oklch(0.196 0.014 267);
  --foreground: oklch(0.925 0.011 265);
  --card: oklch(0.232 0.017 267);
  --primary: oklch(0.681 0.181 18.6);        /* #ff5c63 */
  --border: oklch(0.297 0.017 267);
  --sidebar: oklch(0.232 0.017 267);
  --player-bar: oklch(0.232 0.017 267 / 0.86);
}

/* 关键桥接：让 bg-background / text-primary 等工具类落到上面的变量 */
@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-sidebar: var(--sidebar);
  --color-lyric-active: var(--lyric-active);
  --radius-lg: var(--radius);
}
```

### 皮肤应用流程

```text
用户选择皮肤 / 修改外观偏好
   │
   ▼
Rust 读取 .ltskin.json → 结构校验 + 颜色归一 → 返回 Skin
   │
   ▼
前端 ThemeStore：按 AppearancePreference.mode 选 tokens.light 或 tokens.dark
   │  （mode = system 时监听 matchMedia('(prefers-color-scheme: dark)')）
   ▼
写入 document.documentElement.style.setProperty('--xxx', value)
   │  + 切换 .dark class
   ▼
广播 theme-changed → 桌面歌词窗口同步应用（两个窗口共享同一套写入逻辑）
```

要点：

1. 皮肤切换**只改 CSS 变量**，不重挂载组件，因此无需重启也不闪屏；过渡动画对 `background-color` / `color` 加 150ms transition，且在 `reduceMotion` 下关闭。
2. 首帧前必须先写入变量（从 `settings` 同步读取，走 Rust 的启动快照），否则会出现浅色闪一下再变深色。
3. 桌面歌词窗口独立应用主题，禁止依赖主窗口 DOM。

### 封面取色的优先级（原文未定义）

封面取色与用户自定义皮肤会争夺同一批变量，必须定优先级：

| 层级 | 覆盖范围 |
|---|---|
| 1. 皮肤 tokens | 全量令牌，基础层 |
| 2. 封面取色（`followCoverColor = true` 时） | **只覆盖** `--primary`、`--lyric-active`、`--spectrum-*`、播放页背景色；不覆盖 `--background` / `--card` / `--border`，避免整体界面随每首歌跳色 |
| 3. 用户在皮肤编辑器中显式锁定的令牌 | 最高优先级，取色不覆盖 |

取色还必须保证对比度：生成的 `--primary` 与 `--primary-foreground` 的 APCA / WCAG 对比度不足时自动调整明度，直到达标（对应 REQUIREMENTS §3.8 验收第 5 条）。


## 9.4 封面取色流程

```text
当前歌曲切换
   │
   ▼
Rust 读取封面
   │
   ▼
提取主色 / 辅助色 / 暗色
   │
   ▼
发送 cover-color-changed 事件
   │
   ▼
React 更新 CSS Variables
   │
   ▼
背景 / 按钮 / 进度条 / 频谱联动变化
```

颜色提取规则：

1. 忽略过亮和过暗区域。
2. 优先选择饱和度适中的颜色。
3. 生成可读的前景色。
4. 深色模式自动加深背景。
5. 浅色模式自动提亮背景。

## 9.5 主题文件校验（白名单式）

导入是**唯一的外部数据入口**，必须按白名单校验，而不是「检查有没有脚本」这种黑名单思路：

| 校验项 | 规则 | 失败处理 |
|---|---|---|
| 文件大小 | `.ltskin.json` ≤ 256KB；`.ltskin` 包 ≤ 8MB | 拒绝导入 |
| 结构 | `schema` 必须等于当前支持版本；未知字段**直接丢弃**而非报错（向前兼容） | 丢弃未知字段 |
| 必填 | `id / name / version / tokens.light / tokens.dark / radius` | 拒绝导入 |
| `id` | `^[a-z0-9][a-z0-9-]{1,31}$`，用于目录名，杜绝路径穿越 | 拒绝导入 |
| 颜色值 | 只接受 `#RGB(A) / #RRGGBB(AA) / rgb() / rgba() / oklch() / hsl()`，正则匹配后再解析；解析失败回落该令牌的默认值 | 单令牌回落 |
| 数值范围 | `radius 0~24`、`opacity 0~1`、`blur 0~40`、`fontSize 8~72`、`playerBar.height 64~120` | 钳制到区间 |
| `fontFamily` | 只接受字体族名字符串，且必须在「本地已安装字体 + 内置字体」列表中；不接受 `url()` | 回落默认字体 |
| 资源路径 | 只允许皮肤目录内的相对路径，禁止 `..`、绝对路径、UNC 路径、符号链接；扩展名限 `png/jpg/jpeg/webp` | 拒绝该资源 |
| 图片 | 单图 ≤ 4MB，像素 ≤ 4096×4096，须能被 `image` crate 正常解码 | 拒绝该资源 |
| 远程引用 | 任何 `http(s)://` 引用**一律拒绝**（不是「不自动加载」，而是不允许出现） | 拒绝导入 |
| 对比度 | `foreground` 与 `background` 对比度低于阈值时**警告但不拦截**，在编辑器中标红 | 提示 |

失败一律回落到内置默认皮肤，并保留原皮肤文件供用户排查（对应 REQUIREMENTS §3.8 验收第 4 条）。校验逻辑放在 Rust，前端只消费已校验结构。

## 9.6 皮肤包与资源（原文缺失）

原文只定义了 `.ltskin.json` 单文件，但需求里的「自定义字体 / 播放条毛玻璃」以及主流播放器普遍具备的**自定义背景图**都需要携带资源。定两种形态：

| 形态 | 内容 | 用途 |
|---|---|---|
| `.ltskin.json` | 纯配置，单文件 | 最常见的分享形式，可直接贴文本 |
| `.ltskin` | ZIP 包：`skin.json` + `preview.png` + `assets/*` | 需要携带背景图的皮肤 |

存放位置：`<APPDATA>/<identifier>/themes/<skinId>/`，导入时解压到该目录；前端通过 `convertFileSrc()` 走 asset 协议读取图片，`assetProtocol.scope` 已限定在 `$APPDATA/**`（§4.1）。

背景图渲染：使用**独立的绝对定位层**（`背景图 → blur+opacity 层 → tint 层 → 内容层`），不要用 `body { background-image }` 叠 `backdrop-filter`，后者在 WebView2 上滚动时会掉帧。

Windows 11 云母 / 亚克力：作为**皮肤之外的独立开关**（`settings.appearance.windowEffect = none | mica | acrylic`），因为它依赖系统能力而非皮肤内容。开启时窗口背景需设为半透明，与「背景图」互斥；Win10 上不可用则自动降级为 `none` 并置灰选项。

## 9.7 皮肤编辑器

| 能力 | 说明 |
|---|---|
| 分基础 / 高级两档 | 基础只暴露 主色 / 圆角 / 深浅 / 背景图 4 项；高级暴露全部令牌（对应风险表「主题配置过多导致复杂」的应对） |
| 实时预览 | 直接写 CSS 变量，无需保存即生效；「取消」时还原快照 |
| 令牌锁 | 可锁定单个令牌，使封面取色不覆盖它（§9.4） |
| 派生色 | 修改 `primary` 时自动推导 `primary-foreground` / `ring` / hover 态，减少手工配色 |
| 导出 | 导出为 `.ltskin.json`；含背景图时打包为 `.ltskin` |
| 内置皮肤 | 默认浅色、默认深色、纯黑（OLED）、封面动态 4 套，内置皮肤只读，修改时自动另存副本 |

## 9.8 表面语言（自定义背景图下的半透明口径）

**背景图渲染在内容层之下**（§9.6 的独立绝对定位层，`opacity-40`），因此内容层里任何**实底**表面都会把壁纸整块盖住。浅色主题下 `--card` 就是纯白 `oklch(1 0 0)`、默认皮肤 `--background` 是 `#ffffff`，一旦写成实底 `bg-card`，设了背景图的用户在该页面**完全看不到壁纸** —— 这是踩过的坑（首页「榜单精选」卡片、听歌报告页整片纯白）。故定下统一口径：

| 层 | 底色 | 说明 |
|---|---|---|
| 标题栏 / 侧边栏 | `bg-[color:var(--sidebar-surface)]` | 由 `useAppearanceEffect` 派生：有背景图时 = `color-mix(… 35%, transparent)`，无背景图时等同 `--sidebar` |
| 页面内容卡片 / 砖块 / 胶囊 | `bg-card/50` ~ `bg-card/70` | 半透明砖，壁纸透出；同一页面内保持同一档（个人中心 `/60`、反馈 `/60`、发现页胶囊 `/60`、播放条 `/70`） |
| 浮层（弹窗 / 提示 / 悬浮按钮） | `bg-card/85` ~ `bg-card/95` + `backdrop-blur-xl` | 浮层要压住下面的内容，透明度不宜过低；toast 用 `/95`、确认框 `/90` |
| 次级面（骨架、封面占位、输入框内的选择器） | `bg-secondary` / `bg-secondary/60` | 中性灰，非纯白，不在此约束内 |
| 页头 hero 渐隐收尾色 | `bg-gradient-to-b from-background/10 to-[color:var(--page-fade)]` | 歌手 / 专辑 / 歌单详情 / 每日新歌共用；无背景图时等同 `--background`，有背景图时 ~80% 不透明，避免页头底部压出一条本色带、与紧邻的内容区脱节 |

**禁止**：内容层出现实底 `bg-card`（= 浅色主题纯白）。新增页面 / 卡片时按上表取值，不要图省事写 `bg-card`。

同理，**渐变的收尾色不要写实底 `to-background`**：那会在页头底部压出一条不透明的本色带，紧邻的内容区却是半透明砖，设了背景图时接缝很明显。收尾色统一用 `to-[color:var(--page-fade)]`（口径见上表）。

**例外**：`ShareCardPanel` 用 `getComputedStyle` 读 `--card` 画 canvas 导出图，必须拿到**不透明**的十六进制颜色 —— 因此不要通过改写 `--card` 变量本身来实现半透明（那会把导出的分享图也变透明），一律在调用点用 Tailwind 的 `/xx` 透明度修饰符。

`--popover`（下拉菜单 / 气泡）保持实底：菜单文字密集且面积小，半透明会与背后内容抢注意力。

---

## 10. 桌面歌词设计

## 10.1 窗口结构

```text
桌面歌词 WebviewWindow
 ├─ 歌词文字层
 ├─ 歌词翻译层
 ├─ 拖拽区域
 └─ 设置浮层（未锁定时显示）
```

## 10.2 歌词渲染流程（修正 R4：歌词窗口自行计算）

**原文问题**：原流程是「Rust 发进度 → 主窗口计算当前行 → emit 给歌词窗口 → 歌词窗口渲染」。这条链路在最常见的使用场景下会失效：用户开着桌面歌词、把主窗口最小化或切到别的应用去做事。此时主窗口的 WebView 被系统 / WebView2 降频，`requestAnimationFrame` 基本停摆、定时器被节流到秒级，主窗口算出来的「当前行」会卡住或跳变，**50ms 同步误差的验收标准不可能达成**。而且多绕一跳，多一次序列化。

修正后：**Rust 是唯一状态源，歌词窗口直接订阅并自行插值计算**，与主窗口完全解耦。

```text
切歌
 │  Rust 加载歌词（provider / 缓存 / 本地文件）→ 解析为 LyricDoc
 ▼
emit_to("lyrics", "lyric-loaded", LyricDoc)   ── 整篇歌词只下发一次
emit_to("main",   "lyric-loaded", LyricDoc)
 │
 ▼
播放中 Rust 每 250ms emit "position-changed" { positionMs, monotonicMs }
 │
 ├─ 主窗口：插值 → 计算当前行 → 播放页滚动歌词
 └─ 歌词窗口：插值 → 计算当前行/当前字 → 渲染（互不依赖）
```

要点：

1. 整篇歌词（含翻译、音译、逐字时间轴）**一次性下发**，之后只传进度，避免每 250ms 序列化文本。
2. 当前行 / 当前字的计算是纯函数：`(LyricDoc, positionMs + offsetMs) → { lineIndex, wordIndex, wordProgress }`，主窗口与歌词窗口共用同一份 TS 实现。
3. 歌词窗口不可见时不注册 `rAF`，可见时才启动。
4. 偏移（§10.5）在计算函数内生效，两个窗口读同一份偏移值，通过 `lyric-setting-changed` 事件同步。

### LyricDoc 结构

```ts
export interface LyricDoc {
  trackId: string
  /** 无歌词 / 纯音乐时为空数组，由 UI 决定展示文案 */
  lines: LyricLine[]
  hasWordTiming: boolean
  hasTranslation: boolean
  hasRomaji: boolean
  source: 'provider' | 'embedded' | 'file' | 'manual' | 'none'
}

export interface LyricLine {
  timeMs: number
  durationMs?: number
  text: string
  translation?: string
  romaji?: string
  /** 逐字时间轴，缺失时按整行渐变降级 */
  words?: { timeMs: number; durationMs: number; text: string }[]
}
```

## 10.3 歌词获取与匹配规则

原文的匹配顺序只考虑了本地文件，漏了在线曲目（PC 版主场景是在线播放）。补全后按曲目类型分流：

**在线曲目**

```text
lyrics 表缓存命中且未过期 → 用缓存
   │ 否
   ▼
Provider.lyric() （wyy 额外取 translation）
   │ 失败或为空
   ▼
跨音源兜底：按 标题 + 歌手 在其他音源搜歌词
   │ 仍失败
   ▼
显示「暂无歌词」，并提供「手动关联本地 .lrc」入口
```

**本地曲目**

```text
同目录同名 .lrc  →  文件内嵌歌词（lofty）  →  lyrics 表缓存
   →  按 标题+歌手 到当前音源在线搜索  →  仅标题搜索  →  暂无歌词 / 纯音乐
```

### 逐字歌词的可得性（原文未加限定，需求会落空）

「逐字歌词」不是客户端能力问题，而是**音源是否提供**：

| 音源 | 逐字格式 | 结论 |
|---|---|---|
| wyy | `yrc` | 部分热门曲目提供，可解析 |
| qq | `qrc` | 需解密，第一版**不做** |
| kg | `krc` | 需解密，第一版**不做** |
| kw | 无稳定逐字接口 | 不支持 |

因此：**逐字歌词按「有则用、无则整行渐变降级」实现**，需求文档需把「逐字歌词」标注为「音源支持时可用」，不能作为无条件验收项。音译（罗马音）同理，仅 wyy 的 `romalrc` 提供。

## 10.4 锁定与穿透（修正 R5：消除逻辑冲突）

**原文冲突**：同时写了「锁定 → 鼠标穿透，不可交互」和「悬停解锁 → 鼠标移动到安全区域可临时解锁」。这两条不能共存——`set_ignore_cursor_events(true)` 之后窗口**收不到任何鼠标消息**，包括 hover，前端无从感知「鼠标移到了安全区」。

三种可选方案与结论：

| 方案 | 做法 | 评价 |
|---|---|---|
| A. 纯穿透 + 外部解锁（**推荐 v1**） | 锁定后完全穿透，解锁只能通过托盘菜单、全局快捷键（`Ctrl+Alt+L` 系列）、主窗口按钮 | 零风险、实现最简，行为可预期 |
| B. Rust 轮询光标位置 | 后台每 100–150ms 调 `GetCursorPos`，判断是否进入歌词窗口矩形，进入则临时 `set_ignore_cursor_events(false)` 显示工具条，离开则恢复 | 可实现「悬停解锁」，代价是常驻轮询；空闲时可降频到 300ms |
| C. 全局鼠标钩子 | `SetWindowsHookEx(WH_MOUSE_LL)` | 易被安全软件误判、影响全局输入延迟，**不采用** |

定稿：**v1 采用 A**，把 B 作为「悬停显示控制条」的可选增强（设置项，默认关闭）。需求文档中「悬停解锁」需相应改写。

状态机：

| 状态 | 鼠标事件 | 表现 |
|---|---|---|
| 未锁定 | 接收 | 显示半透明容器边框 + 拖动区 + 悬浮工具条（上一首 / 播放 / 下一首 / 字号 / 锁定 / 关闭） |
| 已锁定 | 穿透 | 只有文字，无背景无边框，点击直达桌面图标 |
| 锁定 + 悬停增强（可选） | 轮询模拟 | 鼠标进入区域时临时恢复交互 2s |

补充：锁定状态需持久化；进入锁定时给一次 Toast 提示解锁快捷键，避免用户找不回控制入口。


## 10.5 歌词偏移

1. 支持每次 ±100ms 微调。
2. 支持直接输入偏移值。
3. 偏移按歌曲保存（`lyric_settings.offset_ms`），另设一个全局偏移，最终生效值 = 全局 + 单曲。
4. 偏移不影响原歌词文件。
5. 偏移变更通过 `lyric-setting-changed` 同时广播给主窗口与歌词窗口。

## 10.6 桌面歌词渲染性能（原文缺失）

桌面歌词是**常驻置顶**组件，性能问题会被用户长期感知，需明确约束：

| 约束 | 做法 |
|---|---|
| 只用 GPU 友好属性 | 逐字进度用 `background-clip: text` + `background-size` 或 `clip-path` 的百分比推进；**禁止**每帧改 `width` / 触发布局 |
| 帧率 | 有逐字时间轴时 60fps；仅逐行时降到「行切换才重绘」，空闲期 0 重绘 |
| 不可见即停 | 窗口隐藏 / 暂停播放时取消 `rAF` |
| 文本描边 | 用 `paint-order: stroke fill` + `-webkit-text-stroke`，不要用 4 层 `text-shadow` 模拟（后者开销高） |
| DOM 规模 | 只渲染当前行与下一行（双行模式），不渲染整篇 |
| CPU 目标 | 歌词窗口自身 CPU < 1%，与 REQUIREMENTS §4.1「播放 CPU ≤ 3%」共享预算 |

## 10.7 桌面歌词快捷键与交互

| 操作 | 行为 |
|---|---|
| `Ctrl+Alt+L` | 显示 / 隐藏桌面歌词 |
| `Ctrl+Alt+K` | 锁定 / 解锁（新增，原文只有显示隐藏，锁死后无解锁快捷键） |
| 鼠标滚轮（未锁定） | 调整字号 |
| 拖动（未锁定） | 移动窗口，松开后写回位置 |
| 拖动左右边缘 | 调整宽度，高度按行数与字号自动计算 |
| 双击（未锁定） | 切换单行 / 双行模式 |
| 右键（未锁定） | 弹出样式菜单 |

---

## 11. IPC 接口设计

## 11.1 音源相关

**原文问题**：§11.1 只有 6 个命令（含 `search_music_source`），而 §6.5 的映射表用的是另一套命名（`search_music`、`get_charts`…），两处对不上。此处以 §6.5 为准统一，并去掉 `connect_music_source`（第一版四大音源无用户配置，等 WebDAV 阶段再加）。

音源管理：

| Command | 入参 | 出参 |
|---|---|---|
| `get_music_sources` | 无 | `MusicSourceInfo[]`（含 capabilities） |
| `set_active_source` | `sourceId` | `Settings` |
| `get_source_status` | 无 | `Record<SourceId, ProviderStatus>` |

音乐内容（与 §6.5 一一对应，全部返回 `Result<T, ProviderError>`）：

| Command | 入参 |
|---|---|
| `get_playlist_categories` | `sourceId` |
| `get_recommendations` | `sourceId, category?, page` |
| `get_latest_songs` / `get_all_latest_songs` | `sourceId?, limit, offset` |
| `get_charts` / `get_all_charts` | `sourceId?` |
| `get_chart_detail` | `sourceId, chartId, page, size` |
| `get_playlist_detail` | `sourceId, playlistId, page, size` |
| `get_hot_words` / `get_all_hot_words` | `sourceId?` |
| `search_music` | `sourceId, keyword, type, page, size` |
| `search_all_music_sources` | `keyword, type, page, size` |
| `search_playlists` / `search_artists` / `search_albums` | `sourceId, keyword, page, size` |
| `get_artist_songs` | `sourceId, name, page, size`（每页上限见 `SEARCH_PAGE_MAX`：kw 100 / qq 50 / kg 30 / wyy 100） |
| `get_videos` | `sourceId, page, size` |
| `get_video_url` | `sourceId, videoId, quality` |
| `get_lyric` / `get_lyric_translation` | `track` |
| `get_play_url` | `track, quality` |
| `invalidate_play_url` | `track, quality` |
| `get_track_cover` | `track` |
| `find_alternative_tracks` | `track, targetSourceId?`（换源候选，§6.8 依赖，原文缺失） |

## 11.2 音频相关

| Command | 入参 | 出参 |
|---|---|---|
| `play_track` | `track, quality` | `PlaybackState`。单曲播放：**不替换播放列表**，队里已有这首（同 `id` + `platform`）就播它原来那条，否则追加到队尾再播；整列表入队见 `play_queue` |
| `play_queue` | `trackIds, startIndex, startPositionMs?` | `PlaybackState`。整表替换队列（「播放全部」） |
| `play_at` | `queueIndex` | `PlaybackState` |
| `next` | 无 | `PlaybackState` |
| `previous` | 无 | `PlaybackState` |
| `pause` / `resume` / `toggle_play` / `stop` | 无 | `PlaybackState` |
| `seek` | `positionMs` | `PlaybackState` |
| `set_volume` | `volume` | `PlaybackState` |
| `set_muted` | `muted` | `PlaybackState` |
| `set_play_mode` | `mode` | `PlaybackState` |
| `set_quality` | `quality` | `PlaybackState` |
| `switch_source` | `targetSourceId, candidateTrack?, keepPosition` | `PlaybackState` |
| `set_sleep_timer` | `minutes \| null \| 'afterCurrentTrack'` | `PlaybackState` |
| `get_playback_state` | 无 | `PlaybackState` |
| `restore_last_session` | 无 | `PlaybackState`（恢复上次现场，需求依赖） |
| `set_crossfade` | `enabled, durationMs` | `AudioSettings` |
| `set_gapless` | `enabled` | `AudioSettings` |
| `set_equalizer` | `enabled, preamp, bands[10]` | `AudioSettings` |
| `get_equalizer_presets` | 无 | `EqPreset[]` |
| `set_spectrum_enabled` | `enabled, fps, bands` | `AudioSettings` |
| `get_output_devices` | 无 | `OutputDevice[]` |
| `set_output_device` | `deviceId \| null` | `AudioSettings` |

> `next` / `previous` 在原文 IPC 表中完全缺失，但播放条、托盘菜单、全局快捷键、SMTC 四处都要用，属必补项。

## 11.2.1 主题与桌面歌词窗口（原文缺失）

| Command | 入参 | 出参 |
|---|---|---|
| `get_appearance` | 无 | `AppearancePreference` |
| `set_appearance` | `patch` | `AppearancePreference` |
| `list_skins` | 无 | `SkinSummary[]` |
| `get_skin` | `skinId` | `Skin` |
| `apply_skin` | `skinId` | `Skin` |
| `import_skin` | `path` | `Skin`（含校验错误明细） |
| `export_skin` | `skinId, path` | `boolean` |
| `save_skin` | `skin`（编辑器另存） | `Skin` |
| `delete_skin` | `skinId` | `boolean` |
| `reset_skin` | 无 | `Skin` |
| `pick_cover_color` | `trackId` | `CoverColor` |
| `show_desktop_lyric` / `hide_desktop_lyric` | 无 | `LyricWindowState` |
| `set_desktop_lyric_locked` | `locked` | `LyricWindowState` |
| `set_desktop_lyric_style` | `patch` | `LyricWindowState` |
| `set_desktop_lyric_bounds` | `x, y, width, height` | `LyricWindowState` |
| `reset_desktop_lyric` | 无 | `LyricWindowState` |


## 11.3 音乐库相关

| Command | 入参 | 出参 |
|---|---|---|
| `add_scan_dir` | `path` | `ScanDir` |
| `remove_scan_dir` | `dirId` | `boolean` |
| `set_scan_dir_enabled` | `dirId, enabled` | `ScanDir` |
| `scan_music_dirs` | `fullScan` | `ScanTask` |
| `cancel_scan` | 无 | `boolean` |
| `get_tracks` | `filter, page` | `TrackPage` |
| `get_track_metadata` | `trackId` | `TrackMetadata` |
| `open_file_location` | `trackId` | `boolean` |
| `remove_missing_tracks` | 无 | `RemoveResult` |

## 11.4 歌词相关

| Command | 入参 | 出参 |
|---|---|---|
| `load_lyric` | `trackId` | `Lyric` |
| `save_lyric` | `trackId, lyric` | `boolean` |
| `import_lyric_file` | `trackId, path` | `Lyric` |
| `set_lyric_offset` | `trackId, offsetMs` | `LyricSetting` |
| `get_lyric_setting` | `trackId` | `LyricSetting` |

## 11.5 队列相关

| Command | 入参 | 出参 |
|---|---|---|
| `get_queue` | 无 | `Track[]` |
| `set_queue` | `trackIds` | `Track[]` |
| `add_to_queue` | `trackIds, position` | `Track[]` |
| `remove_from_queue` | `trackId` | `Track[]` |
| `move_queue_item` | `from, to` | `Track[]` |
| `clear_queue` | 无 | `Track[]` |

队列界面仍通过 pointer 事件实现排序，避开 Tauri 接管的 HTML5 拖放。拖动取消、Esc、失焦、窗口隐藏、面板关闭或队列顺序变化时放弃本次排序；释放到原位只吞掉拖动后的 click，不切歌。多选下标绑定曲目顺序快照，等长替换/重排也使选择失效，纯元数据更新保留选择。行内按钮保持自己的键盘行为；头部提供「定位当前播放」，面板打开时自动定位，播放中浏览列表不会被切歌强制滚回。「下一首播放」按引擎先移除、再插入的语义调整目标：来自当前曲之前时使用原当前下标，之后时使用当前下标加一；当前曲自身禁用该动作。

列表的收藏/屏蔽标记通过 `useTrackFlags` 关联到判定键，异步回执不会按旧下标套到新列表。收藏键是 `(platform,id)`，屏蔽键是原文 `(title,singer)`，实际屏蔽匹配仍由 Rust 完成；每个列表实例复用已查结果，分页只查新增项，进行中的重复项共享请求。缓存默认最多保留 4096 项，当前列表超过该数时保留当前列表全量结果。规则版本变化后立即隐藏旧标记并重查；云端收藏成功落库、换账号清库、备份恢复也触发相应版本刷新。

## 11.6 系统相关

| Command | 入参 | 出参 |
|---|---|---|
| `get_settings` | 无 | `Settings` |
| `set_setting` | `key, value` | `Settings` |
| `set_autostart` | `enabled` | `boolean` |
| `check_update` | 无 | `UpdateInfo` |
| `install_update` | 无 | `boolean` |
| `open_data_folder` | 无 | `boolean` |
| `open_cache_folder` | 无 | `boolean` |
| `get_cache_size` | 无 | `CacheInfo` |
| `clear_cache` | `types` | `CacheInfo` |
| `list_downloads` | 无 | `DownloadTask[]` |
| `list_downloaded_track_ids` | 无 | `string[]`（曲目行「已下载」标） |
| `start_download` | `track, quality` | `taskId`（只入队不取址，见 §13.4） |
| `pause_download` / `pause_downloads` | `taskId` / `ids` | 无 / 实际生效条数 |
| `resume_download` / `resume_downloads` | `taskId` / `ids` | 无 / 实际生效条数 |
| `retry_download` | `taskId` | 无（与「继续」同链路，语义上区分便于文案） |
| `cancel_download` / `cancel_downloads` | `taskId` / `ids` | 无 / 实际生效条数（均会删 `.part`） |
| `delete_download` / `delete_downloads` | `taskId, deleteFile` / `ids, deleteFile` | `boolean` / `boolean` |
| `write_download_lyric` | `taskId, lrc` | `boolean`（歌词附件补写，见 §13.4） |
| `reveal_download` | `taskId` | `boolean`（资源管理器定位） |
| `get_download_dir` / `choose_download_dir` / `reset_download_dir` | 无 / 无 / 无 | 目录路径 |
| `get_download_concurrency` / `set_download_concurrency` | 无 / `n` | 生效并发数（Rust 侧夹 1–6） |
| 其余下载偏好（默认音质 / 文件名格式 / 同时下载封面 / 同时下载歌词） | 走通用 `get_setting` / `set_setting`（键 `download.*`） | — |
| `backup_database` | `path` | `boolean` |
| `restore_database` | `path` | `boolean` |
## 11.7 Astral 服务相关

Rust `AstralClient` 统一封装以下接口，前端不直接使用 `fetch` 请求 Astral。

### 账号

| Command | 对应接口 |
|---|---|
| `astral_login` | `POST /app/user/login` |
| `astral_register` | `POST /app/user/register` |
| `astral_logout` | `POST /app/user/logout` |
| `astral_refresh` | `POST /app/user/refresh` |
| `astral_me` | `GET /app/user/me` |
| `astral_update_profile` | `POST /app/user/update` |
| `astral_upload_avatar` | `POST /app/user/upload` |
| `astral_send_email_code` | `POST /app/user/email` |
| `astral_change_password` | `POST /app/user/changePass` |

### 签到

| Command | 对应接口 |
|---|---|
| `astral_check_in` | `POST /app/user/daka` |
| `astral_check_in_info` | `GET /app/user/dakaInfo` |
| `astral_check_in_month` | `GET /app/user/dakaInfoByMonth` |

### 收藏同步

| Command | 对应接口 |
|---|---|
| `astral_like_song` | `POST /app/user/like/song` |
| `astral_like_playlist` | `POST /app/user/like/playlist` |
| `astral_like_changes` | `GET /app/user/like/changes` |
| `astral_like_page` | `GET /app/user/like/list` |

### 反馈

| Command | 对应接口 |
|---|---|
| `astral_submit_feedback` | `POST /app/feedback/submit` |
| `astral_my_feedback` | `GET /app/feedback/my` |
| `astral_public_feedback` | `GET /app/feedback/public` |
| `astral_feedback_detail` | `GET /app/feedback/{id}` |
| `astral_feedback_replies` | `GET /app/feedback/{id}/replies` |
| `astral_reply_feedback` | `POST /app/feedback/reply` |

### 消息

| Command | 对应接口 |
|---|---|
| `astral_active_messages` | `GET /app/message/active?versionCode=&channel=pc` |
| `astral_message_center` | `GET /app/message/center?channel=pc` |
| `astral_unread_count` | `GET /app/message/unread-count?channel=pc` |
| `astral_ack_messages` | `POST /app/message/read-ack` |

### 更新与统计

| Command | 对应接口 |
|---|---|
| `astral_app_update` | `GET /app/update?type={1103\|1104\|1105}&version=&channel=` |
| `astral_check_official_version` | `GET /app/version/check?type={1103\|1104\|1105}&version=&versionName=` |
| `astral_github_accels` | `GET /app/github/accels` |
| `astral_report_stats` | `POST /app/stat/report`，事件 `ut=app-windows / app-linux / app-macos`（按编译目标） |

## 11.7.1 客户端直连模型（`ai_local`，原文缺失）

设置页「AI」分节 + 「每日推荐」的本地模型精选要用到大模型，但**不经过 Astral 后端**：由 Rust 侧直接 `POST {baseUrl}/chat/completions`。原因有三条 ——

1. 用户的 Key 不能进 WebView：`ai_local_config` 只回 `hasKey: bool`，Key 从读库到发请求全程在 Rust 进程内，前端 JS 永远拿不到明文（这一点与 §17.1 的凭据存储口径不同，见该节）；
2. 换服务商不该改代码：提示词组装、候选池注入、回执硬校验全在 `@/lib/daily-recommend`，Rust 侧只做「转发 + 取回 content」的哑管道；
3. 允许自建 / 中转站地址，所以地址与模型名都是用户可填的自由文本（`GET /v1/models` 只是便利，不实现也不影响使用）。

| Command | 作用 | 关键约束 |
|---|---|---|
| `ai_local_config` | 读配置档列表 + 当前档 | **只回 `hasKey` 布尔**，绝不回 Key 明文 |
| `ai_local_save_config` | 整体保存配置档列表 + `activeId` | 每档 `apiKey` 传 `None` = 不改动已存 Key、`Some("")` = 清空；地址非空必须能归一成合法的 `chat_endpoint()`，否则当场报错不落库；id 重复保留先出现的；空列表回落默认档 |
| `ai_local_test` | 试连（发一句「你好」） | 用**表单值**而非已存值，支持「先试再存」；失败时 `error` 带可读原因 |
| `ai_local_list_models` | `GET {baseUrl}/models` | 兼容 `{"data":[…]}` / `{"models":[…]}` / 裸数组三种形态；失败不阻断，设置页照旧允许手输模型名 |
| `ai_local_chat` | 转发 `messages` 并取回 content | 前端给完整 messages（系统提示 + 用户），Rust 不拼提示词 |

`ai_local_chat` 的健壮性处理（都是实际踩出来的）：

- **3 次重试 + 退避 200ms → 600ms**（`CHAT_ATTEMPTS`）：中转站对同一请求偶发 5xx / 429 是常态，一次失败就报错会把「模型不可用」的错觉甩给用户。可重试状态码：400 / 403 / 408 / 409 / 425 / 429 / 500 / 502 / 503 / 504 / 520–524 / 529；**401 / 404 / 422 不重试**（Key 错、地址错、参数错，重试三次只是让用户多等）。
- **超时不重试**：单次 120s（`CHAT_TIMEOUT_SECS`），重试三次要 6 分钟，超时重试等于卡死界面。
- **兼容 SSE**：部分网关无视 `stream: false` 仍回 `text/event-stream`，`extract_reply` 先按整体 JSON 解析，失败再退化成按 `data:` 行拼 `delta.content` / `message.content` / `text`，跳过 `[DONE]`。
- **空内容当失败**：模型回了空 `content` 报「模型返回了空内容」，不静默返回空串让上层以为成功。
- **上游拒绝加提示**：响应体含 `11140` / `request illegal` 时在原因后追加「（上游拒绝了这次请求，属于中转站侧的偶发问题：可以重试，或换一个模型）」。

配置落在 `settings` 表的 `ai.profiles`（JSON 数组）+ `ai.activeProfile`（当前档 id），旧的单档 `ai.baseUrl` / `ai.model` / `ai.apiKey` 只用于首次迁移读取。

## 11.8 事件设计

| Event | 载荷 | 频率 | 目标窗口 |
|---|---|---|---|
| `playback-state-changed` | `PlaybackState` | 状态语义变化时 | main + lyrics |
| `position-changed` | `{ positionMs, durationMs, monotonicMs }` | 250ms（仅播放中） | main + lyrics |
| `audio-buffering` | `{ trackId, bufferedMs, downloadedBytes, totalBytes }` | 500ms（仅缓冲中） | main |
| `audio-error` | `{ trackId, kind, message }` | 事件驱动 | main |
| `track-changed` | `Track` | 切歌 | main + lyrics |
| `queue-changed` | `{ tracks, index }` | 队列变化 | main |
| `lyric-loaded` | `LyricDoc` | 切歌 / 手动关联后 | main + lyrics |
| `lyric-setting-changed` | `{ trackId, offsetMs, globalOffsetMs }` | 偏移变化 | main + lyrics |
| `lyric-window-changed` | `LyricWindowState` | 显示 / 锁定 / 样式 / 位置变化 | main + lyrics |
| `theme-changed` | `{ appearance, skin }` | 皮肤或外观变化 | main + lyrics |
| `cover-color-changed` | `CoverColor` | 切歌取色完成 | main + lyrics |
| `spectrum-data` | `Float32Array`（`number[]`） | 30fps（可关） | main |
| `scan-progress` | `{ current, total, path }` | 200ms 节流 | main |
| `scan-finished` | `ScanSummary` | 扫描结束 | main |
| `library-changed` | `{ added, updated, missing }` | 文件监听触发 | main |
| `provider-status-changed` | `{ sourceId, status, error? }` | 状态变化 | main |
| `download-progress` | `DownloadProgress` | 500ms 节流 | main |
| `download-finished` | `DownloadTask` | 任务结束 | main |
| `astral-auth-changed` | `AuthState` | 登录 / 登出 / 刷新失败 | main |
| `like-sync-changed` | `LikeSyncState` | 同步状态变化 | main |
| `message-unread-changed` | `{ count }` | 拉取 / 已读后 | main |
| `update-available` | `UpdateInfo` | 检查到新版本 | main |
| `update-progress` | `{ downloaded, total, phase }` | 500ms 节流 | main |
| `media-command` | `{ action }` | 媒体键 / SMTC / 托盘触发 | main |
| `single-instance` | `{ argv, cwd }` | 重复启动时 | main |
| `sleep-timer-changed` | `{ remainingMs \| null }` | 1s（启用时） | main |

**原文缺失项说明**：`lyric-current` 被移除（改为歌词窗口自算，§10.2）；新增 `audio-buffering` / `audio-error`（在线播放必需）、`theme-changed`（皮肤热切换与歌词窗口同步）、`media-command`（媒体键与托盘）、`single-instance`（重复启动激活 + 命令行传入的音频文件）、`library-changed`（文件监听）。

事件约定：

1. 高频事件（`position-changed` / `spectrum-data` / 各类 progress）**只发增量与节流后的值**，不夹带 `Track` 等大对象。
2. 事件按窗口定向下发（`emit_to`），歌词窗口只收到上表标注 `lyrics` 的 6 个事件，与 §17.2 的最小授权一致。
3. 所有事件名用 kebab-case，与命令的 snake_case 区分开，便于检索。


---

## 12. 前端设计

## 12.1 状态管理

使用 Zustand 管理全局状态，TanStack Query 管理服务数据。

### PlayerStore

前端**不持有播放真值**，只镜像 Rust 推送的 `PlaybackState`，再叠加插值后的本地进度：

```ts
export interface PlayerStore {
  // —— 来自 Rust 的镜像，只读 ——
  snapshot: PlaybackState | null
  currentTrack: Track | null
  queue: Track[]
  queueIndex: number | null
  // —— 本地派生 ——
  displayPositionMs: number     // rAF 插值结果，仅用于渲染，不回写 Rust
  isSeeking: boolean            // 拖动进度时冻结插值，松手才 seek
  lastTickAt: number            // performance.now()，插值基准
  // —— 动作，全部转为 invoke ——
  play(trackId: string): Promise<void>
  playQueue(trackIds: string[], startIndex: number): Promise<void>
  next(): Promise<void>
  previous(): Promise<void>
  toggle(): Promise<void>
  seek(ms: number): Promise<void>
  setVolume(v: number): Promise<void>
  setPlayMode(m: PlayMode): Promise<void>
  setQuality(q: Quality): Promise<void>
  switchSource(target: SourceId): Promise<void>
}
```

三条纪律：

1. **单向数据流**：UI 只 `invoke`，状态只从事件回流；禁止前端本地先改 `isPlaying` 再发命令（会与 Rust 状态打架，产生按钮闪烁）。
2. 拖动进度条时用 `isSeeking` 冻结插值与事件覆盖，`onPointerUp` 才发 `seek`。
3. `displayPositionMs` 不入持久化，也不参与相等性比较，避免每帧触发全局重渲染（用 selector 订阅或独立轻量 store）。


### MusicSourceStore

```ts
export interface MusicSourceStore {
  sources: MusicSourceProvider[]
  activeSourceId: string
  aggregateMode: boolean
  sourceStatus: Record<string, ProviderStatus>
}
```

### AstralAuthStore

```ts
export interface AstralAuthStore {
  user: AstralUser | null
  loggedIn: boolean
  refreshing: boolean
}
```

### LikeSyncStore

```ts
export interface LikeSyncStore {
  cursor: number
  syncing: boolean
  pendingCount: number
  lastError: string | null
}
```

### DownloadStore

```ts
export interface DownloadStore {
  tasks: DownloadTask[]
  quality: '128' | '320' | 'flac'
  downloadDir: string
}
```
### ThemeStore

```ts
export interface ThemeStore {
  theme: ThemeConfig
  coverColor: CoverColor | null
  applyTheme(theme: ThemeConfig): void
  applyCoverColor(color: CoverColor | null): void
  resetTheme(): void
}
```

### LyricStore

```ts
export interface LyricStore {
  visible: boolean
  locked: boolean
  currentLine: number
  currentWord: number
  offset: number
  style: LyricStyle
}
```

## 12.2 组件结构

```text
components/
 ├─ ui/                 # shadcn/ui 基础组件
 ├─ common/             # 全站共用的展示组件
 │   ├─ SourceTag.tsx   # 歌名右侧的平台简称徽标（sm=正在播放页 / xs=列表行；本地曲目不渲染）
 │   └─ ToastHost.tsx   # 右上角通知
 ├─ layout/
 │   ├─ AppShell.tsx
 │   ├─ TitleBar.tsx
 │   ├─ Sidebar.tsx
 │   └─ PageContainer.tsx
 ├─ music-source/
 │   ├─ MusicSourceSwitcher.tsx
 │   ├─ ProviderStatusBadge.tsx
 │   └─ ProviderSettingsDialog.tsx
 ├─ player/
 │   ├─ PlayerBar.tsx
 │   ├─ TrackInfo.tsx
 │   ├─ TransportControls.tsx
 │   ├─ ProgressBar.tsx
 │   ├─ VolumeControl.tsx
 │   ├─ QueuePanel.tsx
 │   └─ SpectrumCanvas.tsx
 ├─ lyric/
 │   ├─ LyricView.tsx
 │   ├─ DesktopLyricWindow.tsx
 │   └─ LyricStyleEditor.tsx
 ├─ library/
 │   ├─ TrackTable.tsx
 │   ├─ FolderTree.tsx
 │   └─ ScanProgressBar.tsx
 └─ settings/
     ├─ SettingsPage.tsx
     ├─ AppearanceSettings.tsx
     ├─ LyricSettings.tsx
     ├─ AudioSettings.tsx
     ├─ ShortcutSettings.tsx
     ├─ StorageSettings.tsx
     └─ UpdateSettings.tsx
```

## 12.3 虚拟列表设计

音乐库可能达到 10 万首歌曲，必须使用虚拟列表：

1. 只渲染可视区域和缓冲区域。
2. 行高固定，便于快速计算。
3. 支持键盘导航。
4. 支持批量选择。
5. 排序和筛选由 Rust 查询完成。

---

## 13. 扫描设计

## 13.1 扫描流程

```text
读取启用目录
   │
   ▼
遍历目录
   │
   ▼
过滤支持的音频格式
   │
   ▼
读取元数据
   │
   ▼
计算文件指纹
   │
   ▼
写入 SQLite
   │
   ▼
发送 scan-progress
   │
   ▼
完成后发送 scan-finished
```

## 13.2 增量扫描

优先依据：

1. 文件路径
2. 文件大小
3. 修改时间
4. 文件哈希

策略：

1. 文件不存在，标记 `missing = 1`。
2. 文件大小和修改时间不变，跳过。
3. 文件变化，重新读取元数据。
4. 新文件，插入数据。
5. 老文件恢复，取消缺失标记。

## 13.3 文件监听

使用 `notify` 监听目录变化：

| 事件 | 处理 |
|---|---|
| 新增文件 | 加入扫描队列 |
| 修改文件 | 更新元数据 |
| 删除文件 | 标记缺失 |
| 重命名 | 路径变化时重新关联或新增 |
| 目录删除 | 标记该目录下歌曲缺失 |

---

## 13.4 下载设计

### 下载任务状态

```ts
export interface DownloadTask {
  id: string
  trackId: string
  platform: SourceId
  quality: '128' | '320' | 'flac'
  status: 'pending' | 'downloading' | 'completed' | 'failed' | 'canceled'
  progress: number
  filePath?: string
  fileSize?: number
  error?: string
  createdAt: number
  updatedAt: number
}
```

### 下载流程

```text
用户点击下载
   │
   ▼
创建下载任务（只入队即返回，不取址）
   │
   ▼
排队等并发位（取址也在闸门内，批量入队不会打出 N 个取址请求）
   │
   ▼
真正轮到这首时才获取远程播放地址（失败 → 任务落 failed 带原因，可重试）
   │
   ▼
写入临时文件
   │
   ▼
流式下载并更新进度
   │
   ▼
完成后移动到下载目录
   │
   ▼
写入本地音乐库
   │
   ▼
更新任务状态为 completed
   │
   ▼
按设置落盘附件：封面原图（与歌曲同名，按魔数定扩展名）+ 同名 `.lrc` 歌词
（附件失败不影响音频，安静跳过）

```

> 「只入队不取址」（2026-11 用户口径）：播放地址是音源限时签发的短时凭据，
> 入队时就取好、排在队尾等轮到再下，八成已过期；所以 `start_download` 只建
> pending 任务（part 路径与实测档位都等取址后补写），取址挪到后台
> `launch_download` 拿到并发位之后 —— 与「继续 / 重试」同一条链路，
> 轮到哪首取哪首。取址失败不再发生在点击时，而是在后台落成 failed 终态
> （带原因并广播），下载列表里看得到、可重试。
>
> 「同时下载封面和歌词」（2026-11 用户口径，参考主流音乐软件）：任务完成时
> 就地把附件存到歌曲旁边，而不是打包成 zip 或塞进二进制标签。封面走 `qtres`
> 的代取基础设施（域名白名单 + referer + https 升级），取**原图**而非缩略图，
> 魔数嗅探定 `.jpg/.png/.webp`、上限 20MB；歌词是纯文本 `.lrc`（不带翻译），
> Rust 侧先查本地词库缓存，缓存没有时由前端在任务翻到 completed 的那一刻
> 联网补取并经 `write_download_lyric` 写盘（避免后端为写一个文件引入整套
> 取词脚本）。附件是「锦上添花」：任何一步失败只跳过该附件，不回滚音频、
> 不把任务改回失败。两个开关（`download.saveCover` / `download.saveLyric`，
> 默认开）只影响**之后完成**的任务，关掉不回收已落盘的附件。

### 续传与响应校验（2026-10-17 第四波）

继续时从已有 `.part` 尾部回退最多 64 KiB 发出 Range，先比对重叠字节，全部一致后才追加。`206` 必须具有唯一、数值合法的 `Content-Range`，起点与请求一致、终点覆盖到对象末尾，已知总长不小于已有断点；`Content-Length` 存在时必须与范围长度吻合，结束时同时校验实际接收与落盘字节数。请求使用 `Accept-Encoding: identity` 并关闭透明解压，明确拒绝其他响应编码。

范围错误、重叠内容不一致或 `416` 时，每次尝试最多从零重下一次；忽略 Range 的 `200` 作为完整响应处理。有旧断点时重下写独立 `.restart-*.part`，失败或暂停保留原断点，只有完整响应验证成功才替换成品。空响应不会成为成品；取址阶段的 `declared_size` 只影响进度分母，不能替代本次响应的完整性校验。

连接等待上限 10 秒，请求头与每次读取数据的等待上限各 30 秒；每 50 毫秒检查取消旗标，覆盖静默网络等待与重试退避。确定性失败保留具体错误原因。上述为尾部重叠和 HTTP 传输校验，不能识别「尾部完全相同、此前内容变化」；没有长度的完整响应依赖正常 HTTP framing/EOF，未实现外部整文件哈希验证。安全重下需要额外临时磁盘空间。

### 批量管理

下载页与本地曲库同一套多选交互：全选框 + 已选 N + 批量按钮。批量命令
（`pause_downloads` / `resume_downloads` / `cancel_downloads` /
`delete_downloads`）与单条同语义，只是按 id 列表执行；**不适用的状态在
store 层过滤**（如暂停只作用于 pending / downloading），返回实际生效条数，
前端按返回数提示。工具栏的「全部暂停 / 全部继续 / 清理已完成」就是对应
批量命令套在过滤后的 id 列表上，不再前端 `Promise.all` 逐条打单条接口
（N 条任务会放大成 N 次广播，且中途失败没有部分成功的语义）。「全部继续」
只续**已暂停**的；失败 / 已取消的挨个重试是用户的明确动作，不替用户做主。

### 设计规则

1. 下载队列默认低并发执行，避免占用过多带宽。
2. 下载使用临时文件，完成后原子移动到目标目录。
3. 下载过程中应用退出后，下次启动把未完成任务标记为已暂停，支持继续 / 重试。
4. 远程播放地址只在任务轮到并发位后才获取（见上方流程图与引注）。
5. 本地已存在同 `platform + trackId + quality` 文件时不重复下载。
6. 离线播放时优先匹配本地文件。
7. 删除下载记录时可选择是否删除文件。
8. 下载目录可在设置中修改。
9. 批量操作按 id 列表在 store 层过滤不适用状态，返回实际生效数（见「批量管理」）。
10. 完成的任务按设置落盘封面 / 歌词附件；附件失败不影响任务本身（见引注）。
## 14. 系统集成设计

## 14.1 托盘

托盘菜单：

```text
轻听
├─ 播放 / 暂停
├─ 上一首
├─ 下一首
├─ 显示桌面歌词
├─ 显示主窗口
└─ 退出
```

## 14.2 快捷键

快捷键需要支持用户自定义，默认值如下：

| 功能 | 默认快捷键 |
|---|---|
| 播放 / 暂停 | Ctrl + Alt + P |
| 上一首 | Ctrl + Alt + Left |
| 下一首 | Ctrl + Alt + Right |
| 音量加 | Ctrl + Alt + Up |
| 音量减 | Ctrl + Alt + Down |
| 静音 | Ctrl + Alt + M |
| 桌面歌词 | Ctrl + Alt + L |
| 搜索 | Ctrl + F |

## 14.3 Windows 媒体控制

集成 Windows System Media Transport Controls：

1. 显示歌曲标题。
2. 显示艺术家。
3. 显示封面。
4. 支持播放 / 暂停。
5. 支持上一首 / 下一首。
6. 支持进度显示。

## 14.4 Windows 任务栏缩略图工具栏

鼠标悬停任务栏按钮时，缩略图预览下方提供三个传输按钮：

| 按钮 | 行为 |
|---|---|
| 上一首 | 切换上一首 |
| 播放 / 暂停 | 图标随播放状态切换 |
| 下一首 | 切换下一首 |

实现要点（`src-tauri/src/taskbar.rs`）：

1. **挂载时机由 shell 驱动，不靠等待。** 任务栏按钮由 shell 创建，建好后 shell 会向窗口发一条
   `RegisterWindowMessageW(L"TaskbarButtonCreated")` 注册消息。按官方约定，**必须先收到这条消息，
   才能调用任何 `ITaskbarList3` 方法**；早调时 shell 返回成功却把工具栏静默丢弃。
   因此 `init` 在 `setup` 中先注册消息，并**同步**换好窗口过程（早于窗口首次 `show()`，
   确保不漏收该消息）。
2. **每次重建都重新挂。** shell 在任务栏按钮**重建**时会重发该消息；主窗口 hide→show
   （点关闭收进托盘、再从托盘打开）正是一次重建，旧按钮连同其上的工具栏一起消失。
   窗口过程收到该消息即重新执行 `ThumbBarAddButtons`，这就是「关闭再打开后按钮消失」的修复点。
3. **兜底补挂。** 窗口过程若安装过晚而错过首次消息，则在窗口可见后检测到从未收到过该消息时，
   主动补挂一次。
4. **消息照常透传。** 该分支不拦截，继续交给原窗口过程，tao / tray-icon 同样依赖它。
5. **图标不用资源文件**，由 GDI 现场光栅化（32bpp DIB + 全零掩码 → `CreateIconIndirect`），
   并按 `GetDpiForWindow` 缩放；颜色跟随系统主题（浅色主题画深色图标，深色主题画白色图标）。
6. **非 Windows 平台整体降级为空实现**，调用方无需分支。

---

## 15. 更新、通知与统计平台设计

## 15.1 当前接口基线

Astral 已提供：

| 接口 | 说明 |
|---|---|
| `GET /api/v1/app/update?type={1103\|1104\|1105}&version=&channel=` | 获取本平台版本更新信息（type 按编译目标） |
| `GET /api/v1/app/version/check?type={1103\|1104\|1105}&version=&versionName=` | 校验本平台官方版本 |
| `GET /api/v1/app/github/accels` | 获取 GitHub 加速节点 |
| `GET /api/v1/app/message/active?versionCode=&channel=pc` | 获取 PC 当前生效通知 |
| `GET /api/v1/app/message/center?channel=pc` | 获取 PC 消息中心 |
| `GET /api/v1/app/message/unread-count?channel=pc` | 获取 PC 未读数 |
| `POST /api/v1/app/stat/report` | 匿名批量统计上报 |

## 15.2 平台枚举

### 通知渠道 `channel`

| 值 | 说明 |
|---|---|
| `app` | App 端 |
| `pc` | PC / 桌面端 |
| `web` | Web 端 |
| `all` | 全部端 |

PC 端消息接口固定传：

```text
channel=pc
```

### 统计平台 `ut`

| 值 | 说明 |
|---|---|
| `app-android` | Android App |
| `app-ios` | iOS App |
| `app-windows` | Windows 桌面端 |
| `app-linux` | Linux 桌面端 |
| `app-macos` | macOS 桌面端 |
| `web` | Web 端 |

PC 端统计事件按编译目标三选一（`astral.rs` 的 `CLIENT_UT`）：

```text
Windows: ut=app-windows
Linux:   ut=app-linux
macOS:   ut=app-macos
```

### 更新平台 `type`

| 值 | 说明 |
|---|---|
| `1101` | Android |
| `1102` | iOS |
| `1103` | Windows |
| `1104` | Linux |
| `1105` | macOS |

PC 端更新和官方版本校验按编译目标三选一（`app_config::UPDATE_TYPE`）：

```text
Windows: type=1103
Linux:   type=1104
macOS:   type=1105
```

## 15.3 PC 更新流程

```text
启动或用户手动检查
   │
   ▼
调用 Astral /app/update，携带 type=1103/1104/1105（按编译目标）
   │
   ▼
比较 versionCode
   │
   ▼
获取 GitHub 加速节点（可选）
   │
   ▼
并发探测加速节点
   │
   ▼
下载本平台更新包
   │
   ▼
校验 MD5 / 签名
   │
   ▼
Windows 启动安装器；Linux/macOS 走浏览器下载手动安装
   │
   ▼
退出当前应用
```

Tauri Updater 可作为备选实现：

1. 更新清单由 Astral 或静态文件服务提供。
2. 更新包签名遵循 Tauri Updater 规范。
3. 前端仍通过 Rust Command 获取更新状态。
4. 即使使用 Tauri Updater，Astral 中的版本记录仍应按平台使用 `type=1103/1104/1105`。

## 15.4 通知与统计上报设计

### 通知

1. PC 启动后调用 `active?versionCode=&channel=pc`。
2. 消息中心调用 `center?channel=pc`。
3. 未读数调用 `unread-count?channel=pc`。
4. 已读回执调用 `read-ack`。
5. 后端配置为 `app` 或 `web` 的通知不展示在 PC。
6. 后端配置为 `pc` 或 `all` 的通知正常展示。

### 统计

事件结构沿用 `StatEventDTO`：

```ts
export interface StatEvent {
  evt: 'launcher' | 'show' | 'hide' | 'page' | 'error' | 'custom'
  ts: number
  deviceId: string
  ut: 'app-windows' | 'app-linux' | 'app-macos'
  appVersion: string
  model?: string
  os?: string
  page?: string
  duration?: number
  ch?: string
  errorType?: 'js' | 'network' | 'biz'
  message?: string
  stack?: string
  release?: string
  extra?: Record<string, unknown>
}
```

PC 端规则：

1. 所有事件 `ut` 按编译目标取值：`app-windows` / `app-linux` / `app-macos`（与 `X-App-Ut` 同值）。
2. 单批事件数量不超过 200。
3. 上报失败进入本地队列重试。
4. 统计失败不影响播放。
5. 用户关闭匿名统计后停止上报。

## 15.5 配置

| 配置 | 默认值 |
|---|---|
| 自动检查更新 | 开启 |
| 自动下载 | 关闭 |
| 更新通道 | stable |
| 更新平台类型 | 1103（Windows）/ 1104（Linux）/ 1105（macOS），按编译目标 |
| 通知渠道 | pc |
| 统计平台 | app-windows / app-linux / app-macos，按编译目标 |
| 跳过当前版本 | 不跳过 |
| GitHub 加速 | 开启 |

## 15.6 安全要求

1. 更新源使用 HTTPS。
2. 更新包必须校验 MD5 或签名。
3. 校验失败禁止安装。
4. 下载失败保留当前版本。
5. 安装前提示用户。
6. 强制更新时不允许跳过。
7. 非官方版本校验失败时提示，但不自动退出 PC 应用，除非产品明确要求。

## 15.7 版本号规则与发布流程（原文缺失）

`GET /app/update` 的比较依据是 `version_code`（整数），而 PC 与 Android 共用同一张 `qt_app_update` 表、按 `type` 区分平台，因此 **PC 必须有自己独立的 versionCode 序列**，且不能与移动端的 300 系列混淆。

| 项 | 规则 |
|---|---|
| `versionName` | 语义化版本 `major.minor.patch`，如 `1.0.7` |
| `versionCode` | `major*100 + minor*10 + patch`，如 `1.0.0` → `100`、`1.0.7` → `107`、`1.2.3` → `123` |
| 起始值 | PC 首个版本 `1.0.0` / `100`，与移动端 `3.0.0 / 300` 天然不冲突（同 `type` 内单调即可） |
| 请求参数 | `GET /app/update?type=1103&version=107&channel=stable`（Linux/macOS 换 1104/1105），注意 **`version` 传的是 versionCode 的字符串**，不是 `versionName` |
| 官方校验 | `GET /app/version/check?type=1103&version=107&versionName=1.0.7`（type 同左），三者必须与后台记录完全一致 |
| 单一真值 | 二者只在仓库根的 `app.config.json`（`version.name` / `version.code`）写一次，由 `scripts/sync-config.mjs` 写进 `package.json`、`tauri.conf.json`、`Cargo.toml`、`Cargo.lock`、`src-tauri/src/app_config.rs`（§24.2）；**禁止手改派生文件** |

> 历史注：本文档早期写的是 `major*10000 + minor*100 + patch`（`1.0.0` → `10000`），
> 实现时改成了两位进制的 `major*100 + minor*10 + patch`：后端 `qt_app_update` 表由
> PC 与移动端共用、按 `type` 区分，两位一档更贴近移动端 `3.0.0 / 300` 的量级，
> 也便于人工核对。**以本表与 `app.config.json` 为准**（单测会校验 name ↔ code 自洽）。

### 发布流程

```text
1. 改 app.config.json 的 version.name 与 version.code（如 1.0.8 / 108，两个必须一起改）
2. pnpm config:sync —— 写进 package.json / tauri.conf.json / Cargo.toml / Cargo.lock /
   src-tauri/src/app_config.rs（pnpm build 会先自动同步）
3. 全绿：pnpm config:check、pnpm test、cargo test --lib
4. 打包（见 docs/PACKAGING.md）→ 计算安装包 MD5 与字节大小
5. 上传安装包（GitHub Release 或对象存储）
6. 后台「版本更新」新增记录：**每个平台一条，type 分别填 1103/1104/1105**、versionCode、versionName、
   downloadUrl（GitHub 原始链接）、browserUrl、isGithub=1、md5、fileSize、
   channel、isForce、isPublished=0
7. 用当前版本自测 /app/version/check 通过（未发布也能校验通过）
8. 确认无误后将 isPublished 置 1，客户端开始收到更新
```

### 安装与替换

| 事项 | 做法 |
|---|---|
| 安装器 | NSIS，`installMode: currentUser`（免管理员，避免 UAC 拦截自动更新） |
| 升级体验 | 自定义模板 `src-tauri/nsis/installer.nsi`（Tauri 官方模板 + 18 行补丁）：**升级 / 同版本重装不再询问是否卸载**，直接原地覆盖安装，用户数据不动；仅「从 WiX/MSI 迁移」与「降级」仍提示。原理与 CLI 升级后的重新提取步骤见 `docs/CONFIG.md` §6 |
| 静默参数 | 更新时以 `/S`（或 Tauri Updater 默认参数）启动新安装器，安装完成后重启应用 |
| 退出时机 | 先落盘播放现场与数据库（`PRAGMA wal_checkpoint`），再启动安装器并退出，避免 SQLite 被强杀导致 `-wal` 残留 |
| 校验 | 下载完成后先比对 `md5` 与 `fileSize`，任一不符即删除临时文件并报错，**不进入安装** |
| GitHub 加速 | 复用 `UPDATE_DESIGN.md` 的方案：`isGithub=1` 时取 `/app/github/accels`，并发探测（`Range: bytes=0-0`，4s 超时），首个 200/206 的前缀胜出；全失败回落原始 `downloadUrl` |
| 双链接 | `browserUrl` 存在时提供「浏览器下载」按钮（走系统默认浏览器），与「直接下载」并存 |
| 更新失败 | 保留当前版本可用，记录日志，允许重试或转浏览器下载 |

> 与 `tauri-plugin-updater` 的关系：Updater 需要自己的签名清单（`latest.json` + minisign 私钥）。如果采用它，则 Astral 侧的 `qt_app_update` 记录退化为「展示更新日志 + 官方校验」，**下载与安装由 Updater 负责**，两套流程不要同时开启。第一版建议先做自建流程（与移动端一致、可控），Updater 作为后续增量。

---

## 16. 日志设计

## 16.1 日志文件

```text
logs/
 ├─ app-2026-09-05.log
 └─ errors.log
```

## 16.2 日志级别

| 级别 | 用途 |
|---|---|
| trace | 调试细节 |
| debug | 开发调试 |
| info | 常规运行信息 |
| warn | 可恢复异常 |
| error | 错误 |
| fatal | 严重错误 |

## 16.3 记录内容

1. 应用启动和退出
2. 数据库迁移
3. 扫描开始和结束
4. 音源连接状态
5. 音频设备变化
6. 更新流程
7. 异常堆栈

日志不记录：

1. Astral `satoken` / `refreshToken`（出现时以 `***` 掩码）
2. 用户账号密码、邮箱验证码
3. 歌词正文
4. 完整播放地址（含签名参数的 URL 只记录 host + path，去掉 query）
5. WebDAV 密码、在线音源令牌（后续扩展）
6. 用户完整文件路径仅在 `debug` 级别记录，`info` 及以上只记录文件名

---

## 17. 安全设计

## 17.1 凭据存储

当前第一版只有 Astral 轻听账号凭据，不保存网易云、QQ、酷我、酷狗的音源平台账号。

1. Astral `satoken` 优先使用 Windows Credential Manager 存储。
2. token 不写入 SQLite。
3. token 不写入日志。
4. 界面显示时使用掩码。
5. 退出登录时清理 token。
6. token 过期时由 Rust 自动刷新。
7. 后续若增加 WebDAV 或授权音源登录，同样必须使用系统凭据管理器。

### 例外：AI 模型 Key（`ai.apiKey`）

「AI」设置里用户自填的大模型 Key **存在 `settings` 表的 `ai.profiles` JSON 里，是明文，不走 Windows 凭据管理器**。这是有意为之的例外，理由与代价：

- **为什么不用凭据管理器**：配置档是「多套地址 + 各自的 Key + 当前档」的整体结构（用户会在官方接口、自建网关、中转站之间切），凭据管理器的条目模型是「一条 key = 一个字符串」，把结构化的多档配置拆成 N 条凭据再拼回来，每次增删档都要对账，容易留下孤儿条目；而 `settings` 表本来就是这类「用户设置」的唯一归属（§8.8）。
- **代价与缓解**：Key 明文落盘，能读到 `music.db` 的人就能读到 Key。缓解措施是**前端永远拿不到明文** —— `ai_local_config` 只回 `hasKey: bool`，Key 从读库到发请求全程在 Rust 进程内（见 §11.7.1），WebView 里跑的任何脚本（包括被注入的）都读不到；设置页显示为掩码，留空 = 保持原值，不会因为「没重填」被清掉。
- **与上文的边界**：Astral 账号 token 是**服务端签发、代表用户身份**的凭据，泄露后果是账号被顶；AI Key 是用户自己填的第三方 API Key，泄露后果限于额度。两者风险等级不同，所以策略不同。若将来引入需要更高保障的第三方授权（OAuth refresh token 之类），仍按上文走凭据管理器。

## 17.2 IPC 安全

1. Tauri Capability 按窗口最小授权。
2. 桌面歌词窗口只订阅歌词事件。
3. 文件访问范围限制在用户选择的目录。
4. 高危命令需要显式用户操作触发。

## 17.3 主题安全

主题文件只允许声明视觉属性：

1. 不允许脚本。
2. 不允许远程资源（不是「不自动加载」，而是出现即拒绝导入）。
3. 不允许任意文件路径读取，资源只能落在皮肤自身目录内（§9.5 路径校验）。
4. 字体只能使用本地已安装字体或应用内置字体。

## 17.4 Capability 与 CSP 落地（原文缺失）

Tauri 2 的权限是**按窗口授权**的，§17.2 提出了「最小授权」原则但没有落到配置。定稿如下。

`src-tauri/capabilities/main.json`：

```json
{
  "identifier": "main-window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:window:allow-start-dragging",
    "core:window:allow-start-resize-dragging",
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-hide",
    "core:window:allow-close",
    "core:event:default",
    "dialog:allow-open",
    "opener:allow-open-path",
    "opener:allow-open-url",
    "os:default",
    "global-shortcut:default",
    "updater:default",
    "autostart:default",
    { "identifier": "core:webview:allow-set-webview-zoom", "allow": [] }
  ]
}
```

`src-tauri/capabilities/lyrics.json`（**显著小于主窗口**）：

```json
{
  "identifier": "lyrics-window",
  "windows": ["lyrics"],
  "permissions": [
    "core:event:allow-listen",
    "core:window:allow-start-dragging",
    "core:window:allow-set-size",
    "core:window:allow-set-position",
    "core:window:allow-hide"
  ]
}
```

配套约束：

1. 歌词窗口**不授予** `dialog` / `opener` / `fs` / `shell` 任何权限，即使歌词内容被污染也无法触发文件或外链操作。
2. 自定义 command 也要按窗口区分：歌词窗口只允许调用 `get_playback_state`、`toggle_play`、`next`、`previous`、`set_desktop_lyric_*`；其余 command 在 handler 入口用 `window.label()` 校验并拒绝。
3. CSP（§4.1）不放开任何外部域名；`img-src` / `media-src` 只放开 `asset:` 与 `qtres:`。
4. `assetProtocol.scope` 限定 `$APPDATA/**` 与 `$APPCACHE/**`；用户添加的音乐目录**不加入 asset scope**（本地音频由 Rust 读取后走播放链路，不需要 WebView 直接访问）。
5. 本地封面同样经 `qtres://local/<trackId>` 读取，避免为了显示内嵌封面而把整个音乐目录暴露给 WebView。
6. `dangerousDisableAssetCspModification` 保持默认（不禁用）。

---

## 18. 性能设计

## 18.1 启动优化

1. 延迟初始化非核心模块。
2. 数据库迁移在启动早期完成。
3. 大列表首屏只查询第一页。
4. 封面缩略图异步加载。
5. 主题使用缓存配置。

## 18.2 播放优化

1. 音频线程与 UI 线程隔离。
2. 避免频繁全量序列化播放状态。
3. 进度事件节流。
4. 频谱事件频率可配置。
5. 不在前端计算音频数据。

## 18.3 大列表优化

1. 虚拟滚动。
2. 分页查询。
3. 数据库索引。
4. 封面缩略图缓存。
5. 排序和筛选下沉到 SQL。

---

## 19. 目录结构

## 19.1 前端目录

```text
src/
 ├─ components/            # UI 组件，按页面域分子目录
 │   ├─ common/            # 通用件（按钮、封面、虚拟列表…）
 │   ├─ layout/            # 标题栏 / 侧边栏 / 主框架
 │   ├─ discovery/         # 发现（推荐、排行榜、歌单广场）
 │   ├─ library/           # 本地音乐库
 │   ├─ lyric/             # 歌词
 │   ├─ mine/              # 我的（收藏、歌单、下载、设置、账号；听歌报告的 EntryPicture 等共用件在 ListenReportBits.tsx）
 │   ├─ music-source/      # 音源切换与管理
 │   ├─ onboarding/        # 首次启动引导
 │   ├─ player/            # 播放条 / 播放队列
 │   └─ update/            # 更新弹窗与下载进度
 ├─ hooks/                 # 位置插值、播放事件订阅等
 ├─ lib/                   # 工具函数
 │   ├─ daily-recommend.ts # 每日推荐的流程：偏好读取 / 冷启动 / 五路候选池 / 打散 / 缓存 / 模型提示词，可单测
 │   ├─ music-style.ts     # 风格画像：语种 / 时长带 / 专辑 / 歌单名 / 收听质量 → StyleProfile，可单测
 │   ├─ recommend-rank.ts  # 多维打分 + MMR 多样性 + 两阶段配额放宽 + 推荐理由，可单测
 │   ├─ recommend-types.ts # 上面三个模块共用的契约类型（零运行时代码）
 │   ├─ aggregate-sources.ts # 「聚合搜索只用哪几个源」的设置读写（解析容错 + 进程内缓存），可单测
 │   ├─ recommend-dimensions.ts # 候选池扩维：查询规划 / 榜单·关键词·风格歌单三路采集 / 风格线交织，可单测
 │   ├─ song-key.ts       # 搜索页跨页去重键（歌名 + 歌手集合），口径与包侧 merge-search 一致，可单测
 │   ├─ text.ts            # 文本归一化 / 键 / 日期 / 抖动等纯函数（全仓唯一实现，零依赖），可单测
 │   ├─ coerce.ts          # 未知 JSON 的取值：strict 族 as* 与宽松族 coerce*（两族语义不同，头注释写明）
 │   ├─ format.ts          # 体积等展示格式化（设置页与下载页共用）
 │   ├─ pending-cache.ts   # 在飞去重 + 已落定字符串缓存（歌手头像 / 歌手 id 共用）
 │   ├─ ai.ts              # 本地模型调用的前端封装（提示词与硬校验在这层之上）
 │   └─ …                  # router / storageKeys / lazyPage 等
 ├─ services/ipc.ts        # 所有 Tauri invoke 的唯一出口
 ├─ source-engine/         # 引擎页客户端（跑音源包取链）
 ├─ source-scripts/        # 音源包宿主 facade（统一入口 / 版本检查 / qt-contract 宿主契约）
 ├─ stores/                # Zustand：播放 / 队列 / 认证 / 外观
 ├─ types/
 ├─ App.tsx
 └─ main.tsx
```

## 19.2 Rust 目录

```text
src-tauri/
 ├─ capabilities/
 ├─ icons/
 ├─ src/
 │   ├─ main.rs
 │   ├─ lib.rs
 │   ├─ commands/
 │   │   ├─ audio.rs
 │   │   ├─ music_source.rs
 │   │   ├─ astral.rs
 │   │   ├─ library.rs
 │   │   ├─ lyric.rs
 │   │   ├─ playlist.rs
 │   │   ├─ download.rs
 │   │   └─ system.rs
 │   ├─ audio/
 │   ├─ metadata/
 │   ├─ lyric/
 │   ├─ providers/
 │   │   ├─ mod.rs
 │   │   ├─ wyy.rs
 │   │   ├─ qq.rs
 │   │   ├─ kw.rs
 │   │   ├─ kg.rs
 │   │   └─ local.rs
 │   ├─ astral/
 │   │   ├─ client.rs
 │   │   ├─ auth.rs
 │   │   ├─ like_sync.rs
 │   │   ├─ feedback.rs
 │   │   ├─ message.rs
 │   │   └─ stats.rs
 │   ├─ downloads/
 │   ├─ storage/
 │   │   ├─ mod.rs
 │   │   ├─ database.rs
 │   │   ├─ migration.rs
 │   │   └─ cache.rs
 │   ├─ theme/
 │   ├─ windows/
 │   │   └─ desktop_lyric.rs
 │   ├─ tray.rs
 │   ├─ shortcuts.rs
 │   ├─ media_control.rs
 │   ├─ updater.rs
 │   ├─ ai_local.rs         # 客户端直连大模型（配置档读写 / 试连 / 取模型列表 / 转发对话，§11.7.1）
 │   └─ logger.rs
 ├─ Cargo.toml
 └─ tauri.conf.json
```
---

## 20. 测试设计

## 20.1 Rust 单元测试

| 模块 | 测试重点 |
|---|---|
| audio | 播放状态、队列、模式切换 |
| queue | 顺序、循环、随机、边界 |
| metadata | 各格式元数据解析 |
| lyric | LRC 解析、时间轴排序 |
| storage | SQLite 读写、迁移 |
| provider | 音源状态和搜索 |
| theme | 主题校验 |
| ai_local | SSE 拼接、JSON 快路径、空 content 报错、可重试状态码白/黑名单（5 例） |

## 20.2 前端测试

| 模块 | 测试重点 |
|---|---|
| PlayerBar | 控制、进度、音量 |
| TrackTable | 虚拟列表、选择、排序 |
| MusicSourceSwitcher | 音源切换和状态 |
| ThemeStore | 主题应用 |
| LyricView | 当前行计算 |
| daily-recommend | **136 条单测**（`tests/daily-recommend.test.ts` 84 / `daily-recommend-generate.test.ts` 36 / `daily-recommend-cache.test.ts` 16）：偏好解析、候选池去重、三种口味配额、同歌手打散（v1.15 起**最小相邻交换**：无冲突原样保留、只动相邻撞歌手的那一两首）、推荐理由分级、`parsePicks` 硬校验（越界 / 重复 / 布尔值）与**三级容错**（裸控制字符 / 尾逗号 / 正则捞序号 / 裸数字数组 / `title`、`summary` 捞回）、`pickAiPool`（150 上限、前 90 必进、尾巴按 variant 轮转）、缓存命中与跨天失效、「换一批」合并而非覆盖、模型失败退回规则、**模型回执格式坏了重试一次（0.4 → 0.2 温度）**、**多给一两首按目标条数截住**、**候选池给到 150 首（不是 50 首硬塞）**、**提示词求贴合**（候选行证据 / 语种下限 / 不再要求凑风格 / 第 51–90 首换进 6–10 首 / **池子不够长时这条整条不出现且编号仍连续**）、**`filterAiPicks` 剔掉无依据的歌**、**`limitAiPicks` 中段穿插封顶 12 首**、**冷启动**（无记录不空页面 / 下发风格分类 / 跳过也有内容且不 toast / 存种子后重算且不再冷启动 / 音源不支持分类时降级）与 `parseStyleSeeds` 容错、候选池跨源聚合走数据包 `searchMany`（分块调用、单块失败不连坐）、「聚合搜索音源」设置透传到跨源搜索（默认不传 / 勾选后带白名单）、**v1.16 多维度**（候选行带 `风格线：X` 与「画像里的语种分布」、线 ≤3 条时目标按实际条数给、`diversifyByLanes` 七成底盘 + 三成配额 4 条、有画像风格线支撑的歌不被 `filterAiPicks` 剔、**维度路把榜单里的新风格带进候选池**（local 与规则两条分支都断言 `styleLanes` 含榜单线）） |
| recommend-dimensions | **25 条单测**（`tests/recommend-dimensions.test.ts`）：维度查询规划（画像标签 / 歌单名 / 次要语种（≥5%）/ 相邻风格 / 按 variant 轮换的兜底词 / 搜索历史 → 去重截断 ≤10）、`chartLane` 从榜单名抽风格线（词表命中优先、否则去「榜」后缀）、三路采集的应答归一与 provenance（`laneOf` 主线在前）、单路失败 / 空结果不 throw、`interleaveByLanes`（SWRR 权重 4/2/2/1、未标线进末尾兜底、组内保序、去重）、`laneCoverage`（只统计主线、按 count 降序、截断 5） |
| daily-recommend-page | **4 条 jsdom 用例**（`tests/daily-recommend-page.test.tsx`）：`styleLanes` 非空时在「口味画像」下方渲染「本期风格」chips（`古风 22` / `粤语 7`）、每颗 chip 有 `title` 说明、空数组与缺字段都不渲染、chips 位于口味按钮组之前 |
| AI 模式与本地助手 | **69 条单测 / jsdom 用例**：`ai-mode` 7（解析 / 读写 / 选项与说明）、`ai-server-picks` 9（未登录、无智能体、会话创建失败、事件终态、超时、`finally` 删会话）、`ai-assistant-local` 23（rule 打分、点名歌手不受同歌手配额、默认 20 首与「5 首 / 二十首」解析、local JSON 契约与整段回退 rule）、`ai-assistant-history` 11（增删 / 消息还原 / 30 会话封顶 / 排序稳定 tiebreak）、`ai-assistant` 页面 11（三种模式的横幅与侧栏）、`use-ai-chat` 8（模式分流、非 server 不拉 astral、本地回合写回历史、切换与删除会话） |
| music-style | **38 条单测**（`tests/music-style.test.ts`）：语种判定（假名 / 谚文 / 汉字 / 拉丁 / 器乐）、时长带边界（150 / 240 / 330）、专辑键、完播比与 `skipped` 判定、画像归一化（`mainLang` 份额 < 0.34 时给 `und`）、歌单名抽风格词、`describeProfile` 文案（含只有风格种子时说「你选的风格：…」而不是「口味还不明显」） |
| recommend-rank | **34 条单测**（`tests/recommend-rank.test.ts`）：相似度权重、六项验收（新歌手能进前排 / 同语种不霸屏 / 无相邻同歌手 / 历史降权不排除 / 屏蔽硬排除 / 配额放宽兜底）、语种上限单独放宽、`familiarSingers` 兜底、理由分级与 20 字上限、可复现性 |
| source-scripts 聚合搜索 | **5 条单测**（`tests/source-scripts-search-many.test.ts`）：`searchMany` 应答映射（关键词归一化去重、batches → `Track`、`truncated`）、空关键词不发调用、非「缺入口」错误原样抛出、旧数据包缺入口时直接抛「数据包版本过旧」且只 invoke 一次（v1.17 删掉宿主 `fanOutSearch` 降级） |
| source-tag | **7 条 jsdom 用例**（`tests/source-tag.test.tsx`）：列表用 `xs`（10px / `px-1`）与正在播放页 `sm`（11px / `px-1.5`）两档、`title` 为「来源：简称」、底色是该音源颜色 16% 淡底、简称缺失的旧数据包回落全名、未注册源显示「未知」、本地曲目不渲染、`whitespace-nowrap`（简称不能被折成两行） |
| song-key | **13 条单测**（`tests/song-key.test.ts`）：`normText` 归一化（嵌套括号剥离、歌手集合拆分后排序）与 `songKey`（标题 + 歌手集合；标题归一化为空时回落 `${platform}:${id}`）—— v1.17 从 `aggregate-merge.ts` 摘出，只服务搜索页跨页去重，口径与包侧 `merge-search.ts` 一致 |
| source-scripts 合并入口 | **6 条单测**（`tests/source-scripts-search-merged.test.ts`）：`{list, full}` 应答映射成 `Track` 并按勾选集再过滤、`full` 原样透传、未配勾选集时入参与旧版一致、空关键词不打引擎、非「缺入口」错误原样抛出、旧数据包缺入口时直接抛「数据包版本过旧」且不再退回本地合并（v1.17 删掉 `localMerge`） |
| aggregate-sources | **15 条单测**（`tests/aggregate-sources.test.ts`）：`parseAggregateSources` 的空值 / 坏 JSON / 非数组 / 空数组 / 非字符串项 / 非法 id / 去重保序 / 16 个截断，读写的缓存命中与重置、「全选存空值 → 读回全部」、保存前归一化、读设置抛错按全部兜底 |
| source-scripts 源过滤 | **5 条单测**（`tests/source-scripts-source-filter.test.ts`）：不配置时 invoke 参数不带 `sources`（不破坏既有调用）、配了就把 `sources` 传下去且**应答里未勾选的源被丢掉**（旧包兼容兜底）、空数组等于不过滤、`searchManyBatches` 同样过滤 groups 与 `merged`、旧包退回逐词 `searchAll` 时也带 `sources` |
| 设置页 · 聚合搜索音源 | **5 条 jsdom 用例**（`tests/settings-aggregate-sources.test.tsx`）：默认全开且显示「已选 N/M」、关掉一个立刻落库、最后一个源不允许关（提示且不写坏设置）、点回全部写空值、已配置的勾选按 id 还原 |
| 公共工具（去重合并） | **15 条单测**（`tests/shared-utils.test.ts`）：`normText` 去括号/标点/大小写与全角空格、`compactText` 只折叠空白不剥括号、`trackKey`/`songNameKey` 同源不同平台的合并口径、`localDateKey` 本地时区补零、`safeDecodeURIComponent` 坏编码原样返回、`hashString`/`jitter` 的稳定性与值域、`truncateChars` 按码点不劈代理对；`as*` 严格族与 `coerce*` 宽松族的边界（`asNumber("42")`→0、`coerceNumber("42")`→42）；`formatBytes` 换单位与小数位；`pending-cache` 在飞去重、失败落空串、超容量逐出、`clear` 计数。另：三份 facade 测试的引擎 mock 已收敛到 `tests/helpers/engine-client.ts` |
| 搜索首页 | **5 条 jsdom 用例**（`tests/search-landing.test.tsx`）：无关键词时渲染两块（搜索历史 / 热门搜索）且**不出现「热门歌单」**、输入框自动聚焦、点历史词或热词 = 写历史 + 改 URL、带 `?q=` 进来时落地内容全部收起且页签栏出现 |
| 搜索页 · 播放全部 | **3 条 jsdom 用例**（`tests/search-play-all.test.tsx`）：点「播放全部」= `playQueue(已加载 songs, 0)`、没有结果时不渲染这颗按钮、歌单 / 歌手 / 专辑页签不渲染 |
| 标题栏搜索入口 | **2 条 jsdom 用例**（`tests/titlebar-search.test.tsx`）：点按钮跳到 `/search`（`q` 为空、落在搜索首页）、标题栏不再有输入框（`textbox` 查不到）只留入口按钮文案 |
| 搜索页 · 页签切换 | **7 条 jsdom 用例**（`tests/search-tab-switch.test.tsx`，真 memory-history 路由 + `RouterProvider`）：点页签改 URL 后按新页签重拉、连切多个以最新为准、旧页签请求在飞时切走则迟到结果不覆盖、`?type=playlist` 直接落地（详情页返回场景）、翻到第 2 页后切页签必须回第 1 页重拉、聚合模式歌曲→歌单走歌单动作、快速连点两页签 URL 与列表不分叉 |

## 20.3 集成测试

1. 播放 → 暂停 → 恢复。
2. 扫描 → 播放 → 收藏。
3. 创建歌单 → 添加歌曲 → 播放歌单。
4. 切换音源 → 搜索 → 播放。
5. 开启桌面歌词 → 切歌 → 校验同步。
6. 修改主题 → 重启 → 校验持久化。
7. 更新检查 → 下载 → 安装。
8. 听几首歌 → 打开每日推荐 → 校验结果按画像出歌（不只常听歌手）、摘要下有口味画像 → 换一批 → 校验当天推过的降权而非重复 → 跨天（改系统时间）→ 校验重算。
9. 清空播放记录与收藏（模拟新用户）→ 打开每日推荐 → 校验页头列出风格 chip 且下方已有兜底内容 → 点两个风格 → 按这些风格生成 → 校验结果页显示「你选的风格：…」且不再出现 chip → 重启应用后仍按该风格推荐（种子已入库）。
10. 设置 → 音源包 → 关掉两个音源 → 回到搜索页切「全部音源」搜一个词 → 校验分组里只剩已勾选的源（关掉的那些**一条都不出现**）→ 再关到只剩一个 → 校验最后一个源关不掉且有提示 → 点回全部 → 校验分组恢复。

## 20.4 性能测试

1. 冷启动时间。
2. 10 万首歌曲滚动。
3. 大目录扫描。
4. 播放时 CPU 和内存。
5. 桌面歌词同步误差。
6. 无缝播放间隙。

---

## 21. 里程碑计划

### 21.0 先跑通一条最小闭环（原文缺失，强烈建议）

原计划 M1–M12 是按模块切的，问题是**要到 M5 才有能听的歌**（M2 的「可播放在线歌曲」依赖 M5 的 Provider 才能取到地址），中间三个里程碑无法验证核心假设。建议先插一个 M0，把最不确定的三件事（Rust 音频链路、流式播放、无边框壳）在一周内验证掉：

| M0 交付 | 验证的风险 |
|---|---|
| Tauri 壳 + 无边框标题栏 + 播放条静态布局 | 无边框窗口的拖动 / 缩放 / Snap 缺失是否可接受 |
| **单一音源（建议 wyy）**的 `search_music` + `get_play_url` + `get_lyric` | Provider 移植的真实难度（签名、请求头、响应归一） |
| Rust 音频核心：`HttpRangeReader` + rodio 播放 / 暂停 / seek / 音量 | 流式播放、seek、FLAC 兼容性——**整个项目最大的技术风险** |
| `position-changed` + 前端插值 + 播放页滚动歌词 | 50ms 同步误差是否可达 |

M0 通过后再按下表推进；M0 不通过就要在架构层面调整（例如改用 `stream-download` crate、或先只支持完整下载后播放）。

### 21.1 里程碑表

| 阶段 | 内容 | 交付物 |
|---|---|---|
| M1 | Tauri 2 + React 项目初始化、基础布局、自定义标题栏、路由 | 可运行壳应用 |
| M2 | Rust 音频核心、播放条、播放队列、播放模式、播放地址 10 分钟失效策略 | 可播放在线歌曲 |
| M3 | Astral HTTP Client、登录、Token 刷新、账号资料 | Astral 账号能力 |
| M4 | 收藏增量同步、本地待同步队列、收藏页 | 多端收藏能力 |
| M5 | 四大音源 Rust Provider：搜索、歌单、榜单、新歌、热词、歌词、封面 | 音源基础能力 |
| M6 | 歌单广场、排行榜、榜单详情、新歌速递、歌手、专辑、MV | 发现与搜索能力 |
| M7 | 本地扫描、下载队列、离线播放、本地歌单、播放历史 | 本地与离线能力 |
| M8 | 主题系统、皮肤自定义、封面取色、播放页 | 视觉定制能力 |
| M9 | 桌面歌词、托盘、快捷键、媒体键、迷你模式 | 桌面体验 |
| M10 | 反馈、消息中心、统计上报、Windows 更新、自启动 | 服务与系统能力 |
| M11 | 频谱、波形、无缝播放、淡入淡出、EQ | 音频增强 |
| M12 | 性能优化、接口回归测试、打包发布 | 正式版本 |
---

## 22. 风险与应对

| 风险 | 等级 | 应对 |
|---|---|---|
| 音频格式兼容不稳定 | 高 | 建立多格式测试集，失败文件明确提示 |
| 桌面歌词窗口在 Windows 上表现异常 | 中 | 优先 Windows 适配，提供普通置顶模式降级 |
| 大目录扫描慢 | 中 | 增量扫描、后台任务、进度展示 |
| 无缝播放实现复杂 | 高 | 先保证稳定切歌，再逐步优化间隙 |
| 主题配置过多导致复杂 | 中 | 提供基础模式和高级模式 |
| WebView 渲染性能差异 | 中 | 关键列表虚拟化，动画可关闭 |
| 在线音源合规风险 | 高 | 第一版仅限个人学习交流，不绕过 DRM 和版权限制；商业发行前替换为官方或授权接口 |

---

## 23. 后续扩展方向

1. WebDAV Provider
2. 自建音乐服务器 Provider
3. 智能歌单
4. 主题市场
5. 歌词编辑器
6. 音频转码工具
7. 移动端联动
8. 多端播放同步
9. 音乐统计报告
10. 插件系统

---

## 24. 工程与交付（原文缺失）

### 24.1 目录与仓库位置

新工程建议放在 `F:\qtMusic\qt-pc\`（与 `qt-uniappx`、`astral` 平级），本文档与需求文档同目录。工程内不修改 `qt-uniappx` 与 `astral` 的任何文件——Provider 是**移植**而非引用，两侧各自演进。

```text
qt-pc/
 ├─ app.config.json          # ★ 公开配置源（§24.2）：版本号 / 产品名 / ID / 本机联调地址 / 端口 / 音源包版本
 ├─ app.config.local.json    # 私有配置（不提交）：自有域名 / 生产后端 / 官网；模板见 .example
 ├─ REQUIREMENTS.md
 ├─ DESIGN.md
 ├─ README.md
 ├─ package.json             # version 由 config:sync 写入
 ├─ tsconfig.json
 ├─ vite.config.ts           # 端口读 app.config.json
 ├─ vitest.config.js
 ├─ index.html
 ├─ scripts/
 │   └─ sync-config.mjs      # ★ 配置同步器（config:sync / config:check）
 ├─ src/                     # §19.1
 ├─ tests/                   # 前端单测（含 config.test.ts 配置护栏）
 ├─ docs/                    # CONFIG.md / PACKAGING.md
 ├─ tools/                   # registry-proxy.mjs（本机 cargo 绕行）
 └─ src-tauri/               # §19.2
```

### 24.2 配置单一真值（`app.config.json` + 私有层）

> 早期草案设想的 `config.dev.toml` / `config.local.toml` **没有落地**，按下面的方案实现。
> 草案的问题：同一份信息（版本号）散落在 5 个文件里手改，发版时必然漏改一处。

| 位置 | 提交 | 内容 |
|---|---|---|
| `app.config.json`（仓库根） | 提交 | **唯一公开配置源**：产品名 / 展示名 / ID、`version.{name,code}`、`sourcePack.hostApiVersion`、`backend.{dev,active}`、`platform.*`、`devServer.{port,hmrPort}` |
| `app.config.local.json`（仓库根） | **不提交** | **私有值**：`backendBaseUrl` / `officialSiteUrl` / `ownDomains`（模板见 `app.config.local.json.example`） |
| `scripts/sync-config.mjs` | 提交 | 同步器：把公开值写进 6 个派生文件、把私有值写进 `private_config.rs`；`--check` 只校验不写盘（且**不校验**私有产物） |
| `src-tauri/src/app_config.rs` | 提交（**生成物**） | Rust 侧公开常量的唯一读取入口（`astral.rs` 的对外常量转指到它）+ 一致性单测 |
| `src-tauri/src/private_config.rs` | **不提交**（生成物） | 私有值编译成的常量；缺失时由 `build.rs` 补空壳，保证裸 `cargo test` 可编译 |
| `src-tauri/src/runtime_config.rs` | 提交 | 运行期读同名 `app.config.local.json` 覆盖编译期常量 + 自有域名匹配 |
| `src-tauri/.cargo/config.toml` | **不提交** | 本机 cargo 走 127.0.0.1 镜像的绕行配置（已在 `.gitignore`） |

规则：

- 改公开配置**只改 `app.config.json`**，然后 `pnpm config:sync`；`pnpm build` / `pnpm dev` 会自动先同步，
  `pnpm test` 会先校验（不一致直接失败）。
- **自有域名 / 生产后端地址 / 官网地址一律不进仓库**（仓库公开）。它们只活在
  `app.config.local.json` 里，编译期落进 `private_config.rs`，运行期还能被同名文件覆盖 ——
  后者让运维改地址不必重新发版，也让测试能把客户端指向本机服务。
- 后端地址由 Rust 持有（`app_config.rs` → `runtime_config.rs` → `astral.rs`），
  前端不感知也不硬编码；官网地址同样如此，经 `official_site_url` 命令下发。
  切换环境改 `backend.active`（`dev` / `prod`）后同步重编，不手改任何地址字面量。
- 私有配置缺失**不 panic**：公开仓库与 CI 裸构建本来就没有它。代价是自有域名列表为空 ⇒
  `net_guard::is_own_host()` 永远为假 ⇒ 明文 http 下载一律被拒（**收紧**而非放松）。
- 只有「在多个文件里重复出现」的值才进配置源；工具独占的配置（tsconfig 选项、vite 构建目标、
  Cargo 依赖与 profile、NSIS 模板…）留在原文件 —— 理由与完整字段表见 `docs/CONFIG.md`。

### 24.3 构建与 CI

| 任务 | 命令 |
|---|---|
| 配置校验 | `pnpm config:check`（`pnpm build` / `pnpm test` 已内置） |
| 前端类型检查 | `pnpm typecheck`（= `tsc --noEmit`） |
| 前端单测 | `pnpm test`（= `config:check` + `vitest run`） |
| Rust 检查 | `cargo clippy --all-targets -- -D warnings` |
| Rust 单测 | `cargo test`（§20.1 的模块；含 `app_config` 的配置一致性单测） |
| 本地运行 | `pnpm tauri dev`（本机 CLI 的 argv[0] 问题见 `docs/PACKAGING.md`） |
| 出包 | `pnpm tauri build`（产物：`src-tauri/target/release/bundle/nsis/*.exe`） |

CI（GitHub Actions，`windows-latest`）：`checkout → setup node/pnpm → setup rust(msvc) → 缓存 cargo/pnpm → 类型检查 + clippy + 测试 → tauri build → 计算 MD5/大小 → 上传 artifact`。Release 环节保持人工确认，避免自动发布未验证的包。

### 24.4 代码签名与 SmartScreen（发布必须提前决策）

未签名的安装包在 Windows 上会触发 SmartScreen「未知发布者」拦截，用户需点两次「更多信息 → 仍要运行」。这是**发布前必须决策**的成本项：

| 选项 | 成本 | 效果 |
|---|---|---|
| 不签名 | 0 | 首次运行有警告，下载量积累后逐渐减轻 |
| OV 代码签名证书 | 年费 | 去掉「未知发布者」，仍需积累声誉 |
| EV 代码签名证书 | 年费更高 + 硬件密钥 | 立即获得 SmartScreen 信誉 |

第一版按「不签名 + 官网/README 说明 + 提供 MD5 供校验」处理，并在需求文档的验收标准中排除签名相关项。

### 24.5 与移动端的一致性检查清单

发布前逐项核对，避免两端行为漂移：

1. 源 ID 仍为 `wyy / qq / kw / kg`，收藏接口 `platform` 字段一致。
2. 音质枚举仍为 `128 / 320 / flac`。
3. 播放地址有效期仍为 10 分钟。
4. 收藏同步仍以 `updatedSeq` 为游标，last-write-wins。
5. 更新 `type=1103/1104/1105`（按编译目标）、消息 `channel=pc`、统一客户端系统头 `X-App-Ut=app-windows/app-linux/app-macos`（统计 `ut` 与反馈平台同值）。
6. 默认皮肤主色与移动端品牌色一致（`#e5484d` / `#ff5c63`）。

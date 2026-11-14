# 可选账号每日推荐与私人 FM

## 支持范围

| 功能 | 网易云 | 酷狗 | QQ | 咪咕 | 酷我 | B站 |
| --- | --- | --- | --- | --- | --- | --- |
| 账号每日推荐 | 已实现，保留 | 已实现，保留 | 已实现（feed「每日30首」卡片 → `aiDissInfo`，2026-11-13 真账号 30 首） | 已实现（网页「今日推荐」，2026-11-13 真账号 60 首） | 未声明（仅有官方编辑歌单，不顶替账号日推） | 上游不存在 |
| 账号私人 FM | 已实现，保留 | 协议已实现（只读 `action: login`） | 已实现（含微信 `W_X` 登录 + 19 位 `wxuin`） | 协议已实现（Cookie 本人校验后 `PRIVATE_FM action=2`） | 上游不存在可复现 HTTP 链 | 上游不存在可复现 HTTP 链 |

当前协议实现与合成回归不等于真实账户可用性或当前客户端已安装新版数据包；真实账号与 Native 验收仍为 NOT RUN。各源协议依据、剩余缺口与分阶段证据见[全源 FM 能力矩阵](<./FM-SOURCE-CAPABILITIES.md>)。

上表只表示当前已实现的能力。当前账号 FM 与账号日推均为网易云、QQ、酷狗、咪咕四源（QQ 日推 30 首、咪咕日推 60 首的账号级身份都由真账号实测确认）。**酷我与 B站的账号 FM / 账号日推在 2026-11-13 的三轮只读侦查中判定为“上游不存在可复现链”，不是“还没写”**：酷我 FM 的三段调用经 `window.external.callkwmusic` 落到宿主 Native（[comm2.js](<https://github.com/gudegan/nec-ai-crack/blob/b328ea619b9eaba7ffb7fa30f0d50090a4d55ef7/Nec/html/webdata/netsong/js/comm2.js>)），web/H5 端点表与 App 网关 `mobi.s` 的 15 个候选 type 全部 404；第三轮（同日，真实登录会话 Cookie `userid/sid/websid`）追加实测：① `mobi.s?type=radiolist` 带 `loginUid` 与匿名应答 sha256 完全相同（纯编辑位，登录参数只是透传）；② `mobi.s` DES 密封通道（`f=kuwo&q=`）`convert_url2` 正常取链但 18 个电台/FM 候选 type 全 404；③ `i.kuwo.cn/userinfo/` 密封族**存活**（`lua_get_user_and_follow`/`lua_get_user_playlist` 200 且解出本人资料，仓库 2026-10-27 判死的只是 `/US_NEW/kuwo/` 族），但 `lua_get_radio`/`lua_get_private_fm`/`lua_get_guesslike`/`lua_get_recommend`/`lua_get_daily_recommend`/`lua_get_rcm_song`/`lua_get_fm`/`lua_get_listen` 全 404，`lua_get_user_radio` 是资料 catch-all 不回歌曲；④ `wapi rcm/daily|listen`、`www radio`、`nplserver` 电台 op、`gxh2 newradio.nr` 各 type 均为编辑位或空——`nplserver getuserlist` 虽按 uid 回本人歌单，但乱 uid 同样 ok（不校验归属，更无电台歌曲流）。酷我「每日推荐」在网页端只是官方编辑歌单（恒为第一项 `1082685104`「每日最新单曲推荐」），按本文件的既有约定不能当账号日推。B站唯一的账号推荐面是**视频**首页流 `rcmd`（`goto ∈ {av,ogv,live}`，条目无分区字段），音频区 37 个端点全为编辑位、`/audio` SPA bundle 内 `每日`/`daily` 零命中，唯一「每日 11:00 更新」的官方歌单实测 0/16 可播。未取得合格协议时保留明确缺口，不用公共榜单、匿名歌单、日推、混合视频或客户端 AI 冒充账号 FM，不把局部完成称为“全部源已支持”。

“应用推荐”仍为默认。每日推荐与 FM 的供给来源可分别选择，与共享的规则 / 本地 AI / 服务端 AI 模式独立。切换供给不重写音乐助手的 AI 偏好。旧数据包没有账号能力声明时，不将公共歌单 `recommendations` 当成账号歌曲接口，也不悄悄降级为应用推荐。

使用账号供给需要在音源账号管理中保存该平台账号，并由用户开启该源的“数据”授权；本功能不会自动开启数据或播放授权。账号 Cookie 只用于已经授权的源请求，选择推荐供给不等于获得歌曲播放权限或会员解锁。Cookie 当前仍按既有账号设置存储，不代表新增了加密保险库或强隔离的脚本沙箱。

## 使用方式

1. 在音源账号管理中保存对应平台账号，确认该源的“数据”授权已开启，并加载声明账号推荐能力的新版数据包。
2. 在每日推荐页或私人 FM 页的来源控件中选择“平台账号”和平台；两个页面的选择独立保存。
3. 私人 FM 需要明确开始；选择账号来源不会自动开始播放，也不会开启“播放”授权。切回“应用推荐”后继续使用原有推荐与 AI 设置。

## 日推行为

- 通过当前源包的 `accountDailySongs` 取得该账号的歌曲；保留上游歌曲顺序、数量及原始 ID，不由应用重新打分、排序或补到固定数量。
- 显示账号与平台来源；应用的口味、冷启动、本地评分、AI 增强及歌曲排序不用于账号日推。
- 空结果显示空推荐，不混入应用推荐；账号变化、失效、限流及网络失败显示相应状态。
- 独立缓存与应用日推历史分离，按平台、账号、非密钥登录会话、当地日期、实际加载的数据包版本及 schema 隔离。最多 12 条缓存记录，寿命不超过 30 分钟及上游有效期；切换同 ID 账号登录会话也不复用旧条目。
- 缓存读取检查本地授权和加载上下文；实时上游身份核对发生在推荐获取阶段，不声称每次本地缓存读取都会联网。
- 来源切换、退出页面、换号、关闭数据授权、数据包切换和跨日后，旧异步结果不能覆盖当前页面或缓存。清除账号缓存不会清除应用推荐历史。

## FM 行为

- QQ 账号日推走两跳：`recommend.RecommendFeedServer/get_recommend_feed` 的首页卡片流里按 `extra_info.moduleID=recforyou@0@0` + `jumptype=10014` + `miscellany.dirid=202` 定位「每日30首」卡（其 `id` 即当日动态歌单 dissid），再以 `music.srfDissInfo.aiDissInfo/uniform_get_Dissinfo` 取 30 首；未登录时上游把该 id 下发成哨兵字符串 `"0"`，按需要登录处理。单页取完（`total_song_num=30`、`hasmore=0`），没有 cursor 也不翻页；歌曲 `interval` 为秒，封面按 `album.mid` 拼 `y.gtimg.cn`。
- 咪咕账号日推走网页「今日推荐」`pc/v1.0/template/todayRecommendList/release`：登录态 Cookie 得 60 首，只带设备 `imei` 是另一份 11 首通用清单，伪造 `pacmtoken` 被上游按「无身份」拒绝（`code 200205`）⇒ 清单由账号身份决定；同一账号换 `imei` 参数结果哈希不变。只收显式音乐标签行，非歌曲卡片（听歌偏好提示）按标签排除，过滤后为空即判畸形应答；单页无 cursor。
- 网易云、QQ、酷狗与咪咕的 `accountFmNext` 保留上游次序与重复歌曲；实际入队时按平台与歌曲 ID 去重。QQ 串行重验账号并保持 `song_ids: []`；酷狗每批只用 `action: login`；咪咕本人校验后读取 `PRIVATE_FM action=2`，均不回灌已播 ID、不返回虚构 cursor。酷狗与咪咕空批返回 `exhausted: false`，不是已证明无限续批；真实换批与上游终止语义尚未验证。仅透传真实上游游标。游标、歌曲计数及归属仅在 Native 实际接受入队后提交；有界探测全为空或重复时停止供给，保留最后已接受状态。
- 播放开始只认 Native 实际应用的 `play_queue` 回执。补曲必须携带该队列的结构版本，通过 Native 同锁的条件追加；用户换队列后，旧 FM 不得把歌曲加到新队列。
- 初始播放请求在 Native 尚未提交时被取消，只撤销该次原始播放票据，不回滚已经应用的队列，更不会恢复或覆盖用户的新队列。
- 补曲请求尚未提交时被取消，通过 `queue_release_if_current` 在原队列锁下释放匹配的结构版本；只推进归属版本，不清空队列、不停止播放、不改播放票据。已经提交的追加和后来建立的人工队列不会被撤回。预先取消的请求不发送追加或释放命令。
- Native 追加回执无效或传输结果不确定时，停止旧 FM 供给，不重试、不恢复队列快照，也不把诊断版本认作新的队列归属。
- 单次开始或补曲最多检查 3 批空 / 重复结果；失败有退避和有界停止，不无限拉取，不用应用推荐补齐。
- 来源、账号、授权或包会话变化停止旧账号供给；用户可明确重新开始。
- 应用内喜欢、不喜欢和跳过不隐式调用平台反馈接口。酷狗不移植默认 `action: play` 或 `hash/songid/playtime`；咪咕不刷新或静默覆盖 token。离线重复 `login` / action-2 取批只证明这些请求及响应边界，不证明真实账号能连续得到不同新曲。

## 源包开发契约

三份宿主契约均使用 `AccountRecommendationBatch`，注册项为 `accountDailySongs` / `accountFmNext`，能力声明为 `accountRecommendations.daily` / `.fm`。`accountId` 是预期身份，不是凭据；包适配器先核对实时上游账号，再请求推荐。

客户端结果边界校验字段类型并只复制公开契约字段；不会把原始 HTTP 错误、Cookie、token、请求头或 error cause 放进推荐结果、缓存、展示错误。网易云身份核对只接受正整数 UID 的规范字符串或安全整数；同时存在的 profile 与 account 身份必须一致，缺少 profile 时仅接受与预期身份匹配的有效 account.id，访客身份不作推荐回落。

账号与授权开关的进程缓存只在对应 Native 设置写入 Promise 成功后发布；写入未应用且拒绝时，不让成功的 Cookie 本人检查或乐观 UI 状态成为 META/FM 授权。META 修订仍立即失效，失败后不自动恢复旧修订。这不是多键事务、已接受写入的回滚、引擎注入失败恢复或“写成功但 ACK 丢失”的解决方案。

咪咕 Cookie 登录只使用已注册 `authImportCookie` / `authUser` 的本人校验；导入结果不自行保存，由宿主明确持久化并注入。`pacmtoken=` 片段只修剪前导间隔，保留 token 尾部空白/控制字符，让无效凭据在 HTTP 前被拒绝。无 QR、refresh 或会员权益推断。

metadata 注入只有当前账号 / 授权修订 / 引擎代次的成功 ACK 可复用。“播放”授权开关不重设有效 metadata 会话，但真实数据包安装或热加载事件会使引擎上下文失效；即使 META 包头未变，仍须等待新的 metadata ACK。合格日推缓存可以在新 ACK 后复用，不要求再次请求推荐。

Native 队列结构版本上限为 JS 安全整数，达到上限时失败关闭，不回绕或复用；单纯播放游标前进不视为结构变化。条件追加拒绝时不改变队列、播放或加载副作用。

## 数据面登录态注入（2026-11-14）

「数据请求使用登录态」开启时，meta 面全部请求按域名注入该源 Cookie（`auth-store` 的 `withAuth(host.request, "meta")` + `registerAuthDomains`）。六源域名表：wyy `music.163.com`、qq `qq.com`、kg `kugou.com`、migu `migu.cn`/`musicapp.migu.cn`、kw `kuwo.cn`、bili `bilibili.com`。播放面独立，默认关；bili 在播放面显式排除（带 Cookie 打 playurl 更易 -412）。

**注入规则**：请求头已存在 Cookie（任意大小写）时不覆盖——平台模块自管的 Cookie 优先。据此逐源核对，只有酷我签名路径踩到这条：`kwRequest` 无条件用自己的匿名 Cookie（首页 Set-Cookie 的 `kw_token`/`Hm_Iuvt*`）写头，把 meta 面登录凭据整个盖掉，导致开关对 kw 完全失效。修复为按 name 合并（登录凭据在前、匿名 Cookie 在后），因为匿名 Cookie 提供 `Hm_Iuvt*` 签名种子、登录 Cookie 提供 `userid`/`sid`/`websid` 身份位，缺任一半都不行。播放路径 `kw-play.ts` 不经 `kwRequest`，不受影响。

**实测口径（2026-11-14，真实登录账号）**：普通数据接口的「个性化」并不存在——酷我 `wapi/rcm/index/playlist`、咪咕 `pc/bmw/rank/rank-index`、`musiclistplaza-*` 带与不带登录 Cookie 的应答仅时间戳字段（`curTime`/`dataVersion`）不同，歌单条目逐字节一致；酷我 `api/www/bang/bang/bangMenu` 两种态都是 `The request is illegal!`。真正的个性化只在已实现的账号级接口里（网易云/QQ/酷狗/咪咕的日推与 FM，酷我公开层无此协议）。故该修复是**语义正确性**（开关应当生效），不是新的推荐来源。

## 验证边界

源端回归调用真实 registered META 入口及业务模块，仅外部 HTTP 使用受控 fixture。桌面回归调用真实控件、source façade、FM/player stores，仅外部 source engine / Native IPC 使用受控 fixture；此桌面结果不证明 Rust 队列代码实际执行或声卡播放。历史 Native 门禁与本阶段分别记账；本阶段未运行 Native、不使用用户的实际 Cookie 或生产账号。

**历史 QQ 阶段快照，保持独立，不代表当前文件计数：**2026-11-12 已收 QQ family 95 PASS；与原账号 84、身份 158 和 KG 2 联合 339 PASS / 0 skip，原授权/注册兼容性 131 PASS / 33 原联网跳过，桌面 focused 65 PASS / 0 skip。原完整公开 Source / PC TS5.8.3 `--noEmit` 与自有未签名源包构建通过。2026-11-13 收齐原桌面 ESLint exit0 / 0 warnings、字号/动效守卫 exit0 / 0 违规和原完整桌面 Vitest **214 文件 / 2047 PASS / 0 skip**，未放宽规则或新增跳过；精确收据与各自限制见[分阶段门禁](<./FM-SOURCE-CAPABILITIES.md#44-收齐的阶段门禁2026-11-12>)。原全 Source 测试的真实 GCID 阻碍未绕过，未签名合成包未交付任何客户端。离线回归和本地构建不证明当前账号的实际返回数量、现网协议稳定性、官方客户端完全等价或全源 FM 已支持。

**当前剩余源阶段（2026-11-13）：**源端 **9 文件 / 861 PASS / 0 skip**（含 KG FM170、Migu FM172/auth170）；桌面公共调用 **6 文件 / 89 PASS / 0 skip**；原兼容族 **131 PASS / 33 个逐项未变的 skip**。Source/PC 类型、原 lint、原完整桌面测试、自有未签名构建和 renderer 六个变更输入门禁均 exit0；原完整 PC 输出为 **215 文件 / 2071 PASS / 0 skip**，不是旧 214/2047。三处同测试字节 RED→GREEN 修复为账号 cache-after-persistence、开关 cache-after-persistence、Migu raw token tail；其余首跑 GREEN 矩阵不算额外修复。Lead 与独立 reviewer 从原 JSON 核对数量、原 skip IDs 与三组 TDD 一致；KW9/Bili1仅是未实现基线，不是 FM 验收。[当前独立冻结](<../../_tmp/remaining-fm-stage-freeze-20261113-d0c6c981-c59d-4d8d-8575-77b9b6b50b0e/verification.json>)及[当前门禁与覆盖限制](<./FM-SOURCE-CAPABILITIES.md#45-当前剩余源与桌面阶段2026-11-13>)单独保存，不回写历史 QQ/Migu 证据。

桌面和源包源码均需更新。正式官方数据包仍需要正确签名及原发布流程；本任务不提交、推送、发布，也不把未签名或合成签名的调试产物称为正式可安装包。Renderer 自有编译不是当前客户端热更新；本阶段未运行真实账号/音乐 HTTP、Native/Rust、物理音频、签名安装或发布，也不证明全源已完成。

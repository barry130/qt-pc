# 账号私人 FM：能力、证据与剩余缺口

> 状态日期：2026-11-13；当前 WYY / QQ / KG / Migu 四源已有账号 FM 协议/声明；账号日推为 WYY / KG / QQ / Migu 四源（QQ 与 Migu 均为 2026-11-13 真账号实测接入）。第 4.3–4.4 节保留历史 QQ 阶段快照，当前输入证据单列于第 4.5 节。**协议实现 / 合成回归**与**真实账户可用性 NOT RUN**分别记账。
> 本文不是全源 FM 完成声明。**KW 与 Bili 的账号 FM / 账号日推在 2026-11-13 两轮只读侦查后判定“公开层不存在可复现链”（第 6、7 节，附实测负证据）**；没有合格账号音乐 FM 取歌协议时，不用日推、榜单、广播、匿名供给、混合视频或客户端 AI 顶替。

## 1. 范围与状态口径

注册清单为 `wyy / qq / kw / kg / bili / migu`，以[源注册与可选账号能力契约](<../../qt-sources/src/registry.ts>)为准。本文覆盖五个扩展目标，并保留 WYY daily/FM 与 KG daily。[账号推荐说明](<./ACCOUNT-RECOMMENDATIONS.md>)同步四源 FM 的当前实现状态；两份文档均不把协议存在当作真实账号可用性或全源最终覆盖结论。

| 状态列 | 能证明什么 | 不能据此声称什么 |
| --- | --- | --- |
| 协议实现 | 当前处理器、能力声明、响应校验与前端接线是否存在 | 上游现在接受该客户端、真实账号能取歌或连续补给 |
| 合成回归 | 被明确列出的固定响应、身份、撤销或队列案例是否通过 | 真实账户可用、真实网关兼容、未覆盖边界也通过 |
| 真实账户可用性 | 经另行授权的真实账号、真实上游响应及连续供给证据 | 用公开仓库、显示登录状态或 fixture 代替此证据 |
| Native / 构建 / 发布 | 各自独立的实际运行或产物证据 | 用源码接线或源端测试代替 Native 验证、安装、签名与发布 |
| 全任务验收 | 全部目标达到其要求，且通过相应门禁 | 把单一文档完成或 QQ 首轮 GREEN 称为全源 FM 完成 |

初稿由文档 teammate 只读核对本地实现与固定版本公开源码后交付；后续由 Lead 更新实际收集的回归与门禁状态。初稿作者未执行测试、构建、Native、真实账户 HTTP、反馈写入、提交或发布；下述执行证据均归属于 Lead，不能改述为文档作者亲自运行。

## 2. 当前能力矩阵

`daily` 与 `fm` 是独立可选能力；源已注册不等于已实现账号 FM。未实现的接口维持当前能力门禁，不用匿名结果、公共歌单或日推顶替。

| 源 | 当前账号 daily | 当前账号 FM 协议/声明 | 本阶段合成证据 | 真实账户可用性 | 主要剩余缺口 |
| --- | --- | --- | --- | --- | --- |
| WYY 网易云 | 已实现，保留 | 已实现，保留 | 原账号 84 与身份 158 保留在当前源端联合 **861 PASS / 0 skip**；不外推为 WYY live 验证 | **NOT RUN** | 真实账号上游兼容性、连续供给及独立 Native/最终验收 |
| QQ QQ 音乐 | **已实现**：`daily: true` / `qqAccountDailySongs`（每日30首，2026-11-13 真账号 30 首） | **已实现协议**：`fm: true` / `qqAccountFmNext`；微信 `W_X` + 19 位 `wxuin` 已支持 | QQ **95 PASS** 保留在当前 861 联合；新增日推 **24 PASS**（`tests/account-qq-daily.test.ts`）；桌面联合 **89 PASS** 保留原 QQ 案例；历史 339/65 单列第 4.3–4.4 节 | FM 与日推**均已真账号实测**（FM 5 首 / 736ms、日推 30 首 / 1055ms）；换批与刷新时刻 **NOT RUN** | 连续多日 dissid 稳定性、刷新时刻、Native 与当前客户端验收 |
| KW 酷我 | 未实现：网页「每日推荐」只是官方编辑歌单（恒为 `1082685104`），按本文约定不能当账号日推 | **公开层无可用链**（2026-11-13 三轮判定，见第 6 节）：web/H5 全表无 FM 端点，App 网关 15 个候选 type 全 404，宿主桥为 `window.external.callkwmusic`；第三轮真实登录会话复核——`mobi.s` 带 `loginUid` 应答与匿名逐字节同哈希、DES 密封通道 18 候选 type 全 404、`i.kuwo.cn/userinfo/` lua 族存活但 8 个 FM/推荐 action 全 404（`lua_get_user_radio` 为资料 catch-all）、`nplserver getuserlist` 不校验 uid 归属 | 当前 **9 项 unsupported 基线**，不算 KW FM 验收 | **NOT RUN**（无可测协议） | 只有 App 私有抓包级逆向可能突破：请求类型、账号会话与批次语义三者都未取得 |
| KG 酷狗 | 已实现，保留 | **已实现协议**：`fm: true` / `kgAccountFmNext`；每批只读 `action: login` | KG FM **170 PASS**，纳入当前源端 861；新桌面 24 项包含真实 KG/Migu 开始、切换与补曲公共调用 | **NOT RUN** | 重复 `login` 的真实换批/终止语义；不伪造 `play/hash/playtime` 反馈 |
| Bili 哔哩哔哩 | 上游不存在：音频区 37 端点全为编辑位，`/audio` SPA bundle 内 `每日`/`daily` 零命中 | **上游不存在可复现链**（2026-11-13 判定，见第 7 节）：唯一账号推荐面是视频 `rcmd`（混 `av/ogv/live`、无分区字段） | 当前 **1 项 unsupported 基线**，不算 Bili FM 验收 | **NOT RUN**（无可测协议） | 若降级只能是「非账号」的 `song/similar` 种子电台，语义上不能叫账号 FM |
| Migu 咪咕 | **已实现**：`daily: true` / `miguAccountDailySongs`（今日推荐，2026-11-13 真账号 60 首） | **已实现协议**：Cookie 本人检查后 `PRIVATE_FM action=2`；`fm: true` / `miguAccountFmNext` | Migu FM **172 PASS**、Cookie auth **170 PASS**、新增日推 **30 PASS**；桌面实际导入/保存/META/FM 路径纳入 89 | 日推与 FM **均已真账号实测**（60 首 / 1642ms、5 首 / 203ms；FM 此前只有合成证据） | action-2 的真实换批/终止语义、连续多日清单稳定性与刷新时刻；不刷新或覆盖 token |

现有实现定位：[WYY 账号处理器](<../../qt-sources/src/platforms/wyy-recommend.ts>)、[KG daily/FM 处理器](<../../qt-sources/src/platforms/kg-recommend.ts>)、[QQ FM 处理器](<../../qt-sources/src/platforms/qq-recommend.ts>)、[Migu FM 处理器](<../../qt-sources/src/platforms/migu-recommend.ts>)与[Cookie 本人 helper](<../../qt-sources/src/platforms/migu-auth.ts>)。源码存在与合成 GREEN 均不解除真实凭据和账户 HTTP 的暂停边界；注册 META 入口仍为原 46 项 / `META_REVISION=19`，没有另造 `authUserByCookie` 入口。

## 3. 所有源共同遵守的边界

1. **明确 META 授权**：只使用所选账号已保存、明确允许数据面使用的凭据快照。选择“平台账号”不自动开启 META/PLAY，不改变全局 AI；daily/FM 来源各自独立持久化，默认应用供给保持不变。
2. **严格上游身份**：获取阶段必须从服务身份响应取原始账号 ID，与所选账号严格匹配。显示资料、Cookie 形状、凭据自带 ID、离线 fallback 都不是权威本人证明。QQ 的 GetSession `uid` 是会话/设备身份，不能替代 GetUserInfo 原始 `uin`；KG FM 验证 signed `/v3/get_my_info` 原始 `data.userid`，Migu 只认顶层 `userInfoItem.userId`。当前测试替换外部 HTTP，不能称为真实账号 live 验证。
3. **结构与顺序**：账号批次为 `AccountRecommendationBatch`，含 `source/kind/accountId/items/fetchedAt` 及可选 `cursor/expiresAt/exhausted`；每项按[MusicInfo 与批次契约](<../../qt-sources/src/contract.ts>)映射，`interval` 单位为秒。保留上游 ID 与顺序，不重新采样、随机重排或混入其他供给来伪装账号 FM。
4. **cursor 只认上游 token**：没有真实 continuation token 就不返回 cursor。不能把已播 ID、反馈字段、页号猜测或随机值造为 cursor。重复读批次的无 cursor 模式与真正分页模式必须明确区分。
5. **只读供给与反馈分离**：喜欢、不喜欢、跳过、自然播完不隐式提交上游反馈。为补歌伪造 `play/hash/playtime/cur_mark/is_overplay` 等行为，不属于本阶段授权。
6. **上下文与队列安全**：[公共账号 action](<../../qt-sources/src/actions/account-recommendations.ts>)检查能力及处理器，随后对显式凭据快照执行请求前后校验；[前端账号推荐上下文](<../src/lib/account-recommendation.ts>)校验源策略、选择、账号与引擎版本。沿用既有 FM 队列入口去重、最多 3 次空/重复批次探测、Native 接受追加后才提交 cursor、队列归属与版本保护；不借新源绕开这些规则。
7. **失败不降级冒充成功**：身份缺失/错配、网关拒绝、错误 envelope、响应结构错误与凭据撤销均显式失败；错误脱敏，不泄露 Cookie/token/请求 URL 或 raw cause。无真实上游依据时不自行给异常码贴“限流”标签。

[推荐来源控件](<../src/components/common/RecommendationSourceControl.tsx>)按注册表对应 `daily/fm` 能力过滤选项。能力声明仅表示处理器实现存在，不是 live 成功标志。

## 4. QQ：已实现协议；合成证据与 live 缺口分开

### 4.1 固定版本协议依据与当前实现

- [QQMusicApi 推荐模块：c046788d][Q1] 的 `get_guess_recommend` 调用 `music.radioProxy.MbTrackRadioSvr/get_radio_track`，固定参数为 `{ id: 99, num: 5, from: 0, scene: 0, song_ids: [] }`，支持显式 credential；SDK 注释中非 Android 需有效 credential。本应用不采用匿名例外，始终要求显式所选账号授权。
- [QQMusicApi 响应模型：同一 commit][Q2] 将推荐歌曲字段映射至 `tracks`；[共享歌曲模型][Q5] 区分 type 1 普通歌曲、2 长音频、6 视频/直播，时长为秒。当前[QQ FM 处理器](<../../qt-sources/src/platforms/qq-recommend.ts>)严格要求 RPC `data.tracks` 数组与数值 `type: 1`，映射 `mid/name/singer/album/interval`，不接受猜测的多数组 fallback。
- 当前[独立账号身份与 RPC helper](<../../qt-sources/src/platforms/qq-auth.ts>)使用显式凭据快照，校验 HTTP、根 envelope、`req_0` 与响应 `data`；先 GetSession，再验证 GetUserInfo 原始 `uin` 匹配选中 ID。它不调用可离线兜底的显示登录 helper。
- 传输复用**本仓 v14 客户端** comm/profile（Lead 明确为 `ct: 11 / cv: 14090008`）与实际 GetSession 字段。**没有把 QQMusicApi 默认 v20 或额外 QIMEI 整套移植进来**；本仓 v14 profile 是否被真实 gateway 接受为 **NOT RUN**，不能以推荐 RPC 参数有公开依据代替 transport live 验证。
- 当前实现的是 QQ `uin/qm_keyst` 凭据路径；**微信 `W_X` profile 尚未实现**，helper 显式返回 `unsupported`，不把微信 key 转成 QQ 类型继续请求。该边界不等于所有 QQ 登录方式或账号类型已覆盖，不保证微信 FM 支持；其他 profile 的适配仍需单独证据。

### 4.2 无 cursor 的串行读批次

[Quaver 固定版本 README：cadba6cb][Q3] 的作者报告：相同请求串行重复可得到新批次，一次 5 首；提高 `num` 未扩大批次，回灌 `song_ids` 返回 `22006`，并发多轮出现 `700000`。这是**第三方报告**，不是本项目真实账号连续供给实测。

当前 QQ handler 每次保持上述参数、`song_ids: []`，不返回 cursor；空 `tracks` 才标 `exhausted`。后续应在现有队列安全约束下验证串行重复取批，不回灌已播 ID，不并发赌通过，不把 `22006/700000` 误写为 cursor 或已确立的 rate-limit 语义。第三方“每轮随机”也不保证当前账号不重复或无限供给。

### 4.3 已收集的合成结果快照

证据来源为 Lead 2026-11-12 **19:05:10（+08:00）**已 collect 的四族结果：

| family | 该次结果 | 解释 |
| --- | --- | --- |
| registered QQ 首个 META 正向 tracer | 1 PASS | 原未注册时实际 RED `unsupported`、1 fail；实现与声明落地后首片 GREEN |
| 原账号族 | 84 PASS | 原 84 项仅 QQ 能力期待与标题两处按新能力更新；不能写成 84 个 QQ FM 案例 |
| 原身份族 | 158 PASS | 既有身份回归保留，不等于新增 QQ 身份边界全部覆盖 |
| 独立 KG | 2 PASS | 保留 KG daily/live 身份相关边界，不是 KG FM 测试 |
| 合计 | **245 PASS / 0 skip** | 每族 unexpected network attempts 为 **0**；固定响应测试，不是真实音乐服务 HTTP |

**上述 245 项是历史首片快照，不是最新最终 union。**随后 Lead 已 collect 2026-11-12 **19:24:34（+08:00）**的 QQ public family **22 PASS / 0 skip / 外部网络尝试 0**（后续快照见下）：

- 原始 live UID 20 种非法值的 public family 21 项首跑已 PASS；严格实现已存在，不伪称这些案例先 RED 再修复。
- 微信 `W_X` key 被误发为 QQ type 2 的 tracer 实际 RED（21 pass / 1 fail）后，新增显式拒绝 guard；QQ family 22 项 GREEN。微信 profile 仍未实现，`unsupported` 不转 QQ，不能声称微信 FM 已支持。
- serial 第 23 例在该 19:24 消息时仍运行，随后已在 19:28:31 的 23 PASS 快照通过；三处 GetSession/GetUserInfo/FM 响应期间 clearAuth 撤销在 19:32:57 的 26 PASS 快照首跑通过。以上已有正确 guard，不制造 RED。
- CGI 子项 `2001` 限流实际 RED（27 项中 26 pass / 1 fail，误分类 upstream）后，最小限流 guard 在 19:43:47 得到 27 PASS。分类参考固定版本 [CGI response mapping][Q4]；未知 `22006/700000` 仍为 upstream，不推断限流或登录失效。
- 普通音乐类型 tracer 的 10 种失效/长音频/视频实际 RED（37 项中 27 pass / 10 fail）后，只允许严格数值 `type: 1`，19:53:27 的 QQ family 37 PASS / 0 skip；不把非音乐当歌曲供给。
- 新桌面 QQ 控件／真实 façade 与 FM/player 串行队列案例在 19:42:10 单例 PASS；首次失败只是两个控件同名查询歧义，修正作用域后无需桌面生产修改。19:52:44 联合原 64 项与新 1 项 **65 PASS / 0 skip**；fixture 替代外部 source engine/Native IPC，不是真播放。受限 focused tsc 暴露新测试事件多余字段与跨仓库类型依赖，已按实际契约移除多余 `queueRevision`，未改原测试与配置；19:55:31 重新联合65 PASS，随后原 whole-public PC TS5.8.3 `--noEmit` 实际 exit0、PC与相邻Source公开投影/解析均 `projectionVerified:true`。不把 companion 解析验证当作另跑 Source CLI，不认证完整传递依赖字节闭包或字面原host root。
- 空 `tracks` 的第 38 例首跑通过，保持所选身份、空结果和 `exhausted: true`，不从应用/公共曲库补齐。合法普通歌曲空 album MID 的第 39 例实际 RED 后，最小映射允许恰好空字符串并保留空封面，得到 39 PASS；缺字段、非字符串或非法 MID 仍拒绝整批。
- 超出安全整数的原始十进制 UID 字符串 `9007199254740992` 实际 RED（39 pass / 1 fail）：曾误归为可比较的账号错配。数字字符串新增安全整数约束后得到 40 PASS，坏结构不从 Cookie、会话 UID 或显示资料补身份。
- 外层 global `104401` 实际 RED（40 pass / 1 fail）：曾借用 CGI 子项的登录失效语义。外层非零统一 `upstream` 的最小修复后得到 41 PASS；只有 CGI 子项使用 [固定第三方错误表][Q4]，并非官方或 live 验证。
- 追加的 54 项验证覆盖规范字符串 UID、不同本人账号、仅 PLAY 授权、会话/envelope/歌曲坏结构、HTTP/CGI 静态错误、三段响应期间凭据对象/token 与源策略更换。既有生产守卫已生效，不能把首跑通过称为新增修复；关闭源一条期待曾误要求 raw policy error，校正为既有公共 adapter 的静态 `upstream`，不是 production RED→GREEN。20:22:08 QQ family **95 PASS / 0 skip / 外部尝试 0**。

### 4.4 收齐的阶段门禁（2026-11-12）

| 门禁 | 已收实际结果 | 收据与限定 |
| --- | --- | --- |
| registered META 账号联合 | **339 PASS / 0 skip**：QQ 95 + 原账号 84 + 原身份 158 + KG 2 | [联合收据](<../../_tmp/qq-fm-source-focus-9f759c65-4d21-43c3-aafe-e621ba3764a6/result.json>)；输入前后 SHA 一致，各 worker unexpected network attempts 0；原 84 的旧断言仅有标题/QQ capability 两处可逆更新 |
| 原授权/注册兼容性 | **131 PASS / 33 原联网跳过**：原 auth 与 source-scripts 族共 164 例 | [兼容性收据](<../../_tmp/qq-fm-source-focus-fefc00c4-7f6c-46bf-a250-41ce22a59c7c/result.json>)；保留原 `QT_NET_TESTS` 开关和断言，没有新增跳过，各 worker 外部尝试 0 |
| 真实桌面公共调用 | **65 PASS / 0 skip**：原 64 + QQ 新 1 | [桌面收据](<../../_tmp/qq-fm-desktop-focus-cc388000-13b8-4e1e-95bc-c76f2b14d907/result.json>)；真实控件/façade/FM/player，只有外部 source engine 与 Native IPC fixture，不是声卡播放 |
| 原 Source 类型检查 | TS **5.8.3 `--noEmit` / exit0** | [Source 类型收据](<../../_tmp/task-36-public-2026-11-12T12-22-10-851Z-48e4bf19-f246-4bd5-9909-94779fa13521/receipt.json>)；原完整公开 source/test/config 投影与解析验证，没有缩减 include/types |
| 原 PC 类型检查 | TS **5.8.3 `--noEmit` / exit0**，已包含较新 QQ Source 输入 | [PC 类型收据](<../../_tmp/task-36-public-2026-11-12T12-23-13-358Z-b3922d0a-784c-4710-a323-149a0671d0fb/receipt.json>)；相邻 Source companion 保持原导入，解析验证不是另跑 Source CLI，也不认证完整传递依赖字节闭包或字面原 host root |
| 自有未签名源包构建 | **exit0**；原双包源策略、敏感词与 8 个 LX body 守卫通过；双包头各 **130B** | [构建收据](<../../_tmp/task-36-public-2026-11-12T12-22-11-928Z-a23823ca-7ce5-4b75-b4c8-697abb61a258/receipt.json>)；合成 `meta-task36-fixture/play-task36-fixture`，main/8 workers hooks 已报告、外部尝试 0，客户端目标为空、无签名和交付 |
| 原桌面 ESLint（2026-11-13） | **exit0 / 0 warnings**，`--max-warnings 0 --no-fix --no-cache` | [lint 收据](<../../_tmp/task-36-public-2026-11-13T02-13-41-956Z-a0b877f9-2806-469b-8145-6e2b8ea60c0e/receipt.json>)；全部公开 JS/TS 的等字节投影，原配置/规则/扫描范围不变，输入前后稳定；不是字面原 host root 执行 |
| 原桌面字号/动效守卫（2026-11-13） | **exit0 / 0 违规** | [motion 收据](<../../_tmp/task-36-public-2026-11-13T02-20-23-697Z-23d1596c-0a16-44f6-99c3-b3827baa10f5/receipt.json>)；原守卫与全 `src` 等字节投影，未调整规则或忽略文件 |
| 原完整桌面 Vitest（2026-11-13） | **214 文件 / 2047 PASS / 0 skip / exit0** | [完整 PC 收据](<../../_tmp/task-36-public-2026-11-13T02-40-42-572Z-da4f39ea-06e0-454b-985f-c698c1288551/receipt.json>)；保留原测试/config/断言、threads/node/setup 与公开扫描范围，包含 QQ 新桌面案例；不等于执行 Rust/声卡或整套 Source 联网测试 |

这些数字各自绑定其快照，不能把历次 QQ family 累加，也不代表全部错误/连续供给皆被覆盖。原完整 Source suite 的两项真实 GCID 联网测试仍受独立门禁限制，未被跳过、改 guard 或假响应替代。Node 内置网络守卫不是 OS-egress 隔离证明。

源端阶段结果不能宣称桌面当前客户端或全任务已经验收。真实账号首批、连续批次、实际 gateway/v14 profile、Native、官方签名、安装和发布均为 **NOT RUN**；本次构建日志中的通用“安装”文案不改变合成 ID、空客户端目标和无交付事实。

### 4.5 当前剩余源与桌面阶段（2026-11-13）

本段是当前代码输入的新快照，不覆盖第 4.3–4.4 节历史记录，也不累加历史执行次数。[独立冻结](<../../_tmp/remaining-fm-stage-freeze-20261113-d0c6c981-c59d-4d8d-8575-77b9b6b50b0e/verification.json>)由 Node 内置 JSON/hash 数据核验生成，没有重跑产品测试、联网或执行候选代码；Lead 与独立数据 reviewer 从原 Vitest JSON 重算 focused 数量、原 33 skip ID、三组同测试 SHA 的 RED/GREEN，与报告一致。这是数据终审，不是新增全源代码审阅或 live 认证。

| 当前门禁 | 已收结果 | 证据与限制 |
| --- | --- | --- |
| registered META 账号联合 | **9 文件 / 861 PASS / 0 skip / exit0** | [执行收据](<../../_tmp/all-account-fm-account-eafdc051-793b-47bb-afb3-b572c332667a/result.json>)；QQ 95 + 原账号 84 + 原身份 158 + KG 身份 2 + KG FM 170 + Migu FM 172 + Migu auth 170 + KW 9 + Bili 1。最后 10 项只是 unsupported 基线，**不是 KW/Bili FM 验收** |
| 原授权/注册兼容性 | **2 文件 / 131 PASS / 33 原 skip / exit0** | [执行收据](<../../_tmp/all-account-fm-compat-d56f8a81-1430-4193-8300-010543407e9c/result.json>)；raw header 把 skipped 计入 pending，33 个唯一 skip ID 与原 RED 逐项一致，没有新增跳过；三条旧 Migu-disabled 期待仅按 Cookie-only/未知源 fail-closed 可逆修正 |
| 真实桌面公共调用 | **6 文件 / 89 PASS / 0 skip / exit0** | [执行收据](<../../_tmp/remaining-fm-desktop-focus-951e7868-ec77-4a70-b783-05f8978146d0/result.json>)；旧 65 + 新 24，实际账号页/来源控件/FM/façade/auth/player，仅外部 source engine / Native IPC fixture。包括 Cookie 导入保存、META/PLAY、停止/晚回、只读补曲与非 applied 拒写 |
| 原 Source 类型检查 | **TS5.8.3 `--noEmit` / exit0** | [收据](<../../_tmp/task-36-public-2026-11-13T06-37-06-818Z-84b0d70a-0693-4776-ba8d-f9547783bbe3/receipt.json>)；原完整公开源/test/config、解析/选项/已解析类型及默认库等价投影，不是字面原 host root 或完整依赖字节闭包 |
| 原 PC 类型检查 | **TS5.8.3 `--noEmit` / exit0** | [收据](<../../_tmp/task-36-public-2026-11-13T06-37-06-895Z-49953773-ee88-479b-a8b7-428b7f0fc395/receipt.json>)；保留原完整 include/types/aliases；相邻 source companion 的解析证明不算又一次 Source CLI 执行 |
| 原桌面 ESLint | **exit0 / 0 warnings** | [收据](<../../_tmp/task-36-public-2026-11-13T06-37-06-932Z-fff8154c-0d9f-4eb8-96b2-e0b2b1025973/receipt.json>)；`--max-warnings 0 --no-fix --no-cache`，原配置/规则/范围与前后输入保持 |
| 原完整桌面 Vitest | **215 文件 / 2071 PASS / 0 skip / exit0** | [收据](<../../_tmp/task-36-public-2026-11-13T06-37-06-967Z-ee0d0b84-bed8-4d70-a26d-d1572a87fb81/receipt.json>)；原输出明确 215/2071，**不是收据统计字段**。对应历史 214/2047 + 新 24；原 threads/node/setup/范围保留，不是 Rust/声卡验收 |
| 自有未签名源包构建 | **exit0，交付 0** | [收据](<../../_tmp/task-36-public-2026-11-13T06-37-07-025Z-f1142129-4dfb-4fce-a6ef-c1abddf8ce36/receipt.json>)；原策略/8 LX 守卫不变，main/8 workers hooks 报告尝试 0；合成未签名 meta/play，包头各 130B、chainRevision 48，无客户端安装 |
| Renderer 编译 | **Vite6.3.5 / 1999 modules / exit0** | [收据](<../../_tmp/task-36-public-2026-11-13T06-37-07-080Z-dcfc98c3-7be4-4013-a15a-fd9a42035f83/receipt.json>)；自有 renderer-dist，原 Vite config 未直接执行，CSS 证明不等于原 PostCSS 环境，可能仍查询 ancestor metadata；没有更新运行客户端 |

三处本阶段最小生产修复各有真实行为 RED 与同测试字节 GREEN：账号缓存 **20+1 FAIL → 21 PASS**、META 开关缓存 **21+1 FAIL → 22 PASS**、Migu 实际 token 尾 TAB **153+1 FAIL → 154 PASS**。两缓存 helper 只把发布移到 `ipc.setSetting` 成功后；只证明**Native 写未应用且 Promise 拒绝**时 fail-closed，不是多键事务、已接受写回滚、引擎注入恢复或 ACK 丢失恢复。Migu 只改 `trimStart` 保原 token；新增矩阵/跨源/scope-clear 首跑 GREEN 不算额外生产修复。

[冻结逆向结果](<../../_tmp/remaining-fm-stage-freeze-20261113-d0c6c981-c59d-4d8d-8575-77b9b6b50b0e/verification.json#L563-L616>)分别精确回到已审 dirty baseline：两 helper `8d63d0ba…`、Migu trim 前 `10d86be9…`、Original84 `040c2a80…`、legacy auth `0ae3794b…`。不把 Git HEAD 中其他已有 WIP 算作本阶段修改，不归一整仓换行。

覆盖界限：KG 晚批测试在**新 Migu 开始前**释放旧结果，不声称覆盖新 Migu Native 已提交后的所有时序；clearAuth 案例证明真实 façade 传递 named/omitted source 的外部合约，不证明 auth-module 的缓存/许可同步。表中六个变更输入门禁均已 collect，不为文档更新重跑。原 motion/QQ 旧门禁保持历史记录；全 Source GCID 与先前 Native 限制不绕过。没有真实账号/音乐 HTTP、Native、物理音频、官方签名、安装、发布或 OS-egress 认证。

### 4.6 账号每日推荐（每日30首，2026-11-13 接入）

链路两跳，都走客户端 comm（`qqAccountTransport`，不做服务端身份回读）：① `recommend.RecommendFeedServer/get_recommend_feed` 的首页卡片流里，按 `extra_info.moduleID=recforyou@0@0` + `jumptype=10014` + `miscellany.dirid="202"` 定位「每日30首」卡，其 `id` 即该账号当天的动态歌单 dissid；② `music.srfDissInfo.aiDissInfo/uniform_get_Dissinfo`（`disstid=Number(id)`、`song_num=30`）取 30 首。未登录时上游把该 id 下发成哨兵字符串 `"0"`，映射为需要登录而不是上游故障；`feed` 里没有该卡时同样按需要登录处理，绝不拿 `playlist@135@0` / 电台卡顶替。

- 协议依据：[feeluown-qqmusic@241a9678 的 `provider.py#L359` 每日推荐实现](<https://github.com/feeluown/feeluown-qqmusic/blob/241a9678bcd26e88d19e08e5da8048018f06e330/fuo_qqmusic/provider.py#L359>)、[`api.py#L442` feed 构造](<https://github.com/feeluown/feeluown-qqmusic/blob/241a9678bcd26e88d19e08e5da8048018f06e330/fuo_qqmusic/api.py#L442>)、[`api.py#L556` 歌单详情](<https://github.com/feeluown/feeluown-qqmusic/blob/241a9678bcd26e88d19e08e5da8048018f06e330/fuo_qqmusic/api.py#L556>)、[真实响应样本 #L236–L270](<https://github.com/feeluown/feeluown-qqmusic/blob/241a9678bcd26e88d19e08e5da8048018f06e330/data/fixtures/get_recommend_feed.json#L236-L270>)。
- 真账号实测（2026-11-13，微信绑定的 QQ 账号）：**2 次 HTTP、1055ms、30 首**，`interval` 秒、封面按 `album.mid` 拼 `y.gtimg.cn`；同样的 cookie 在 `GetSession`/`GetUserInfo` 仍被网关指纹墙拦住，本链路不触碰那两个接口。
- 实测修正的公开说法：歌单行 `type` 实测为 **1**（公开样本里是 0），因此两者都接受；长音频（2）与视频（6）仍按非音乐拒绝，不做「跳过坏行」的静默降级。
- 单页取完（`total_song_num=30`、`hasmore=0`），**没有 cursor、不翻页**；带 cursor 的请求在 HTTP 前以 `invalid-args` 拒绝。刷新时刻未证实，未把「当地 0 点」写进协议常量。
- 合成回归：[account-qq-daily.test.ts](<../../qt-sources/tests/account-qq-daily.test.ts>) **24 PASS**（成功 30 首 + 哨兵 `"0"` + 无卡 + 三种坏 cookie 零 HTTP + 账号不一致 + cursor 拒绝 + 7 类畸形应答 + HTTP/CGI 错误码映射 + 注册表 `{daily:true,fm:true}`）。

## 5. KG：已实现只读 login 取批；真实续批仍未验证

- [KuGouMusicApi 固定 personal_fm 模块][K1] / [传输与 Android 签名][K5]提供 POST `/v2/personal_recommend`、router `persnfm.service.kugou.com` 的公开依据。当前[KG FM 处理器](<../../qt-sources/src/platforms/kg-recommend.ts#L78-L159>)每批明确 `action: "login"`，不沿用上游默认 `play`；body 是签名后的一次字符串序列化，时间戳为毫秒，不混用秒。
- 保存的 Cookie 必须包含规范安全正整数 `userid`、有效 token 与既有设备 JSON 的 `guid/mid/dev`；不随机造设备。显式 token 若存在必须等于 Cookie token。Cookie userid 先与选中账号一致，再由[本人 helper](<../../qt-sources/src/platforms/kg-auth.ts>)执行 signed `/v3/get_my_info`，核对原始 `data.userid`。
- 只接受合格 HTTP raw 整数状态、规范 raw `status/error_code` 与精确 `data.song_list`；每曲必须有 32 位 hex hash、非空 `songname`、字符串 `author_name`、非负有限数 `time_length`。后者按[固定字段模型的秒单位][K3]映射；hash 标准化大写，缺失专辑/封面留空，不猜多数组 fallback。保留上游顺序/重复，任一 malformed 项拒绝整批；可选 userid/kguid echo 必须同账号。
- 当前 **170 项 FM 回归**纳入源端 861；12 项修复用例与后续 158 项首跑 GREEN 矩阵不混作 170 次生产修复。真实 registered META 和外部 HTTP fixture 验证身份、结构、错误、凭据撤销及只读重复请求；KG daily 与独立身份族原样保留。
- [私人 FM 文档][K2]只区分 `login` 与播放行为，[PersonalFmService][K4]及[issue #11][K6]的 `play/hash/songid/playtime` 反馈不能移植作只读续批。反复 `login` 的合成响应 **不证明**真实账号每次得到不同歌曲，也不是已知失败/无法续批的证明。

当前拒绝非空输入 cursor、不返回 cursor，不发送已播 ID 或反馈；空批仍为 `exhausted: false`，因为没有确定的服务端 end 标记。宿主最多探测三批空/重复，仅在 Native 接受实际队列变更后提交状态。**剩余证据门禁**是另行授权后的真实账号、网关、换批与终止语义，不影响已保留的 KG daily，也不宣称无限供给。

## 6. KW：账号 FM 与账号日推在公开层均无可用链（2026-11-13 判定）

**2026-11-13 追加判定（只读侦查，未改生产文件）：**账号 FM 在公开层没有任何可用 HTTP 链 —— 官方 web bundle 与 m 站 API 表（31 条端点）都无 fm/daily 条目；`lx-music-source` 的 kw 源只声明 `musicUrl`、MusicFree 的 kuwo 插件只有歌单/榜单且 `loginUid=0`、`baiji-music` 与 `kuwoMusicApi` 也无 FM；App 明文网关 `mobi.kuwo.cn/mobi.s` 的 **15 个候选 type 全部 404**（而合法 `convert_url2` 返 200），签名本身不是阻断（`f=kuwo&q=base64(DES-ECB(…))` 的密钥是公开常量），阻断点是**未知请求类型 + 账号会话 + 每批"下一批"语义**三者叠加。账号日推同样不成立：网页「每日推荐」导航 `rcm/index/playlist` 第一项恒为官方歌单 `1082685104`「每日最新单曲推荐」（`playListInfo` 可取 `total=606`、`rn≤100`、`duration` 单位秒），这是**编辑歌单**，本文明文禁止用它顶替账号日推。结论：**只有 App 私有抓包级逆向可能突破**，属另行授权范围；不用匿名歌单、站点目录或 `newradio` 相似站点将就。

当前[9 项基线](<../../qt-sources/tests/account-kw-fm.test.ts>)只验证未声明能力的 fail-closed 行为，不是 FM GREEN。[历史证据清单](<../../_tmp/kw-account-fm-20261113-evidence/final-manifest.json>)与[协议未知项](<../../_tmp/kw-account-fm-20261113-evidence/private-song-protocol-unknowns.json>)保持原记录；生产文件没有因此增加 FM handler。

- 固定 `gudegan/nec-ai-crack@b328ea619b9eaba7ffb7fa30f0d50090a4d55ef7` 的[首页脚本][W1]读取 `GetPrivFMInfo`，只消费 `musicradiolists[0]` 的电台描述。该版 `BuildFMClickStr` 原文是赋值 `if (ntype = '0')`，非比较，静态路径进入 source 9 / `-26711`；不能擅自修正后借 else source 4 补造路径。
- 实际三段调用为 `commonClick(source:9)` → `someDianTai` → `AddMusicRadio?...` → `window.external.callkwmusic`。[comm2.js](<https://github.com/gudegan/nec-ai-crack/blob/b328ea619b9eaba7ffb7fa30f0d50090a4d55ef7/Nec/html/webdata/netsong/js/comm2.js>) / [music.js](<https://github.com/gudegan/nec-ai-crack/blob/b328ea619b9eaba7ffb7fa30f0d50090a4d55ef7/Nec/html/webdata/netsong/js/music.js>)显示的是 Native 命令，不是已认证 HTTP query。`GetPrivFMInfo` 与 AddMusicRadio 未显式传账号 Cookie；`UserState` 是当前全局客户端状态，不是选定 immutable META 的 self 等值证明。
- [play_radio.js](<https://github.com/gudegan/nec-ai-crack/blob/b328ea619b9eaba7ffb7fa30f0d50090a4d55ef7/Nec/html/webdata/netsong/js/play_radio.js>)的 `GetRadioPlayingSongInfo`仅提供当前歌曲展示字段；下一首发 `RadioClickDustbin?icontype=pass`。不能把 pass 当作已证 read-only next，不能推断 Native 是否上报反馈。五个文件有界读取止于宿主桥；[Nec 固定递归目录](<https://api.github.com/repos/gudegan/nec-ai-crack/git/trees/02e71599f925e1cf0a86ef17d29d6d2d734f7fa4?recursive=1>)共 1287 项、未截断，所筛 C/C++/Java 等源码后缀为 0，仅见 DLL 名称。未下载/执行/反编译 DLL，也不据此声称全仓不存在实现。
- 固定 `Bhands6/BhandsMusicChange@0f1dae30abb0762fd88881f917b0cd36df399589` 的[“私人电台”卡片](<https://github.com/Bhands6/BhandsMusicChange/blob/0f1dae30abb0762fd88881f917b0cd36df399589/public/index.html>)实际调用 `playHomeSong(1)`；[provider 分流](<https://github.com/Bhands6/BhandsMusicChange/blob/0f1dae30abb0762fd88881f917b0cd36df399589/public/js/app/09-api-search.js>)只有网易云日推与 QQ 日推/歌单。后端 `recommend_songs` 或 QQ 每日 30 首动态歌单形成整批本地队列，[nextTrack](<https://github.com/Bhands6/BhandsMusicChange/blob/0f1dae30abb0762fd88881f917b0cd36df399589/public/js/app/10-audio-queue.js>)只是循环队列；不建立 KW 推荐 transport。`unblockPlatforms: ['kugou','kuwo']` 属于既有歌曲音频解析，不是 KW 账号取歌。

匿名 `newradio uid=0/login=0`、广播/HLS、播客分页、日推/歌单、解析既有歌曲 URL 都不代供。**缺口**仍是选定账号对应的认证歌曲 URL/method/headers/string body、权威 self、首批歌曲 ID/歌手/专辑/秒单位、次批/cursor/end 和反馈独立性。KW **尚未实现，不是已确认不能实现**；公开 JS 的精确断点为 `window.external.callkwmusic` 的宿主分发/歌曲 HTTP 实现，后续只推进该真实供给链，不用 fake offset 或伪播放行为凑功能。

## 7. Bili：账号音乐 FM 与账号日推上游不存在（2026-11-13 判定）

**2026-11-13 追加判定（匿名实测 + 线上产物逆查，未读任何 Cookie）：**唯一账号化推荐面是视频首页流 `x/web-interface/wbi/index/top/feed/rcmd`（匿名 `data.mid=0`；条目 `goto ∈ {av,ogv,live}`，**无 `tid`/`tname`，接口无 `rid` 参数**）⇒ 协议层无法收窄到音乐区，用它即"混合视频顶替账号 FM"。音频侧 `music-service-c` 的 37 个端点在官方音频 SPA bundle 里被完整枚举，**没有 `recommend`/`daily`/`fm`**，`每日`/`daily` 零命中，路由只有 5 条、没有 FM/日推页；`home/recommend/upper` 固定 3 条且跨伪造 cookie 完全一致（编辑位，非账号）。唯一「每天 11:00 更新」的官方歌单 menu 10624 实测 **0/16 可播**（`url size=168` 空音轨占位）、10629 为 0/8 ⇒ 连"降级到编辑每日歌单"都拿不到声音。可用的纯音频推荐只有 `song/similar?sid=`（100/100 可播）与 `song/upper-hit?uid=`（11/11），属**内容相似/UP 主热门**，可做「种子电台」但不是账号 FM。另：`bilibili-API-collect` 已于 2026-01-28 关停，本次文档依据取 [AkaiShuichi7 镜像](<https://github.com/AkaiShuichi7/bilibili-API-collect>)。

当前[1 项 unsupported 基线](<../../qt-sources/tests/account-bili-fm.test.ts>)与[历史协议评估](<../../_tmp/bili-account-fm-20261113/BILI-FM-PROTOCOL-ASSESSMENT.md>)不是 Bili FM 验收，没有注册 handler。歌曲可以是合格音乐 AV+bvid+cid，不要求一律 AU；但不能将普通视频/投稿者当歌曲/歌手，或把混合音频队列称作音乐个性 FM。

- [bbspace 固定 Listener][B1] / [protobuf][B2]有 `RcmdPlaylist` 的真实 `next_page.next → page.next` 线索，但供给是混合监听队列。[认证 header][B3]使用 app accessKey / identify_v1 与二进制 metadata；`RequestBuiltin.body` 当前是字符串，未建立或授权 gRPC/Native 二进制桥。现有 SESSDATA 不直接等于 appKey，不能为拿到 next 而扩传输或混入视频。
- 固定 `Jmiao11/bili-music@6008f1e107da72bd514389223ab4be876c4342a9` 的[discovery](<https://github.com/Jmiao11/bili-music/blob/6008f1e107da72bd514389223ab4be876c4342a9/src-tauri/src/commands/discovery.rs#L44-L56>)实际调用[本地记录 + AI 关键词/候选重排](<https://github.com/Jmiao11/bili-music/blob/6008f1e107da72bd514389223ab4be876c4342a9/src-tauri/src/ai/recommendation.rs#L49-L206>)，之后通用 video search；这不是账号上游 FM，`author` 是投稿者，不能映成 singer。
- 固定 `cwuom/NeriPlayer@38fa735b1f0a055821434dbfda6833f4033d6a7a` 的[BiliClient 音乐常量](<https://github.com/cwuom/NeriPlayer/blob/38fa735b1f0a055821434dbfda6833f4033d6a7a/modules/platform/src/main/java/moe/ouom/neriplayer/platform/bilibili/api/client/BiliClient.kt#L128-L142>)与[真实字段 parser](<https://github.com/cwuom/NeriPlayer/blob/38fa735b1f0a055821434dbfda6833f4033d6a7a/modules/platform/src/main/java/moe/ouom/neriplayer/platform/bilibili/api/client/BiliClient.kt#L1626-L1656>)提供 `music_title/singer/creation_aid/creation_bvid/creation_first_cid/creation_duration`，投稿者另存 uploader，是诚实音乐字段线索；但[唯一追踪 consumer](<https://github.com/cwuom/NeriPlayer/blob/38fa735b1f0a055821434dbfda6833f4033d6a7a/app/src/main/java/moe/ouom/neriplayer/ui/viewmodel/tab/bili/BiliMusicHomeRepository.kt#L72-L111>)只拉版权榜单/热门视频，没有推荐 session/next/end。
- 该版本[getJson transport](<https://github.com/cwuom/NeriPlayer/blob/38fa735b1f0a055821434dbfda6833f4033d6a7a/modules/platform/src/main/java/moe/ouom/neriplayer/platform/bilibili/api/client/BiliClient.kt#L1103-L1130>)可附带非空 Cookie，所以不称榜单必定匿名；**携 Cookie 不等于个性化或选定账号绑定**。全文件只作关键词/声明定位，正文限所列音乐/transport/nav 段及一个 consumer；独立 nav 的 `optInt/optBoolean/optLong`亦未建立此链的 raw MID 等值闸。
- 固定 `AprDeci/bili-music@7a2e900ecb1da2a949ec193c2614a7f785fdfc84` 的[home](<https://github.com/AprDeci/bili-music/blob/7a2e900ecb1da2a949ec193c2614a7f785fdfc84/lib/feature/home/ui/home_page.dart#L25-L37>)是近期播放与[音乐 ranking](<https://github.com/AprDeci/bili-music/blob/7a2e900ecb1da2a949ec193c2614a7f785fdfc84/lib/feature/home/data/bili_music_ranking_repository.dart#L13-L59>)，`owner.name` 不是 singer；QR Cookie DedeUserID 也不是权威 nav self。

[固定登录文档](<https://github.com/rinnein/bilibili-API-collect/blob/cfc5fddcc8a94b74d91970bb5b4eaeb349addc47/docs/login/login_info.md>)同时存在 Cookie JSON nav 与 app-token JSON myinfo 身份线索，未调用/签名，不能说 Bili 本人接口必需 protobuf。**断点**在“选定 META/MID → 上游个性化音乐供给 → 真实下一批”而非单独缺歌曲字段；当前公开有界范围没有取得合格 HTTP JSON 取歌链，不证明全仓无功能或无法实现。后续只补真实账号歌曲协议、raw identity/fields/seconds、next/end/read-only 语义；榜单、AI、AU seed-similar 和混合 Listener 不代供。

## 8. Migu：Cookie 本人校验、action-2 FM 与账号日推；真实换批未验证

当前实现以 [MiguWave 固定版本 `f42978049200b85331326dc39c4cc5c104dc5d07`](<https://github.com/horizon0514/MiguWave/tree/f42978049200b85331326dc39c4cc5c104dc5d07>) 的公开 profile/browse/client 字段为协议依据，保留源码证据但不执行该 Go 客户端。历史候选[匿名 action-1][M2]、[随机 device][M3]、[listen-freely][M4]与[多数组 decoder][M5]不混入当前实现；[SDK 消费者][M7]的[FAKE 展示][M9]不当作服务端验收。

- [Cookie auth helper](<../../qt-sources/src/platforms/migu-auth.ts>)仅声明 `methods: ["cookie"]`；注册入口为原 `authImportCookie` / `authUser`，返回本人结果不自行保存。宿主明确持久化成功后才注入 META。没有 QR、refresh、离线 ID fallback 或会员权益推断。
- 每批用同一显式 Cookie / `pacmtoken` 快照请求本人 `https://app.u.nf.migu.cn/pc/user/h5/queryUserInfo/v1.0`。只接受**顶层** raw `userInfoItem.userId` 的规范安全正整数字符串，与选定账号严格等值；不采用嵌套、手机号、Cookie/设备 ID 代替本人。[历史本人字段线索][M1]亦与此位置一致。
- [FM handler](<../../qt-sources/src/platforms/migu-recommend.ts>)读取 `https://app.c.nf.migu.cn/pc/resource-dataloader/recommend-song/v1.0?scene=PRIVATE_FM&algorithm=v1&action=2`，显式带 Cookie/PACM 与固定公开客户端 device 标识；device 不是账号证明，不匿名随机生成。只接受精确 `data.songItemList`：`contentId → id`、`copyrightId → musicId`、`songName`、`singerList[].name`、`album`、`img2`及秒单位 duration；若显式 resourceType 存在必须为音乐 2。保上游顺序/重复，任一坏项拒绝整批。
- HTTP raw `statusCode` 必须为 100–599 整数；确切 `"000000"` 成功、`"290001"` 失效。**PACM 轮换不是换号**：2026-11-13 真账号实证咪咕在每次成功应答里都下发新的 `pacmtoken`（连调三次三次不同），旧 token 仍有效，早先把它判成 `auth-changed` 会让网页登录校验每 1.5s 失败一次、界面永远停在「登录中…」；当前实现既不报错也不采纳/回传新 token，「不落新凭据、不改已存 Cookie」的约定不变，真正的失效仍由 401/403 与 `290001` 判定。
- 实际 token 尾 TAB 注册入口 tracer **153 PASS + 1 FAIL → 同 154 PASS**，只把 `trim()` 改为 `trimStart()`：允许 Cookie 分号后前导间隔，保留 token 尾部空白/控制字符以在 HTTP 前拒绝。后续有效 spacing/原值和 control 矩阵是首跑 GREEN 回归，不另算生产修复；当前 Cookie auth **170 PASS**、FM **172 PASS**纳入源端 861。

当前每次重新本人校验，拒绝非空 cursor、不返回 cursor、不发送已播 ID/行为反馈、不续换 token；包括空批都为 `exhausted: false`。重复 action-2 的合成回归**不证明**真实账号连续得到新曲，也没有建立真实 end 语义；不能断言 action-1 必是播放上报或 action-2 已证明无限只读续批。真实 Cookie、网关、换批与终止语义仍须另行授权验证，daily 不以 FM 冒充。

- **账号日推（2026-11-13 接入）**：`https://app.c.nf.migu.cn/pc/v1.0/template/todayRecommendList/release`（网页「今日推荐」页，`data.recommendData.{time,week,data[]}`）。同一接口的身份分级用真账号实测清楚：**登录态 Cookie → 60 首**；只带设备 `imei` → 另一份 **11 首**通用清单（哈希不同，与账号清单不重叠语义）；伪造 `pacmtoken` 且无 `imei` → 上游 `code 200205`「手机号和IMEI不能同时为空」⇒ 该清单由账号身份决定，不是设备位或编辑位。同一账号带不同 `imei` 查询得到完全相同的 60 首哈希，证明设备参数不影响账号结果。
- 日推只取 `recommendData.data` 内**显式音乐标签**（`resourceType === "2"` 或 `2`）的行；非歌曲卡片（听歌偏好提示等）不是歌曲，按标签排除；若过滤后为空、`resourceType` 缺失或任一音乐行字段畸形，整批按 `malformed-response` 拒绝，不返回空日推冒充成功。`time` 若出现必须是 `YYYY-MM-DD`（缺省不阻断，避免跨日刷新瞬间误判）。单页 60 首、**无 cursor 不翻页**、`exhausted: true`。
- 真账号实测：日推 **60 首 / 1642ms**（首曲时长 299 秒、封面 `d.musicapp.migu.cn`），FM **5 首 / 203ms**（此前只有合成证据），两次调用各 2 次 HTTP（self + 内容）。合成回归新增 [account-migu-daily.test.ts](<../../qt-sources/tests/account-migu-daily.test.ts>) **30 PASS**（60 首映射 + 非歌曲过滤 + 全非歌曲拒绝 + 12 类畸形应答 + 两种坏 Cookie 零 HTTP + cursor 拒绝 + 账号不一致 + HTTP/CGI 错误码 + 注册表 `{daily:true,fm:true}`）。

[历史 v3 验证](<../../_tmp/migu-account-fm-20261113/auth-verification-v3.json>) / [v3 状态](<../../_tmp/migu-account-fm-20261113/AUTH-STATUS-V3.md>)保持原快照，153 auth / 164 FM 不是当前数量。当前输入、尾部 token 修复和三组 RED/GREEN 以第 4.5 节的独立新版冻结为准，不回写旧报告。

## 9. 后续推进与验收记录要求

| 目标 | 允许先推进的证据工作 | 升级状态前必须补齐 |
| --- | --- | --- |
| QQ | 已收本阶段身份/撤销/serial 与真实桌面公共调用案例；保留按 family 的准确证据 | 微信登录 namespace 未实现；真实 v14 gateway/profile、账号首批和连续供给及当前客户端支持另行授权后验证 |
| KG FM | 当前 strict 本人/精确 decoder/只读 login 与 170 回归已收 | 真实网关/账号与无反馈换批/end；不以合成重复 login 认证无限供给 |
| KW FM | 2026-11-13 已穷举公开层（web/m 站端点表、4 个开源实现、App 网关 15 个 type）并判定无可用链；日推候选分账到官方编辑歌单 | 需要**另行授权**的 App 私有抓包逆向（请求类型 + 账号会话 + 批次语义）；在此之前不实现 |
| Bili FM | 2026-11-13 已穷举音频 37 端点 + 线上 SPA + 社区实现，判定账号化推荐不存在；`song/similar`、`upper-hit` 为可播的内容口径候选 | 若要做只能是「非账号」种子电台，须先在文案与接口语义上改名；账号 FM/日推不实现，不为此扩大 binary transport |
| Migu FM / 日推 | 当前 Cookie本人 / 精确 songItemList / action-2 / 今日推荐与 auth170 + FM172 + daily30 已收；真账号 FM 5 首、日推 60 首实测 | 真实换批/end 与跨日清单稳定性；不续换 token，不用匿名 device 或编辑歌单代供 |

记录新证据时分别写“协议已实现”“具体合成 family/数量/skip/外部网络尝试”“真实账户 NOT RUN 或已获授权的具体结果”“Native/构建/发布”“全任务验收”。不能把 pending 变成不支持的永久结论，也不能把公开源码可读、单源首片 GREEN 或本文完成变成全源 FM 已完成。

## 固定版本公开引用

以下源码链接均钉到 commit，不用浮动默认分支作为协议结论；issue 引用固定编号/评论，属于历史第三方报告而不是源码快照。公开源码/第三方报告与真实账户测试是不同证据类型。

[Q1]: <https://github.com/L-1124/QQMusicApi/blob/c046788dd1f11daacc74da487cbbf1bcd8ac6f33/qqmusic_api/modules/recommend.py#L81-L103>
[Q2]: <https://github.com/L-1124/QQMusicApi/blob/c046788dd1f11daacc74da487cbbf1bcd8ac6f33/qqmusic_api/models/recommend.py#L65-L72>
[Q3]: <https://github.com/Team-Quaver/quaver-music/blob/cadba6cbe866ffe937a94381c31be14a72de4887/ui/README.md#L298-L306>
[Q4]: <https://github.com/L-1124/QQMusicApi/blob/c046788dd1f11daacc74da487cbbf1bcd8ac6f33/qqmusic_api/core/response.py>
[Q5]: <https://github.com/L-1124/QQMusicApi/blob/c046788dd1f11daacc74da487cbbf1bcd8ac6f33/qqmusic_api/models/base.py>
[K1]: <https://github.com/MakcRe/KuGouMusicApi/blob/7ac64e1cdd333ad9bfff644ded82a0ffeef002d1/module/personal_fm.js>
[K2]: <https://github.com/MakcRe/KuGouMusicApi/blob/7ac64e1cdd333ad9bfff644ded82a0ffeef002d1/docs/README.md#L2191-L2218>
[K3]: <https://github.com/Linsxyx/KugouMusic.NET/blob/105fe59c5e5439913fb0dccb097f934f396ef067/src/Libraries/KuGou.Net/Abstractions/Models/PersonalFmResponse.cs#L9-L87>
[K4]: <https://github.com/Linsxyx/KugouMusic.NET/blob/105fe59c5e5439913fb0dccb097f934f396ef067/src/Apps/KugouAvaloniaPlayer/Services/PersonalFmService.cs#L256-L289>
[K5]: <https://github.com/MakcRe/KuGouMusicApi/blob/7ac64e1cdd333ad9bfff644ded82a0ffeef002d1/util/request.js#L138-L182>
[K6]: <https://github.com/MakcRe/KuGouMusicApi/issues/11#issuecomment-1888276713>
[W1]: <https://github.com/gudegan/nec-ai-crack/blob/b328ea619b9eaba7ffb7fa30f0d50090a4d55ef7/Nec/html/webdata/netsong/js/radioInIndex.js>
[B1]: <https://github.com/naaammme/bbspace/blob/93eb904b1ee37328d588e190df728149bd54858f/core/listen/src/main/java/com/naaammme/bbspace/core/listen/ListenRepository.kt>
[B2]: <https://github.com/naaammme/bbspace/blob/93eb904b1ee37328d588e190df728149bd54858f/infra/protobuf/src/main/proto/bilibili/app/listener/v1/listener.proto>
[B3]: <https://github.com/naaammme/bbspace/blob/93eb904b1ee37328d588e190df728149bd54858f/infra/network-grpc/src/main/java/com/naaammme/bbspace/infra/grpc/GrpcHeaderBuilder.kt#L34-L79>
[M1]: <https://github.com/HeHang0/musiche/blob/274a7648e1e26f9065f290dba24afd446b4a9edd/web/src/utils/api/migu.ts#L892-L911>
[M2]: <https://github.com/Domdkw/miguMusic-api-enhanced/blob/87a4c2ffd2e35a878d2d60894893e35a00074afb/src/modules/recommend_song.ts>
[M3]: <https://github.com/Domdkw/miguMusic-api-enhanced/blob/87a4c2ffd2e35a878d2d60894893e35a00074afb/src/utils/device.ts>
[M4]: <https://github.com/Domdkw/miguMusic-api-enhanced/blob/87a4c2ffd2e35a878d2d60894893e35a00074afb/src/modules/recommend_listenFreely.ts>
[M5]: <https://github.com/mytv-android/myMusic/blob/941a98a667897bdcd9703f3557d5d5ed2255e296/app/src/main/java/com/mytv/mymusic/data/native/MiguProvider.kt#L393-L470>
[M6]: <https://github.com/Domdkw/miguMusic-api-enhanced/blob/87a4c2ffd2e35a878d2d60894893e35a00074afb/src/modules/user_queryInfo.ts#L8-L17>
[M7]: <https://github.com/zzm1027123/migu-music-desktop/blob/a5fee3c126f4d9b0bf5ea67aa63eff344d31b1ba/src/migu-api.js#L352-L413>
[M8]: <https://github.com/zzm1027123/migu-music-desktop/blob/a5fee3c126f4d9b0bf5ea67aa63eff344d31b1ba/src/resolver.js#L33-L64>
[M9]: <https://github.com/zzm1027123/migu-music-desktop/blob/a5fee3c126f4d9b0bf5ea67aa63eff344d31b1ba/test-guess.js#L51-L63>

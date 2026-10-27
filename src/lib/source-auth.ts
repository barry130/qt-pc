/**
 * 音源账号登录：凭据的持久真源 + 「数据/播放两面是否使用登录态」**按源独立**
 * 的开关 + 向数据包引擎的懒注入（v9 数据包契约）。
 *
 * 职责边界（与数据包内 auth-store 分工）：
 * - 这里是**持久层**：Cookie 与用户信息存本机设置库，卸载重装数据包、
 *   重启应用都不丢；数据包内只有引擎内存工作副本，引擎每次重装/热切换
 *   都从零开始，所以注入必须跟着「数据包装载完成」重放。
 * - 「是否使用登录态」体现在**灌不灌**：某源的某面开关关闭 = 只 clear 该源
 *   该面的凭据（数据包收到的是「这个源的这类请求一律匿名」），别的源不受牵连。
 *
 * 注入时机（与 stores/sourceRegistry.ts 的注册表刷新同一套路）：
 * - AppShell 挂载 ensure 一次（引擎多半还没就绪，靠下面的钩子兜）；
 * - 引擎相位转 ready（含 error→ready 自愈）；
 * - source-meta-changed / source-pack-changed：两事件都会热切换引擎页
 *   （重新 import 数据包 = auth-store 清零），延迟重试跨过装载窗口。
 */
import { listen } from "@tauri-apps/api/event";
import * as ipc from "@/services/ipc";
import {
  SOURCE_AUTH_ACCOUNTS_KEY,
  SOURCE_AUTH_TOGGLES_KEY,
  SOURCE_AUTH_USE_META_KEY,
  SOURCE_AUTH_USE_PLAY_KEY,
} from "@/lib/storageKeys";
import {
  authCheckUser,
  authClearCredential,
  authSetCredential,
  type SourceAuthScope,
  type SourceAuthUser,
} from "@/source-scripts";
import { onEnginePhaseChange } from "@/source-engine/client";
import { SOURCE_META_CHANGED_EVENT, SOURCE_PACK_CHANGED_EVENT } from "@/services/ipc";

/** 一个已登录账号的持久记录（cookie 是官方下发的凭据本体） */
export interface SourceAuthAccount {
  cookie: string;
  user: SourceAuthUser;
  /** ISO 时间：排障用（「我什么时候登的」），不参与任何逻辑判断 */
  savedAt: string;
  /** 登录/轮换时随 credential 下发的凭据副键（键名沿用包侧应答字段，
   * 如 bili 的 refresh_token）。校验时原样透传回包入口供 refreshCredential
   * 使用。缺省 = 旧记录或该源无副键，向后兼容。 */
  extras?: Record<string, string>;
}

type SourceAuthAccounts = Record<string, SourceAuthAccount>;

// ---------- 存取（带进程内缓存；写路径统一走 writeAccounts 刷新缓存） ----------

/** 解析设置原文（JSON 对象：source → account）。任何形状问题都归一成空表：
 * 一条坏设置不该让「已登录的源」全部掉登录态，宁可当作没登录过。 */
export function parseSourceAuthAccounts(raw: string | null | undefined): SourceAuthAccounts {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: SourceAuthAccounts = {};
  for (const [source, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(source)) continue;
    if (value === null || typeof value !== "object") continue;
    const account = value as Record<string, unknown>;
    if (typeof account.cookie !== "string" || account.cookie.length === 0) continue;
    if (account.user === null || typeof account.user !== "object") continue;
    const user = account.user as Record<string, unknown>;
    if (typeof user.nickname !== "string" || user.nickname.length === 0) continue;
    const record: SourceAuthAccount = {
      cookie: account.cookie,
      user: {
        id: typeof user.id === "string" ? user.id : String(user.id ?? ""),
        nickname: user.nickname,
        avatar: typeof user.avatar === "string" ? user.avatar : "",
        vip: user.vip === true,
        vipLabel: typeof user.vipLabel === "string" ? user.vipLabel : "",
      },
      savedAt: typeof account.savedAt === "string" ? account.savedAt : new Date().toISOString(),
    };
    // extras（凭据副键）：只收字符串值，一条坏键不拖垮整条记录；全空视为无
    if (account.extras !== null && typeof account.extras === "object" && !Array.isArray(account.extras)) {
      const extras: Record<string, string> = {};
      for (const [key, value] of Object.entries(account.extras as Record<string, unknown>)) {
        if (typeof value === "string" && value.length > 0) extras[key] = value;
      }
      if (Object.keys(extras).length > 0) record.extras = extras;
    }
    out[source] = record;
  }
  return out;
}

let cachedAccounts: SourceAuthAccounts | undefined;

export function readSourceAuthAccountsSync(): SourceAuthAccounts {
  return cachedAccounts ?? {};
}

export async function readSourceAuthAccounts(): Promise<SourceAuthAccounts> {
  if (cachedAccounts !== undefined) return cachedAccounts;
  const raw = await ipc.getSetting(SOURCE_AUTH_ACCOUNTS_KEY).catch(() => null);
  cachedAccounts = parseSourceAuthAccounts(raw);
  return cachedAccounts;
}

async function writeAccounts(next: SourceAuthAccounts): Promise<void> {
  cachedAccounts = next;
  await ipc.setSetting(SOURCE_AUTH_ACCOUNTS_KEY, JSON.stringify(next));
}

/** 清进程内缓存（账号表/开关表/旧全局解析），下次读取回库重拉。测试用。 */
export function resetSourceAuthCaches(): void {
  cachedAccounts = undefined;
  cachedToggles = undefined;
  cachedLegacy = undefined;
}

/** 两面开关（按源独立；生效值解析链见 effectiveTogglesFor） */
export interface SourceAuthToggles {
  useMeta: boolean;
  usePlay: boolean;
}

type SourceAuthTogglesMap = Record<string, SourceAuthToggles>;

/** 解析开关表原文（JSON：source → { useMeta, usePlay }）。形状问题归一成空表：
 * 坏设置只影响「记住的开关选择」（退回解析链下一级），不该让注入整体失效。 */
export function parseSourceAuthToggles(raw: string | null | undefined): SourceAuthTogglesMap {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: SourceAuthTogglesMap = {};
  for (const [source, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(source)) continue;
    if (value === null || typeof value !== "object") continue;
    const toggles = value as Record<string, unknown>;
    if (typeof toggles.useMeta !== "boolean") continue;
    if (typeof toggles.usePlay !== "boolean") continue;
    out[source] = {
      useMeta: toggles.useMeta,
      usePlay: toggles.usePlay,
    };
  }
  return out;
}

let cachedToggles: SourceAuthTogglesMap | undefined;
/** 旧全局开关解析结果（null = 库里从未写过全局键，不能再当继承源） */
let cachedLegacy: SourceAuthToggles | null | undefined;

async function readTogglesMap(): Promise<SourceAuthTogglesMap> {
  if (cachedToggles === undefined) {
    const raw = await ipc.getSetting(SOURCE_AUTH_TOGGLES_KEY).catch(() => null);
    cachedToggles = parseSourceAuthToggles(raw);
  }
  return cachedToggles;
}

async function writeTogglesMap(next: SourceAuthTogglesMap): Promise<void> {
  cachedToggles = next;
  await ipc.setSetting(SOURCE_AUTH_TOGGLES_KEY, JSON.stringify(next));
}

/** 旧全局键（per-source 表上线前所有源共用一对）。只读不写：作为未物化源的
 *  一次性继承源，让升级前调过全局开关的用户不回跳。
 *
 *  **只继承「偏离旧缺省」的值**：旧版缺省就是双开，所以库里残留的 `true/true`
 *  与「从没动过」完全不可区分、不携带任何用户意图——若照旧整体继承，这对键会
 *  永久盖住新缺省（数据开/播放关），新装的源、没物化过的源全都显示双开
 *  （2026-10-27 用户报「没有登录的怎么还是双开」的根因）。任一面为 false 才
 *  证明用户主动关过东西，此时才整体继承。两键都没有 / 两键都是 true = null。 */
async function legacyGlobalToggles(): Promise<SourceAuthToggles | null> {
  if (cachedLegacy === undefined) {
    const [meta, play] = await Promise.all([
      ipc.getSetting(SOURCE_AUTH_USE_META_KEY).catch(() => null),
      ipc.getSetting(SOURCE_AUTH_USE_PLAY_KEY).catch(() => null),
    ]);
    if (meta === null && play === null) {
      cachedLegacy = null;
    } else {
      const inherited: SourceAuthToggles = { useMeta: meta === "true", usePlay: play === "true" };
      // 双开 = 旧缺省 = 无信息量，不当继承源
      cachedLegacy = inherited.useMeta && inherited.usePlay ? null : inherited;
    }
  }
  return cachedLegacy;
}

/** 单源生效开关的解析优先级：per-source 表 → 旧全局键（升级继承）→ 缺省。
 *  缺省口径（2026-10-27 用户需求「数据请求使用登录态默认为开，播放请求使用
 *  登录态为关」）：数据面默认开、播放面默认关——数据面是搜索/歌单/歌词这类
 *  「不带凭据就用不了」的必需项；播放面默认不带凭据，避免冷门音质档拿不到链
 *  就被误判成播放失败，需要时用户自己开。**未登录的源用同一缺省**（用户
 *  2026-10-27：「非登录态也是使用这个」）：开关行在无账号时本就禁用，展示口径
 *  与登录态一致，登录后立刻生效的就是用户看到的那对值。 */
async function effectiveTogglesFor(
  source: string,
  map: SourceAuthTogglesMap,
): Promise<SourceAuthToggles> {
  const hit = map[source];
  if (hit !== undefined) return hit;
  return (await legacyGlobalToggles()) ?? { useMeta: true, usePlay: false };
}

/** 读单源生效开关（页面展示用）：与登录态无关，登录前后同一套解析链 */
export async function readSourceAuthTogglesFor(source: string): Promise<SourceAuthToggles> {
  return effectiveTogglesFor(source, await readTogglesMap());
}

/** 保存/覆盖一个源的登录：落库 + 该源开关未物化时按解析链初始化（旧全局值
 * 优先继承，避免升级后新登录的源绕过用户已调过的全局关闭）+ 立即注入该源。
 * extras 为登录/轮换时随 credential 下发的凭据副键（如 bili refresh_token）；
 * 缺省/空表不写 extras 键，账号记录形状与旧版本保持一致。 */
export async function saveSourceAuthAccount(
  source: string,
  cookie: string,
  user: SourceAuthUser,
  extras?: Record<string, string>,
): Promise<void> {
  const accounts = { ...(await readSourceAuthAccounts()) };
  accounts[source] = {
    cookie,
    user,
    savedAt: new Date().toISOString(),
    ...(extras !== undefined && Object.keys(extras).length > 0 ? { extras } : {}),
  };
  const map = { ...(await readTogglesMap()) };
  if (map[source] === undefined) {
    // 刚登录成功：该源必有账号，走登录态缺省（旧全局继承→数据开/播放关）
    await writeTogglesMap({ ...map, [source]: await effectiveTogglesFor(source, map) });
  }
  await writeAccounts(accounts);
  await applySourceAuthForSource(source);
  emitPlayLoginChanged();
}

/** 退出一个源的登录：清凭据 + 两面都清掉该源的注入。开关选择保留——
 * 重新登录后还原用户之前的开关习惯。 */
export async function removeSourceAuthAccount(source: string): Promise<void> {
  const accounts = { ...(await readSourceAuthAccounts()) };
  if (!(source in accounts)) return;
  delete accounts[source];
  await writeAccounts(accounts);
  try {
    await authClearCredential("meta", source);
    await authClearCredential("play", source);
  } catch {
    // 引擎未就绪/旧包没有入口：内存副本随下次注入自然对齐（库里已删）
  }
  emitPlayLoginChanged();
}

// ---------- 后台保活（定时校验 + 凭据轮换） ----------

/** 轮换落库时的 extras 合并：旧键保留（包侧可能还带别的副键），refresh_token
 * 有新值则覆盖；空值键一律剔除、全空 → undefined（与账号解析侧口径一致：
 * 记录形状与旧版本一致，不写空对象/空值键）。 */
export function mergeCredentialExtras(
  prev: Record<string, string> | undefined,
  refreshToken?: string,
): Record<string, string> | undefined {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(prev ?? {})) {
    if (value.length > 0) next[key] = value;
  }
  if (refreshToken !== undefined && refreshToken.length > 0) {
    next.refresh_token = refreshToken;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/** 进行中的全量保活（模块级锁：后台定时器与音源账号页同时触发只跑一轮，
 * 进行中的调用复用同一个 Promise，拿到同一份统计结果） */
let keepaliveInFlight: Promise<{ checked: number; rotated: number }> | null = null;

/**
 * 全量校验 + 凭据轮换（后台保活主流程，useSourceAuthKeepalive 触发）：
 * 逐源用已存凭据（连同 extras 副键，如 bili 的 refresh_token）查登录态；
 * 包侧轮换出新 cookie 时经 saveSourceAuthAccount 落库（引擎内存副本随保存
 * 同步注入），其余情况跳过不动：
 * - 未轮换（credential 为空）：凭据仍有效，不写库；
 * - ok:false（凭据失效）：跳过且**不删账号**——绝不自动退出，账号页会标
 *   「凭据已过期」引导用户自行重新登录；
 * - 单源失败（网络/旧包缺入口）只记 warn，不影响其余源。
 * 返回 { checked, rotated } 简单统计（checked = 尝试的源数）。
 */
export function refreshAllSourceAccounts(
  reason?: string,
): Promise<{ checked: number; rotated: number }> {
  if (keepaliveInFlight !== null) return keepaliveInFlight;
  const round = (async () => {
    const accounts = await readSourceAuthAccounts();
    const sources = Object.keys(accounts);
    let rotated = 0;
    for (const source of sources) {
      const account = accounts[source];
      try {
        const r = await authCheckUser(source, account.cookie, account.extras);
        if (!r.ok || r.credential === null) continue; // 失效跳过不删 / 未轮换跳过不写
        const extras = mergeCredentialExtras(account.extras, r.refreshToken);
        await saveSourceAuthAccount(source, r.credential, r.user ?? account.user, extras);
        rotated += 1;
      } catch (err) {
        console.warn(
          `[source-auth] 后台保活校验失败${reason ? `（${reason}）` : ""}：${source}`,
          err,
        );
      }
    }
    return { checked: sources.length, rotated };
  })();
  void round.catch(() => undefined); // 拒绝由调用方消化，锁自身不告警
  keepaliveInFlight = round.finally(() => {
    keepaliveInFlight = null;
  });
  return keepaliveInFlight;
}

/** 切换一个源的一面开关并立即生效：先把该源在解析链上的生效值物化进表
 * （此后旧全局键不再影响这个源），再按新值对该源逐面 set/clear。
 * 失败抛给调用方决定提示。 */
export async function setSourceAuthToggle(
  source: string,
  scope: SourceAuthScope,
  on: boolean,
): Promise<void> {
  const map = { ...(await readTogglesMap()) };
  const current = await effectiveTogglesFor(source, map);
  const next: SourceAuthToggles =
    scope === "meta" ? { ...current, useMeta: on } : { ...current, usePlay: on };
  if (next.useMeta === current.useMeta && next.usePlay === current.usePlay) return;
  await writeTogglesMap({ ...map, [source]: next });
  await applySourceAuthForSource(source);
  if (scope === "play") emitPlayLoginChanged();
}

// ---------- 官方线路档位（v10：登录态下档位展示整体切官方清单） ----------
//
// 官方档位清单本身由数据包注册表下发（SourceAuthCaps.officialQualities，
// stores/sourceRegistry.ts 消费）；这里只负责把「该源播放面登录态是否生效」
// 以可同步读、可订阅的形态暴露给档位展示逻辑（useSourceQualities /
// clampQualityForPlatform / quality-fallback）——判定口径与包侧官方前置
// 线路的启用条件一致：有凭据（账号存在）且播放面开关开启。

/** 该源播放面登录态是否生效（同步版，读进程内缓存；缓存未热时按缺省「播放面
 *  关」处理——宁可先不展示官方档，也不要展示一个取链会失败的档位） */
export function sourcePlayLoginActiveSync(source: string): boolean {
  const accounts = cachedAccounts;
  if (accounts === undefined || accounts[source] === undefined) return false;
  const map = cachedToggles;
  if (map === undefined) return false; // 开关表还没读进来：按缺省播放面关
  const materialized = map[source];
  if (materialized !== undefined) return materialized.usePlay;
  return cachedLegacy?.usePlay ?? false;
}

/** 播放面登录态变化事件（登录/登出/切开关后派发，档位展示订阅它刷新） */
export const SOURCE_PLAY_LOGIN_CHANGED_EVENT = "qt:source-play-login-changed";

function emitPlayLoginChanged(): void {
  // node 环境（单测）没有 window；事件只服务 UI 层订阅
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SOURCE_PLAY_LOGIN_CHANGED_EVENT));
}

/**
 * 该源登录账号的会员档（v11：官方档位按账号等级展示——VIP 展示到 VIP 级
 * 档位，SVIP 展示到 SVIP 级）。判定读账号记录里数据包 authUser/authQrPoll
 * 下发的 vipLabel（wyy：黑胶VIP/黑胶SVIP）。
 * 返回 null = 档位未知（没登录/账号记录里没有会员信息）——调用方按「不过滤」
 * 处理（多展示不隐藏，官方接口拿不到的档会降档回落，功能不坏）。
 */
export function sourceVipTierOf(source: string): "none" | "vip" | "svip" | null {
  const account = cachedAccounts?.[source];
  if (account === undefined) return null;
  if (account.user.vipLabel === "黑胶SVIP") return "svip";
  if (account.user.vipLabel === "黑胶VIP" || account.user.vip === true) return "vip";
  return "none";
}

// ---------- 注入（把「当前该不该用」投给数据包引擎） ----------

/** 单源应用（按源逐面对账）：有凭据的面按开关 set，开关关的面显式 clear——
 * 清单源单面而不是整面，别的源不受牵连。无凭据时两面清干净（引擎里可能
 * 残留旧副本）。失败抛给调用方决定提示。 */
async function applySourceAuthForSource(source: string): Promise<void> {
  const [accounts, map] = await Promise.all([readSourceAuthAccounts(), readTogglesMap()]);
  const account = accounts[source];
  if (account === undefined) {
    await authClearCredential("meta", source);
    await authClearCredential("play", source);
    return;
  }
  const toggles = await effectiveTogglesFor(source, map);
  for (const scope of ["meta", "play"] as const) {
    const on = scope === "meta" ? toggles.useMeta : toggles.usePlay;
    if (on) await authSetCredential(scope, source, account.cookie);
    else await authClearCredential(scope, source);
  }
}

/** 全量重灌（引擎（重）装数据包后的对账动作）。静默失败：注入失败不该打断
 * 启动/换包流程，下一次触发时机（引擎转 ready / 换包事件）会再试。 */
export async function ensureSourceAuthInjected(): Promise<void> {
  bindInjectionHooks();
  try {
    const accounts = await readSourceAuthAccounts();
    for (const source of Object.keys(accounts)) {
      await applySourceAuthForSource(source);
    }
    // 凭据（重）灌入后广播登录态变化：注册表据此重查包侧 getSourceQualities
    // 判定官方清单。不广播的话，导入新数据包/引擎重建后 profile 会停留在
    // 重灌前那次「无凭据 → platform」的结果上（2026-10-25 QQ 下拉不切官方档
    // 的根因）。
    emitPlayLoginChanged();
  } catch {
    // 引擎未就绪等：交给 phase/事件钩子的下一次重放
  }
}

// ---------- 生命周期钩子（模块内只绑一次） ----------

let hooksBound = false;
function bindInjectionHooks(): void {
  if (hooksBound) return;
  hooksBound = true;
  onEnginePhaseChange((phase) => {
    if (phase !== "ready") return;
    void ensureSourceAuthInjected();
  });
  for (const event of [SOURCE_META_CHANGED_EVENT, SOURCE_PACK_CHANGED_EVENT]) {
    void listen(event, () => {
      // 与注册表刷新同款延迟重试：引擎页接到广播后要 fetch+import 新包，
      // 立即注入会打到旧实例（或装载中）上
      window.setTimeout(() => void ensureSourceAuthInjected(), 800);
      window.setTimeout(() => void ensureSourceAuthInjected(), 2500);
    }).catch(() => undefined);
  }
}

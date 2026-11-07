import { create, type StateCreator, type StoreApi, type UseBoundStore } from "zustand";
import { errMsg } from "@/lib/utils";
import { log } from "@/lib/logger";
import type { AuthSession } from "@/types";
import * as ipc from "@/services/ipc";
import { useFavoritesStore } from "@/stores/favorites";

/**
 * Astral 登录态（DESIGN §2.3.4）。
 *
 * 会话本体存在 Rust 侧 settings 表里（前端不碰 token 明文存储），
 * 这里只做「启动恢复 + 登录/注册/登出」的状态同步，供标题栏、个人中心、登录页共用。
 */
interface AuthStore {
  session: AuthSession | null;
  /** 后端 app/user/me 的原始结构（字段以后端为准，这里不强约束） */
  profile: Record<string, unknown> | null;
  loading: boolean;
  error: string | null;

  /** 应用启动时调用：读本地会话并拉用户信息 */
  init: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  register: (
    username: string,
    password: string,
    passwordConfirm: string,
    email?: string,
    nickname?: string,
  ) => Promise<void>;
  logout: () => Promise<void>;
  /** 改资料：后端是全量替换（nickname/email/avatar 必填，password 选填） */
  updateProfile: (patch: ProfilePatch) => Promise<void>;
  /**
   * 头像上传成功后只改本地展示态（UPDATE_DESIGN.md §5.2）：
   * 后端头像走独立接口（avatar/complete 直接写 sys_user.avatar），不走 update 全量替换，
   * 也就不会触发踢下线 —— 千万别用 updateProfile 改头像。
   */
  setLocalAvatar: (url: string) => void;
  /** 发邮箱验证码（找回密码用；邮件模板 scene 由 Rust 侧持有） */
  sendEmailCode: (email: string) => Promise<void>;
  /** 用邮箱验证码重置密码（后端会踢掉该用户全部会话） */
  changePassword: (email: string, password: string, code: string) => Promise<void>;
}

/**
 * 改资料的请求体。
 *
 * 后端 QtUpdateUserDto 是**全量替换**：nickname / email / avatar 都带 @NotBlank，
 * 只想改昵称也必须把当前邮箱与头像原样回传，否则后端校验直接 400。
 * password 选填（不传 = 不改密码）。
 *
 * 用 type 而不是 interface：interface 没有隐式索引签名，无法赋给
 * `Record<string, unknown>`（ipc.astralUpdateProfile 的形参类型）。
 */
export type ProfilePatch = {
  nickname: string;
  email: string;
  avatar: string;
  password?: string;
};

/** 会话是否有效（留 60s 余量，和 Rust 侧 AuthSession::is_valid 同口径） */
export function isSessionValid(s: AuthSession | null): boolean {
  return !!s && s.expiresAt > Date.now() + 60_000;
}

/**
 * 从 me 的响应里猜一个展示名：**昵称优先，其次用户名**。
 * 后端字段名不固定（QtUserInfoVo 是 Java 风格 nickName/userName），且名字可能挂在
 * 嵌套的 `user` 对象上 —— 两种命名、两层结构都要兜底，否则有名字也会落到 fallback。
 */
export function displayName(
  profile: Record<string, unknown> | null,
  fallback: string,
): string {
  if (!profile) return fallback;
  const user = profile.user as Record<string, unknown> | null | undefined;
  const groups = [
    ["nickname", "nickName", "nick_name", "nick"],
    ["username", "userName", "user_name", "account", "name"],
  ];
  for (const keys of groups) {
    for (const source of [profile, user]) {
      if (!source) continue;
      for (const key of keys) {
        const v = source[key];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
    }
  }
  return fallback;
}

/**
 * 从 me 的响应里猜头像地址（后端字段名可能不同，逐个兜底；兼容 user 嵌套）。
 * 只认 http(s) 远程地址 —— 相对路径/本地路径在 webview 里加载不出来，宁可不用。
 * 拿不到返回空串，标题栏回退到应用 logo。
 */
export function avatarUrl(profile: Record<string, unknown> | null): string {
  if (!profile) return "";
  const user = profile.user as Record<string, unknown> | null | undefined;
  for (const o of [profile, user]) {
    if (!o) continue;
    for (const key of [
      "avatar",
      "avatarUrl",
      "avatar_url",
      "headImg",
      "headImage",
      "faceUrl",
      "picUrl",
      "pic",
      "face",
    ]) {
      const v = o[key];
      if (typeof v === "string" && /^https?:\/\//.test(v.trim())) return v.trim();
    }
  }
  return "";
}

/** 本地收藏的账号归属标记（user.id）。退出不清除，供换号登录时检测
 *  注：like.imported / like.sync.seq / like.lastError 三个键在本文件一律用
 *  字面量（不用常量），原因见 pullLikes 与 init 里的注释 —— 启动早期同步
 *  时引用未初始化完的模块常量会掩盖真正的错误。 */
export const LIKE_OWNER_KEY = "like.sync.owner";

/**
 * 从 me / 登录响应里收集「已授予的权限码与角色名」。
 *
 * 2026-09-30 权限模型重构（V20260930001）后的响应形状：顶层 `permissions` 是
 * 分层权限码（如 admin:qt:admin，超管角色合成 *:*:* 不落库），`roles` 是角色名
 * （如 TESTER/APP_USER）；兼容 user 嵌套与旧库（roles 里还是旧扁平码 qt_admin）。
 */
function grantedCodes(profile: Record<string, unknown> | null): string[] {
  if (!profile) return [];
  const out: string[] = [];
  const lists: unknown[] = [profile.permissions, profile.roles];
  const user = profile.user as Record<string, unknown> | null | undefined;
  if (user) lists.push(user.permissions, user.roles);
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const v of list) {
      if (typeof v === "string" && v.trim()) out.push(v.trim());
    }
  }
  return out;
}

/**
 * 是否持有某个权限码。对齐后端 PermissionChecker 的匹配规则：
 * - 精确持有；
 * - 超管 `*:*:*`，或层级通配（`user:ai:*` / `user:ai:music:*`）按段前缀覆盖；
 * - `aliases` 兜底旧扁平码（未跑迁移的线上库，后端同名别名过渡期）。
 * 注意不能只看 roles：重构后 roles 回的是角色名，权限码在 permissions 里。
 */
export function hasPermission(
  profile: Record<string, unknown> | null,
  required: string,
  aliases: readonly string[] = [],
): boolean {
  for (const g of grantedCodes(profile)) {
    if (g === required || g === "*:*:*" || aliases.includes(g)) return true;
    if (g.endsWith(":*") && required.startsWith(g.slice(0, -1))) return true;
  }
  return false;
}

/** 是否轻听管理员（权限控件用，如播放地址调试框） */
export function isAdmin(profile: Record<string, unknown> | null): boolean {
  return hasPermission(profile, "admin:qt:admin", ["qt_admin"]);
}

/**
 * 一次收藏同步的上下文（C01 内层长链路）。
 *
 * generation 是前端会话代次；epoch 是宿主侧会话 epoch（登录 / 换号时由 Rust
 * 自增，同步链路开始时取一次并随每个收藏 IPC 传给宿主）。同一条链路
 * 里每个 await 都可能横跨一次换号，所以分页、apply、游标与归属写入之前都要用它
 * 核对一遍 —— 只在外层阶段之间核对，旧账号已经排到 JS 队列里的分页/写入仍会落进
 * 新账号的本地库。
 */
interface LikeSyncContext {
  generation: number;
  epoch: number;
}

/**
 * 链路是否已被打断。
 */
function likeSyncAborted(ctx: LikeSyncContext): boolean {
  return ctx.generation !== authRuntime.sessionGeneration || !authRuntime.likeSyncTrusted;
}

/**
 * 宿主 epoch 拿不到时收手（fail-closed）。
 *
 * 之前约定「查询失败就退化成不带 epoch 继续同步」，那是 fail-open：native
 * 已经换号 / 接口升级异常时，宿主侧的保护恰好失效，旧链路会继续推进游标、
 * 覆盖 owner，A 的数据就这样落到 B 的接口上（C01）。
 *
 * 现在的约定：确认不了宿主会话代次，本轮 flush / pull / apply / owner / 游标
 * 一个都不发，只在当前代次写一条可排查的 lastError；本地已经落库的数据照常可读，
 * 断网 / 旧宿主也不会影响已有收藏展示。
 */
function reportLikeSyncPaused(generation: number, err: unknown): void {
  if (generation !== authRuntime.sessionGeneration) return;
  const reason = "无法确认登录会话代次，已暂停收藏同步";
  log.warn("[like] 读取宿主会话代次失败，暂停收藏同步", err);
  void ipc.setSetting("like.lastError", reason).catch(() => {});
}

/** 收藏 IPC 的 epoch 实参：宿主会话代次（取不到时不发请求，所以这里一定有值） */
function epochOf(ctx: LikeSyncContext): number {
  return ctx.epoch;
}

/**
 * 构造一次可信同步上下文：先确认本地身份可信，再取一次宿主 epoch。
 *
 * 取 epoch 也是 await，期间可能登出 / 换号，所以取完必须再核对一次前端代次。
 * 返回 null 表示不可信、已换号，或 epoch 查询失败（fail-closed）—— 调用方
 * 一个云端请求都不要发。
 */
async function captureLikeSyncContext(): Promise<LikeSyncContext | null> {
  if (!authRuntime.likeSyncTrusted) return null;
  const generation = authRuntime.sessionGeneration;
  let epoch: number;
  try {
    epoch = await ipc.likeSessionEpoch();
  } catch (err) {
    reportLikeSyncPaused(generation, err);
    return null;
  }
  if (generation !== authRuntime.sessionGeneration || !authRuntime.likeSyncTrusted) return null;
  return { generation, epoch };
}

/**
 * 启动恢复 / 登录 / 注册链路上的宿主 epoch 获取。
 *
 * 取不到就是 fail-closed：写一条当前代次的 lastError 并返回 null，调用方保持
 * 本地登录态但不做任何云端同步（C01）。已换号 / 已登出的旧链路不写错误。
 */
async function fetchLikeSessionEpochFor(generation: number): Promise<number | null> {
  try {
    return await ipc.likeSessionEpoch();
  } catch (err) {
    reportLikeSyncPaused(generation, err);
    return null;
  }
}

const LIKE_PAGE_SIZE = 200;

/**
 * 拉取云端收藏并落本地。
 *
 * 分两种路径，因为**后端的 changes 接口只保留最近若干条变更**，
 * 老收藏根本不在里面（实测 since=0 只回 4 条，而账号里有一百多条）。
 * 所以第一次必须走全量 `like/list` 分页导入，之后才用增量追变更 ——
 * 这也是移动端 like.ts 里 fetchAllLikes 兜底的原因。
 */
export async function pullLikes(ctx?: LikeSyncContext): Promise<void> {
  // 独立调用（我的收藏页打开时刷新）也构造可信上下文并过门闩：
  // 身份未知 / 隔离失败 / 已登出时一个云端请求都不发。
  const context = ctx ?? (await captureLikeSyncContext());
  if (context === null || likeSyncAborted(context)) return;
  // 同上，这里一律用字面量，避免模块初始化顺序带来的引用问题
  const imported = await ipc.getSetting("like.imported").catch(() => null);
  // 等待 setSetting 期间可能已经登出/换号：后面的分页与写入必须停手
  if (likeSyncAborted(context)) return;

  // 全量导入和游标分开记：老用户可能早就有游标（增量同步跑过），
  // 但没做过全量，这时也该先补一次全量。
  if (imported !== "1") {
    await importAllLikes(context);
    if (likeSyncAborted(context)) return;
    await ipc.setSetting("like.imported", "1", epochOf(context)).catch(() => {});
    return;
  }

  const raw = await ipc.getSetting("like.sync.seq").catch(() => null);
  if (likeSyncAborted(context)) return;
  let since = Number(raw ?? 0);
  // 循环拉到没有新变更为止（对齐 uniappx pullChanges）：
  // 后端单页 500 条上限，之前只拉一次就把游标推到 maxSeq，
  // 第 501 条之后的变更（如删大歌单时同 seq 级联软删的全部成员行）永久丢失
  for (let round = 0; round < 50; round++) {
    if (likeSyncAborted(context)) return;
    const result = await ipc.likePull(Number.isFinite(since) ? since : 0, epochOf(context));
    if (likeSyncAborted(context)) return;
    // 增量接口的字段可能带 null（album/hash/pid…），直接透传会让 Rust 反序列化整条失败
    // （invalid type: null, expected a string），所以这里和全量一样先归一。
    const changes = Array.isArray(result?.changes)
      ? (result.changes as unknown as RawLike[]).map((c) =>
          toChange(c?.type === "playlist" ? "playlist" : "song", c ?? {}),
        )
      : [];
    // 服务器 maxSeq 比本地游标还小：云端整库重建过（seq 从 1 重计），
    // 旧游标已失效。对齐到新库 maxSeq，缺失数据交给启动对账补推，
    // 不能再把旧游标写回去（否则永远追不上新库）
    const maxSeq = typeof result?.maxSeq === "number" ? result.maxSeq : since;
    if (maxSeq < since) {
      if (likeSyncAborted(context)) return;
      await ipc.setSetting("like.sync.seq", String(maxSeq), epochOf(context)).catch(() => {});
      return;
    }
    if (changes.length > 0) {
      if (likeSyncAborted(context)) return;
      await ipc.likeApply(changes, epochOf(context));
      // 跨号打断后不再 bump：本次 apply 落在旧上下文里，刷新 UI 只会暴露脏数据
      if (likeSyncAborted(context)) return;
      useFavoritesStore.getState().bump();
    }
    if (maxSeq <= since) return;
    since = maxSeq;
    if (likeSyncAborted(context)) return;
    await ipc.setSetting("like.sync.seq", String(maxSeq), epochOf(context)).catch(() => {});
    if (changes.length === 0) return;
  }
}

/** 全量分页导入，导完把游标推到后端的 maxSeq */
async function importAllLikes(ctx?: LikeSyncContext): Promise<void> {
  // 私有调用方都会传入可信 context；保留兜底，单独调用时同样受信任门闩约束
  const context = ctx ?? (await captureLikeSyncContext());
  if (context === null || likeSyncAborted(context)) return;
  // 两阶段（对齐 uniappx doFullPull「先收齐再合并」）：歌曲行的 pid
  // 归属依赖歌单先落地，DESC 分页里歌常在歌单前面的页 —— 逐页应用会因
  // 「歌单不存在」跳过歌曲，且 imported=1 后永不再重试
  const allPlaylists: ipc.LikeChange[] = [];
  const allSongs: ipc.LikeChange[] = [];
  let maxSeq = 0;
  let page = 1;
  for (;;) {
    if (likeSyncAborted(context)) return;
    const { songs, playlists, maxSeq: seq } = normalizeLikeList(
      await ipc.likePullAll(page, LIKE_PAGE_SIZE, epochOf(context)),
    );
    if (likeSyncAborted(context)) return;
    if (songs.length === 0 && playlists.length === 0) break;
    allPlaylists.push(...playlists.map((p) => toChange("playlist", p)));
    allSongs.push(...songs.map((s) => toChange("song", s)));
    if (seq > maxSeq) maxSeq = seq;
    page += 1;
  }
  // 先歌单后歌曲：歌单卡片全部就位，歌曲的 pid 准入检查才都能过
  if (allPlaylists.length > 0) {
    if (likeSyncAborted(context)) return;
    await ipc.likeApply(allPlaylists, epochOf(context));
    if (likeSyncAborted(context)) return;
    useFavoritesStore.getState().bump();
  }
  if (allSongs.length > 0) {
    if (likeSyncAborted(context)) return;
    await ipc.likeApply(allSongs, epochOf(context));
    if (likeSyncAborted(context)) return;
    useFavoritesStore.getState().bump();
  }
  if (maxSeq > 0) {
    if (likeSyncAborted(context)) return;
    await ipc.setSetting("like.sync.seq", String(maxSeq), epochOf(context)).catch(() => {});
  }
}

interface AuthRuntime {
  /** 登录 / 登出等操作自增；长链路每个 await 后核对，防止旧账号结果覆盖新账号。 */
  sessionGeneration: number;
  /** 只有身份确认且本地换号隔离成功后才允许同步收藏。 */
  likeSyncTrusted: boolean;
  store?: UseBoundStore<StoreApi<AuthStore>>;
}

// Vite 热更新与后续懒加载可能用不同 ?t= 地址重复执行本模块。
// hot.data 按模块路径共享；保留 store 及其会话门闩，避免标题栏和编辑页各持一份状态。
// 仅保存在当前 WebView 的开发期内存中，不把账号资料写进全局或本地存储。
// Vitest 等执行器可能只提供空的 hot 占位，没有 Vite 的 data 生命周期。
const hotData = import.meta.hot?.data;
const authRuntime: AuthRuntime = hotData?.authRuntime ?? {
  sessionGeneration: 0,
  likeSyncTrusted: false,
};
if (hotData) hotData.authRuntime = authRuntime;

/**
 * 启动 / 登录后的完整同步（LIKE_SYNC_DESIGN.md §3 / §5 的 PC 版）：
 * 1. 先重放离线队列（断网期间没推上去的操作）——拉取之前推，
 *    否则队列里的 remove 会被拉下来的旧状态重新加回本地，来回震荡；
 * 2. 增量拉取（游标缺失转全量）——其他端的删除先在本地生效；
 * 3. 启动对账：全量拉云端做存在性 diff，本地有而云端没有的补推。
 *
 * 身份未确认或本地隔离失败时整体跳过；跑到一半被换号/登出打断也立即停止。
 * epoch / generation 由 resumeLikeSync 在确认身份前取好并传入：整条链路共用
 * 同一个宿主代次，宿主据此丢弃换号前发出的请求。
 */
export async function syncLikesWithReconcile(epoch: number, generation: number): Promise<void> {
  // 同步上下文：宿主 epoch 已经由调用方取好（取不到时不会走到这里），
  // 全链路的每个收藏 IPC 都带上它。
  const ctx: LikeSyncContext = { generation, epoch };
  if (likeSyncAborted(ctx)) return;
  try {
    await ipc.likeFlushPending(epochOf(ctx)).catch(() => {});
    if (likeSyncAborted(ctx)) return;
    await pullLikes(ctx);
    if (likeSyncAborted(ctx)) return;
    await ipc.likeReconcile(epochOf(ctx)).catch(() => {});
  } catch (err) {
    // 换号 / 登出后旧链路抛错（含宿主 epoch 拒绝）属于预期，安静退出不写 lastError
    if (likeSyncAborted(ctx)) return;
    throw err;
  }
}

/** 从 me 响应里取当前账号 uid（兼容 user 嵌套与平铺两种形状） */
function profileUid(profile: Record<string, unknown> | null): string {
  if (!profile) return "";
  const user = profile.user as Record<string, unknown> | null | undefined;
  for (const v of [profile.id, profile.uid, user?.id, user?.uid]) {
    if (v != null && String(v).length > 0) return String(v);
  }
  return "";
}

/**
 * 登录成功后的收藏归属检查（LIKE_SYNC_DESIGN.md §6 的 PC 版）。
 * 本地库不分账号（uid 固定 0），换号登录必须先清库 —— A 的数据只留在
 * A 的服务器账号里，清完游标自动复位，随后的 pullLikes 全量拉取恢复 B 的数据。
 * 同账号重登（或 token 过期自动恢复，不走登录页）什么都不动，本地秒恢复。
 * 登录响应的 user.id 记入 like.sync.owner，退出登录不清除。
 *
 * 返回 false 表示「身份不可信」或「隔离失败」：此时保持原 owner 不变，
 * 调用方必须暂停收藏同步 —— 新账号的 session 已由后端持久化，继续同步会把
 * A 未确认的本地歌单当成 B 的推上去（C01）。generation 用来丢弃换号瞬间
 * 仍在途的旧流程。
 */
async function handleLikeOwnerSwitch(
  profile: Record<string, unknown> | null,
  generation: number,
  epoch: number,
): Promise<boolean> {
  const uid = profileUid(profile);
  // 身份未知（/me 失败等）：分辨不出是不是同一个人，宁可不动也不猜
  if (!uid) return false;
  // 归属检查本身也是写操作：带上宿主 epoch，旧会话的迟到写由宿主直接拒绝
  let prev: string | null;
  try {
    prev = await ipc.getSetting(LIKE_OWNER_KEY);
  } catch {
    return false;
  }
  if (generation !== authRuntime.sessionGeneration) return false;
  if (prev && prev !== uid) {
    try {
      await ipc.likeClearLocal(epoch);
      useFavoritesStore.getState().bump();
    } catch (err) {
      // 清库失败：保留 A 的本地数据与归属标记，暂停同步等下次登录重试
      log.warn("[like] 换号清理本地收藏失败，保留原归属并暂停同步", err);
      void ipc.setSetting("like.lastError", errMsg(err)).catch(() => {});
      return false;
    }
    if (generation !== authRuntime.sessionGeneration) return false;
  }
  try {
    await ipc.setSetting(LIKE_OWNER_KEY, uid, epoch);
  } catch (err) {
    log.warn("[like] 记录收藏归属失败，暂停同步", err);
    return false;
  }
  return generation === authRuntime.sessionGeneration;
}

/**
 * 身份确认 + 本地隔离都通过才放开收藏同步；否则保持暂停并留一条可排查的线索。
 * phase 只用于日志前缀（启动恢复 / 登录 / 注册）。
 */
async function resumeLikeSync(
  profile: Record<string, unknown> | null,
  generation: number,
  phase: string,
  epochArg?: number,
): Promise<void> {
  // fail-closed：先确认宿主会话代次。取不到就不做归属检查（不写 owner、不清本地库），
  // 更不启动 flush / pull / reconcile —— fail-open 会在 native 已换号 / 接口升级异常时
  // 让保护直接消失（C01）。本地可信数据照常可读，只是本轮暂停同步。
  //
  // 调用方（init / login / register）已经为身份确认取过一次 epoch，直接复用，
  // 避免同一链路里出现两个不同代次（task-9）。
  let epoch: number;
  if (epochArg === undefined) {
    const fetched = await fetchLikeSessionEpochFor(generation);
    if (fetched === null) return;
    epoch = fetched;
  } else {
    epoch = epochArg;
  }
  if (generation !== authRuntime.sessionGeneration) return;
  const trusted = await handleLikeOwnerSwitch(profile, generation, epoch);
  if (generation !== authRuntime.sessionGeneration) return;
  authRuntime.likeSyncTrusted = trusted;
  if (!trusted) {
    const reason = "身份未确认或本地收藏隔离失败，已暂停收藏同步";
    log.warn(`[like] ${phase}${reason}`);
    void ipc.setSetting("like.lastError", reason).catch(() => {});
    return;
  }
  void syncLikesWithReconcile(epoch, generation).catch((err) => {
    // 跑到一半已换号 / 登出：旧链路的失败（含宿主 epoch 拒绝）与当前账号无关，
    // 安静退出，别把旧会话的错误写进新会话的 lastError。
    if (generation !== authRuntime.sessionGeneration || !authRuntime.likeSyncTrusted) return;
    log.warn(`[like] ${phase}收藏同步失败`, err);
    void ipc.setSetting("like.lastError", errMsg(err)).catch(() => {});
  });
}

type RawLike = Record<string, unknown>;

function normalizeLikeList(raw: unknown): {
  songs: RawLike[];
  playlists: RawLike[];
  maxSeq: number;
} {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    songs: Array.isArray(o.songs) ? (o.songs as RawLike[]) : [],
    playlists: Array.isArray(o.playlists) ? (o.playlists as RawLike[]) : [],
    maxSeq: Number(o.maxSeq ?? 0),
  };
}

/**
 * 全量接口给的是实体（sid/pid + deletedAt），同步认的是变更（id + deleted），
 * 这里做一次归一：deletedAt 非空就是已取消收藏。
 */
function toChange(kind: "song" | "playlist", item: RawLike): ipc.LikeChange {
  return {
    type: kind,
    id: String(item.sid ?? item.pid ?? item.id ?? ""),
    platform: String(item.platform ?? ""),
    name: String(item.name ?? ""),
    singer: String(item.singer ?? ""),
    album: String(item.album ?? ""),
    hash: String(item.hash ?? ""),
    // 歌曲的归属歌单：后端 like/list 的 songs[].pid 原样返回，可空
    ...(kind === "song" && item.pid != null && item.pid !== ""
      ? { pid: String(item.pid) }
      : {}),
    // 封面「没给 / 为 null」与「明确清空」是两种语义：前者省略字段（宿主保留
    // 原封面），后者传空串。这里以前一律 `String(picUrl ?? "")`，全量导入时
    // 会把云端没给封面的歌单统一改写成空串，覆盖掉本地已有封面（C13）。
    ...(item.picUrl === undefined || item.picUrl === null
      ? {}
      : { picUrl: String(item.picUrl) }),
    // 两种接口字段不一样：增量 changes 给 deleted 布尔，全量 list 给 deletedAt（非空即取消）
    deleted: item.deleted === true || item.deletedAt != null,
    updatedSeq: Number(item.updatedSeq ?? 0),
  };
}

/**
 * 向服务端确认本地这个会话是否还认。
 *
 * 本地没过期 ≠ 服务端还认：后端重启、会话被撤销后，token 在本地可能还剩好几天
 * （后端不给 expiresIn 时按 7 天兜底），界面就会一直显示「已登录」而接口全 401。
 *
 * 返回用户信息表示有效；返回 null 表示服务端明确否认；抛错表示网络不可达。
 * Rust 侧遇到 401 会顺手清掉本地会话，所以失败后再读一次即可分辨：
 * 会话被清了就是确实失效，还在就是网络问题（不能登出用户）。
 */
async function confirmSession(
  session: AuthSession,
  epoch: number,
): Promise<Record<string, unknown> | null> {
  try {
    return await ipc.astralMe(epoch);
  } catch (err) {
    const still = await ipc.astralSession().catch(() => session);
    if (!still) return null;
    throw err;
  }
}

const createAuthState: StateCreator<AuthStore> = (set, get) => ({
  session: null,
  profile: null,
  loading: false,
  error: null,

  init: async () => {
    const generation = ++authRuntime.sessionGeneration;
    authRuntime.likeSyncTrusted = false;
    try {
      const session = await ipc.astralSession().catch(() => null);
      // 读会话也是 await：期间用户可能已经登录 / 登出，晚到的旧结果整条作废，
      // 否则会把新账号的会话覆盖回启动时的旧会话（task-9）。
      if (generation !== authRuntime.sessionGeneration) return;
      if (!session || !isSessionValid(session)) {
        set({ session: null, profile: null });
        return;
      }
      set({ session });

      // 身份确认必须带宿主会话代次；取不到就保持「已恢复会话、资料待下次刷新」，
      // 不发任何会改变账号归属的请求（fail-closed，C01）。
      const epoch = await fetchLikeSessionEpochFor(generation);
      if (generation !== authRuntime.sessionGeneration) return;
      if (epoch === null) return;

      // 再向服务端确认一次：本地没过期不代表服务端还认这个 token
      const profile = await confirmSession(session, epoch);
      if (generation !== authRuntime.sessionGeneration) return;
      if (!profile) {
        // 服务端明确否认 → 回到未登录（Rust 侧 401 时已清过一遍，这里兜底清本地行）
        set({ session: null, profile: null, error: null });
        await ipc.astralLogout(epoch).catch(() => {});
        return;
      }
      set({ profile });
      // 同步前先确认身份并完成换号隔离（C01）：失败保持 owner 不变、暂停同步，
      // 等下次启动/登录再试；通过后才按「重放队列 → 拉取 → 对账」跑。
      await resumeLikeSync(profile, generation, "启动恢复后", epoch);
    } catch (err) {
      // 过期链路的失败与当前会话无关，不能清掉新账号的 profile / 写 error（task-9）。
      if (generation !== authRuntime.sessionGeneration) return;
      // 后端没起 / 网络不可达：保留本地登录态（离线容忍），只是暂时拿不到用户信息。
      // 这是正常离线场景，不该刷成 warn 吓人；但留一条 debug 决策轨迹 ——
      // 排查「为什么没登录上」时，得能看出是走到了这条路，而不是压根没调。
      log.debug("[auth] 拉取用户信息失败，保持离线登录态", err);
      set({ profile: null, error: null });
    }
  },

  login: async (username, password) => {
    const generation = ++authRuntime.sessionGeneration;
    authRuntime.likeSyncTrusted = false;
    set({ loading: true, error: null });
    try {
      const session = await ipc.astralLogin(username, password);
      // 登录请求也是 await：期间用户可能又发起登录 / 登出，旧链路一律作废，
      // 不能把旧账号的会话与资料写回当前账号（task-9）。
      if (generation !== authRuntime.sessionGeneration) return;
      // 先取宿主 epoch 再确认身份；取不到就只落地会话、暂停同步（fail-closed）。
      const epoch = await fetchLikeSessionEpochFor(generation);
      if (generation !== authRuntime.sessionGeneration) return;
      if (epoch === null) {
        set({ session, profile: null, loading: false });
        return;
      }
      const profile = await ipc.astralMe(epoch).catch(() => null);
      if (generation !== authRuntime.sessionGeneration) return;
      set({ session, profile, loading: false });
      // 收藏归属检查（换号清库）+ 新账号的收藏同步：身份与隔离都通过才同步，
      // 失败保持原 owner 并暂停同步（C01）。
      await resumeLikeSync(profile, generation, "登录后", epoch);
    } catch (err) {
      // 过期链路的失败（网络错误 / 旧账号密码错）与当前会话无关，
      // 不能写进新会话的 error / loading（task-9）。
      if (generation !== authRuntime.sessionGeneration) return;
      set({
        loading: false,
        error: errMsg(err),
      });
      throw err;
    }
  },

  register: async (username, password, passwordConfirm, email, nickname) => {
    const generation = ++authRuntime.sessionGeneration;
    authRuntime.likeSyncTrusted = false;
    set({ loading: true, error: null });
    try {
      const session = await ipc.astralRegister(
        username,
        password,
        passwordConfirm,
        email,
        nickname,
      );
      // 注册同样是多段 await，过期链路的结果不能落到新会话上（task-9）。
      if (generation !== authRuntime.sessionGeneration) return;
      const epoch = await fetchLikeSessionEpochFor(generation);
      if (generation !== authRuntime.sessionGeneration) return;
      if (epoch === null) {
        set({ session, profile: null, loading: false });
        return;
      }
      const profile = await ipc.astralMe(epoch).catch(() => null);
      if (generation !== authRuntime.sessionGeneration) return;
      set({ session, profile, loading: false });
      await resumeLikeSync(profile, generation, "注册后", epoch);
    } catch (err) {
      if (generation !== authRuntime.sessionGeneration) return;
      set({
        loading: false,
        error: errMsg(err),
      });
      throw err;
    }
  },

  logout: async () => {
    // 先让在途同步失效：退出后 token 已不属于这个账号，继续 pull/reconcile
    // 会把 A 的数据写进随后登录的账号（C01）。
    const generation = ++authRuntime.sessionGeneration;
    authRuntime.likeSyncTrusted = false;
    set({ loading: true, error: null });
    // 退出链路上的补推 / 重置都要带同一个宿主 epoch：
    // logout 会让 native 提升 epoch，后置的 reset 就带不上原代次了，
    // 所以 reset 必须放在 astralLogout 之前（task-9）。
    let epoch: number;
    try {
      epoch = await ipc.likeSessionEpoch();
    } catch (err) {
      if (generation !== authRuntime.sessionGeneration) return;
      // 未知宿主 epoch 时，「重置收藏同步 / 登出」都是没有绑定代次的宿主副作用：
      // A 的旧命令可能在桥里排队，B 的 native 登录先落，零参命令会按 B 的当前
      // 代次执行，于是迟到的 A 链路直接把刚登录的 B 清掉（task-10）。
      // 这里必须 fail-closed：保留当前会话、一个宿主写都不发，给可重试的错误。
      log.warn("[auth] 读取宿主会话代次失败，已取消退出", err);
      set({ loading: false, error: "无法确认登录会话代次，请稍后重试" });
      return;
    }
    if (generation !== authRuntime.sessionGeneration) return;
    // 退出前把断网积压的收藏操作尽力推一把（token 还有效），丢队列前先补推；
    // 收藏数据与归属标记保留 —— 同账号重登无缝恢复，换号由登录侧清库
    await ipc.likeFlushPending(epoch).catch(() => {});
    if (generation !== authRuntime.sessionGeneration) return;
    // 先 reset 再 logout：logout 会提升 native epoch，之后 reset 就带不上同一代次。
    await ipc.likeResetSync(epoch).catch(() => {});
    if (generation !== authRuntime.sessionGeneration) return;
    try {
      await ipc.astralLogout(epoch);
    } catch {
      // 后端不可达也要清本地，否则用户退不出去
    }
    // 等待期间已重新登录：旧 logout 不能再清新会话（task-9）。
    if (generation !== authRuntime.sessionGeneration) return;
    set({ session: null, profile: null, loading: false });
  },

  updateProfile: async (patch) => {
    const generation = authRuntime.sessionGeneration;
    // 改资料链路上有多个 await：先固定 epoch，之后每一步都核对本地代次，
    // 旧响应（成功或失败）不能作用于期间新登录的账号（task-9）。
    let epoch: number;
    try {
      epoch = await ipc.likeSessionEpoch();
    } catch {
      if (generation !== authRuntime.sessionGeneration) return;
      const message = "无法确认登录会话代次，请重新登录后再试";
      set({ loading: false, error: message });
      throw new Error(message);
    }
    if (generation !== authRuntime.sessionGeneration) return;
    set({ loading: true, error: null });
    try {
      await ipc.astralUpdateProfile(patch, epoch);
    } catch (err) {
      // 失败时后端还没走到 kickout（校验不过就返回了），本地登录态保持不动；
      // 过期链路的失败不写进新会话。
      if (generation !== authRuntime.sessionGeneration) return;
      set({ loading: false, error: errMsg(err) });
      throw err;
    }
    if (generation !== authRuntime.sessionGeneration) return;
    // 成功：后端 updateUser 结尾会 StpUtil.kickout(userId)，token 当场作废。
    // 本地必须跟着清，否则界面会停在「显示已登录、接口全 401」。
    // 收藏数据与归属标记按 logout 的口径保留（同账号重登无缝恢复）；
    // 在途的收藏同步也要一并失效（C01）。清理链同样先 reset 再 logout。
    const cleanupGeneration = ++authRuntime.sessionGeneration;
    authRuntime.likeSyncTrusted = false;
    await ipc.likeResetSync(epoch).catch(() => {});
    if (cleanupGeneration !== authRuntime.sessionGeneration) return;
    await ipc.astralLogout(epoch).catch(() => {});
    if (cleanupGeneration !== authRuntime.sessionGeneration) return;
    set({ session: null, profile: null, loading: false });
  },

  setLocalAvatar: (url) => {
    const p = get().profile;
    if (p) set({ profile: { ...p, avatar: url } });
  },

  // 下面两个不碰 store 的 loading/error：调用方（找回密码页）自己管按钮倒计时与报错
  sendEmailCode: async (email) => {
    await ipc.astralSendEmailCode(email);
  },

  changePassword: async (email, password, code) => {
    await ipc.astralChangePassword(email, password, code);
  },
});

export const useAuthStore = authRuntime.store ?? create<AuthStore>(createAuthState);

if (hotData) {
  if (authRuntime.store) {
    // 保留现有资料、订阅与在途会话代次，同时让后续调用使用热更新后的 action。
    const {
      session: _session, profile: _profile, loading: _loading, error: _error, ...actions
    } = createAuthState(useAuthStore.setState, useAuthStore.getState, useAuthStore);
    useAuthStore.setState(actions);
  }
  authRuntime.store = useAuthStore;
}

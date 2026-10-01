import { create } from "zustand";
import { errMsg } from "@/lib/utils";
import type { AuthSession } from "@/types";
import * as ipc from "@/services/ipc";

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

/** 同步失败时把错误写到这里，便于从库中排查 */
export const LIKE_LAST_ERROR_KEY = "like.lastError";

/** 收藏同步游标（存 settings 表，跟着账号走） */
export const LIKE_SEQ_KEY = "like.sync.seq";

/** 是否已做过全量导入。和游标分开记，见 pullLikes 里的说明 */
export const LIKE_IMPORTED_KEY = "like.imported";

/** 本地收藏的账号归属标记（user.id）。退出不清除，供换号登录时检测 */
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
 * 是否轻听管理员（权限控件用，如播放地址调试框）。
 * 对齐后端 PermissionChecker 的匹配规则：
 * - 精确持有新码 `admin:qt:admin`；
 * - 超管 `*:*:*`，或层级通配（`admin:*` / `admin:qt:*`）按段前缀覆盖；
 * - 旧扁平码 `qt_admin` 兜底（未跑迁移的线上库，后端同名别名过渡期）。
 * 注意不能只看 roles：重构后 roles 回的是角色名，权限码在 permissions 里。
 */
export function isAdmin(profile: Record<string, unknown> | null): boolean {
  const required = "admin:qt:admin";
  for (const g of grantedCodes(profile)) {
    if (g === required || g === "qt_admin" || g === "*:*:*") return true;
    if (g.endsWith(":*") && required.startsWith(g.slice(0, -1))) return true;
  }
  return false;
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
export async function pullLikes(): Promise<void> {
  // 同上，这里一律用字面量，避免模块初始化顺序带来的引用问题
  const imported = await ipc.getSetting("like.imported").catch(() => null);

  // 全量导入和游标分开记：老用户可能早就有游标（增量同步跑过），
  // 但没做过全量，这时也该先补一次全量。
  if (imported !== "1") {
    await importAllLikes();
    await ipc.setSetting("like.imported", "1").catch(() => {});
    return;
  }

  const raw = await ipc.getSetting("like.sync.seq").catch(() => null);
  let since = Number(raw ?? 0);
  // 循环拉到没有新变更为止（对齐 uniappx pullChanges）：
  // 后端单页 500 条上限，之前只拉一次就把游标推到 maxSeq，
  // 第 501 条之后的变更（如删大歌单时同 seq 级联软删的全部成员行）永久丢失
  for (let round = 0; round < 50; round++) {
    const result = await ipc.likePull(Number.isFinite(since) ? since : 0);
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
      await ipc.setSetting("like.sync.seq", String(maxSeq)).catch(() => {});
      return;
    }
    if (changes.length > 0) {
      await ipc.likeApply(changes);
    }
    if (maxSeq <= since) return;
    since = maxSeq;
    await ipc.setSetting("like.sync.seq", String(maxSeq)).catch(() => {});
    if (changes.length === 0) return;
  }
}

/** 全量分页导入，导完把游标推到后端的 maxSeq */
async function importAllLikes(): Promise<void> {
  // 两阶段（对齐 uniappx doFullPull「先收齐再合并」）：歌曲行的 pid
  // 归属依赖歌单先落地，DESC 分页里歌常在歌单前面的页 —— 逐页应用会因
  // 「歌单不存在」跳过歌曲，且 imported=1 后永不再重试
  const allPlaylists: ipc.LikeChange[] = [];
  const allSongs: ipc.LikeChange[] = [];
  let maxSeq = 0;
  let page = 1;
  for (;;) {
    const { songs, playlists, maxSeq: seq } = normalizeLikeList(
      await ipc.likePullAll(page, LIKE_PAGE_SIZE),
    );
    if (songs.length === 0 && playlists.length === 0) break;
    allPlaylists.push(...playlists.map((p) => toChange("playlist", p)));
    allSongs.push(...songs.map((s) => toChange("song", s)));
    if (seq > maxSeq) maxSeq = seq;
    page += 1;
  }
  // 先歌单后歌曲：歌单卡片全部就位，歌曲的 pid 准入检查才都能过
  if (allPlaylists.length > 0) await ipc.likeApply(allPlaylists);
  if (allSongs.length > 0) await ipc.likeApply(allSongs);
  if (maxSeq > 0) {
    await ipc.setSetting("like.sync.seq", String(maxSeq)).catch(() => {});
  }
}

/**
 * 启动 / 登录后的完整同步（LIKE_SYNC_DESIGN.md §3 / §5 的 PC 版）：
 * 1. 先重放离线队列（断网期间没推上去的操作）——拉取之前推，
 *    否则队列里的 remove 会被拉下来的旧状态重新加回本地，来回震荡；
 * 2. 增量拉取（游标缺失转全量）——其他端的删除先在本地生效；
 * 3. 启动对账：全量拉云端做存在性 diff，本地有而云端没有的补推。
 */
export async function syncLikesWithReconcile(): Promise<void> {
  await ipc.likeFlushPending().catch(() => {});
  await pullLikes();
  await ipc.likeReconcile().catch(() => {});
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
 */
async function handleLikeOwnerSwitch(
  profile: Record<string, unknown> | null,
): Promise<void> {
  const uid = profileUid(profile);
  if (!uid) return;
  const prev = await ipc.getSetting(LIKE_OWNER_KEY).catch(() => null);
  if (prev && prev !== uid) {
    await ipc.likeClearLocal().catch(() => {});
  }
  await ipc.setSetting(LIKE_OWNER_KEY, uid).catch(() => {});
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
    picUrl: String(item.picUrl ?? ""),
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
): Promise<Record<string, unknown> | null> {
  try {
    return await ipc.astralMe();
  } catch (err) {
    const still = await ipc.astralSession().catch(() => session);
    if (!still) return null;
    throw err;
  }
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  session: null,
  profile: null,
  loading: false,
  error: null,

  init: async () => {
    try {
      const session = await ipc.astralSession().catch(() => null);
      if (!session || !isSessionValid(session)) {
        set({ session: null, profile: null });
        return;
      }
      set({ session });

      // 再向服务端确认一次：本地没过期不代表服务端还认这个 token
      const profile = await confirmSession(session);
      if (!profile) {
        // 服务端明确否认 → 回到未登录（Rust 侧 401 时已清过一遍，这里兜底清本地行）
        set({ session: null, profile: null, error: null });
        await ipc.astralLogout().catch(() => {});
        return;
      }
      set({ profile });
      // 登录态就绪后把云端的收藏变更拉回本地，再补两件事（LIKE_SYNC_DESIGN §3/§5）：
      // 1) 重放离线队列（断网期间失败的收藏推送）；
      // 2) 启动对账：本地有而云端没有的收藏补推上去。
      // 顺序保证「增量拉取在前，对账在后」——其他端删除的收藏先在本地移除，
      // 不会被对账误复活。同步失败不影响使用，只记错误不抛。
      void syncLikesWithReconcile().catch((err) => {
        const msg = errMsg(err);
        console.warn("[like] 收藏同步失败", err);
        // 同步失败不该打断登录流程，但得留下线索：错误写进 settings 表，
        // 桌面端没有顺手的 devtools，从库里能直接读到。
        // 用字面量而不是模块常量：同步是启动早期跑的，万一模块还没初始化完，
        // 引用常量会抛 ReferenceError 并**掩盖真正的错误**（这次就是这么踩的）。
        void ipc.setSetting("like.lastError", msg).catch(() => {});
      });
    } catch (err) {
      // 后端没起 / 网络不可达：保留本地登录态（离线容忍），只是暂时拿不到用户信息
      set({ profile: null, error: null });
      void err;
    }
  },

  login: async (username, password) => {
    set({ loading: true, error: null });
    try {
      const session = await ipc.astralLogin(username, password);
      const profile = await ipc.astralMe().catch(() => null);
      set({ session, profile, loading: false });
      // 收藏归属检查（换号清库）+ 新账号的收藏同步，失败不影响登录
      await handleLikeOwnerSwitch(profile);
      void syncLikesWithReconcile().catch(() => {});
    } catch (err) {
      set({
        loading: false,
        error: errMsg(err),
      });
      throw err;
    }
  },

  register: async (username, password, passwordConfirm, email, nickname) => {
    set({ loading: true, error: null });
    try {
      const session = await ipc.astralRegister(
        username,
        password,
        passwordConfirm,
        email,
        nickname,
      );
      const profile = await ipc.astralMe().catch(() => null);
      set({ session, profile, loading: false });
      await handleLikeOwnerSwitch(profile);
      void syncLikesWithReconcile().catch(() => {});
    } catch (err) {
      set({
        loading: false,
        error: errMsg(err),
      });
      throw err;
    }
  },

  logout: async () => {
    set({ loading: true, error: null });
    // 退出前把断网积压的收藏操作尽力推一把（token 还有效），丢队列前先补推；
    // 收藏数据与归属标记保留 —— 同账号重登无缝恢复，换号由登录侧清库
    await ipc.likeFlushPending().catch(() => {});
    try {
      await ipc.astralLogout();
    } catch {
      // 后端不可达也要清本地，否则用户退不出去
    } finally {
      await ipc.likeResetSync().catch(() => {});
      set({ session: null, profile: null, loading: false });
    }
  },

  updateProfile: async (patch) => {
    set({ loading: true, error: null });
    try {
      await ipc.astralUpdateProfile(patch);
    } catch (err) {
      // 失败时后端还没走到 kickout（校验不过就返回了），本地登录态保持不动
      set({ loading: false, error: errMsg(err) });
      throw err;
    }
    // 成功：后端 updateUser 结尾会 StpUtil.kickout(userId)，token 当场作废。
    // 本地必须跟着清，否则界面会停在「显示已登录、接口全 401」。
    // 收藏数据与归属标记按 logout 的口径保留（同账号重登无缝恢复）。
    await ipc.astralLogout().catch(() => {});
    await ipc.likeResetSync().catch(() => {});
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
}));

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
    email?: string,
    code?: string,
  ) => Promise<void>;
  logout: () => Promise<void>;
}

/** 会话是否有效（留 60s 余量，和 Rust 侧 AuthSession::is_valid 同口径） */
export function isSessionValid(s: AuthSession | null): boolean {
  return !!s && s.expiresAt > Date.now() + 60_000;
}

/** 从 me 的响应里猜一个展示名（后端字段名可能不同，逐个兜底） */
export function displayName(
  profile: Record<string, unknown> | null,
  fallback: string,
): string {
  if (!profile) return fallback;
  for (const key of ["nickname", "nickName", "username", "name", "account"]) {
    const v = profile[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return fallback;
}

/** 同步失败时把错误写到这里，便于从库中排查 */
export const LIKE_LAST_ERROR_KEY = "like.lastError";

/** 收藏同步游标（存 settings 表，跟着账号走） */
export const LIKE_SEQ_KEY = "like.sync.seq";

/** 是否已做过全量导入。和游标分开记，见 pullLikes 里的说明 */
export const LIKE_IMPORTED_KEY = "like.imported";

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
  const since = Number(raw ?? 0);
  const result = await ipc.likePull(Number.isFinite(since) ? since : 0);
  // 增量接口的字段可能带 null（album/hash/pid…），直接透传会让 Rust 反序列化整条失败
  // （invalid type: null, expected a string），所以这里和全量一样先归一。
  const changes = Array.isArray(result?.changes)
    ? (result.changes as unknown as RawLike[]).map((c) =>
        toChange(c?.type === "playlist" ? "playlist" : "song", c ?? {}),
      )
    : [];
  if (changes.length > 0) {
    await ipc.likeApply(changes);
  }
  if (typeof result?.maxSeq === "number" && result.maxSeq > since) {
    await ipc.setSetting("like.sync.seq", String(result.maxSeq)).catch(
      () => {},
    );
  }
}

/** 全量分页导入，导完把游标推到后端的 maxSeq */
async function importAllLikes(): Promise<void> {
  let page = 1;
  let maxSeq = 0;
  for (;;) {
    const { songs, playlists, maxSeq: seq } = normalizeLikeList(
      await ipc.likePullAll(page, LIKE_PAGE_SIZE),
    );
    if (songs.length === 0 && playlists.length === 0) break;
    const changes: ipc.LikeChange[] = [
      ...songs.map((s) => toChange("song", s)),
      ...playlists.map((p) => toChange("playlist", p)),
    ];
    await ipc.likeApply(changes);
    if (seq > maxSeq) maxSeq = seq;
    page += 1;
  }
  if (maxSeq > 0) {
    await ipc.setSetting("like.sync.seq", String(maxSeq)).catch(() => {});
  }
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

export const useAuthStore = create<AuthStore>((set) => ({
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
      const profile = await ipc.astralMe().catch(() => null);
      set({ profile });
      // 登录态就绪后把云端的收藏变更拉回本地。同步失败不该影响使用，
      // 所以只记错误不抛（本地收藏本身是权威数据）。
      void pullLikes().catch((err) => {
        const msg = errMsg(err);
        console.warn("[like] 拉取云端收藏失败", err);
        // 同步失败不该打断登录流程，但得留下线索：错误写进 settings 表，
        // 桌面端没有顺手的 devtools，从库里能直接读到。
        // 用字面量而不是模块常量：同步是启动早期跑的，万一模块还没初始化完，
        // 引用常量会抛 ReferenceError 并**掩盖真正的错误**（这次就是这么踩的）。
        void ipc.setSetting("like.lastError", msg).catch(() => {});
      });
    } catch (err) {
      // 后端没起 / 未授权都走未登录，不弹全局错误
      set({ session: null, profile: null, error: null });
      void err;
    }
  },

  login: async (username, password) => {
    set({ loading: true, error: null });
    try {
      const session = await ipc.astralLogin(username, password);
      const profile = await ipc.astralMe().catch(() => null);
      set({ session, profile, loading: false });
    } catch (err) {
      set({
        loading: false,
        error: errMsg(err),
      });
      throw err;
    }
  },

  register: async (username, password, email, code) => {
    set({ loading: true, error: null });
    try {
      const session = await ipc.astralRegister(username, password, email, code);
      const profile = await ipc.astralMe().catch(() => null);
      set({ session, profile, loading: false });
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
    try {
      await ipc.astralLogout();
    } catch {
      // 后端不可达也要清本地，否则用户退不出去
    } finally {
      set({ session: null, profile: null, loading: false });
    }
  },
}));

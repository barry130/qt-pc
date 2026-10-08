import { create } from "zustand";
import * as ipc from "@/services/ipc";
import { trackDbId } from "@/stores/downloads";
import type { DislikeRule, Track } from "@/types";

/**
 * 歌手串按分隔符拆词（**原文**，去空白、丢空段）。
 *
 * 分隔符集合必须与 Rust `split_singer_parts` 一字不差 —— 多一个少一个都会让
 * 「屏蔽 A/B」与「撤销 A/B」落到不同的词上，留下撤不掉的孤儿规则。
 * 判定屏蔽与否的权威在 Rust（它按归一化键匹配），这里只用于前端回显匹配。
 */
const SINGER_SEPARATORS = /[,，、;；/|\&＆　]/g;

function splitSingerParts(raw: string): string[] {
  return (raw ?? "")
    .split(SINGER_SEPARATORS)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 不喜欢列表（屏蔽规则）的前端镜像。
 *
 * Rust 侧是真值：规则存在 `dislike_rules` 表里，写命令还会顺手推一条
 * `ReloadDislikes` 给音频引擎（它在挑下一首时绕开这些歌）。这份 store 只做两件事：
 *   1. 设置页的规则清单（展示 / 逐条删除 / 清空）；
 *   2. 给行内按钮记住「刚才那一下屏蔽生成了哪条规则」，好让用户能就地反悔。
 *
 * 为什么要把规则 id 记在内存里：规则按「歌名 + 歌手」匹配，同一条规则可能被
 * 多处曲目（`稻香` 与 `稻香 (Live)`）命中，靠行数据反查规则并不可靠 —— 而
 * `add_dislike_song` 会直接把规则 id 返回给我们。会话外的场合（重启后想取消）
 * 退化为在 `rules` 里按原文回查，查不到就交给设置页处理。
 *
 * 行要不要显示「已屏蔽」标不在这里判定 —— 那是 `check_disliked` 批量查询的活，
 * 因为归一化 / 版本后缀剥离都在 Rust 侧，前端猜不出来。
 */
interface DislikesStore {
  rules: DislikeRule[];
  loaded: boolean;
  /** 每次增删改后自增：`useDislikeFlags` 据此重新批量判定 */
  version: number;
  /** 本会话内由曲目行新增的规则 id 反查表（key = `platform:id`） */
  songRuleIds: Record<string, number>;
  /**
   * 本会话内由歌手串新增的规则 id 反查表（key = 歌手原文）。
   *
   * **是数组不是单个 id**：一个歌手串会按分隔符拆成多条规则（`A/B` → 两条），
   * 记一个 id 的话撤销只会撤掉第一位，留下 B 那条孤儿规则继续生效。
   */
  singerRuleIds: Record<string, number[]>;

  refresh: () => Promise<void>;
  /** 屏蔽一首歌；返回是否真的新增了规则（0 = 歌名为空等非法输入） */
  banSong: (track: Track) => Promise<boolean>;
  /** 屏蔽某位歌手（整串会按分隔符拆开，逐个生效） */
  banSinger: (singer: string) => Promise<void>;
  /** 就地取消这首的屏蔽；返回是否成功（找不到对应规则时 false） */
  unbanSong: (track: Track) => Promise<boolean>;
  /** 就地撤销整串歌手的屏蔽；返回是否真的撤掉了 */
  unbanSinger: (singer: string) => Promise<boolean>;
  /** 这位歌手（整串里任一词）是否已被屏蔽 —— Alt+点击在「屏蔽/取消」之间切换的依据 */
  singerBanned: (singer: string) => boolean;
  /** 按规则 id 删除（设置页逐条删除用） */
  unbanById: (id: number) => Promise<void>;
  clearAll: () => Promise<void>;
  /** 这首歌对应的规则 id；找不到返回 null */
  ruleIdForSong: (track: Track) => number | null;
}

export const useDislikesStore = create<DislikesStore>((set, get) => ({
  rules: [],
  loaded: false,
  version: 0,
  songRuleIds: {},
  singerRuleIds: {},

  refresh: async () => {
    try {
      const rules = await ipc.listDislikes();
      set((s) => ({
        rules: Array.isArray(rules) ? rules : [],
        loaded: true,
        version: s.version + 1,
      }));
    } catch {
      set({ loaded: true });
    }
  },

  banSong: async (track) => {
    const id = await ipc.addDislikeSong(track);
    if (id > 0) {
      set((s) => ({
        songRuleIds: { ...s.songRuleIds, [trackDbId(track)]: id },
      }));
      await get().refresh();
    }
    return id > 0;
  },

  banSinger: async (singer) => {
    const ids = await ipc.addDislikeSinger(singer);
    if (ids.length > 0) {
      set((s) => ({ singerRuleIds: { ...s.singerRuleIds, [singer]: ids } }));
      await get().refresh();
    }
  },

  unbanSinger: async (singer) => {
    // 交给 Rust 按整串拆词逐条删，而不是删记住的 id：重启后这张表是空的，
    // 而多歌手串（`A/B/C`）靠前端回查 id 只会撤掉一部分、留下孤儿规则。
    const removed = await ipc.removeDislikeSinger(singer);
    if (removed > 0) {
      set((s) => {
        const singerRuleIds = { ...s.singerRuleIds };
        delete singerRuleIds[singer];
        return { singerRuleIds };
      });
      await get().refresh();
    }
    return removed > 0;
  },

  singerBanned: (singer) => {
    if (!singer) return false;
    if ((get().singerRuleIds[singer]?.length ?? 0) > 0) return true;
    // 回退：按回显原文匹配。歌手规则存的是原文（name_raw），
    // 而 song 规则存的才是归一化键 —— 两列不能混用。
    const parts = splitSingerParts(singer);
    return get().rules.some(
      (r) => r.kind === "singer" && parts.indexOf(r.nameRaw) >= 0,
    );
  },

  unbanSong: async (track) => {
    const id = get().ruleIdForSong(track);
    if (id === null) return false;
    await ipc.removeDislikeRule(id);
    set((s) => {
      const songRuleIds = { ...s.songRuleIds };
      delete songRuleIds[trackDbId(track)];
      return { songRuleIds };
    });
    await get().refresh();
    return true;
  },

  unbanById: async (id) => {
    await ipc.removeDislikeRule(id);
    await get().refresh();
  },

  clearAll: async () => {
    await ipc.clearDislikes();
    set({ songRuleIds: {}, singerRuleIds: {} });
    await get().refresh();
  },

  ruleIdForSong: (track) => {
    const remembered = get().songRuleIds[trackDbId(track)];
    if (remembered) return remembered;
    // 退回按原文回查：`name_raw` / `singer_raw` 存的就是当初传进去的字面串
    const hit = get().rules.find(
      (r) =>
        r.kind === "song" &&
        r.nameRaw === track.title &&
        r.singerRaw === track.singer,
    );
    return hit ? hit.id : null;
  },
}));

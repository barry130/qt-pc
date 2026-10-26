/**
 * 歌曲列表排序（2026-10-24，用户 m02960：任何歌曲列表都要有和 qt-uniappx 一样的排序）。
 *
 * 口径对齐 uniappx `pages/playlist/index.uvue` 的排序抽屉 —— 只有三个维度：
 * 歌曲名 / 专辑名 / 歌手名，每个维度可正序或倒序，外加「默认顺序」（不排序）。
 * 故意不做「按添加时间 / 时长 / 来源」这些维度：多端要保持同一套口径，用户在哪一端
 * 看到的选项都一样，切设备不用重新找。
 *
 * 排序发生在**可见列表**上（搜索过滤之后），所以「播放全部」「批量管理」拿到的
 * 顺序和用户看到的一致 —— 这一点与 uniappx 完全同构：排序只改变展示顺序，
 * 不改变列表成员，也不落到歌单本身（真实顺序由音源决定，本地排序纯展示）。
 *
 * 2026-10-24 晚再改口径（用户 m00002 / m00029）：界面上不再是一个塞了 7 项的
 * 下拉，而是**两个弹窗** —— 上面选维度（按歌曲名 / 按专辑名 / 按歌手名），
 * 下面选方向（正序 / 倒序），默认两个都不勾选（= 音源原始顺序，不显示
 * 「默认顺序」这个假选项）。下面 `TRACK_SORT_FIELDS` / `TRACK_SORT_DIRECTIONS`
 * 就是这两个弹窗的数据源；`TRACK_SORT_OPTIONS` / `parseTrackSort` 的
 * 「维度-方向」字符串编码保持不变，页面与本地缓存的接口都不用动。
 */
import { normText } from "@/lib/text";

/** 排序维度：`none` = 保留音源给的默认顺序 */
export type TrackSortKey = "none" | "name" | "album" | "singer";

/** 下拉里的单个选项：value 是「维度-方向」拼出来的稳定标识，便于 select 直接绑定 */
export interface TrackSortOption {
  value: string;
  label: string;
  key: TrackSortKey;
  desc: boolean;
}

/**
 * 七个选项，顺序与 uniappx 的排序抽屉一致：
 * 默认顺序 → 按歌曲名（正/倒）→ 按专辑名（正/倒）→ 按歌手名（正/倒）。
 */
export const TRACK_SORT_OPTIONS: readonly TrackSortOption[] = [
  { value: "none", label: "默认顺序", key: "none", desc: false },
  { value: "name-asc", label: "按歌曲名 · 正序", key: "name", desc: false },
  { value: "name-desc", label: "按歌曲名 · 倒序", key: "name", desc: true },
  { value: "album-asc", label: "按专辑名 · 正序", key: "album", desc: false },
  { value: "album-desc", label: "按专辑名 · 倒序", key: "album", desc: true },
  { value: "singer-asc", label: "按歌手名 · 正序", key: "singer", desc: false },
  { value: "singer-desc", label: "按歌手名 · 倒序", key: "singer", desc: true },
];

/** 「默认顺序」在 select 里的值：页面初值也用它 */
export const DEFAULT_TRACK_SORT = "none";

/** 两个弹窗的维度选项（顺序与 uniappx 的排序抽屉一致；不含「默认顺序」） */
export const TRACK_SORT_FIELDS: readonly {
  key: Exclude<TrackSortKey, "none">;
  label: string;
}[] = [
  { key: "name", label: "按歌曲名" },
  { key: "album", label: "按专辑名" },
  { key: "singer", label: "按歌手名" },
];

/** 两个弹窗的方向选项（正序在前，与 uniappx 一致） */
export const TRACK_SORT_DIRECTIONS: readonly {
  value: "asc" | "desc";
  label: string;
  desc: boolean;
}[] = [
  { value: "asc", label: "正序", desc: false },
  { value: "desc", label: "倒序", desc: true },
];

/**
 * 维度 + 方向 → 编码值（如 `album-desc`）。
 *
 * `key === "none"` 固定回 `DEFAULT_TRACK_SORT`：没有维度就没有方向，
 * 避免出现 `none-desc` 这种半截值。页面仍然只存一个字符串，所以现有的
 * `useState(DEFAULT_TRACK_SORT)` / `parseTrackSort` 调用方零改动。
 */
export function trackSortValue(key: TrackSortKey, desc = false): string {
  if (key === "none") return DEFAULT_TRACK_SORT;
  return `${key}-${desc ? "desc" : "asc"}`;
}

/** 把 select 的值解析回（维度, 方向）；未知值按「默认顺序」处理，不抛错 */
export function parseTrackSort(value?: string | null): { key: TrackSortKey; desc: boolean } {
  const option = TRACK_SORT_OPTIONS.find((item) => item.value === value);
  return option ? { key: option.key, desc: option.desc } : { key: "none", desc: false };
}

/** 参与排序的最小曲目形状：title / singer / album 三个字段一定有（Track 与本地曲目都满足） */
interface SortableTrack {
  title: string;
  singer: string;
  album: string;
}

/**
 * 排序曲目，返回新数组（不改入参）。
 *
 * 比较规则：
 * - 用 `localeCompare(..., "zh-Hans-CN")`，中文按拼音、拉丁字母按字母序 —— 与本地曲库页一致；
 * - 同维度并列时再比另一列（专辑名 → 歌曲名 → 歌手名），避免「同名专辑里顺序随机」；
 * - 仍然并列就保持音源给的原始顺序（用原始下标做兜底，稳定排序）。
 *
 * `none` 或不认识的维度直接返回入参的浅拷贝，调用方可以无脑替换原列表。
 */
export function sortTracks<T extends SortableTrack>(
  tracks: readonly T[],
  key: TrackSortKey,
  desc = false,
): T[] {
  if (key === "none" || tracks.length < 2) return [...tracks];

  const compareText = (a: string, b: string): number => a.localeCompare(b, "zh-Hans-CN");

  // Schwartian transform：每首歌的三列归一化串只算一次（原先在比较器里现算，
  // 同一首歌会被重复归一化 ~log N 次，归一化含 3 个正则 + toLowerCase，是热路径）。
  // 原始下标一并带上：既用于并列时的稳定兜底，也方便调试时看出顺序来源。
  const decorated = tracks.map((track, index) => ({
    track,
    index,
    title: normText(track.title),
    singer: normText(track.singer),
    album: normText(track.album),
  }));
  const direction = desc ? -1 : 1;

  decorated.sort((a, b) => {
    let result: number;
    switch (key) {
      case "singer":
        result =
          compareText(a.singer, b.singer) ||
          compareText(a.album, b.album) ||
          compareText(a.title, b.title);
        break;
      case "album":
        result =
          compareText(a.album, b.album) ||
          compareText(a.title, b.title) ||
          compareText(a.singer, b.singer);
        break;
      default:
        result =
          compareText(a.title, b.title) ||
          compareText(a.singer, b.singer) ||
          compareText(a.album, b.album);
    }
    return result !== 0 ? direction * result : a.index - b.index;
  });

  return decorated.map((item) => item.track);
}

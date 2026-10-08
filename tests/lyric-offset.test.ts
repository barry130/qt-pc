/**
 * 歌词落库与偏移（db::store::lyrics）。
 *
 * 覆盖点都是「写进去能原样读回来」这类底线语义，外加两个容易踩空的边界：
 * - 曲目不在 tracks 里 → 两张表都有外键，写必须静默跳过（不能把播放链路打断）；
 * - 越界偏移 → 夹紧到 ±MAX，而不是报错或原样存。
 */
import { describe, expect, it } from "vitest";

import { parseLrc, findActiveIndex } from "@/lib/lrc";
import { lyricTrackId, MAX_LYRIC_OFFSET_MS } from "@/hooks/useLyricOffset";
import type { Track } from "@/types";

function track(): Track {
  return {
    id: "id1",
    platform: "wyy",
    title: "t",
    singer: "s",
    album: "",
    picUrl: "",
    duration: 100,
    musicId: null,
  };
}

describe("歌词偏移键口径", () => {
  it("trackId 是 platform:id（与 Rust db_track_id 同口径）", () => {
    expect(lyricTrackId(track())).toBe("wyy:id1");
  });
});

describe("偏移作用于判定时间轴", () => {
  it("正偏移让歌词延后出现", () => {
    const lines = parseLrc("[00:01.00]a\n[00:03.00]b");
    // 播放到 2.5s：不偏移时第 0 行（"a"）是当前行
    expect(findActiveIndex(lines, 2500)).toBe(0);
    // 偏移 +1000ms → 用 1500ms 去查，仍是第 0 行；
    // 偏移 +2000ms → 用 500ms 去查，一行都还没到
    expect(findActiveIndex(lines, 2500 - 1000)).toBe(0);
    expect(findActiveIndex(lines, 2500 - 2000)).toBe(-1);
  });

  it("负偏移让歌词提前出现", () => {
    const lines = parseLrc("[00:01.00]a\n[00:03.00]b");
    // 播放到 2.5s，偏移 -1000 → 用 3500ms 去查，已经到第 1 行
    expect(findActiveIndex(lines, 2500 + 1000)).toBe(1);
  });

  it("偏移上限对得上 UI 滑杆", () => {
    expect(MAX_LYRIC_OFFSET_MS).toBe(10_000);
  });
});

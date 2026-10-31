/**
 * 取链命中线路的记忆（`src/source-scripts/playurl-line.ts`）。
 *
 * 守的契约是「换了源，歌词也要跟着换」这条链路的地基：
 * 1. `rememberPlayUrlLine` 除了展示文本，还必须留下**原始结构**（含 targetSong）——
 *    只有原始结构才知道跨源兜底命中的是目标源的**哪一首**，取词要靠它；
 *    曾经漏写这一份，`playUrlHitLine` 恒为 null，整条「歌词跟随换源」就是死代码。
 * 2. 降档命中时（实际出链档位 ≠ 请求档），线路记忆要镜像到请求档，
 *    否则播放页按 `state.quality` 永远查不到。
 * 3. 镜像只复制原始结构，不复制展示文本（不让 320k 的线路冒认成无损那条）。
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  clearPlayUrlLines,
  mirrorPlayUrlLine,
  playUrlHitLine,
  playUrlLine,
  playUrlLineKey,
  rememberPlayUrlLine,
} from "@/source-scripts/playurl-line";
import type { PlayUrlLine } from "@/source-engine/client";
import type { Quality, Track } from "@/types";

const track: Track = {
  platform: "kw",
  id: "228908",
  title: "测试曲目",
  singer: "测试歌手",
} as Track;

const line: PlayUrlLine = {
  id: "cross:tx=003abc",
  name: "tx",
  kind: "cross",
  targetSong: {
    id: "003abc",
    name: "测试曲目",
    singer: "测试歌手",
    album: "测试专辑",
    picUrl: "",
    interval: 215,
  },
};

beforeEach(() => {
  clearPlayUrlLines();
});

describe("rememberPlayUrlLine", () => {
  it("记下展示文本，也记下含 targetSong 的原始结构", () => {
    rememberPlayUrlLine(track, "320" as Quality, line);
    expect(playUrlLine(track, "320" as Quality)).toContain("cross:tx=003abc");
    const raw = playUrlHitLine(track, "320" as Quality);
    expect(raw).not.toBeNull();
    expect(raw?.targetSong?.id).toBe("003abc");
  });

  it("line 为 null 时保持原值不动", () => {
    rememberPlayUrlLine(track, "320" as Quality, line);
    rememberPlayUrlLine(track, "320" as Quality, null);
    expect(playUrlHitLine(track, "320" as Quality)?.id).toBe("cross:tx=003abc");
  });

  it("不同音质各记一份，互不串味", () => {
    rememberPlayUrlLine(track, "128" as Quality, line);
    expect(playUrlHitLine(track, "320" as Quality)).toBeNull();
    expect(playUrlLineKey(track, "128" as Quality)).toBe("kw:228908:128");
  });
});

describe("mirrorPlayUrlLine", () => {
  it("把实际出链档位的原始结构镜像到请求档（降档播放时歌词仍能跟随换源）", () => {
    rememberPlayUrlLine(track, "128" as Quality, line);
    expect(playUrlHitLine(track, "320" as Quality)).toBeNull();
    mirrorPlayUrlLine(track, "128" as Quality, "320" as Quality);
    expect(playUrlHitLine(track, "320" as Quality)?.targetSong?.id).toBe("003abc");
  });

  it("不镜像展示文本：320k 的线路不会冒认成无损那条", () => {
    rememberPlayUrlLine(track, "128" as Quality, line);
    mirrorPlayUrlLine(track, "128" as Quality, "320" as Quality);
    expect(playUrlLine(track, "320" as Quality)).toBe("");
    expect(playUrlLine(track, "128" as Quality)).toContain("cross:tx=003abc");
  });

  it("源档位没有记忆时镜像什么也不做（不写 entry，不让空值占位）", () => {
    mirrorPlayUrlLine(track, "128" as Quality, "320" as Quality);
    expect(playUrlHitLine(track, "320" as Quality)).toBeNull();
  });

  it("同档位镜像直接跳过", () => {
    rememberPlayUrlLine(track, "320" as Quality, line);
    mirrorPlayUrlLine(track, "320" as Quality, "320" as Quality);
    expect(playUrlHitLine(track, "320" as Quality)?.id).toBe("cross:tx=003abc");
  });
});

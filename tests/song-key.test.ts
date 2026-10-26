import { describe, expect, it } from "vitest";
import type { Track } from "@/types";
import { normText, songKey } from "@/lib/song-key";

/**
 * 跨源判重键（`songKey`）与归一化口径。
 *
 * 这组用例原本在 `tests/aggregate-merge.test.ts`：2026-10-24 聚合合并下沉数据包后，
 * app 侧只留下搜索页跨页去重需要的 `songKey`，所以把这两段搬过来继续锁行为。
 * 归一化规则必须与数据包 `qt-sources/src/actions/merge-search.ts` 的判重键一致。
 */

// ---------- 夹具 ----------

function track(id: string, title: string, singer: string, extra: Partial<Track> = {}): Track {
  return {
    id,
    platform: extra.platform ?? "wyy",
    title,
    singer,
    album: extra.album ?? "",
    picUrl: extra.picUrl ?? "http://cover/x.jpg",
    duration: extra.duration ?? 240,
    ...extra,
  };
}

// ---------- normText ----------

describe("normText：各平台写法差异要归一掉，同一首歌才会撞成同一个键", () => {
  it("去掉成对括号整段（Live/Remix/片段 不是歌名本体）", () => {
    expect(normText("晴天 (Live)")).toBe("晴天");
    expect(normText("晴天（Live）")).toBe("晴天");
    expect(normText("晴天 [Live]")).toBe("晴天");
    expect(normText("晴天【Live】")).toBe("晴天");
  });

  it("嵌套括号：内层也一起丢掉，不留半截括号", () => {
    // 正则 `[（(][^）)]*[）)]` 只能吃掉内层，会留下 "晴天（live）" 这种半截
    expect(normText("晴天（Live（现场版））")).toBe("晴天");
    expect(normText("晴天 (Live (Remastered))")).toBe("晴天");
    // 三层
    expect(normText("A（B（C（D）））")).toBe("a");
  });

  it("括号不闭合时一路丢到结尾，而不是留下半个括号段", () => {
    expect(normText("晴天（Live")).toBe("晴天");
  });

  it("全角空格当空白处理（U+3000 不在 \\s 里，容易漏）", () => {
    expect(normText("告 白\u3000气 球")).toBe("告白气球");
  });

  it("去掉标点：顿号/间隔号/连接符/引号/中英标点都算", () => {
    expect(normText("Don't Stop")).toBe("dontstop");
    expect(normText("A·B")).toBe("ab");
    expect(normText("A - B")).toBe("ab");
    expect(normText("《晴天》")).toBe("晴天");
    expect(normText("周杰伦、温岚")).toBe("周杰伦温岚");
  });

  it("大小写归一", () => {
    expect(normText("Hello World")).toBe("helloworld");
    expect(normText("HELLO")).toBe(normText("hello"));
  });

  it("空值/undefined/null 都当空串，不抛错", () => {
    expect(normText()).toBe("");
    expect(normText(null)).toBe("");
    expect(normText("")).toBe("");
    expect(normText("（纯括号）")).toBe("");
  });
});

// ---------- songKey ----------

describe("songKey：同一首歌跨源必须算出同一个键", () => {
  it("歌手顺序不同要相等（各平台排列顺序不一样）", () => {
    const a = track("1", "屋顶", "周杰伦/温岚");
    const b = track("2", "屋顶", "温岚/周杰伦", { platform: "qq" });
    expect(songKey(a)).toBe(songKey(b));
  });

  it("歌手分隔符不同要相等（、 , & 空格 都当分隔）", () => {
    const base = songKey(track("1", "屋顶", "周杰伦/温岚"));
    expect(songKey(track("2", "屋顶", "周杰伦、温岚"))).toBe(base);
    expect(songKey(track("3", "屋顶", "周杰伦 & 温岚"))).toBe(base);
    expect(songKey(track("4", "屋顶", "周杰伦 温岚"))).toBe(base);
  });

  it("歌手不同则不相等（不能把不同歌手的同名歌合并）", () => {
    const a = track("1", "晴天", "周杰伦");
    const b = track("2", "晴天", "翻唱歌手");
    expect(songKey(a)).not.toBe(songKey(b));
  });

  it("标题里的版本括号不影响键：晴天 与 晴天(Live) 同键", () => {
    expect(songKey(track("1", "晴天", "周杰伦"))).toBe(
      songKey(track("2", "晴天 (Live)", "周杰伦")),
    );
  });

  it("标题为空时退回 platform:id，不能把所有无标题曲目并成一条", () => {
    const a = track("1", "", "周杰伦");
    const b = track("2", "", "周杰伦");
    expect(songKey(a)).toBe("wyy:1");
    expect(songKey(b)).toBe("wyy:2");
    expect(songKey(a)).not.toBe(songKey(b));
  });

  it("平台不同 + 标题为空 → 键也不同", () => {
    const a = track("1", "", "周杰伦");
    const b = track("1", "", "周杰伦", { platform: "qq" });
    expect(songKey(a)).not.toBe(songKey(b));
  });
});

import { describe, expect, it } from "vitest";
import {
  findActiveIndex,
  formatTime,
  karaokeFillRatio,
  mergeTranslation,
  parseLrc,
  parseWordByWordLrc,
  qtresCoverUrl,
  type LyricLine,
} from "@/lib/lrc";

describe("parseLrc", () => {
  it("解析常规 LRC 并按时间排序", () => {
    const lrc = `[ti:测试]
[00:02.50]第二行
[00:01.00]第一行
[00:10]末行`;
    const lines = parseLrc(lrc);
    expect(lines.map((l) => l.timeMs)).toEqual([1000, 2500, 10000]);
    expect(lines[0].text).toBe("第一行");
    expect(lines[2].text).toBe("末行");
  });

  it("忽略元数据标签与空行", () => {
    const lines = parseLrc(`[ar:x]
[al:y]
[by:z]

[00:03.200]正文`);
    expect(lines).toHaveLength(1);
    expect(lines[0].timeMs).toBe(3200);
  });

  it("同一时间多 tag 合并为一行", () => {
    const lines = parseLrc("[00:05.00]a\n[00:05.00]b");
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("a");
  });

  it("空输入返回空数组", () => {
    expect(parseLrc("")).toEqual([]);
    expect(parseLrc("无标签文本")).toEqual([]);
  });
});

describe("mergeTranslation", () => {
  it("按时间戳就近合并翻译", () => {
    const main = parseLrc("[00:01.00]hello\n[00:05.00]world");
    const merged = mergeTranslation(main, "[00:01.10]你好\n[00:05.20]世界");
    expect(merged[0].translation).toBe("你好");
    expect(merged[1].translation).toBe("世界");
  });

  it("超出 500ms 不合并", () => {
    const main = parseLrc("[00:01.00]hello");
    const merged = mergeTranslation(main, "[00:02.00]你好");
    expect(merged[0].translation).toBeUndefined();
  });

  it("翻译为空时原样返回", () => {
    const main = parseLrc("[00:01.00]hello");
    expect(mergeTranslation(main, "")).toBe(main);
  });
});

describe("findActiveIndex", () => {
  const lines = parseLrc("[00:01.00]a\n[00:03.00]b\n[00:05.00]c");
  it("命中区间返回对应下标", () => {
    expect(findActiveIndex(lines, 0)).toBe(-1);
    expect(findActiveIndex(lines, 1000)).toBe(0);
    expect(findActiveIndex(lines, 3500)).toBe(1);
    expect(findActiveIndex(lines, 9999)).toBe(2);
  });
  it("空歌词返回 -1", () => {
    expect(findActiveIndex([], 1000)).toBe(-1);
  });
});

describe("formatTime", () => {
  it("格式化为 m:ss", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(61_500)).toBe("1:01");
    expect(formatTime(-5)).toBe("0:00");
  });
});

describe("parseWordByWordLrc 词时间轴口径归一", () => {
  // 包侧归一到同一行内格式，但各源沿用自己的时间戳口径：
  // qq（QRC）给的是行内绝对时间（首词起点 ≈ 行起点），kg（KRC）给的是相对值（首词 0）。
  // 上层卡拉 OK 染色只认「相对行首」，解析出口必须折算——否则整行/整词恒判为
  // 「还没开唱」，当前行会一直显示成非高亮色（桌面歌词白色、播放页发暗）。
  it("绝对时间（qq QRC）：首词折算到 0，末词仍在时长内", () => {
    const lines = parseWordByWordLrc(
      "[9330,672]你(9330,224)好(9554,224)世(9778,224)",
    );
    expect(lines[0].timeMs).toBe(9330);
    expect(lines[0].words?.map((w) => w.startMs)).toEqual([0, 224, 448]);
    // 折算后进度就从行首开始推进（修复前整行恒为 0）：第二个词唱一半 → (1+0.5)/3
    expect(karaokeFillRatio(lines[0], 336)).toBeCloseTo(0.5, 5);
  });

  it("相对时间（kg KRC）：原样保留", () => {
    const lines = parseWordByWordLrc("[3485,2982]你(0,224)好(224,224)世(448,224)");
    expect(lines[0].words?.map((w) => w.startMs)).toEqual([0, 224, 448]);
  });

  it("两套误差相等（开场行 timeMs=0）按契约保持相对", () => {
    const lines = parseWordByWordLrc("[0,1000]你(0,224)好(224,224)世(448,224)");
    expect(lines[0].words?.map((w) => w.startMs)).toEqual([0, 224, 448]);
  });

  it("行文本由词拼接而来，归一不影响文本", () => {
    const lines = parseWordByWordLrc("[9330,672]你(9330,224)好(9554,224)");
    expect(lines[0].text).toBe("你好");
  });
});

describe("karaokeFillRatio", () => {
  // 「你(0,200) 好(200,300) 世(600,300) 界(900,300)」：总字符 4，词三与词四之间有 100ms gap
  const lines = parseWordByWordLrc(
    "[1000,1200]你(0,200)好(200,300)世(600,300)界(900,300)",
  );
  const line: LyricLine = lines[0];

  it("无 words 或空词整行高亮 / 行未开唱整行暗", () => {
    expect(karaokeFillRatio({ timeMs: 0, text: "x" }, 100)).toBe(1);
    expect(karaokeFillRatio(line, -50)).toBe(0);
  });

  it("词内进度按字符占比折算（词一唱一半 → 0.5 字符 / 4 字符 = 0.125）", () => {
    expect(karaokeFillRatio(line, 100)).toBe(0.125);
  });

  it("唱完的词整词计入；词间 gap 填充停在词尾不动", () => {
    expect(karaokeFillRatio(line, 500)).toBe(0.5); // 你+好 唱完，gap(500~600) 内停在 2/4
    expect(karaokeFillRatio(line, 750)).toBe(0.625); // 世 唱到一半：(2+0.5)/4
  });

  it("超出最后一个词 → 1；比例始终夹在 0~1", () => {
    expect(karaokeFillRatio(line, 5000)).toBe(1);
    expect(karaokeFillRatio(line, 99999)).toBe(1);
  });
});

describe("qtresCoverUrl", () => {
  it("http 图片转换为 qtres base64url（遵循 Tauri v2 协议地址约定）", () => {
    const url = qtresCoverUrl("https://p1.music.126.net/abc==") as string;
    // Windows 产物为 http://qtres.localhost/cover/<b64>，其余为 qtres://localhost/cover/<b64>
    const m = /^(?:qtres:\/\/localhost|http:\/\/qtres\.localhost)(\/cover\/.+)$/.exec(
      url,
    );
    expect(m).not.toBeNull();
    const b64 = (m as RegExpExecArray)[1].slice("/cover/".length);
    expect(b64).not.toContain("+");
    expect(b64).not.toContain("/");
    expect(b64).not.toContain("=");
    // base64url 解码回原 URL
    expect(atob(b64.replace(/-/g, "+").replace(/_/g, "/"))).toBe(
      "https://p1.music.126.net/abc==",
    );
  });
  it("非 http 地址返回 null", () => {
    expect(qtresCoverUrl("")).toBeNull();
    expect(qtresCoverUrl("file:///x.png")).toBeNull();
  });
});

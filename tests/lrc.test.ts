import { describe, expect, it } from "vitest";
import {
  findActiveIndex,
  formatTime,
  karaokeFillRatio,
  mergeTranslation,
  parseLrc,
  parseWordByWordLrc,
  qtresCoverUrl,
  qtresImageSrc,
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

  it("绝对时间但末词远早于行尾（QRC 行尾留白）：仍按绝对折算", () => {
    // 真实线上行（qq 曲尽陈情 [152417,6401]）：首词贴行起点，末词终点 158001
    // 距 timeMs+durationMs=158818 差 817ms —— 旧口径的 400ms 上限把它判成相对，
    // 词起点留成绝对毫秒，整行恒 0% 染色（这就是「同一首歌有的行能逐字有的不行」）。
    const lines = parseWordByWordLrc(
      "[152417,6401]无(152417,456)端(152873,368)瞬(156977,1024)",
    );
    expect(lines[0].words?.map((w) => w.startMs)).toEqual([0, 456, 4560]);
    // 折算后逐字染色才推得动：行内 500ms 处 → 首词唱完
    expect(karaokeFillRatio(lines[0], 500)).toBeGreaterThan(0);
  });

  it("相对时间但末词远超时长：不误判成绝对（只认首词锚点）", () => {
    // kg 形态：首词 0，末词终点超出 durationMs 也仍保持相对
    const lines = parseWordByWordLrc("[3485,500]你(0,224)好(224,9000)");
    expect(lines[0].words?.map((w) => w.startMs)).toEqual([0, 224]);
  });

  it("行时长为 0：照样能折算（时长已不参与判定）", () => {
    // 真实线上行（qq [57681,0]…）：旧实现把 durationMs 当判据，为 0 就整行跳过归一
    const lines = parseWordByWordLrc("[57681,0]无(57681,456)端(58137,368)");
    expect(lines[0].words?.map((w) => w.startMs)).toEqual([0, 456]);
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

describe("qtresImageSrc", () => {
  it("上游 http(s) 地址走 qtres 代理（CSP 只放开 qtres，直连 <img> 会被拦成破图）", () => {
    const url = "https://thirdqq.qlogo.cn/g?b=sdk&nk=123";
    expect(qtresImageSrc(url, 40)).toBe(qtresCoverUrl(url, 40));
    expect(qtresImageSrc(url, 40)).toMatch(/\?w=40$/);
  });

  it("内联图（data:/blob:）原样返回，不绕代理", () => {
    const data = "data:image/png;base64,AAAA";
    expect(qtresImageSrc(data)).toBe(data);
    expect(qtresImageSrc("blob:http://tauri.localhost/abc")).toBe(
      "blob:http://tauri.localhost/abc",
    );
  });

  it("空值与非 web 地址返回 null", () => {
    expect(qtresImageSrc("")).toBeNull();
    expect(qtresImageSrc(undefined)).toBeNull();
    expect(qtresImageSrc("file:///c:/x.png")).toBeNull();
  });
});

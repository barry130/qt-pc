import { describe, expect, it } from "vitest";
import {
  findActiveIndex,
  formatTime,
  mergeTranslation,
  parseLrc,
  qtresCoverUrl,
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

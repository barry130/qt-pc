/**
 * 本地音频格式展示规则测试（评审 F 项）。
 *
 * 关键契约：前端 LOSSLESS_FORMATS 必须是 Rust 扫描器 SUPPORTED_EXTS
 * （src-tauri/src/local.rs）的子集 —— Rust 是唯一裁决者，前端不能展示
 * 一个根本不会被扫描入库的「无损」格式（旧清单的 ape/alac/aiff 就是这么来的）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOSSLESS_FORMATS, isLosslessAudioFormat } from "@/lib/audio-format";

describe("isLosslessAudioFormat", () => {
  it("识别按无损口径展示的格式", () => {
    expect(isLosslessAudioFormat("flac")).toBe(true);
    expect(isLosslessAudioFormat("wav")).toBe(true);
    expect(isLosslessAudioFormat("FLAC")).toBe(true);
  });

  it("有损格式与本地库不支持的格式不算无损", () => {
    for (const fmt of ["mp3", "ogg", "m4a", "aac", "ape", "alac", "aiff", ""]) {
      expect(isLosslessAudioFormat(fmt), `${fmt} 不应算无损`).toBe(false);
    }
  });

  it("缺失 format 字段的曲目按非无损处理（在线曲目 / 元数据缺失）", () => {
    expect(isLosslessAudioFormat(null)).toBe(false);
    expect(isLosslessAudioFormat(undefined)).toBe(false);
  });
});

describe("LOSSLESS_FORMATS 与 Rust 扫描器支持表的一致性", () => {
  it("无损清单是 Rust SUPPORTED_EXTS 的子集", () => {
    const rust = readFileSync(join(process.cwd(), "src-tauri", "src", "local.rs"), "utf8");
    const m = rust.match(/SUPPORTED_EXTS:\s*\[&str;\s*\d+\]\s*=\s*\[([^\]]*)\]/);
    expect(m, "local.rs 应仍声明 SUPPORTED_EXTS 常量").toBeTruthy();
    const supported = new Set(
      m![1]
        .split(",")
        .map((s) => s.trim().replace(/^"|"$/g, ""))
        .filter(Boolean),
    );
    expect(supported.size).toBeGreaterThan(0);
    for (const fmt of LOSSLESS_FORMATS) {
      expect(supported.has(fmt), `前端判无损的 ${fmt} 必须在 Rust 支持表里`).toBe(true);
    }
  });
});

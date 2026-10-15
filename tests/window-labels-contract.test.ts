/**
 * 窗口 label 跨端契约护栏（评审 R6）。
 *
 * 窗口 label 是 Tauri 前后端之间仅靠字面量对齐的隐式契约：前端散写
 * "main" / "lyrics" / "source-engine"、Rust 侧另有常量，任何一端改名
 * 另一端不会编译失败、只会在运行时找不到窗口（静默失效）。这里把 TS
 * 常量（src/lib/window-labels.ts）与 Rust 常量、tauri.conf.json 钉在
 * 一起 —— 任何一侧漂移直接测试失败。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LYRICS_WINDOW_LABEL,
  MAIN_WINDOW_LABEL,
  SOURCE_ENGINE_WINDOW_LABEL,
} from "@/lib/window-labels";

const read = (rel: string): string =>
  readFileSync(join(process.cwd(), rel), "utf8");

/** 递归收集 src/ 下全部 .ts/.tsx 文件（回归检查用） */
function collectSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectSources(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("窗口 label 跨端契约", () => {
  it("TS 常量与 Rust 侧常量逐字一致", () => {
    expect(read("src-tauri/src/lib.rs")).toContain(
      `pub const MAIN_WINDOW_LABEL: &str = "${MAIN_WINDOW_LABEL}";`,
    );
    expect(read("src-tauri/src/lyric_window.rs")).toContain(
      `pub const LYRIC_WINDOW_LABEL: &str = "${LYRICS_WINDOW_LABEL}";`,
    );
    expect(read("src-tauri/src/source_window.rs")).toContain(
      `pub const SOURCE_ENGINE_LABEL: &str = "${SOURCE_ENGINE_WINDOW_LABEL}";`,
    );
  });

  it("主窗口 label 与 tauri.conf.json 声明一致（歌词窗/引擎窗动态创建，不进 conf）", () => {
    const conf = JSON.parse(read("src-tauri/tauri.conf.json")) as {
      app: { windows: { label: string }[] };
    };
    expect(conf.app.windows[0].label).toBe(MAIN_WINDOW_LABEL);
  });

  it("前端不再散写窗口 label 字面量（比较点一律走常量）", () => {
    // 标签比较与 emitTo 的典型形态；注释里的文字不受影响
    const banned = [
      /\.label\s*===\s*"main"/,
      /\.label\s*!==\s*"main"/,
      /\.label\s*===\s*"lyrics"/,
      /\.label\s*!==\s*"lyrics"/,
      /emitTo\(\s*"source-engine"/,
    ];
    for (const file of collectSources(join(process.cwd(), "src"))) {
      const text = readFileSync(file, "utf8");
      // 剥掉块注释与行注释，只查代码
      const code = text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const pattern of banned) {
        expect(pattern.test(code), `${file} 不应散写窗口 label 字面量`).toBe(false);
      }
    }
  });
});

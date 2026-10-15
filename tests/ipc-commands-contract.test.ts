/**
 * Tauri 命令名跨端契约护栏（评审 R6：前端 invoke 字符串与 Rust 命令名只靠字面量对齐）。
 *
 * 命令名漂移（Rust 改名 / 删命令、前端拼错）没有任何编译期症状，只会在运行时
 * 报 "unknown command"。这里机械抽取两端清单，断言前端 src/ 里用到的每个命令名
 * Rust 侧都有定义 —— 任何一侧漂移直接测试失败。
 *
 * 反方向不查：音源引擎页（qtres 资源，不在 src/）也会调用命令，且 Rust 允许
 * 存在暂未接线的新命令。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** 递归收集目录下全部指定扩展名的文件 */
function collectFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectFiles(full, exts));
    } else if (exts.some((e) => entry.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

/** 前端 src/ 里所有 invoke("...") 的命令名字面量 */
function frontendCommandNames(): Set<string> {
  const names = new Set<string>();
  for (const file of collectFiles(join(process.cwd(), "src"), [".ts", ".tsx"])) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/invoke(?:<[^>]*>)?\(\s*"([a-zA-Z_]+)"/g)) {
      names.add(m[1]);
    }
  }
  return names;
}

/** Rust 侧定义的命令名：rename="x" 用 x；无 rename 的命令名 = 函数名 */
function rustCommandNames(): Set<string> {
  const names = new Set<string>();
  const files = collectFiles(join(process.cwd(), "src-tauri", "src"), [".rs"]);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(
      /#\[tauri::command\(rename\s*=\s*"([a-zA-Z_]+)"\)\]/g,
    )) {
      names.add(m[1]);
    }
    for (const m of text.matchAll(
      /#\[tauri::command\]\s*(?:#\[[^\]]*\]\s*)*(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z_]+)/g,
    )) {
      names.add(m[1]);
    }
  }
  return names;
}

describe("Tauri 命令名跨端契约", () => {
  it("前端用到的每个命令名 Rust 侧都有定义", () => {
    const rust = rustCommandNames();
    const missing = [...frontendCommandNames()].filter((n) => !rust.has(n));
    expect(missing, "前端 invoke 了 Rust 未定义的命令").toEqual([]);
  });

  it("抽取器没有失明：两端清单规模符合预期", () => {
    // 规模断言是抽取器自身的哨兵：一旦代码形态变化导致正则失明，
    // 这里先失败，避免上面的子集检查退化成恒真
    expect(frontendCommandNames().size).toBeGreaterThan(100);
    expect(rustCommandNames().size).toBeGreaterThan(150);
  });
});

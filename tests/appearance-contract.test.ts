/**
 * 外观默认值跨端契约护栏（评审 R 项）。
 *
 * Rust `default_appearance()`（commands.rs）与前端 `DEFAULT_APPEARANCE`
 * （src/types/index.ts）必须同键同值：历史上 Rust 漏了 customColor / bgImage
 * 两键、前端靠 `??` 兜底掩盖了漂移 —— 用户清空配置后 Rust 侧的残缺默认值
 * 会直接生效。任何一侧加字段或改默认值，这里直接失败。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE } from "@/types";

function rustDefaultAppearance(): Record<string, unknown> {
  const src = readFileSync(
    join(process.cwd(), "src-tauri", "src", "commands.rs"),
    "utf8",
  );
  const match = src.match(/fn default_appearance\(\)[\s\S]*?json!\((\{[\s\S]*?\})\)/);
  expect(match, "Rust 侧应仍存在 default_appearance() 且返回 json!({...})").toBeTruthy();
  // json! 宏体允许尾随逗号，JSON.parse 不允许：剥掉再解析
  const body = match![1].replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(body) as Record<string, unknown>;
}

describe("外观默认值跨端契约", () => {
  it("Rust default_appearance() 与前端 DEFAULT_APPEARANCE 同键同值", () => {
    expect(rustDefaultAppearance()).toEqual(DEFAULT_APPEARANCE);
  });

  it("七个字段一个都不能少（防任一侧加字段时忘掉另一侧）", () => {
    const rust = rustDefaultAppearance();
    expect(Object.keys(rust).sort()).toEqual(Object.keys(DEFAULT_APPEARANCE).sort());
  });
});

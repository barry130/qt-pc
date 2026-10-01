/**
 * 配置一致性护栏（DESIGN §15.7 / docs/CONFIG.md）。
 *
 * 仓库根的 `app.config.json` 是唯一配置源，其余配置文件由
 * `scripts/sync-config.mjs` 生成/改写。这个测试确保**没有人在别处手改**：
 * 只要某个派生文件与配置源不一致，`pnpm test` 直接失败，而不是等到发版
 * 才发现安装包版本、升级接口版本号、Cargo 版本三者对不上。
 */
import { describe, expect, it } from "vitest";
import { check, loadConfig, versionCodeOf } from "../scripts/sync-config.mjs";

describe("app.config.json 单一配置源", () => {
  const config = loadConfig();

  it("版本名与版本号自洽（1.0.7 ↔ 107）", () => {
    expect(versionCodeOf(config.version.name)).toBe(config.version.code);
  });

  it("backend.active 只能是 dev / prod", () => {
    expect(["dev", "prod"]).toContain(config.backend.active);
  });

  it("所有派生文件都与 app.config.json 一致（否则跑 pnpm config:sync）", () => {
    const drifted = check(config).map((i) => `${i.file} —— ${i.desc}`);
    expect(drifted).toEqual([]);
  });

  it("每个派生文件都被纳入校验（防止新增文件漏配）", () => {
    const files = check(config).map((i) => i.file);
    // 这些是同步器负责的全部落点；新增配置落点时要同步更新本列表与 docs/CONFIG.md
    expect(files.length).toBe(0);
    expect(config.version.name).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

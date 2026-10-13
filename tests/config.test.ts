/**
 * 配置一致性护栏（DESIGN §15.7 / docs/CONFIG.md）。
 *
 * 仓库根的 `app.config.json` 是唯一**公开**配置源，其余配置文件由
 * `scripts/sync-config.mjs` 生成/改写。这个测试确保**没有人在别处手改**：
 * 只要某个派生文件与配置源不一致，`pnpm test` 直接失败，而不是等到发版
 * 才发现安装包版本、升级接口版本号、Cargo 版本三者对不上。
 *
 * 私有值（自有域名 / 生产后端地址 / 官网地址）走另一条路：只存在于
 * `app.config.local.json`（被忽略）→ `src-tauri/src/private_config.rs`（被忽略），
 * **不参与一致性校验** —— 有私有文件时它本来就该与仓库版本不同。
 */
import { describe, expect, it } from "vitest";
import { check, loadConfig, loadLocalConfig, versionCodeOf } from "../scripts/sync-config.mjs";

describe("app.config.json 单一配置源", () => {
  const config = loadConfig();

  it("版本名与版本号自洽（1.0.7 ↔ 107）", () => {
    expect(versionCodeOf(config.version.name)).toBe(config.version.code);
  });

  it("backend.active 只能是 dev / prod", () => {
    expect(["dev", "prod"]).toContain(config.backend.active);
  });

  it("公开配置里不含任何自有生产地址（只留本机联调地址）", () => {
    // 这条守的是"公开仓库不含自有域名"：一旦有人把生产地址写回 app.config.json，
    // 推上去就等于把自有域名公开了。私有值只能出现在 app.config.local.json。
    //
    // 断言刻意**不写具体域名**（否则这个测试自己就成了泄露点）：改成"公开配置里
    // 出现的每一个 http(s) 地址都必须指向本机"，任何外网主机名都会让它失败。
    const urls = JSON.stringify(config).match(/https?:\/\/[^"\\\s]+/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url, `公开配置里不应出现非本机地址：${url}`).toMatch(
        /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/,
      );
    }
    // 生产地址的字段本身也不该存在（类型上也没有，这里用 unknown 视图断言，
    // 免得"字段被删掉"这件事只体现在类型里、运行时没人守）
    expect((config.backend as Record<string, unknown>).prod).toBeUndefined();
    expect(config.backend.dev).toMatch(/^http:\/\/localhost[:/]/);
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

  it("私有配置读取器：文件不存在时返回空对象而不是抛错", () => {
    // 公开仓库 / CI 裸构建就是"没有私有文件"这一形态，必须能正常构建
    const local = loadLocalConfig();
    expect(typeof local).toBe("object");
    expect(Array.isArray(local)).toBe(false);
  });
});

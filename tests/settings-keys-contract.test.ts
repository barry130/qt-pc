/**
 * settings 表键名跨端契约护栏（评审「六类隐式契约」中的 settings keys 类）。
 *
 * 键名是 Rust 与前端之间仅靠字面量对齐的隐式契约：前端经 get_setting /
 * set_setting 泛型命令直接传键字符串，任何一端拼错/改名另一端不会编译失败，
 * 只会运行时静默读写不到。Rust 侧已收敛到 src-tauri/src/settings_keys.rs
 * （自有权重的键常量留在原模块），前端侧常量在 src/lib/storageKeys.ts。
 * 这里把两端钉在一起：任何一侧漂移直接测试失败。
 *
 * 注意：auth.ts 里 like.* 三个键**刻意**用字面量（启动早期同步引用未初始化
 * 完的模块常量会掩盖真正的错误，见该文件注释），不强改成常量 —— 这里只对值。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CACHE_AUDIO_LIMIT_MB_KEY, GAPLESS_KEY, QUALITY_KEY } from "@/lib/storageKeys";

const read = (rel: string): string =>
  readFileSync(join(process.cwd(), rel), "utf8");

/** 解析 Rust 源码里的键常量表：`pub const SETTING_X: &str = "value";` */
function rustConsts(rel: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of read(rel).matchAll(
    /pub(?:\(crate\))? const ([A-Z0-9_]+): &str = "([^"]*)";/g,
  )) {
    out[m[1]] = m[2];
  }
  return out;
}

/** 递归收集 src/ 下全部 .ts/.tsx 文件（散写字面量回归检查用） */
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

describe("settings 键名跨端契约", () => {
  const keys = rustConsts("src-tauri/src/settings_keys.rs");

  it("集中常量模块收录了评审点名的散写键（防常量被清空后测试恒真）", () => {
    const required = [
      "SETTING_APPEARANCE",
      "SETTING_QUALITY",
      "SETTING_OUTPUT_DEVICE",
      "SETTING_QUEUE_INDEX",
      "SETTING_POSITION_MS",
      "SETTING_PLAY_MODE",
      "SETTING_VOLUME",
      "SETTING_MUTED",
      "SETTING_LIKE_SYNC_SEQ",
      "SETTING_LIKE_IMPORTED",
      "SETTING_LYRIC_WINDOW",
      "SETTING_SHORTCUTS",
      "SETTING_DOWNLOAD_NAME_FORMAT",
    ];
    for (const name of required) {
      expect(keys[name], `settings_keys.rs 应定义 ${name}`).toBeDefined();
    }
    expect(Object.keys(keys).length).toBeGreaterThanOrEqual(required.length);
  });

  it("前端常量与 Rust 常量同值（quality / cache.audioLimitMb）", () => {
    expect(keys.SETTING_QUALITY).toBe(QUALITY_KEY);
    const cache = rustConsts("src-tauri/src/cache.rs");
    expect(cache.SETTING_AUDIO_CACHE_LIMIT_MB).toBe(CACHE_AUDIO_LIMIT_MB_KEY);
    const engine = rustConsts("src-tauri/src/audio/engine.rs");
    expect(engine.SETTING_GAPLESS).toBe(GAPLESS_KEY);
  });

  it("auth.ts 的 like.* 字面量与 Rust 常量一致（该处刻意用字面量，只对值）", () => {
    const auth = read("src/stores/auth.ts");
    const used = [
      ...new Set(
        [...auth.matchAll(/(?:get|set)Setting\(\s*"(like\.[^"]*)"/g)].map(
          (m) => m[1],
        ),
      ),
    ].sort();
    // like.lastError 是前端独有键（Rust 不读），其余必须与常量表同值
    expect(used).toEqual(
      [keys.SETTING_LIKE_SYNC_SEQ, keys.SETTING_LIKE_IMPORTED, "like.lastError"].sort(),
    );
  });

  it("已收敛成常量的键不再在 src/ 散写字面量", () => {
    const banned = [
      /getSetting\(\s*"quality"\s*\)/,
      /setSetting\(\s*"quality"\s*,/,
      /getSetting\(\s*"cache\.audioLimitMb"\s*\)/,
      /setSetting\(\s*"cache\.audioLimitMb"\s*,/,
      /getSetting\(\s*"app\.lastError"\s*\)/,
      /setSetting\(\s*"app\.lastError"\s*,/,
    ];
    for (const file of collectSources(join(process.cwd(), "src"))) {
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const pattern of banned) {
        expect(
          pattern.test(code),
          `${file} 不应散写已收敛的 settings 键字面量`,
        ).toBe(false);
      }
    }
  });

  it("网络设置键名与代理模式值稳定（DB 持久化格式护栏，键不进前端常量表）", () => {
    // 网络设置走专用命令（get/set_net_config），前端不直接用 getSetting 传键，
    // 但键值与模式枚举是 settings 表里的持久化格式，改了会静默丢用户配置 —— 钉住。
    const net = rustConsts("src-tauri/src/net_config.rs");
    expect(net.SETTING_PROXY_MODE).toBe("network.proxyMode");
    expect(net.SETTING_PROXY_URL).toBe("network.proxyUrl");
    expect(net.SETTING_SOURCE_TIMEOUT_MS).toBe("network.sourceTimeoutMs");
    expect(net.PROXY_MODE_SYSTEM).toBe("system");
    expect(net.PROXY_MODE_NONE).toBe("none");
    expect(net.PROXY_MODE_CUSTOM).toBe("custom");
  });
});

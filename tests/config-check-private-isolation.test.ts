import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  publicFiles: new Map<string, string>(),
  files: new Map<string, string>(),
  privateAccess: [] as string[],
  writes: [] as string[],
  allowPrivate: false,
  key(file: unknown) {
    return String(file).replaceAll("\\", "/");
  },
}));

// The public repository inputs are allowed; every check-time filesystem call
// goes through this fixture. Never open either real private configuration file.
vi.mock("node:fs", async (importOriginal) => {
  type NodeFs = typeof import("node:fs");
  const actual = await importOriginal<NodeFs & { default: NodeFs }>();
  const { fileURLToPath } = await import("node:url");
  const { join } = await import("node:path");
  const root = fileURLToPath(new URL("../", import.meta.url));
  for (const file of [
    "app.config.json",
    "package.json",
    "src-tauri/tauri.conf.json",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
    "src/source-scripts/source-update.ts",
    "src-tauri/src/app_config.rs",
  ]) {
    const absolute = join(root, file);
    fixture.publicFiles.set(fixture.key(absolute), actual.default.readFileSync(absolute, "utf8"));
  }

  function accessible(file: unknown) {
    const key = fixture.key(file);
    const privateFile = key.endsWith("/app.config.local.json") ||
      key.endsWith("/src-tauri/src/private_config.rs");
    if (privateFile && !fixture.allowPrivate) {
      fixture.privateAccess.push(key);
      throw new Error("Public configuration check attempted private filesystem access");
    }
    return key;
  }

  return {
    ...actual,
    default: {
      ...actual.default,
      existsSync(file: unknown) {
        return fixture.files.has(accessible(file));
      },
      readFileSync(file: unknown) {
        const contents = fixture.files.get(accessible(file));
        if (contents === undefined) throw new Error("Missing configuration fixture");
        return contents;
      },
      statSync(file: unknown) {
        const contents = fixture.files.get(accessible(file));
        if (contents === undefined) throw new Error("Missing configuration fixture");
        return { mtimeMs: 1, size: Buffer.byteLength(contents) };
      },
      writeFileSync(file: unknown, contents: unknown) {
        const key = accessible(file);
        fixture.writes.push(key);
        fixture.files.set(key, String(contents));
      },
    },
  };
});

import { check, loadConfig } from "../scripts/sync-config.mjs";

beforeEach(() => {
  fixture.files = new Map(fixture.publicFiles);
  fixture.privateAccess.length = 0;
  fixture.writes.length = 0;
  fixture.allowPrivate = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("public configuration check filesystem boundary", () => {
  it("reports every public target's drift without inspecting either private file", () => {
    // check() returns drift only, not the target registry. Mutate all six public
    // inputs in memory so a forgotten target cannot pass on an empty result.
    const targets = [
      "package.json",
      "src-tauri/tauri.conf.json",
      "src-tauri/Cargo.toml",
      "src-tauri/Cargo.lock",
      "src/source-scripts/source-update.ts",
      "src-tauri/src/app_config.rs",
    ];
    for (const target of targets) {
      const file = [...fixture.files.keys()].find((key) => key.endsWith(`/${target}`))!;
      let contents = fixture.files.get(file)!;
      if (target.endsWith(".json")) {
        contents = contents.replace(/("version"\s*:\s*)"[^"]*"/, '$1"0.0.0"');
      } else if (target.endsWith("Cargo.toml")) {
        contents = contents.replace(/^version = "[^"]*"/m, 'version = "0.0.0"');
      } else if (target.endsWith("Cargo.lock")) {
        contents = contents.replace(/(name = "quietmusic"\s*\nversion = )"[^"]*"/, '$1"0.0.0"');
      } else if (target.endsWith("source-update.ts")) {
        contents = contents.replace(/HOST_API_VERSION\s*=\s*\d+/, "HOST_API_VERSION = 0");
      } else {
        contents += "\n// Public config drift fixture.\n";
      }
      fixture.files.set(file, contents);
    }

    expect(check(loadConfig()).map((item: { file: string }) => item.file)).toEqual(targets);
    expect(fixture.privateAccess).toEqual([]);
    expect(fixture.writes).toEqual([]);
  });

  it("keeps the actual --check entry point away from private configuration", async () => {
    const { fileURLToPath } = await import("node:url");
    const originalArgv = process.argv;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`Unexpected config check exit: ${String(code)}`);
    });
    vi.resetModules();
    try {
      process.argv = [originalArgv[0], fileURLToPath(new URL("../scripts/sync-config.mjs", import.meta.url)), "--check"];
      await import("../scripts/sync-config.mjs");
    } finally {
      process.argv = originalArgv;
    }

    expect(log).toHaveBeenCalledWith(expect.stringContaining("[config] 全部一致"));
    expect(exit).not.toHaveBeenCalled();
    expect(fixture.privateAccess).toEqual([]);
    expect(fixture.writes).toEqual([]);
  });
});

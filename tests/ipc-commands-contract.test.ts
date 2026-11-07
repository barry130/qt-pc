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
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

type SourceMetadata = {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};
type SourceEntry = SourceMetadata & { name: string };
type SourceFileSystem = {
  readdirSync(dir: string, options: { withFileTypes: true }): SourceEntry[];
  lstatSync(file: string): SourceMetadata;
  statSync(file: string): SourceMetadata;
  readFileSync(file: string, encoding: "utf8"): string;
};
type PublicSourceScanner = {
  files(dir: string, extensions: readonly string[], ignoredDirectories?: readonly string[]): string[];
  read(file: string): string;
};
type MotionViolation = {
  file: string;
  line: number;
  snippet: string;
  rule: string;
};

// A typed file-URL import keeps the shared seam in the four authorized files;
// loading the module does not scan the repository or invoke its CLI.
const scannerModule = new URL("../scripts/check-motion.mjs", import.meta.url).href;
const { createPublicSourceScanner, checkMotion } = await import(scannerModule) as {
  createPublicSourceScanner(root: string, fileSystem?: SourceFileSystem): PublicSourceScanner;
  checkMotion(root: string, fileSystem?: SourceFileSystem): MotionViolation[];
};
const sources = createPublicSourceScanner(process.cwd());

/** 前端 src/ 里所有 invoke("...") 的命令名字面量 */
function frontendCommandNames(): Set<string> {
  const names = new Set<string>();
  for (const file of sources.files(join(process.cwd(), "src"), [".ts", ".tsx"])) {
    const text = sources.read(file);
    for (const m of text.matchAll(/invoke(?:<[^>]*>)?\(\s*"([a-zA-Z_]+)"/g)) {
      names.add(m[1]);
    }
  }
  return names;
}

/** Rust 侧定义的命令名：rename="x" 用 x；无 rename 的命令名 = 函数名 */
function rustCommandNames(): Set<string> {
  const names = new Set<string>();
  const files = sources.files(join(process.cwd(), "src-tauri", "src"), [".rs"]);
  for (const file of files) {
    const text = sources.read(file);
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

type FixtureNode = {
  kind: "directory" | "file" | "link";
  direntKind?: "directory" | "file" | "link";
  text?: string;
  forbidden?: boolean;
};

function publicSourceFixture(entries: Record<string, FixtureNode>) {
  const root = join(process.cwd(), "__scanner_fixture__");
  const nodes = new Map<string, FixtureNode>([[root, { kind: "directory" }]]);
  for (const [relative, node] of Object.entries(entries)) {
    nodes.set(join(root, ...relative.split("/")), node);
  }
  const touches: { operation: string; file: string }[] = [];
  function touch(operation: string, file: string): FixtureNode {
    touches.push({ operation, file });
    const node = nodes.get(file);
    if (!node) throw new Error("Unknown fake public source path");
    if (node.forbidden || (node.kind === "link" && operation !== "lstat")) {
      throw new Error("Fake filesystem rejected private, hidden or followed-link access");
    }
    return node;
  }
  function metadata(kind: FixtureNode["kind"]): SourceMetadata {
    return {
      isDirectory: () => kind === "directory",
      isFile: () => kind === "file",
      isSymbolicLink: () => kind === "link",
    };
  }
  const fileSystem: SourceFileSystem = {
    readdirSync(dir) {
      if (touch("readdir", dir).kind !== "directory") throw new Error("Not a fake source directory");
      return [...nodes].filter(([file]) => file !== dir && dirname(file) === dir).map(([file, node]) => ({
        ...metadata(node.direntKind ?? node.kind),
        name: basename(file),
      }));
    },
    lstatSync(file) {
      return metadata(touch("lstat", file).kind);
    },
    statSync(file) {
      return metadata(touch("stat", file).kind);
    },
    readFileSync(file) {
      const node = touch("read", file);
      if (node.kind !== "file") throw new Error("Not a fake source file");
      return node.text ?? "";
    },
  };
  return { root, fileSystem, touches };
}

describe("public source scanner filesystem boundary", () => {
  it("excludes private names and hidden entries before any metadata or read", () => {
    const fixture = publicSourceFixture({
      "private_config.rs": { kind: "file", forbidden: true },
      "app.config.local.json": { kind: "file", forbidden: true },
      ".hidden.ts": { kind: "file", forbidden: true },
      ".private": { kind: "directory", forbidden: true },
      ".private/hidden.rs": { kind: "file", forbidden: true },
      "public.rs": { kind: "file" },
      "nested": { kind: "directory" },
      "nested/public.ts": { kind: "file" },
    });
    const scanner = createPublicSourceScanner(fixture.root, fixture.fileSystem);

    expect(scanner.files(fixture.root, [".rs", ".ts", ".tsx"])).toEqual([
      join(fixture.root, "public.rs"),
      join(fixture.root, "nested/public.ts"),
    ]);
    expect(fixture.touches.some(({ file }) => /private_config|app\.config\.local|[\\/]\./.test(file))).toBe(false);
  });

  it("rejects file symlinks and directory junctions without following metadata", () => {
    const fixture = publicSourceFixture({
      "external.ts": { kind: "link" },
      // A junction/reparse may look like a directory to the Dirent; lstat is
      // the no-follow check that must still reject it before readdir or read.
      "junction": { kind: "link", direntKind: "directory" },
      "junction/outside.ts": { kind: "file", forbidden: true },
      "public.ts": { kind: "file", text: "public source" },
    });
    const scanner = createPublicSourceScanner(fixture.root, fixture.fileSystem);

    expect(scanner.files(fixture.root, [".ts", ".tsx"])).toEqual([join(fixture.root, "public.ts")]);
    expect(scanner.read(join(fixture.root, "public.ts"))).toBe("public source");
    expect(fixture.touches.some(({ operation }) => operation === "stat")).toBe(false);
    expect(fixture.touches.some(({ operation, file }) =>
      operation !== "lstat" && file.includes("junction"))).toBe(false);
  });

  it("rejects private, hidden or outside explicit paths before filesystem access", () => {
    const fixture = publicSourceFixture({
      "private_config.rs": { kind: "file", forbidden: true },
      "app.config.local.json": { kind: "file", forbidden: true },
      ".hidden": { kind: "directory", forbidden: true },
      ".hidden/public.ts": { kind: "file", forbidden: true },
    });
    const scanner = createPublicSourceScanner(fixture.root, fixture.fileSystem);

    expect(() => scanner.read(join(fixture.root, "private_config.rs"))).toThrow();
    expect(() => scanner.read(join(fixture.root, "app.config.local.json"))).toThrow();
    expect(() => scanner.read(join(fixture.root, ".hidden/public.ts"))).toThrow();
    expect(() => scanner.read(join(fixture.root, "../outside.ts"))).toThrow();
    expect(() => scanner.files(join(fixture.root, "../outside"), [".ts"])).toThrow();
    expect(fixture.touches).toEqual([]);
  });

  it("checks scan roots and all fixed-read ancestors without dereferencing links", () => {
    const fixture = publicSourceFixture({
      "linked.ts": { kind: "link" },
      "linked-dir": { kind: "link", direntKind: "directory" },
      "linked-dir/outside.ts": { kind: "file", forbidden: true },
      "public": { kind: "directory" },
      "public/source.ts": { kind: "file", text: "safe nested source" },
    });
    const scanner = createPublicSourceScanner(fixture.root, fixture.fileSystem);
    const linkedRoot = join(fixture.root, "linked-dir");

    expect(() => scanner.read(join(fixture.root, "linked.ts"))).toThrow();
    expect(() => scanner.read(join(linkedRoot, "outside.ts"))).toThrow();
    expect(() => scanner.files(linkedRoot, [".ts"])).toThrow();
    const rootedAtLink = createPublicSourceScanner(linkedRoot, fixture.fileSystem);
    expect(() => rootedAtLink.files(linkedRoot, [".ts"])).toThrow();
    expect(() => rootedAtLink.read(join(linkedRoot, "outside.ts"))).toThrow();
    expect(scanner.read(join(fixture.root, "public/source.ts"))).toBe("safe nested source");
    expect(fixture.touches.filter(({ operation, file }) =>
      operation !== "lstat" && file.includes("linked"))).toEqual([]);
  });

  it("rejects an excluded scanner base before probing it or its descendants", () => {
    const fixture = publicSourceFixture({
      "private_config.rs": { kind: "file", forbidden: true },
      "APP.CONFIG.LOCAL.JSON": { kind: "file", forbidden: true },
      ".hidden": { kind: "directory", forbidden: true },
      ".hidden/nested": { kind: "directory", forbidden: true },
    });
    for (const name of ["private_config.rs", "APP.CONFIG.LOCAL.JSON", ".hidden", ".hidden/nested"]) {
      const base = join(fixture.root, name);
      expect(() => createPublicSourceScanner(base, fixture.fileSystem).files(base, [".ts"])).toThrow();
      expect(() => createPublicSourceScanner(base, fixture.fileSystem).read("public.ts")).toThrow();
    }
    expect(fixture.touches).toEqual([]);
  });

  it("runs every motion rule while excluding private, hidden, linked and build sources", () => {
    const fixture = publicSourceFixture({
      "src": { kind: "directory" },
      "src/private_config.rs": { kind: "file", forbidden: true },
      "src/app.config.local.json": { kind: "file", forbidden: true },
      "src/.hidden.ts": { kind: "file", forbidden: true },
      "src/linked.tsx": { kind: "link" },
      "src/junction": { kind: "link", direntKind: "directory" },
      "src/junction/outside.ts": { kind: "file", forbidden: true },
      "src/node_modules": { kind: "directory", forbidden: true },
      "src/dist": { kind: "directory", forbidden: true },
      "src/readme.md": { kind: "file", text: 'duration-200 ease-in text-[9px]' },
      "src/public.tsx": {
        kind: "file",
        text: [
          "// text-[9px] duration-200 ease-in-out",
          'const size = "text-[9px]";',
          'const duration = "duration-200";',
          'const easing = "ease-in-out";',
          'const repeated = "duration-300";',
          'const tokens = "text-xs duration-base ease-soft";',
          "* duration-500",
          "/* text-[10px] ease-in */",
        ].join("\n"),
      },
    });

    const violations = checkMotion(fixture.root, fixture.fileSystem);
    expect(violations.map(({ file, line, snippet, rule }) => ({ file, line, snippet, rule }))
      .sort((a, b) => a.line - b.line)).toEqual([
      { file: "src/public.tsx", line: 2, snippet: "text-[9px]", rule: "raw-text-size" },
      { file: "src/public.tsx", line: 3, snippet: "duration-200", rule: "raw-duration" },
      { file: "src/public.tsx", line: 4, snippet: "ease-in-out", rule: "raw-easing" },
      { file: "src/public.tsx", line: 5, snippet: "duration-300", rule: "raw-duration" },
    ]);
    expect(fixture.touches.filter(({ operation }) => operation === "read")).toEqual([
      { operation: "read", file: join(fixture.root, "src/public.tsx") },
    ]);
  });
});

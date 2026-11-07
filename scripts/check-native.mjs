/** Run native gates with public configuration and an owned temporary directory. */
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const nativeRoot = path.join(root, "src-tauri");
const [mode = "check", ...args] = process.argv.slice(2);
if (!["check", "test", "clippy"].includes(mode)) {
  console.error("Usage: node scripts/check-native.mjs [check|test|clippy] [cargo arguments]");
  process.exit(2);
}
if (mode === "check" && args.length) {
  console.error("Use test or clippy mode to pass arguments to an individual gate.");
  process.exit(2);
}

const parentPath = path.join(root, "_tmp", "native-tests");
mkdirSync(parentPath, { recursive: true });
// Resolve junctions before creating a unique directory; Rust verifies all ancestors too.
const parent = realpathSync(parentPath);
const fixture = mkdtempSync(path.join(parent, "qt-native-run-"));
const env = {
  ...process.env,
  // Keep public test binaries separate from an active `tauri dev` executable.
  CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR || path.join(nativeRoot, "target", "native-check"),
  QT_PUBLIC_TEST_BUILD: "1",
  QT_NATIVE_FIXTURE_PARENT: parent,
  QT_NATIVE_FIXTURE_ROOT: fixture,
  TEMP: fixture,
  TMP: fixture,
  TMPDIR: fixture,
};
const commands = mode === "check"
  ? [["clippy", "--all-targets", "--", "-D", "warnings"], ["test"]]
  : [mode === "clippy" && args.length === 0
    ? ["clippy", "--all-targets", "--", "-D", "warnings"]
    : [mode, ...args]];

let exitCode = 0;
try {
  console.log("[native] Public configuration; temporary files are isolated for this run.");
  for (const command of commands) {
    const result = spawnSync("cargo", command, { cwd: nativeRoot, env, stdio: "inherit" });
    if (result.error) throw result.error;
    exitCode = result.status ?? 1;
    if (exitCode !== 0) break;
  }
  if (mode === "check" && exitCode === 0) {
    const result = spawnSync(process.execPath, [path.join(root, "tests", "source-engine-network-guard-native.mjs")],
      { cwd: root, env, stdio: "inherit" });
    if (result.error) throw result.error;
    exitCode = result.status ?? 1;
  }
} catch (error) {
  console.error(error);
  exitCode = 1;
}
try {
  // Delete only the exact owned child; never follow a replaced path or remove its parent.
  const resolved = realpathSync(fixture);
  if (resolved !== fixture || path.dirname(resolved) !== parent
    || !path.basename(resolved).startsWith("qt-native-run-")
    || lstatSync(fixture).isSymbolicLink()) {
    throw new Error("Refusing to remove an unexpected native fixture path");
  }
  rmSync(fixture, { recursive: true, force: true });
} catch (error) {
  console.error(error);
  exitCode ||= 1;
}
process.exitCode = exitCode;

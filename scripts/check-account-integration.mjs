// Opt-in cross-repository integration. Ordinary CI does not need qt-sources.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = path.resolve(root, process.argv[2] ?? "../qt-sources");
const entry = path.join(sourceRoot, "src", "meta-entries.ts");
if (!existsSync(entry)) {
  console.error(`Missing integration source: ${entry}\nPass a qt-sources checkout to pnpm test:account-integration <path>.`);
  process.exitCode = 1;
} else {
  const require = createRequire(import.meta.url);
  const vitest = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");
  console.log(`Account integration uses real registered source handlers: ${entry}`);
  const result = spawnSync(process.execPath, [vitest, "run", "tests/account-auth-session.test.ts"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, QT_ACCOUNT_META_ENTRY: path.relative(path.join(root, "tests"), entry).split(path.sep).join("/") },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

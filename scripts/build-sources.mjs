/**
 * 音源包构建脚本（音源包热更新开发方案 P3）。
 *
 * 产物（dist-sources/，发布时由 publish-sources.mjs 上传）：
 * - source-bundle.js  实现：12 个 LX 脚本宿主 + 平台官方接口 + chain 执行器
 * - chain.json        编排：默认 chain（改顺序/停线/改声明式线路后重跑构建）
 *
 * 打包用 Vite 库模式而不是裸 esbuild：vendored 混淆脚本里有 sloppy-mode 的
 * const 赋值（esbuild 解析期硬报错，Rollup/acorn 容忍，现有 vite build 一直
 * 如此），且 Vite 原生展开 `?raw` 与 import.meta.glob；target es2020 以支持
 * kw-des 的 BigInt。host-request 仍不进 bundle（createSourceLayer 由宿主
 * 注入 request）。
 *
 * 用法：npm run build:sources
 */
import { build as viteBuild } from "vite";
import { build as esbuildBuild } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(scriptDir, "..");
const outDir = path.join(project, "dist-sources");

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

await viteBuild({
  root: project,
  configFile: false,
  logLevel: "warn",
  build: {
    outDir,
    emptyOutDir: false,
    target: "es2020",
    minify: false,
    lib: {
      entry: path.join(project, "src/source-scripts/engine-entry.ts"),
      formats: ["es"],
      fileName: () => "source-bundle.js",
    },
  },
});

// 关键后处理：把带源码自校验的混淆脚本体恢复为逐字节原文。
// Rollup 会按自己的 AST 重打印脚本（解码 \xNN 转义、规范化数字进制、重命名遮蔽
// 参数），对 jsjiami.cn.v7 / jsjiami.com.v7 / obfuscator.io strong 这类带自校验的
// 混淆件会破坏其校验，使其字符串数组轮转永不收敛 → 同步忙循环冻结整个 JS 事件
// 循环（2026091905 事故：PC 所有接口超时、安卓 QuickJS 线程卡死）。
await import("./restore-lx-bodies.mjs").then((m) => m.restoreLxBodies(path.join(outDir, "source-bundle.js")));

// chain.json：把 chain-config.ts 临时 CJS 化后取 defaultChainConfig()
//（保证与代码同源，不存在手抄的第二份默认链）
const chainTmp = path.join(outDir, "_chain-config.cjs");
await esbuildBuild({
  entryPoints: [path.join(project, "src/source-scripts/chain-config.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: chainTmp,
  logLevel: "silent",
});
const require = createRequire(import.meta.url);
const { defaultChainConfig, parseChainConfig } = require(chainTmp);
const chain = defaultChainConfig();
// 与前端同一把关：默认链必须能通过 schema 校验
parseChainConfig(JSON.parse(JSON.stringify(chain)));
fs.writeFileSync(path.join(outDir, "chain.json"), JSON.stringify(chain, null, 2) + "\n");
fs.rmSync(chainTmp);

// 冒烟（最低限度）：bundle 可被 ESM 导入、导出面齐全、默认链可解析
const mod = await import("file://" + path.join(outDir, "source-bundle.js").split(path.sep).join("/"));
for (const name of ["createSourceLayer", "defaultChainConfig", "parseChainConfig"]) {
  if (typeof mod[name] !== "function") {
    throw new Error(`bundle 缺少导出 ${name}`);
  }
}
const remote = mod.parseChainConfig(JSON.parse(JSON.stringify(mod.defaultChainConfig())));
if (remote.chainRevision !== chain.chainRevision) {
  throw new Error("bundle 内默认链与 chain.json 不一致");
}

// 守卫（必须）：在 worker 沙箱里逐个执行 LX 脚本体，看门狗拦下「同步忙循环挂死」。
// 上面那条冒烟只验证「bundle 能被导入」，而挂死发生在**脚本初始化**时，导入阶段
// 完全看不出来 —— 2026091905 就是这么过检并发布出去的（bad:[] 为空、无自动回滚）。
const { checkLxBodies } = await import("./check-lx-bodies.mjs");
const guard = await checkLxBodies(path.join(outDir, "source-bundle.js"), { timeoutMs: 20000 });
if (guard.hung.length > 0) {
  throw new Error(`构建中止：${guard.hung.join(", ")} 的脚本体在沙箱里同步忙循环挂死，会冻结宿主事件循环`);
}

const kb = (n) => (n / 1024).toFixed(0);
console.log(
  `[build-sources] source-bundle.js ${kb(fs.statSync(path.join(outDir, "source-bundle.js")).size)} KB；` +
    `chain.json ${kb(fs.statSync(path.join(outDir, "chain.json")).size)} KB（chainRevision=${chain.chainRevision}）`,
);
console.log(
  "[build-sources] 要随应用内置的话：先在 source-update.ts 对齐 BUILTIN_SOURCE_VERSION（镜像发布号），再跑 npm run sync:builtin",
);

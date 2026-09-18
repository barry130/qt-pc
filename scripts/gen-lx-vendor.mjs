/**
 * 生成 LX 音源脚本的静态包装文件（通用版，支持多个脚本）。
 *
 * 用法：node scripts/gen-lx-vendor.mjs
 * 输入：MANIFEST 里各脚本的原文（qt-pc 仓库根的相对路径，如 V260907/*.js）
 * 输出：src/source-scripts/schemes/lx-host/vendored/
 *       <id>.js           —— 脚本原文的逐字节拷贝（cp 语义，SCRIPT_MD5 的真源）
 *       <id>.wrapped.js   —— 静态包装：脚本本体放进带同名遮蔽参数的函数
 *       <id>.wrapped.d.ts —— 包装执行器的类型
 *
 * 背景：CSP 禁 eval/new Function，无法在运行时用字符串包一层；
 * 因此构建期生成包装文件。遮蔽参数：globalThis(Proxy)、process(桩)、
 * lx(mock)、SCRIPT_MD5、console(静默)、window(同一个 Proxy，洛雪 v2-fix
 * 的环境探测 `typeof window === 'object' ? window : …` 会选中它)。
 * Date/JSON/BigInt 等未遮蔽标识符落真实全局。新增脚本 = 往 MANIFEST 加一行
 * 再跑本脚本；原文更新后重跑即可。
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const outDir = join(
  repoRoot,
  "qt-pc",
  "src",
  "source-scripts",
  "schemes",
  "lx-host",
  "vendored",
);

/** id → 原文路径（相对 qt-pc 仓库的上一级，即 F:\qtMusic） */
const MANIFEST = {
  "yuningxi-pro": "V260907/lx-玉宁熙V1.2.2.js",
  yuxi: "V260907/屿溪-终章.js",
  stellarwave: "V260907/stellarwave-v3.2.0.js",
  molan: "V260907/墨澜音乐源v2.3.0.js",
  gdstudio: "V260907/gdstudio音乐源 v1.0.1（仅支持网易）.js",
  kulou: "V260907/(推荐)裤佬SVIP音源（酷狗挂了）.js",
  quandouyao: "V260907/全豆要-聚合音源-V4.1（酷狗挂了）.js",
  luoxue: "音源JS文件/优质-支持四平台FLAC/洛雪音乐源 1.0.0 v2-fix.js",
  yuningxi: "音源JS文件/良好-支持至少两平台FLAC/lx-玉宁熙 v1.1.5 需自行配置.js",
  suyin: "音源JS文件/良好-支持至少两平台FLAC/溯音音源 v1.js",
  shouji: "音源JS文件/良好-支持至少两平台FLAC/收集の聚合接口.js",
  lxv6: "音源JS文件/lx-music-source-v6.js",
};

const banner = (id) => `/**
 * ${id} 静态包装文件 —— 由 scripts/gen-lx-vendor.mjs 生成，勿手改。
 *
 * 原理：把脚本本体放进一个带同名遮蔽参数的函数里执行，
 * 使其中的 globalThis / process / lx / SCRIPT_MD5 / console / window 标识符
 * 解析到我们注入的对象，而 Date/JSON/BigInt 等落在真实全局。
 * 不使用 eval/new Function（CSP），因此必须在构建期生成。
 */
`;

const dts = `/** 包装模块的类型（.js 本体由 scripts/gen-lx-vendor.mjs 生成，勿手改） */
export interface LxRunDeps {
  /** 遮蔽的 globalThis（Proxy：lx/SCRIPT_MD5/定时器覆盖，其余透传真实全局） */
  globalThis: object;
  /** 遮蔽的 process 桩（阻断脚本反调试的 process.exit 静默退出） */
  process: object;
  /** lx mock（bridge.ts 构造） */
  lx: object;
  scriptMd5: string;
  /** 静默 console（脚本内部日志不刷屏） */
  console: object;
  /** 与 globalThis 同一个 Proxy（洛雪 v2-fix 的环境探测选 window 分支） */
  window: object;
}
export function runLxScript(deps: LxRunDeps): void;
`;

mkdirSync(outDir, { recursive: true });
for (const [id, rel] of Object.entries(MANIFEST)) {
  const src = join(repoRoot, rel);
  const raw = readFileSync(src, "utf8");
  copyFileSync(src, join(outDir, `${id}.js`));
  const body = `${banner(id)}
export function runLxScript(deps) {
  (function (globalThis, process, lx, SCRIPT_MD5, console, window) {
${raw}
  })(deps.globalThis, deps.process, deps.lx, deps.scriptMd5, deps.console, deps.window);
}
`;
  // 脚本本体里有块注释/引号都没关系：这里是纯文本拼接，不嵌模板字面量
  writeFileSync(join(outDir, `${id}.wrapped.js`), body, "utf8");
  writeFileSync(join(outDir, `${id}.wrapped.d.ts`), dts, "utf8");
  console.log(`[gen-lx-vendor] ${id} ← ${rel}（${raw.length} 字符）`);
}
console.log(`[gen-lx-vendor] 完成，共 ${Object.keys(MANIFEST).length} 个脚本 → ${outDir}`);

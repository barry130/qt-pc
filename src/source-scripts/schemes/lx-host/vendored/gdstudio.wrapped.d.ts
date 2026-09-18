/** 包装模块的类型（.js 本体由 scripts/gen-lx-vendor.mjs 生成，勿手改） */
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

// ESLint 10 扁平配置。只做**正确性**门禁：JS 推荐 + TS 推荐 + React Hooks
// 规则。刻意不带 stylistic/formatting（不引 Prettier）：存量代码风格已统一，
// 格式化工具会制造与本仓库「增量修改不重排旧代码」约定冲突的海量 diff。
// TS 规则用非 type-checked 档（不开 project service）：typecheck 已由
// `pnpm typecheck`（tsc strict）覆盖，这里不重复做全量类型分析。
// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    // 产物 / 依赖缓存 / Rust 侧不归 ESLint 管：
    // - .vite-cache/：vite dev 的预打包依赖缓存（第三方产物）
    // - dist/、coverage/：构建与测试产物
    // - _tmp/：会话级补丁脚本与本地预览构建（已在 .gitignore 里，里面是
    //   打包产物，lint 它会刷出成片的 no-undef，与源码质量无关）
    // - src-tauri/：Rust，由 cargo clippy / fmt 管
    ignores: [
      "dist/**",
      "coverage/**",
      ".vite-cache/**",
      "_tmp/**",
      "src-tauri/**",
      "node_modules/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // 全局通用规则微调（对齐仓库既有约定）：
    rules: {
      // `_` 前缀 = 刻意占位（与 tsc noUnusedParameters 同口径），不是死代码
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      // `catch {}`（吞掉并忽略）是本仓库对「失败不影响主流程」的惯用写法
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // React Hooks 规则对源码与测试一视同仁（app.render.test 里有组件）
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      // Hook 调用位置错误 = 真 bug，必须 error
      "react-hooks/rules-of-hooks": "error",
      // 依赖数组缺失多为行为细节，先 warn 不挡门（逐步清零后再升 error）
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // 应用源码跑在 WebView（window/document/console 等）
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser },
    },
  },
  {
    // 测试与 Node 脚本（tests/ 跑 jsdom+node；tools/ 与 .cnb/ 是仓库自带的
    // Node 运维脚本——browser+node 并集是为了 fetch（globals.node 无 fetch））
    files: [
      "tests/**/*.{ts,tsx}",
      "scripts/**/*.{mjs,js,ts}",
      "tools/**/*.{mjs,js,ts}",
      ".cnb/**/*.{mjs,js,ts}",
      "eslint.config.js",
      "vitest.config.js",
    ],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
  },
);

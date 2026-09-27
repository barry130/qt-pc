// 用 .js 而非 .ts：vite 加载 TS 配置要靠 esbuild 子进程（沙箱 EPERM），
// JS 配置可被直接 import，绕开子进程。
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // 与 vite.config.ts 保持一致：音源包源码在独立工程 qt-sources（同级目录），
      // 主窗口只借用 contract（类型）与 timeout（工具）两个平台无关模块。
      "@qt-sources": path.resolve(__dirname, "../qt-sources/src"),
    },
  },
  test: {
    // 沙箱内禁止 spawn 子进程，用 worker threads 池
    pool: "threads",
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
});

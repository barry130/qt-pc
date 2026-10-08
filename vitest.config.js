// 用 .js 而非 .ts：vite 加载 TS 配置要靠 esbuild 子进程（沙箱 EPERM），
// JS 配置可被直接 import，绕开子进程。
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    // 沙箱内禁止 spawn 子进程，用 worker threads 池
    pool: "threads",
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // 每个用例结束后卸载 React 树并排空更新队列，避免 jsdom 拆除后
    // 残留的 React 调度任务抛 "window is not defined"（unhandled error → exit 1）
    setupFiles: ["./tests/setup.cleanup.ts"],
  },
});

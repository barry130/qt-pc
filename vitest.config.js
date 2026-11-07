// 隔离 runner 使用 --configLoader native；仅改成 .js 不会禁用 Vite 的默认 bundle。
// 用原配置文件 URL 求同一根目录，兼容 native import 与 Vite bundle 两种加载方式。
import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // 测试不发现真实 .env*；缓存只落到当前仓库的忽略目录。
  envDir: false,
  cacheDir: path.resolve(root, "_tmp/vitest-cache"),
  // 无 API 监听的 Vitest 仍解析 host；数字地址避免 localhost DNS，不开启监听。
  server: { host: "127.0.0.1" },
  resolve: {
    alias: {
      "@": path.resolve(root, "./src"),
    },
  },
  test: {
    // 保留原 worker threads 池；进程级 NODE_OPTIONS 在 setup 之前禁用宿主 Storage。
    pool: "threads",
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // 每个用例结束后卸载 React 树并排空更新队列，避免 jsdom 拆除后
    // 残留的 React 调度任务抛 "window is not defined"（unhandled error → exit 1）
    setupFiles: ["./tests/setup.cleanup.ts"],
  },
});

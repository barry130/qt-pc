import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
// 端口单源于仓库根的 app.config.json（改端口只改那里；tauri.conf.json 的 devUrl 由
// scripts/sync-config.mjs 同步，两边不会漂移）
import appConfig from "./app.config.json";

// @tauri-apps/cli 固定 host/port，dev server 不得使用 strictPort 之外的随机端口
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // vite dev 依赖预构建缓存放在工作区内，避免沙箱外写入
  cacheDir: ".vite-cache",
  clearScreen: false,
  server: {
    port: appConfig.devServer.port,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: appConfig.devServer.hmrPort,
        }
      : undefined,
    watch: {
      // 工作区内有两处会被构建工具高频写入，不能监听：
      // src-tauri（cargo 产物）与 .cargo-home（registry 源码缓存，cargo test/build 会改）
      ignored: ["**/src-tauri/**", "**/.cargo-home/**", "**/.vite-cache/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: process.env.TAURI_ENV_PLATFORM == "windows" ? "chrome105" : "es2021",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    outDir: "dist",
    chunkSizeWarningLimit: 1024,
  },
});

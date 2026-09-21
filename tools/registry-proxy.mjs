/**
 * 本地 crates.io 稀疏索引 / tarball 镜像（仅构建期使用）。
 *
 * 背景：本机 schannel 客户端凭据获取损坏（SEC_E_NO_CREDENTIALS），
 * cargo 的 libcurl 下载栈完全无法做 HTTPS。Node 的 TLS 正常。
 * 方案：本地 127.0.0.1 起 HTTP 服务（cargo 侧不经过 TLS），
 * 上游用 Node fetch（OpenSSL）转发到 rsproxy 镜像。
 *
 * 端口 8650 仅绑定 127.0.0.1；只代理 /index/ 与 /api/v1/crates/ 两个前缀。
 */
import http from "node:http";
import { Readable } from "node:stream";

const PORT = 8650;
const UPSTREAM_INDEX = "https://rsproxy.cn/index";
const UPSTREAM_API = "https://rsproxy.cn/api/v1/crates";

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url ?? "";

    // 1) 稀疏索引 config.json：把 dl/api 指回本地
    if (url === "/index/config.json") {
      const body = JSON.stringify({
        dl: `http://127.0.0.1:${PORT}/api/v1/crates`,
        api: `http://127.0.0.1:${PORT}`,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
      return;
    }

    // 2) 稀疏索引条目
    if (url.startsWith("/index/")) {
      const upstream = UPSTREAM_INDEX + url.slice("/index".length);
      const r = await fetch(upstream, {
        headers: { "user-agent": "quietmusic-local-mirror/0.1" },
      });
      const headers = { "content-type": r.headers.get("content-type") ?? "text/plain" };
      if (r.body) {
        res.writeHead(r.status, headers);
        Readable.fromWeb(r.body).pipe(res);
      } else {
        res.writeHead(r.status, headers);
        res.end();
      }
      return;
    }

    // 3) crate tarball 下载
    if (url.startsWith("/api/v1/crates/")) {
      const upstream = UPSTREAM_API + url.slice("/api/v1/crates".length);
      const r = await fetch(upstream, {
        headers: { "user-agent": "quietmusic-local-mirror/0.1" },
      });
      if (!r.ok || !r.body) {
        res.writeHead(r.status);
        res.end(await r.text().catch(() => ""));
        return;
      }
      const len = r.headers.get("content-length");
      res.writeHead(r.status, {
        "content-type": "application/x-tar",
        ...(len ? { "content-length": len } : {}),
      });
      Readable.fromWeb(r.body).pipe(res);
      return;
    }

    res.writeHead(404);
    res.end("not found");
  } catch (err) {
    console.error("[mirror] error:", err?.message ?? err);
    if (!res.headersSent) res.writeHead(502);
    res.end("upstream error");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mirror] listening on http://127.0.0.1:${PORT}`);
});

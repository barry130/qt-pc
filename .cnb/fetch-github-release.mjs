#!/usr/bin/env node
/**
 * 轮询 GitHub Release，等三平台安装包出齐后**下载到 artifacts/**。
 *
 * 用法（由 .cnb.yml 的 v* tag_push 流水线调用，环境变量注入）：
 *   GITHUB_REPO=barry130/qt-pc      必填，owner/repo
 *   GITHUB_TAG=v1.1.2               必填，tag（默认取 CNB_BRANCH）
 *   WAIT_SECONDS=2700               选填，最长等待秒数，默认 2700（45 分钟）
 *   POLL_SECONDS=60                 选填，轮询间隔，默认 60
 *   ARTIFACT_DIR=artifacts          选填，下载目录，默认 artifacts
 *
 * 为什么不用 shell + curl 解析
 * ---------------------------
 * 1. 匿名 REST 配额：GitHub 对未认证请求限 60 次/小时/IP，CNB 托管节点是共享
 *    出口 IP。轮询间隔必须给到 60s，45 分钟最多 46 次，留足余量。
 * 2. JSON 不能用正则切：资产名里一旦出现特殊字符（GitHub 在 display_name /
 *    标签上会返回转义），grep '"name":"[^"]*"' 就会切错。用 JSON.parse 才稳。
 * 3. 下载要跟随重定向：asset 直链是 302 到 S3，node fetch 默认跟随，
 *    curl 需要 -L 还得额外处理 --retry；这里统一在代码里做。
 *
 * 下载完会把每个文件的字节数与 Release 声明的 size 逐个比对，并写出
 * artifacts/asset-list.json 供流水线的校验阶段复核。截断的下载在这里就被
 * 重试掉，不会流到「生成 MD5 / fileSize」那一步 —— 用截断文件算出的
 * MD5 与 fileSize 会让后台「版本更新」记录静默失效。
 *
 * 判定「出齐」的条件（与 GitHub 侧 release.yml 的 publish 校验保持一致）：
 *   3 个 *-setup.exe + 3 个 .sig + ≥1 .deb + ≥1 .AppImage + ≥1 .dmg
 * GitHub 侧先跑完三平台矩阵才建 Release 并一次性传完所有资产，所以这里读到
 * 的资产列表就是完整清单，不会漏掉最后一个平台。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repo = process.env.GITHUB_REPO || "barry130/qt-pc";
const tag = process.env.GITHUB_TAG || process.env.CNB_BRANCH || process.env.CNB_TAG || "";
const waitSeconds = Number(process.env.WAIT_SECONDS || 2700);
const pollSeconds = Number(process.env.POLL_SECONDS || 60);
const dir = process.env.ARTIFACT_DIR || "artifacts";

if (!repo || !tag) {
  console.error("需要 GITHUB_REPO（owner/repo）与 GITHUB_TAG 两个环境变量");
  process.exit(1);
}

/** 关心的资产类型：exe / sig 是应用内更新链路，deb/AppImage/dmg 是手动安装 */
const PATTERNS = [
  { re: /-setup\.exe$/, min: 3, label: "Windows 安装包" },
  { re: /-setup\.exe\.sig$/, min: 3, label: "安装包签名" },
  { re: /\.deb$/, min: 1, label: "deb" },
  { re: /\.AppImage$/, min: 1, label: "AppImage" },
  { re: /\.dmg$/, min: 1, label: "dmg" },
];

const apiUrl = `https://api.github.com/repos/${repo}/releases/tags/${tag}`;

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}Z] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 拉 Release JSON；Release 还不存在时返回 null（tag 刚推，流水线还没跑完） */
async function fetchRelease() {
  const res = await fetch(apiUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "qt-pc-cnb-mirror",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (res.status === 404) return null;
  if (res.status === 403 || res.status === 429) {
    const reset = res.headers.get("x-ratelimit-reset");
    throw new Error(
      `GitHub 限流（HTTP ${res.status}）` +
        (reset ? `，配额 ${new Date(Number(reset) * 1000).toISOString()} 重置` : ""),
    );
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

/** 匹配关心的资产，返回 {counts, wanted}（wanted 含 name + GitHub 声明的 size） */
function selectAssets(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const wanted = assets
    .filter((a) => PATTERNS.some((p) => p.re.test(a.name)))
    .map((a) => ({ name: a.name, size: Number(a.size) || 0 }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  const names = wanted.map((a) => a.name);
  const counts = PATTERNS.map((p) => ({
    label: p.label,
    n: names.filter((name) => p.re.test(name)).length,
    min: p.min,
  }));
  return { counts, wanted };
}

function formatCounts(counts) {
  return counts.map((c) => `${c.label}=${c.n}`).join(" ");
}

function isReady(counts) {
  return counts.every((c) => c.n >= c.min);
}

async function download(name, expectedSize) {
  const url = `https://github.com/${repo}/releases/download/${tag}/${name}`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "qt-pc-cnb-mirror" },
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error("下载到 0 字节");
      // 与 Release 声明的字节数比对：截断 / 落到 HTML 错误页都能挡住。
      // （不去重算 MD5 —— 校验和留给 make-release-notes 一次算完。）
      if (expectedSize > 0 && buf.length !== expectedSize) {
        throw new Error(`字节数不符：拿到 ${buf.length}，应为 ${expectedSize}`);
      }
      return buf;
    } catch (err) {
      if (attempt === 5) throw new Error(`下载 ${name} 失败：${err.message}`);
      log(`下载 ${name} 第 ${attempt} 次失败（${err.message}），${10 * attempt}s 后重试`);
      await sleep(10_000 * attempt);
    }
  }
  throw new Error("unreachable");
}

async function main() {
  log(`等待 ${repo} 的 Release ${tag}（最多 ${waitSeconds}s，每 ${pollSeconds}s 查一次）`);
  const deadline = Date.now() + waitSeconds * 1000;

  let wanted = null;
  for (;;) {
    let release;
    try {
      release = await fetchRelease();
    } catch (err) {
      // 限流/网络抖动不该直接判死：还有余量就退避后继续等。
      if (Date.now() >= deadline) {
        console.error(`::error::查询 GitHub Release 失败：${err.message}`);
        process.exit(1);
      }
      log(`查询失败：${err.message}`);
      await sleep(Math.min(pollSeconds * 1000, 30_000));
      continue;
    }

    if (!release) {
      log(`Release ${tag} 还不存在（tag 刚推，GitHub 流水线可能还在跑）`);
    } else {
      const { counts, wanted: names } = selectAssets(release);
      log(formatCounts(counts));
      if (isReady(counts)) {
        wanted = names;
        log(`资产已齐（${wanted.length} 个）：`);
        for (const a of wanted) console.log(`  ${a.name}  ${a.size} 字节`);
        break;
      }
      // Release 存在但资产不齐 —— 可能是上一次同 tag 的旧 Release，或 GitHub 侧
      // 正在往里传（delete-then-recreate）。都继续等，不误判。
      log("资产还没齐，继续等");
    }

    if (Date.now() >= deadline) {
      console.error(
        `::error::等待 GitHub Release ${tag} 超时（${waitSeconds}s）。` +
          `多半是 GitHub 流水线失败了，去 https://github.com/${repo}/actions 看日志`,
      );
      process.exit(1);
    }
    await sleep(pollSeconds * 1000);
  }

  mkdirSync(dir, { recursive: true });
  // 清单写到流水线的 cwd 而不是 ${dir}/：.cnb.yml 的校验阶段直接按
  // asset-list.json 读，且 make-release-notes 只认安装包后缀、不该看到清单文件。
  writeFileSync("asset-list.json", JSON.stringify(wanted, null, 2) + "\n", "utf8");
  log(`开始下载 ${wanted.length} 个产物到 ${dir}/`);
  for (const { name, size } of wanted) {
    const buf = await download(name, size);
    writeFileSync(join(dir, name), buf);
    log(`  ${name}  ${(buf.length / 1024 / 1024).toFixed(1)} MiB`);
  }
  console.log(`下载完成：${wanted.length} 个产物`);
}

main().catch((err) => {
  console.error(`::error::${err.message}`);
  process.exit(1);
});
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
 *   STALL_SECONDS=90                选填，下载时多久没进数据就判卡死重试，默认 90
 *   MAX_ATTEMPTS=20                 选填，每个产物的下载重试次数，默认 20
 *   GITHUB_TOKEN=                   选填，配了就能顺带提升 API 配额，默认匿名
 *
 * 为什么轮询走 HTML 片段而不是 REST API
 * -----------------------------------
 * GitHub 对未认证的 `api.github.com` 限 60 次/小时/IP，而 CNB 托管节点是共享出口
 * IP —— 一台节点上别人的构建也在消耗同一个配额，45 分钟轮询一次看着不多，实际很
 * 容易被撞到 403。真撞上了就只能在 45 分钟里干等一个不会到来的重置窗口。
 *
 * 所以主路径改抓 `https://github.com/<repo>/releases/expanded_assets/<tag>`：
 * 这是 github.com 网页端的一段 HTML，列出了每个资产的下载链接和 **sha256 摘要**，
 * 不占 REST 配额。REST API 留作兜底（万一 GitHub 改了这段 HTML 结构，至少还能
 * 拿到资产名和精确字节数，不会彻底卡死）。
 *
 * 顺带白捡一个更硬的校验：sha256。下载时边写边算，对不上就重下 —— 比只比对字节数
 * 强得多（截断、代理塞 HTML 错误页、内容损坏都能挡）。
 *
 * 判定「出齐」的条件（与 GitHub 侧 release.yml 的 publish 校验保持一致）：
 *   3 个 *-setup.exe + 3 个 .sig + ≥1 .deb + ≥1 .AppImage + ≥1 .dmg
 * GitHub 侧先跑完三平台矩阵才建 Release 并一次性传完所有资产，所以这里读到的
 * 资产列表就是完整清单，不会漏掉最后一个平台。
 */
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const repo = process.env.GITHUB_REPO || "barry130/qt-pc";
const tag = process.env.GITHUB_TAG || process.env.CNB_BRANCH || process.env.CNB_TAG || "";
const waitSeconds = Number(process.env.WAIT_SECONDS || 2700);
const pollSeconds = Number(process.env.POLL_SECONDS || 60);
const dir = process.env.ARTIFACT_DIR || "artifacts";
// 单个文件多久没收到新数据就判定卡死并重试。给到 90s：CNB 节点拉 GitHub 大文件
// 时不时会掉到几十 KB/s，只要还在进就不算卡。
const stallSeconds = Number(process.env.STALL_SECONDS || 90);
// undici 连 github.com:443 只有 10s 连接超时，从国内拉经常连不上（实测
// ConnectTimeoutError / fetch failed）。单次超时很便宜，所以宁可多试几轮也别
// 早早就放弃：20 次 × 10s 连接，退避封顶 30s，再由共享 deadline 兜住总时长。
const maxAttempts = Number(process.env.MAX_ATTEMPTS || 20);
const ghToken = (process.env.GITHUB_TOKEN || "").trim();

// 注意：GITHUB_REPO / GITHUB_TAG 的必填校验放在 main() 里，被 import 做单测时
// 不要因为缺环境变量就把进程干掉。

/** 关心的资产类型：exe / sig 是应用内更新链路，deb/AppImage/dmg 是手动安装 */
const PATTERNS = [
  { re: /-setup\.exe$/, min: 3, label: "Windows 安装包" },
  { re: /-setup\.exe\.sig$/, min: 3, label: "安装包签名" },
  { re: /\.deb$/, min: 1, label: "deb" },
  { re: /\.AppImage$/, min: 1, label: "AppImage" },
  { re: /\.dmg$/, min: 1, label: "dmg" },
];

const htmlUrl = `https://github.com/${repo}/releases/expanded_assets/${tag}`;
const apiUrl = `https://api.github.com/repos/${repo}/releases/tags/${tag}`;

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}Z] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function headers(extra = {}) {
  return {
    "User-Agent": "qt-pc-cnb-mirror",
    ...(ghToken ? { Authorization: `Bearer ${ghToken}` } : {}),
    ...extra,
  };
}

/**
 * 从 expanded_assets 的 HTML 片段里抠出资产清单。
 *
 * 结构长这样（空白很多，用正则按「下一个 href 之前」切块最稳）：
 *   <a href="/<repo>/releases/download/<tag>/NAME" ...><span class="text-bold">NAME</span></a>
 *   ... 隔一大段 ... <span class="Truncate-text">sha256:<64 位十六进制></span>
 * sha256 不保证都有（GitHub 只给近期上传的资产生成），缺失时就留空字符串，
 * 由调用方退回到「只比字节数」。
 */
function parseExpandedAssets(html) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `href="/${esc(repo)}/releases/download/${esc(tag)}/([^"]+)"`,
    "g",
  );
  const hits = [];
  for (const m of html.matchAll(re)) {
    hits.push({ name: decodeURIComponent(m[1]), index: m.index });
  }
  return hits.map((hit, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].index : html.length;
    const block = html.slice(hit.index, end);
    const sha = block.match(/sha256:([0-9a-f]{64})/);
    return { name: hit.name, size: 0, sha256: sha ? sha[1] : "" };
  });
}

/** 读一次资产清单：先 HTML（不占 REST 配额，带 sha256），失败再退到 REST API。 */
async function fetchAssets() {
  try {
    const res = await fetch(htmlUrl, {
      headers: headers({ Accept: "text/html" }),
      redirect: "follow",
    });
    if (res.status === 404) return { source: "html", assets: [] };
    if (res.ok) {
      const list = parseExpandedAssets(await res.text());
      if (list.length) return { source: "html", assets: list };
      log("expanded_assets 里没解析出资产，改走 REST API");
    } else {
      log(`expanded_assets 返回 HTTP ${res.status}，改走 REST API`);
    }
  } catch (err) {
    log(`抓 expanded_assets 失败（${err.message}），改走 REST API`);
  }

  const res = await fetch(apiUrl, {
    headers: headers({
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    }),
    redirect: "follow",
  });
  if (res.status === 404) return { source: "api", assets: [] };
  if (res.status === 403 || res.status === 429) {
    const reset = res.headers.get("x-ratelimit-reset");
    throw new Error(
      `GitHub 限流（HTTP ${res.status}）` +
        (reset ? `，配额 ${new Date(Number(reset) * 1000).toISOString()} 重置` : ""),
    );
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const body = await res.json();
  const assets = Array.isArray(body?.assets) ? body.assets : [];
  return {
    source: "api",
    assets: assets.map((a) => ({ name: a.name, size: Number(a.size) || 0, sha256: "" })),
  };
}

/** 匹配关心的资产，返回 {counts, wanted}（wanted 含 name / size / sha256） */
function selectAssets(assets) {
  const wanted = assets
    .filter((a) => PATTERNS.some((p) => p.re.test(a.name)))
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

/** 每一类都达到下限才算「出齐」 */
export function isReady(counts) {
  return counts.every((c) => c.n >= c.min);
}

export { selectAssets, parseExpandedAssets };

/**
 * 流式下载到磁盘，不进内存。
 *
 * 为什么不用 `Buffer.from(await res.arrayBuffer())`：AppImage 有 85 MiB，整块读进
 * 内存再落盘会让容器内存尖峰，而且期间一个字都不打 —— CNB 对「无输出」有 10 分钟
 * 的超时，节点带宽再慢一点就会被判定失败。改成 pipe + 边下边报进度后，峰值内存是
 * 一个 64 KiB 的块，输出也连续不断。
 *
 * 仍然逐个校验内容：先写 `.part`，sha256（拿得到时）或字节数对上了才 rename 到位，
 * 失败重试时把半截文件删掉 —— 绝不能把截断的文件留给后面的 MD5 / fileSize 计算。
 *
 * 还有一层「卡死」看门狗：undici 只管连接超时（10s）和响应头超时（300s），**读到一半
 * 断流不会自己报错**，fetch 会一直挂着。从 CNB 节点拉 GitHub 大文件经常卡在几十 KB/s，
 * 一挂就是十几分钟。stallSeconds 内一个字节都没进来就主动 abort，交给重试。
 *
 * 重试次数很多，但所有文件共享一个 deadline（downloadDeadline）：单个文件失败
 * 不该无限重试，整条流水线的墙钟预算也只有 2h（.cnb.yml 的 timeout: 2h）。
 */
async function download(name, expectedSize, expectedSha, deadline) {
  const url = `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`;
  const finalPath = join(dir, name);
  const partPath = `${finalPath}.part`;
  const mib = (n) => `${(n / 1024 / 1024).toFixed(1)} MiB`;
  const target = expectedSize > 0 ? mib(expectedSize) : "? MiB";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    rmSync(partPath, { force: true });
    const ctl = new AbortController();
    let stallTimer = null;
    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(
        () => ctl.abort(new Error(`${stallSeconds}s 内没有收到数据`)),
        stallSeconds * 1000,
      );
    };
    try {
      armStall();
      const res = await fetch(url, {
        headers: headers(),
        redirect: "follow",
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

      let seen = 0;
      let lastBytes = 0;
      let lastAt = Date.now();
      const sha = createHash("sha256");
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          sha.update(chunk);
          seen += chunk.length;
          armStall();
          // 每 25 MiB 或每 30s 报一次：既能看到在动，也不会刷屏。
          // （两个阈值各用一个变量，别把字节数拿去跟时间戳比。）
          const now = Date.now();
          if (seen - lastBytes >= 25 * 1024 * 1024 || now - lastAt >= 30_000) {
            lastBytes = seen;
            lastAt = now;
            log(`  ${name} ${mib(seen)} / ${target}`);
          }
          cb(null, chunk);
        },
      });

      await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(partPath));
      clearTimeout(stallTimer);

      const size = statSync(partPath).size;
      if (size === 0) throw new Error("下载到 0 字节");
      // 有 sha256 就用它（最硬）；拿不到才退回字节数比对。
      // （不去重算 MD5 —— 校验和留给 make-release-notes 一次算完。）
      if (expectedSha) {
        const got = sha.digest("hex");
        if (got !== expectedSha) {
          throw new Error(`sha256 不符：拿到 ${got.slice(0, 12)}…，应为 ${expectedSha.slice(0, 12)}…`);
        }
      } else if (expectedSize > 0 && size !== expectedSize) {
        throw new Error(`字节数不符：拿到 ${size}，应为 ${expectedSize}`);
      }
      rmSync(finalPath, { force: true });
      renameSync(partPath, finalPath);
      return size;
    } catch (err) {
      clearTimeout(stallTimer);
      rmSync(partPath, { force: true });
      // 最后一个产物失败，或墙钟预算耗尽，都不再往下拖。
      const spent = Date.now() >= deadline;
      if (attempt === maxAttempts || spent) {
        throw new Error(
          `下载 ${name} 失败（${attempt}/${maxAttempts} 次）：${err.message}` +
            (spent ? "；下载阶段的墙钟预算已用尽" : ""),
        );
      }
      // 退避封顶 30s：连接超时是概率事件，等太久没有意义。
      const waitSec = Math.min(5 * attempt, 30);
      log(
        `下载 ${name} 第 ${attempt}/${maxAttempts} 次失败（${err.message}），${waitSec}s 后重试`,
      );
      await sleep(waitSec * 1000);
    }
  }
  throw new Error("unreachable");
}

async function main() {
  if (!repo || !tag) {
    console.error("需要 GITHUB_REPO（owner/repo）与 GITHUB_TAG 两个环境变量");
    process.exit(1);
  }
  log(`等待 ${repo} 的 Release ${tag}（最多 ${waitSeconds}s，每 ${pollSeconds}s 查一次）`);
  log(`资产清单来源：${ghToken ? "HTML + REST（带 token）" : "HTML + REST（匿名）"}`);
  const deadline = Date.now() + waitSeconds * 1000;
  let wanted = [];

  for (;;) {
    let assets = [];
    try {
      // 轮询期间的任何一次失败（网络抖动、限流、5xx、HTML 结构变了）都不该让
      // 整条流水线挂掉：这一轮跳过，sleep(pollSeconds) 后继续，直到预算用完。
      const got = await fetchAssets();
      assets = got.assets;
      if (!assets.length) {
        log(`Release ${tag} 还不存在（tag 刚推，GitHub 流水线可能还在跑）`);
      } else {
        const { counts, wanted: names } = selectAssets(assets);
        log(`${got.source}：${formatCounts(counts)}`);
        if (isReady(counts)) {
          wanted = names;
          log(`资产已齐（${wanted.length} 个）：`);
          for (const a of wanted) {
            console.log(`  ${a.name}  ${a.size || "?"} 字节  sha256=${(a.sha256 || "无").slice(0, 12)}`);
          }
          break;
        }
        // Release 存在但资产不齐 —— 可能是上一次同 tag 的旧 Release，或 GitHub 侧
        // 正在往里传（delete-then-recreate）。都继续等，不误判。
        log("资产还没齐，继续等");
      }
    } catch (err) {
      log(`查询失败：${err.message}`);
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
  // 资产齐了不等于网好：连接超时重试很可能把等包的时间用掉一截，所以下载阶段
  // 另起一个同样长的预算，且所有文件共享，避免最后一个文件无限重试。
  const downloadDeadline = Date.now() + waitSeconds * 1000;
  log(`开始下载 ${wanted.length} 个产物到 ${dir}/`);
  let total = 0;
  for (const [i, a] of wanted.entries()) {
    log(`[${i + 1}/${wanted.length}] ${a.name}`);
    total += await download(a.name, a.size, a.sha256, downloadDeadline);
  }
  log(`下载完成：${wanted.length} 个产物，共 ${(total / 1024 / 1024).toFixed(1)} MiB`);
}

// 直接 `node .cnb/fetch-github-release.mjs` 执行时跑主流程；设了 FETCH_LIB_ONLY=1
// 就只导出纯函数，供本地对 parseExpandedAssets / selectAssets / isReady 做单测。
// 这里刻意**不**用 `import.meta.url === pathToFileURL(process.argv[1]).href` 那套
// 惯用写法：CNB 容器里工作目录与模块真实路径一旦对不上（比如经过软链挂载），
// 比较会静默失败，主流程根本不跑，流水线会在后面「产物为 0」这种莫名其妙的地方挂。
if (process.env.FETCH_LIB_ONLY !== "1") {
  main().catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
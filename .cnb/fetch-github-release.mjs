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

/**
 * 流式下载到磁盘，不进内存。
 *
 * 为什么不用 `Buffer.from(await res.arrayBuffer())`：AppImage 有 85 MiB，整块读进
 * 内存再落盘会让容器内存尖峰，而且期间一个字都不打 —— CNB 对「无输出」有 10 分钟
 * 的超时，节点带宽再慢一点就会被判定失败。改成 pipe + 边下边报进度后，峰值内存是
 * 一个 64 KiB 的块，输出也连续不断。
 *
 * 仍然逐个校验字节数：先写 `.part`，字节数对上才 rename 到位，失败重试时把半截
 * 文件删掉 —— 绝不能把截断的文件留给后面的 MD5 / fileSize 计算。
 *
 * 还有一层「卡死」看门狗：undici 只管连接超时（10s）和响应头超时（300s），**读到一半
 * 断流不会自己报错**，fetch 会一直挂着。从 CNB 节点拉 GitHub 大文件经常卡在几十 KB/s，
 * 一挂就是十几分钟。stallSeconds 内一个字节都没进来就主动 abort，交给重试。
 *
 * 重试次数很多，但所有文件共享一个 deadline（downloadDeadline）：单个文件失败
 * 不该无限重试，整条流水线的墙钟预算也只有 2h（.cnb.yml 的 timeout: 2h）。
 */
async function download(name, expectedSize, deadline) {
  const url = `https://github.com/${repo}/releases/download/${tag}/${name}`;
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
        headers: { "User-Agent": "qt-pc-cnb-mirror" },
        redirect: "follow",
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

      let seen = 0;
      let lastBytes = 0;
      let lastAt = Date.now();
      const counter = new Transform({
        transform(chunk, _enc, cb) {
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
      // 与 Release 声明的字节数比对：截断 / 落到 HTML 错误页都能挡住。
      // （不去重算 MD5 —— 校验和留给 make-release-notes 一次算完。）
      if (expectedSize > 0 && size !== expectedSize) {
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
  // 资产齐了不等于网好：连接超时重试很可能把等包的时间用掉一截，所以下载阶段
  // 另起一个同样长的预算，且所有文件共享，避免最后一个文件无限重试。
  const downloadDeadline = Date.now() + waitSeconds * 1000;
  log(`开始下载 ${wanted.length} 个产物到 ${dir}/`);
  let total = 0;
  for (const [i, { name, size }] of wanted.entries()) {
    log(`[${i + 1}/${wanted.length}] ${name}`);
    total += await download(name, size, downloadDeadline);
  }
  log(`下载完成：${wanted.length} 个产物，共 ${(total / 1024 / 1024).toFixed(1)} MiB`);
}

main().catch((err) => {
  console.error(`::error::${err.message}`);
  process.exit(1);
});
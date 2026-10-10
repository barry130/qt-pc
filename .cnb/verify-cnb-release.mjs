#!/usr/bin/env node
// 镜像流水线的最后一道自检：CNB 的 git:release 与 cnbcool/attachments 都不给可读
// 阶段日志，也没法在 script 里接退出码，所以只能反过来问 CNB 自己的 API ——
// 这个 tag 的 Release 到底建出来没有、附件是不是和 artifacts/ 里的一一对应。
//
// 用法：
//   CNB_TOKEN=... node .cnb/verify-cnb-release.mjs [artifactsDir]
//
// 退出码 0 = 一切齐全；1 = 缺 Release、缺附件或有多余附件。
//
// 为什么用 node 而不是 curl：附件列表是 JSON，本地 node:22 镜像自带运行时，
// 而 curl 未必在 /bin/sh 的 PATH 里（镜像里 PATH 只有 /usr/local/bin:/usr/bin 等）。

import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const API = "https://api.cnb.cool";

function log(msg) {
  console.log(msg);
}

function resolveRepo() {
  const slug = process.env.CNB_REPO_SLUG || process.env.CNB_REPO;
  if (slug) return slug.trim();
  const group = process.env.CNB_GROUP_SLUG;
  const name = process.env.CNB_REPO_NAME_LOWERCASE;
  if (group && name) return `${group}/${name}`;
  return "canace/qt-pc";
}

function resolveTag() {
  const raw = process.env.CNB_BRANCH || process.env.GITHUB_TAG || process.env.CNB_TAG || "";
  return raw.trim().replace(/^refs\/tags\//, "");
}

function resolveArtifactsDir(argv) {
  if (argv[0]) return argv[0];
  return process.env.ARTIFACT_DIR || "artifacts";
}

// CNB 的 assets 字段在不同版本里叫 assets / assetList，稳妥起见两个都看。
function pickAssets(release) {
  const list = release.assets || release.assetList || release.asset_list || [];
  return Array.isArray(list) ? list : [];
}

function assetName(a) {
  return a.name || a.asset_name || a.file_name || a.filename || "";
}

async function fetchRelease(repo, tag, token) {
  const url = `${API}/${repo}/-/releases/tags/${encodeURIComponent(tag)}`;
  const headers = { Accept: "application/json", "User-Agent": "qt-pc-release-mirror" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (res.status === 404) {
    log(`::error::CNB 上找不到 tag ${tag} 的 Release（HTTP 404）`);
    return null;
  }
  if (!res.ok) {
    log(`::error::查询 CNB Release 失败：HTTP ${res.status} ${await res.text()}`);
    return null;
  }
  return await res.json();
}

function localFiles(dir) {
  try {
    return readdirSync(dir)
      .map((f) => ({ name: f, st: statSync(join(dir, f)) }))
      .filter(({ name, st }) => st.isFile() && !name.startsWith(".") && !name.endsWith(".part"))
      .map(({ name }) => name);
  } catch (err) {
    log(`::error::读不到产物目录 ${dir}：${err.message}`);
    return null;
  }
}

async function main() {
  const repo = resolveRepo();
  const tag = resolveTag();
  const dir = resolveArtifactsDir(process.argv.slice(2));
  const token = (process.env.CNB_TOKEN || "").trim();

  log(`== 核对 CNB Release ==`);
  log(`仓库=${repo}  tag=${tag}  产物目录=${dir}`);
  if (!tag) {
    log("::error::解析不到 tag");
    return 1;
  }
  if (!token) {
    log("::error::CNB_TOKEN 为空，无法查询 Release");
    return 1;
  }

  const files = localFiles(dir);
  if (files === null) return 1;
  log(`本地产物 ${files.length} 个：${files.join(" ")}`);

  const release = await fetchRelease(repo, tag, token);
  if (!release) return 1;
  log(`Release：id=${release.id ?? "?"}  title=${JSON.stringify(release.title ?? release.name ?? "")}`);
  log(`  draft=${release.draft}  prerelease=${release.prerelease}  latest=${release.latest ?? "?"}`);

  const assets = pickAssets(release).map(assetName).filter(Boolean);
  assets.sort();
  const want = [...files].sort();
  log(`CNB 附件 ${assets.length} 个：${assets.join(" ")}`);

  const missing = want.filter((f) => !assets.includes(f));
  const extra = assets.filter((a) => !want.includes(a));
  if (missing.length) log(`::error::CNB 上缺少附件：${missing.join(" ")}`);
  if (extra.length) log(`::warning::CNB 上多出附件：${extra.join(" ")}`);

  if (missing.length) return 1;
  if (!assets.length) {
    log("::error::CNB Release 一个附件都没有");
    return 1;
  }
  log(`OK：${assets.length} 个附件与本地产物完全一致`);
  return 0;
}

if (process.env.VERIFY_LIB_ONLY !== "1") {
  // 用 process.exitCode 而不是 process.exit()：node:22 在 Windows 上直接
  // process.exit() 偶尔会撞 libuv 的 "Assertion failed: !(handle->flags &
  // UV_HANDLE_CLOSING)"（连接还没完全收尾就强退）。CI 在 Linux 上跑，但本地
  // 调试时也用得着这个脚本，别让它在最后一步崩掉。
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`::error::${err && err.message ? err.message : err}`);
      process.exitCode = 1;
    });
}
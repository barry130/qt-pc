/**
 * qq / kg 全量接口压测 + 线路权重排行（2026-09-22）
 *
 * 做三件事：
 *   1. 选曲：从真实搜索里挑「Live 版」歌曲（按歌手轮转去重，保证覆盖不同歌手/专辑）；
 *   2. 整链（生产路径）：用当前 chain.json 的真实编排与预算，逐首 × 逐档取链并 Range 探测；
 *      —— 关键：区分「自身命中」与「跨源兜底命中」（qq→kw/wyy、kg→kw/wyy），
 *         否则跨源兜底会把「本平台其实全灭」伪装成成功；
 *   3. 分线路全量：把每条线路单独放进「只有它一条线 + 预算给足」的链里逐首逐档跑，
 *      得到每条线路自己的能力（成功率 / 可播率 / 速度 / 音质覆盖 / 稳定度），据此给权重排行。
 *
 * 用法：node diag-live-rank.mjs <bundle> <chain.json> [platform] [每源歌曲数]
 *   默认 platform=1103（PC 视角，能跑到全部线路），每源 12 首。
 */
import path from "node:path";
import fs from "node:fs";

const [bundlePath, chainPath, platArg = "1103", nArg = "12", srcArg = "qq,kg"] = process.argv.slice(2);
const PLATFORM = Number(platArg);
const PER_SOURCE = Number(nArg);
/** 要测的源（第 5 个参数，逗号分隔）。默认 qq,kg 与原行为一致 */
const SRC_LIST = srcArg.split(",").map((s) => s.trim()).filter(Boolean);
/** 输出文件标签：默认组合沿用原文件名，其他组合加后缀，避免不同批次互相覆盖 */
const OUT_TAG = srcArg === "qq,kg" ? `${PLATFORM}` : `${PLATFORM}-${srcArg.replace(/,/g, "-")}`;
const TIERS = ["128", "320", "flac"];
const CALL_TIMEOUT_MS = 20000;
const LOG = `F:/qtMusic/qt-pc/diag-live-rank-${OUT_TAG}.log`;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

fs.writeFileSync(LOG, "");
function say(line) {
  console.log(line);
  try {
    fs.appendFileSync(LOG, line + "\n");
  } catch {}
}

// ---------- 宿主 request（记录每一次真实 HTTP） ----------
let reqs = [];
const builtinRequest = async (url, options) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 15000);
  const t0 = Date.now();
  const rec = { url, ms: 0, status: 0, err: "" };
  reqs.push(rec);
  try {
    const res = await fetch(url, {
      method: options?.method ?? "GET",
      headers: { "User-Agent": UA, ...(options?.headers || {}) },
      body: options?.body,
      signal: controller.signal,
      redirect: "follow",
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    rec.ms = Date.now() - t0;
    rec.status = res.status;
    const headers = {};
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    return { statusCode: res.status, headers, body };
  } catch (e) {
    rec.ms = Date.now() - t0;
    rec.err = String(e?.cause?.message || e?.message || e).slice(0, 50);
    throw new Error(rec.err);
  } finally {
    clearTimeout(timer);
  }
};

const hostOf = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return String(u).slice(0, 40);
  }
};
/** 把播放地址归到「哪个平台的音源」——区分自身命中与跨源兜底 */
function urlSource(u) {
  const h = hostOf(u).toLowerCase();
  if (h.includes("qqmusic") || h.includes("qq.com")) return "qq";
  if (h.includes("kugou") || h.includes("kglink") || h.includes("kugou.com")) return "kg";
  if (h.includes("kuwo")) return "kw";
  if (h.includes("163.com") || h.includes("126.net") || h.includes("music.163")) return "wyy";
  if (h.includes("gdstudio")) return "gdstudio";
  return h;
}

globalThis.__qtHost = { request: builtinRequest, platform: PLATFORM, log: () => {} };
await import("file://" + path.resolve(bundlePath).split(path.sep).join("/"));
const rootEntries = globalThis.__qtEntries;

/** 每条线路用全新导入的 bundle：urlCache 是模块级全局，复用会让后测线路命中前一条的缓存 */
let importSeq = 0;
async function freshEntries() {
  importSeq++;
  globalThis.__qtHost = { request: builtinRequest, platform: PLATFORM, log: () => {} };
  await import("file://" + path.resolve(bundlePath).split(path.sep).join("/") + "?v=" + importSeq);
  return globalThis.__qtEntries;
}

// ---------- 真实音质探测 ----------
async function probe(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Range: "bytes=0-262143" }, redirect: "follow" });
    const cr = res.headers.get("content-range") || "";
    const m = /\/(\d+)\s*$/.exec(cr);
    const total = m ? Number(m[1]) : Number(res.headers.get("content-length") || 0);
    const b = Buffer.from(await res.arrayBuffer());
    const mb = (total / 1048576).toFixed(1);
    const meta = { status: res.status, type: (res.headers.get("content-type") || "").slice(0, 30), bytes: b.length };
    if (b.length >= 22 && b.toString("latin1", 0, 4) === "fLaC") {
      const rate = (b[18] << 12) | (b[19] << 4) | (b[20] >> 4);
      const bits = (((b[20] & 1) << 4) | (b[21] >> 4)) + 1;
      return { ok: true, kind: "FLAC", detail: `${bits}bit/${rate}Hz`, mb, ...meta };
    }
    if (b.length >= 12 && b.toString("latin1", 4, 8) === "ftyp") {
      return { ok: true, kind: "M4A", detail: "AAC", mb, ...meta };
    }
    if (b.length && (b.toString("latin1", 0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0))) {
      let off = 0;
      if (b.toString("latin1", 0, 3) === "ID3") {
        off = 10 + (((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f));
      }
      const table = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
      for (let i = off; i + 3 < Math.min(b.length, off + 200000); i++) {
        if (b[i] === 0xff && (b[i + 1] & 0xe0) === 0xe0 && ((b[i + 1] >> 3) & 3) === 3) {
          const br = table[(b[i + 2] >> 4) & 15];
          if (br) return { ok: true, kind: "MP3", detail: `${br}k`, mb, ...meta };
          break;
        }
      }
      return { ok: true, kind: "MP3", detail: "?", mb, ...meta };
    }
    return {
      ok: false,
      kind: "非音频",
      detail: `${b.length}B ${b.toString("latin1", 0, 24).replace(/[^\x20-\x7e]/g, ".")}`,
      mb,
      ...meta,
    };
  } catch (e) {
    return { ok: false, kind: "探测失败", detail: String(e?.message ?? e).slice(0, 40), mb: "0", status: 0, type: "" };
  }
}

async function call(name, args) {
  const t0 = Date.now();
  try {
    const raw = await Promise.race([
      rootEntries[name](args ?? {}),
      new Promise((_r, rej) => setTimeout(() => rej(new Error("调用超时")), CALL_TIMEOUT_MS)),
    ]);
    return { ok: true, ms: Date.now() - t0, raw };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, err: String(e?.message || e).slice(0, 160) };
  }
}

// ---------- 1. 选曲：Live 版 ----------
const LIVE_RE = /live|演唱会|现场|音乐会|巡演|concert/i;
const KEYWORDS = [
  "live",
  "演唱会",
  "周杰伦 live",
  "林俊杰 live",
  "五月天 live",
  "陈奕迅 live",
  "邓紫棋 live",
  "薛之谦 live",
  "张杰 live",
  "李荣浩 live",
  "毛不易 live",
  "华晨宇 live",
];

async function pickSongs(source) {
  const seen = new Set();
  const live = [];
  const pool = [];
  for (const kw of KEYWORDS) {
    let list = [];
    try {
      const raw = await rootEntries.search({ source, keyword: kw, page: 1, size: 30 });
      list = JSON.parse(raw).list ?? [];
    } catch {
      continue;
    }
    for (const s of list) {
      const id = String(s.id);
      if (seen.has(id)) continue;
      seen.add(id);
      const rec = { id, name: String(s.name), singer: String(s.singer), album: String(s.album ?? "") };
      pool.push(rec);
      if (LIVE_RE.test(rec.name) || LIVE_RE.test(rec.album)) live.push(rec);
    }
  }
  // 按歌手轮转，保证样本覆盖不同歌手；同歌手同名去重
  const bySinger = new Map();
  for (const s of live) {
    const key = s.singer.split(/[;；,，]/)[0].trim();
    if (!bySinger.has(key)) bySinger.set(key, []);
    bySinger.get(key).push(s);
  }
  const out = [];
  const nameSeen = new Set();
  for (let round = 0; out.length < PER_SOURCE; round++) {
    let progressed = false;
    for (const [, arr] of bySinger) {
      if (out.length >= PER_SOURCE) break;
      const s = arr[round];
      if (!s) continue;
      progressed = true;
      const nk = s.name + "|" + s.singer;
      if (nameSeen.has(nk)) continue;
      nameSeen.add(nk);
      out.push(s);
    }
    if (!progressed) break;
  }
  // Live 不够就用普通歌补齐（并标注）
  if (out.length < PER_SOURCE) {
    for (const s of pool) {
      if (out.length >= PER_SOURCE) break;
      const nk = s.name + "|" + s.singer;
      if (nameSeen.has(nk)) continue;
      nameSeen.add(nk);
      out.push({ ...s, live: false });
    }
  }
  return { songs: out.slice(0, PER_SOURCE), livePool: live.length, totalPool: pool.length };
}

// ---------- 统计工具 ----------
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mad = (a) => (a.length ? median(a.map((x) => Math.abs(x - median(a)))) : 0);
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// ---------- 主流程 ----------
const base = JSON.parse(fs.readFileSync(chainPath, "utf8"));
say("=".repeat(96));
say(`[live-rank] bundle=${path.basename(bundlePath)}  chain=${path.basename(chainPath)} (rev ${base.chainRevision})`);
say(`[live-rank] 平台=${PLATFORM}  每源歌曲数=${PER_SOURCE}  档位=${TIERS.join("/")}`);
say(`[live-rank] 整链预算=${base.budget.totalMs}/${base.budget.lineMs}ms  maxLinesPerQuality=${base.maxLinesPerQuality}`);
say("=".repeat(96));

const sources = SRC_LIST;
const selection = {};
for (const src of sources) {
  selection[src] = await pickSongs(src);
  say(`\n【选曲】${src}：Live 候选池 ${selection[src].livePool} 首，取 ${selection[src].songs.length} 首`);
  selection[src].songs.forEach((s, i) =>
    say(`   ${String(i + 1).padStart(2)}. ${s.name} / ${s.singer}  [${s.album}]  id=${s.id}`),
  );
}

// ---- 2. 整链（生产路径） ----
const chainRows = [];
say("\n" + "=".repeat(96));
say("【整链】生产路径（真实 chain.json 编排与预算）");
say("=".repeat(96));
const lc = await rootEntries.loadChain(fs.readFileSync(chainPath, "utf8"));
say(`[整链] loadChain → ${lc}`);

for (const src of sources) {
  say(`\n── 整链 ${src} ──`);
  for (const song of selection[src].songs) {
    const cells = [];
    for (const q of TIERS) {
      reqs = [];
      const t0 = Date.now();
      let url = "";
      let err = "";
      try {
        const raw = await Promise.race([
          rootEntries.getPlayUrl({
            platform: src,
            id: song.id,
            name: song.name,
            singer: song.singer,
            album: song.album,
            quality: q,
          }),
          new Promise((_r, rej) => setTimeout(() => rej(new Error("调用超时")), CALL_TIMEOUT_MS)),
        ]);
        url = JSON.parse(raw).url ?? "";
      } catch (e) {
        err = String(e?.message ?? e).slice(0, 90);
      }
      const ms = Date.now() - t0;
      const via = url ? urlSource(url) : "";
      const pr = url ? await probe(url) : null;
      chainRows.push({
        source: src,
        song: song.name,
        singer: song.singer,
        id: song.id,
        tier: q,
        url,
        via,
        ok: url.length > 0,
        playable: !!(pr && pr.ok),
        ms,
        probe: pr,
        hosts: reqs.map((r) => hostOf(r.url)),
        err,
      });
      cells.push(
        `${q.padEnd(4)}${url ? (pr?.ok ? "✅" : "⚠️") : "❌"}${url ? `${via}/${pr?.kind}${pr?.detail ?? ""}${pr?.mb ?? ""}MB` : ""}(${ms}ms)`,
      );
      if (url && !pr?.ok) {
        say(`        ↳ ${q} 地址探测不过：HTTP ${pr?.status} ${pr?.type} ${pr?.kind} ${pr?.detail}`);
      }
    }
    say(`   ${song.name.slice(0, 22).padEnd(24)} ${cells.join("  ")}`);
  }
}

// ---- 3. 分线路全量 ----
say("\n" + "=".repeat(96));
say("【分线路全量】每条线路单独成链（预算给足 15000/15000，跨源关闭）——测线路自身能力");
say("=".repeat(96));

const lineRows = [];
for (const src of sources) {
  const lines = base.chains[src] ?? [];
  for (const line of lines) {
    const platOk = !line.platforms || line.platforms.includes(PLATFORM);
    if (!platOk) {
      say(`\n── ${line.id} [${line.kind}] 平台白名单 ${JSON.stringify(line.platforms)} 不含 ${PLATFORM} → 本端不参与，跳过`);
      continue;
    }
    const single = JSON.stringify({
      chainRevision: 999,
      maxLinesPerQuality: 1,
      crossSources: {},
      budget: { totalMs: 15000, lineMs: 15000 },
      chains: { [src]: [line] },
    });
    const e2 = await freshEntries();
    const loaded = JSON.parse(await e2.loadChain(single));
    say(`\n── ${line.id} [${line.kind}] 声明档位 ${JSON.stringify(line.qualities)} loadChain=${loaded.ok} ──`);
    if (!loaded.ok) continue;
    for (const song of selection[src].songs) {
      const cells = [];
      for (const q of TIERS) {
        if (line.qualities && !line.qualities.includes(q)) {
          cells.push(`${q.padEnd(4)}—`);
          continue;
        }
        reqs = [];
        const t0 = Date.now();
        let url = "";
        let err = "";
        try {
          const raw = await Promise.race([
            e2.getPlayUrl({
              platform: src,
              id: song.id,
              name: song.name,
              singer: song.singer,
              album: song.album,
              quality: q,
            }),
            new Promise((_r, rej) => setTimeout(() => rej(new Error("调用超时")), CALL_TIMEOUT_MS)),
          ]);
          url = JSON.parse(raw).url ?? "";
        } catch (e) {
          err = String(e?.message ?? e).slice(0, 110);
        }
        const ms = Date.now() - t0;
        const pr = url ? await probe(url) : null;
        lineRows.push({
          source: src,
          line: line.id,
          lineName: line.name,
          kind: line.kind,
          song: song.name,
          id: song.id,
          tier: q,
          url,
          ok: url.length > 0,
          playable: !!(pr && pr.ok),
          ms,
          probe: pr,
          err,
        });
        cells.push(`${q.padEnd(4)}${url ? (pr?.ok ? "✅" : "⚠️") : "❌"}${url ? `${pr?.kind}${pr?.detail ?? ""}` : ""}(${ms}ms)`);
      }
      say(`   ${song.name.slice(0, 20).padEnd(22)} ${cells.join("  ")}`);
      const last = lineRows.filter((r) => r.line === line.id && r.id === song.id);
      const fail = last.find((r) => r.err);
      if (fail) say(`        ↳ 失败原因：${fail.err}`);
      for (const dead of last.filter((r) => r.ok && !r.playable)) {
        say(
          `        ↳ ${dead.tier} 返回了地址但探测不过：HTTP ${dead.probe.status} ${dead.probe.type} ` +
            `${dead.probe.kind} ${dead.probe.detail}  ${dead.url.slice(0, 110)}`,
        );
      }
    }
  }
}

// ---- 4. 权重排行 ----
say("\n" + "=".repeat(96));
say("【权重排行】口径：可播率 45% + 速度 25% + 音质覆盖 20% + 稳定度 10%");
say("  可播率 = 取到地址且 Range 探测为真实音频的比例（只算该线路声明过的档位）");
say("  速度   = 同源内按「可播请求中位耗时」归一（最快=100 分，≥5000ms=0 分）");
say("  音质   = 0.5×flac可播率 + 0.3×320可播率 + 0.2×128可播率（未声明档位记 0）");
say("  稳定度 = 1 - 中位绝对偏差/中位耗时（延迟抖动越小越高）");
say("=".repeat(96));

const ranking = {};
for (const src of sources) {
  const lines = (base.chains[src] ?? []).filter((l) => !l.platforms || l.platforms.includes(PLATFORM));
  const stat = lines.map((line) => {
    const rows = lineRows.filter((r) => r.line === line.id);
    const declared = TIERS.filter((t) => !line.qualities || line.qualities.includes(t));
    const usable = rows.filter((r) => declared.includes(r.tier));
    const playable = usable.filter((r) => r.playable);
    const lats = playable.map((r) => r.ms);
    const tierRate = {};
    for (const t of TIERS) {
      const tr = rows.filter((r) => r.tier === t);
      tierRate[t] = tr.length ? tr.filter((r) => r.playable).length / tr.length : 0;
    }
    return {
      line,
      rows,
      declared,
      total: usable.length,
      playableN: playable.length,
      P: usable.length ? playable.length / usable.length : 0,
      tierRate,
      med: median(lats),
      mad: mad(lats),
      errs: rows.filter((r) => !r.ok).map((r) => r.err).filter(Boolean),
    };
  });
  const bestMed = Math.min(...stat.filter((s) => s.med > 0).map((s) => s.med));
  for (const s of stat) {
    s.V = s.med > 0 ? 100 * clamp01(1 - (s.med - bestMed) / Math.max(1, 5000 - bestMed)) : 0;
    s.Q = 0.5 * s.tierRate.flac + 0.3 * s.tierRate["320"] + 0.2 * s.tierRate["128"];
    s.S = s.med > 0 ? 100 * clamp01(1 - s.mad / s.med) : 0;
    s.score = 45 * s.P + 0.25 * s.V + 20 * s.Q + 0.1 * s.S;
  }
  stat.sort((a, b) => b.score - a.score);
  ranking[src] = stat;

  say(`\n── ${src} 线路权重排行（${selection[src].songs.length} 首 × 声明档位）──`);
  say(
    "  排名 线路                权重分  可播率        速度分 音质覆盖(128/320/flac)  稳定度  中位耗时",
  );
  stat.forEach((s, i) => {
    const rr = (t) => `${(s.tierRate[t] * 100).toFixed(0)}%`.padStart(4);
    say(
      `   ${String(i + 1).padStart(2)}  ${s.line.id.padEnd(18)} ${s.score.toFixed(1).padStart(6)}  ` +
        `${String(s.playableN).padStart(3)}/${String(s.total).padEnd(3)} ${(s.P * 100).toFixed(0).padStart(3)}%  ` +
        `${s.V.toFixed(0).padStart(6)}  ${rr("128")}/${rr("320")}/${rr("flac")}          ` +
        `${s.S.toFixed(0).padStart(5)}  ${s.med ? s.med.toFixed(0) + "ms" : "—"}`,
    );
  });
  for (const s of stat) {
    if (s.errs.length) {
      const uniq = [...new Set(s.errs.map((e) => e.replace(/\(.*?\)/g, "").slice(0, 70)))];
      say(`   · ${s.line.id} 失败样本：${uniq.slice(0, 2).join(" | ")}`);
    }
  }
}

// ---- 5. 整链汇总 ----
say("\n" + "=".repeat(96));
say("【整链汇总】");
for (const src of sources) {
  const rows = chainRows.filter((r) => r.source === src);
  const ok = rows.filter((r) => r.ok);
  const playable = rows.filter((r) => r.playable);
  const self = playable.filter((r) => r.via === src);
  const cross = playable.filter((r) => r.via !== src && r.via !== "");
  const songsAllOk = selection[src].songs.filter((s) =>
    TIERS.every((t) => rows.some((r) => r.id === s.id && r.tier === t && r.playable)),
  ).length;
  say(`\n── ${src} ──`);
  say(`   取到地址 ${ok.length}/${rows.length}；Range 可播 ${playable.length}/${rows.length}`);
  say(`   自身命中（${src} 域名）${self.length}；跨源兜底命中 ${cross.length}（${[...new Set(cross.map((r) => r.via))].join("/") || "无"}）`);
  say(`   三档全可播的歌曲：${songsAllOk}/${selection[src].songs.length}`);
  for (const t of TIERS) {
    const tr = rows.filter((r) => r.tier === t);
    const tp = tr.filter((r) => r.playable);
    say(
      `   ${t.padEnd(4)} 可播 ${String(tp.length).padStart(2)}/${String(tr.length).padEnd(2)}` +
        `  中位 ${median(tp.map((r) => r.ms)).toFixed(0)}ms  实际音质：${[...new Set(tp.map((r) => `${r.probe.kind}${r.probe.detail}`))].slice(0, 4).join(" / ") || "—"}`,
    );
  }
}

fs.writeFileSync(
  `F:/qtMusic/qt-pc/diag-live-rank-${OUT_TAG}.json`,
  JSON.stringify(
    {
      platform: PLATFORM,
      chainRevision: base.chainRevision,
      selection: Object.fromEntries(sources.map((s) => [s, selection[s].songs])),
      chainRows,
      lineRows,
      ranking: Object.fromEntries(
        sources.map((s) => [
          s,
          ranking[s].map((x) => ({
            line: x.line.id,
            kind: x.line.kind,
            score: Number(x.score.toFixed(2)),
            playable: x.playableN,
            total: x.total,
            tierRate: x.tierRate,
            medianMs: x.med,
            madMs: x.mad,
          })),
        ]),
      ),
    },
    null,
    2,
  ),
);
say(`\n[live-rank] 完成；原始数据 → diag-live-rank-${OUT_TAG}.json`);
process.exit(0);

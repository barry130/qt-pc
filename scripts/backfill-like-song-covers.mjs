#! /usr/bin/env node
/**
 * 给 qt_like_song 里 pic_url 为空的行回填封面（一次性运维脚本，DSN 走环境变量）。
 *
 * 取封面链路与桌面端 provider / 移动端 songCover（music-api.ts:3156）完全同口径：
 *   1. 在记录的 platform（wyy/qq/kw/kg）上按「歌名 + 歌手」搜索，取前 8 条结果；
 *   2. 优先取 sid 与搜索结果 id 相同且带封面的那条（同曲目的原平台封面）；
 *      sid 对不上时退化为搜索结果里第一条带封面的（移动端同款兜底）；
 *   3. 仍没有 → 兜底网易云再搜一遍（封面覆盖最全，移动端同款兜底）；
 *   4. 更新时带 pic_url 非空守卫，不覆盖已有封面；失败不影响该行，继续下一条。
 *
 * 平台接口细节与 src-tauri/src/provider/{wyy,qq,kw,kg}.rs 一一对应：
 *   wyy: GET music.163.com/api/cloudsearch/pc   （s/type/offset/limit，Referer music.163.com）
 *   qq : GET c.y.qq.com/soso/fcgi-bin/client_search_cp（IE 内核 UA，否则接口不返回数据）
 *   kw : GET www.kuwo.cn/search/searchMusicBykeyWord（Referer www.kuwo.cn）
 *   kg : GET mobilecdnbj.kugou.com/api/v3/search/song（Referer www.kugou.com，
 *        响应里可能混有 KG_TAG_RES 注释标记，先清掉再 JSON.parse）
 *
 * 封面字段映射（与各 provider 的 song_from_* 相同）：
 *   wyy: 顶层 picUrl → al.picUrl
 *   qq : albummid → https://y.qq.com/music/photo_new/T002R300x300M000{mid}.jpg
 *   kw : web_albumpic_short（"120/…" 前缀替换为 320）→ https://img1.kuwo.cn/star/albumcover/…
 *   kg : trans_param.union_cover → cover → album_sizable_cover → imgUrl，
 *        {size}→300、http→https（normalize_kg_pic 同款）
 *
 * 用法：
 *   DSN="jdbc:postgresql://host:5432/astral?currentSchema=astral" DB_USER=astral DB_PASS=… \
 *     node scripts/backfill-like-song-covers.mjs            # 默认 dry-run：只打印将要更新的行
 *   … node scripts/backfill-like-song-covers.mjs --apply    # 真正写库
 * 可选：--limit N 只处理前 N 行；--platform kw 只处理某个平台；--debug 打印每条决策。
 */

import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Git Bash / cmd 下 stdout 码页可能是 GBK，中文歌名会乱码；统一写 UTF-8
if (process.stdout && typeof process.stdout.write === "function" && !process.stdout.isTTY) {
  // 重定向时 Node 本身按 UTF-8 写管道，无需处理；这句是占位防御
}


// ------------------------------ 参数 ------------------------------

// 控制台输出统一走 UTF-8 文件再回显，避免 Windows GBK 码页把歌名打乱码
const LOG_FILE = path.join(os.tmpdir(), `backfill-${process.pid}.log`);
const realLog = fs.openSync(LOG_FILE, "w");
function log(line = "") {
  fs.writeSync(realLog, line + "\n");
  try {
    process.stdout.write(line + "\n");
  } catch {
    // 无 stdout（双击运行等）时至少日志文件里有
  }
}
process.on("exit", () => fs.closeSync(realLog));
const console = {
  log,
  error: (m) => log(`[错误] ${m instanceof Error ? m.stack ?? m.message : m}`),
};

const { values: args } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    limit: { type: "string", short: "n" },
    platform: { type: "string" },
    debug: { type: "boolean", default: false },
  },
});

if (!args.apply) {
  console.log("[dry-run] 只打印将要更新的行，加 --apply 才会写库\n");
}

// ------------------------------ JDBC via jshell ------------------------------
// 仓库里没有 node 的 pg 驱动，但机器上有 jshell + ~/.m2 的 postgresql 驱动
// （之前统计联调就是这么直查库的）。SQL 全部参数化，杜绝注入面。

function jdbc(sql, params = []) {
  const dsn = process.env.DSN;
  const user = process.env.DB_USER;
  const pass = process.env.DB_PASS;
  if (!dsn || !user) {
    console.error("缺 DSN / DB_USER 环境变量（DB_PASS 可为空串）");
    process.exit(1);
  }
  const tmp = path.join(os.tmpdir(), `jdbc-${randomUUID()}.jsh`);
  const outFile = `${tmp}.out`;
  const script = [
    'import java.sql.*;',
    `var c = DriverManager.getConnection("${dsn}","${user}","${pass ?? ""}");`,
    "var ps = c.prepareStatement(" + JSON.stringify(sql) + ");",
    ...params.map((p, i) => `ps.set${typeof p === "number" ? "Long" : "String"}(${i + 1}, ${typeof p === "number" ? String(p) : JSON.stringify(String(p))});`),
    "var rs = ps.executeQuery();",
    "var md = rs.getMetaData();",
    `var w = new java.io.PrintWriter(new java.io.OutputStreamWriter(new java.io.FileOutputStream("${outFile.replaceAll("\\", "\\\\")}"), "UTF-8"));`,
    'while(rs.next()){var row="";for(var i=1;i<=md.getColumnCount();i++){var v=rs.getObject(i);row+=(i>1?"\\u0001":"")+(v==null?"":v.toString());}w.println(row);}',
    "w.close();",
    "c.close();",
    "/exit",
  ].join("\n");
  fs.writeFileSync(tmp, script);
  try {
    execFileSync(
      path.join(process.env.JSHELL_BIN ?? path.join(os.homedir(), ".jdks", "ms-21.0.10", "bin", "jshell.exe")),
      ["--class-path", path.join(process.env.PG_JAR ?? path.join(os.homedir(), ".m2", "repository", "org", "postgresql", "postgresql", "42.6.1", "postgresql-42.6.1.jar")), tmp],
      { encoding: "buffer", timeout: 120_000 },
    );
    // 结果走文件而不是 stdout：Windows 控制台 GBK 码页会把中文歌名打成乱码
    const raw = fs.readFileSync(outFile, "utf8");
    return raw
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("|"))
      .map((l) => l.split("\u0001"));
  } finally {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(outFile, { force: true });
  }
}

function jdbcExec(sql, params = []) {
  // UPDATE 不返回结果集，用 execute()
  const dsn = process.env.DSN;
  const user = process.env.DB_USER;
  const pass = process.env.DB_PASS;
  if (!dsn || !user) {
    console.error("缺 DSN / DB_USER 环境变量（DB_PASS 可为空串）");
    process.exit(1);
  }
  const tmp = path.join(os.tmpdir(), `jdbc-${randomUUID()}.jsh`);
  const outFile = `${tmp}.out`;
  const script = [
    'import java.sql.*;',
    `var c = DriverManager.getConnection("${dsn}","${user}","${pass ?? ""}");`,
    "var ps = c.prepareStatement(" + JSON.stringify(sql) + ");",
    ...params.map((p, i) => `ps.set${typeof p === "number" ? "Long" : "String"}(${i + 1}, ${typeof p === "number" ? String(p) : JSON.stringify(String(p))});`),
    "var n = ps.executeUpdate();",
    `var w = new java.io.PrintWriter(new java.io.OutputStreamWriter(new java.io.FileOutputStream("${outFile.replaceAll("\\", "\\\\")}"), "UTF-8"));`,
    'w.println("UPDATED\\u0001" + n);',
    "w.close();",
    "c.close();",
    "/exit",
  ].join("\n");
  fs.writeFileSync(tmp, script);
  fs.writeFileSync(`${tmp}.err`, "");
  try {
    execFileSync(
      path.join(process.env.JSHELL_BIN ?? path.join(os.homedir(), ".jdks", "ms-21.0.10", "bin", "jshell.exe")),
      ["--class-path", path.join(process.env.PG_JAR ?? path.join(os.homedir(), ".m2", "repository", "org", "postgresql", "postgresql", "42.6.1", "postgresql-42.6.1.jar")), tmp],
      { encoding: "buffer", timeout: 120_000, stdio: ["ignore", "ignore", fs.openSync(`${tmp}.err`, "a")] },
    );
    const raw = fs.readFileSync(outFile, "utf8");
    const line = raw.split("\n").find((l) => l.startsWith("UPDATED"));
    if (line) return Number(line.split("\u0001")[1]);
    // 没有结果行 = jshell 里抛了异常（如 SQL 语法/参数错误）。错误在 stderr 文件里
    const errText = fs.readFileSync(`${tmp}.err`, "utf8");
    throw new Error(`SQL 执行失败：${errText.slice(0, 500)}`);
  } finally {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(outFile, { force: true });
    fs.rmSync(`${tmp}.err`, { force: true });
  }
}

// ------------------------------ HTTP 搜索 ------------------------------

const UA = "Mozilla/5.0";
const IE_UA = "Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0)";

/** encodeURIComponent 语义（provider 里 urlencoded/urlencode 同款） */
function enc(s) {
  return encodeURIComponent(String(s));
}

async function getJson(url, headers) {
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${url.slice(0, 80)}`);
  const text = await resp.text();
  // kg 搜索响应可能混注释标记（provider get_json 同款清理）
  return JSON.parse(
    text.replaceAll("<!--KG_TAG_RES_START-->", "").replaceAll("<!--KG_TAG_RES_END-->", ""),
  );
}

/** 各平台搜索：返回 [{id, name, singer, picUrl}]，只保留带封面的前 size 条 */
async function search(platform, keyword, size = 8) {
  const kw = enc(keyword);
  if (platform === "wyy") {
    const j = await getJson(
      `https://music.163.com/api/cloudsearch/pc?s=${kw}&type=1&offset=0&limit=${size}`,
      { "User-Agent": UA, Referer: "https://music.163.com/" },
    );
    const songs = j?.result?.songs ?? [];
    return songs.map((s) => ({
      id: String(s.id ?? ""),
      name: s.name ?? "",
      singer: (s.ar ?? s.artists ?? [])?.[0]?.name ?? "",
      picUrl: s.picUrl ?? s?.al?.picUrl ?? "",
    }));
  }
  if (platform === "qq") {
    const j = await getJson(
      `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&w=${kw}&p=1&n=${size}&platform=yqq&g_tk=5381`,
      // 必须带 IE 内核 UA，否则不返回数据（provider qq.rs:27-29 注释同款）
      { "User-Agent": IE_UA, Referer: "https://y.qq.com/" },
    );
    const list = j?.data?.song?.list ?? [];
    return list.map((s) => ({
      id: s.songmid ?? s.mid ?? "",
      name: s.songname ?? s.name ?? "",
      singer: s.singer?.[0]?.name ?? "",
      picUrl: s.albummid
        ? `https://y.qq.com/music/photo_new/T002R300x300M000${s.albummid}.jpg`
        : "",
    }));
  }
  if (platform === "kw") {
    const j = await getJson(
      `https://www.kuwo.cn/search/searchMusicBykeyWord?all=${kw}&pn=0&rn=${size}&vipver=1&client=kt&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&mobi=1&issubtitle=1&show_copyright_off=1`,
      { "User-Agent": UA, Referer: "https://www.kuwo.cn/" },
    );
    const list = j?.abslist ?? [];
    return list.map((s) => {
      const short = String(s.web_albumpic_short ?? "");
      return {
        id: String(s.DC_TARGETID ?? ""),
        name: s.NAME ?? "",
        singer: s.ARTIST ?? "",
        // "120/s3s94/93/xxx.jpg" → 320 尺寸（provider kw.rs:520-523 同款）
        picUrl: short
          ? `https://img1.kuwo.cn/star/albumcover/${short.replace("120/", "320/")}`
          : "",
      };
    });
  }
  if (platform === "kg") {
    const j = await getJson(
      // 该域名证书不含自身（CDN 只给 HTTP 用），provider kg.rs:44 同款走 http
      `http://mobilecdnbj.kugou.com/api/v3/search/song?version=9108&plat=0&keyword=${kw}&page=1&pagesize=${size}`,
      { "User-Agent": UA, Referer: "https://www.kugou.com/" },
    );
    const list = j?.data?.info ?? [];
    return list.map((s) => {
      const pic =
        s.trans_param?.union_cover || s.cover || s.album_sizable_cover || s.imgUrl || "";
      // {size}→300、http→https（provider kg.rs normalize_kg_pic 同款）
      const norm = pic
        .replaceAll("{size}", "300")
        .replace(/^http:\/\//, "https://");
      return {
        id: s.hash || String(s.album_id ?? ""),
        name: s.songname ?? "",
        singer: s.singername ?? (s.filename ?? "").split(" - ")[0] ?? "",
        picUrl: norm,
      };
    });
  }
  return [];
}

/**
 * 给一行记录找封面。返回 {picUrl, via}；找不到返回 null。
 * 与移动端 songCover 的决策一致：原平台优先、结果里挑带封面的；
 * 这里多一步「sid 精确命中优先」，避免同名不同曲拿错图。
 */
async function findCover(row) {
  const keyword = row.name + (row.singer ? ` ${row.singer}` : "");
  if (!row.name) return null;

  // 本地收藏记录 platform 可能为 local 等：搜不到就当没有，不走兜底（原平台才有意义）
  if (!["wyy", "qq", "kw", "kg"].includes(row.platform)) return null;

  let results = [];
  try {
    results = await search(row.platform, keyword);
  } catch (err) {
    if (args.debug) console.log(`    搜索失败(${row.platform}): ${err.message}`);
  }

  const pick = (list) => {
    const withPic = list.filter((r) => r.picUrl);
    if (withPic.length === 0) return null;
    // sid 精确命中优先（qq mid / kg hash / wyy id / kw DC_TARGETID 同一 id 空间）
    const exact = withPic.find((r) => r.id && r.id === String(row.sid));
    if (exact) return { picUrl: exact.picUrl, via: "sid" };
    return { picUrl: withPic[0].picUrl, via: "search" };
  };

  let hit = pick(results);

  // 兜底网易云（wyy 本身没搜到就不用再兜了）
  if (!hit && row.platform !== "wyy") {
    try {
      const wyyResults = await search("wyy", keyword);
      hit = pick(wyyResults);
      if (hit) hit = { ...hit, via: "wyy-fallback" };
    } catch {
      // 兜底也失败就算了
    }
  }
  return hit;
}

// ------------------------------ 主流程 ------------------------------

async function main() {
  const where = [
    "deleted_at IS NULL",
    "(pic_url IS NULL OR pic_url = '')",
    "name IS NOT NULL AND name <> ''",
  ];
  const params = [];
  if (args.platform) {
    where.push("platform = ?");
    params.push(args.platform);
  }
  let sql = `SELECT id, sid, platform, name, singer FROM astral.qt_like_song WHERE ${where.join(" AND ")} ORDER BY id`;
  if (args.limit) {
    sql += " LIMIT ?";
    params.push(Number(args.limit));
  }

  const rows = jdbc(sql, params).map((r) => ({
    id: r[0],
    sid: r[1],
    platform: r[2],
    name: r[3],
    singer: r[4],
  }));

  console.log(`pic_url 为空的记录：${rows.length} 条${args.platform ? `（platform=${args.platform}）` : ""}`);

  // ---- 按 sid+platform 分组：同一首歌只搜一次，封面一次批量更新 ----
  // key = platform + \u0001 + sid（\u0001 不会出现在业务字段里，做连接符安全）
  const groups = new Map(); // key -> { sid, platform, name, singer, rows: [{id, …}] }
  for (const row of rows) {
    const key = `${row.platform}\u0001${row.sid}`;
    let g = groups.get(key);
    if (!g) {
      // 组内第一行作为代表：同组 sid/platform 必然相同，
      // name/singer 取首个非空的（老数据可能行间不一致）
      g = {
        sid: row.sid,
        platform: row.platform,
        name: row.name,
        singer: row.singer,
        rows: [],
      };
      groups.set(key, g);
    } else {
      if (!g.name && row.name) g.name = row.name;
      if (!g.singer && row.singer) g.singer = row.singer;
    }
    g.rows.push(row);
  }
  console.log(`去重后（sid+platform）：${groups.size} 个不同歌曲\n`);

  /** 收集 (rowId, picUrl)，攒够一批后合并成一条 UPDATE ... FROM (VALUES) */
  const pendingUpdates = [];
  const BATCH_UPDATE = 500;
  let updatedRows = 0;
  async function flushUpdates() {
    if (pendingUpdates.length === 0 || !args.apply) return;
    const batch = pendingUpdates.splice(0, pendingUpdates.length);
    // UPDATE ... FROM (VALUES ...)：一条 SQL 更新整批，行级匹配 id。
    // 占位符必须用 JDBC 的 ?（pgjdbc 会自动转成 $n）；写 $n 驱动识别不了，
    // 会出现"bind message supplies 0 parameters"（pgjdbc 按 $n 数了 100 个参数位）。
    // pic_url 非空守卫放在子查询外层：只挑仍是空的行。
    const values = batch.map(() => "(?::text, ?::bigint)");
    const params = batch.flatMap((u) => [u.picUrl, u.rowId]);
    const sqlText = [
      "UPDATE astral.qt_like_song s",
      "SET pic_url = v.pic_url, update_time = now()",
      `FROM (VALUES ${values.join(", ")}) AS v(pic_url, id)`,
      "WHERE s.id = v.id AND (s.pic_url IS NULL OR s.pic_url = '')",
    ].join(" ");
    const n = jdbcExec(sqlText, params);
    updatedRows += n;
    if (n < batch.length) {
      console.log(`  （本批 ${batch.length} 条里有 ${batch.length - n} 条已被并发更新，跳过）`);
    }
    // jshell 一次起一个 JVM，批间不需要歇；这里只是打点
    console.log(`  [批量更新] ${batch.length} 条 → 影响 ${n} 行`);
  }

  let missedRows = 0;
  let groupIdx = 0;
  for (const g of groups.values()) {
    groupIdx += 1;
    const hit = await findCover(g);
    if (!hit) {
      missedRows += g.rows.length;
      if (args.debug || g.rows.length > 1) {
        console.log(`✗ [${g.platform}] ${g.name} - ${g.singer || "?"}（sid=${g.sid}）：未找到封面，跳过 ${g.rows.length} 行`);
      }
    } else {
      const label = `[${g.platform}] ${g.name} - ${g.singer || "?"}（sid=${g.sid}）via=${hit.via}${g.rows.length > 1 ? ` ×${g.rows.length} 行` : ""}`;
      console.log(`✓ ${label}\n  → ${hit.picUrl}`);
      for (const row of g.rows) {
        pendingUpdates.push({ rowId: Number(row.id), picUrl: hit.picUrl });
      }
      if (pendingUpdates.length >= BATCH_UPDATE) await flushUpdates();
    }
    // 搜完歇口气，别把第三方接口打限流（按组歇，不再按行）
    await new Promise((r) => setTimeout(r, 300));
    if (groupIdx % 200 === 0) {
      console.log(`… 进度：${groupIdx}/${groups.size} 组`);
    }
  }
  await flushUpdates(); // 收尾批次

  const willUpdate = rows.length - missedRows;
  console.log(
    `\n完成：${args.apply ? `更新 ${updatedRows} 行（${groups.size} 组）` : `将更新 ${willUpdate} 行（dry-run）`}，未找到封面 ${missedRows} 行`,
  );
  if (!args.apply) console.log("确认无误后加 --apply 写库。");
}

main()
  .then(() => {})
  .catch((err) => {
    log(
      `[错误] 脚本失败： ${err instanceof Error ? err.stack ?? err.message : err}`,
    );
    process.exitCode = 1;
  });

/*__QT_PACK__{"kind":"meta","id":"meta-official","name":"官方数据包","versionCode":1,"versionName":"meta.1"}*/
var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
const POW16 = 65536;
const POW32 = 4294967296;
const POW = [
  1,
  2,
  4,
  8,
  16,
  32,
  64,
  128,
  256,
  512,
  1024,
  2048,
  4096,
  8192,
  16384,
  32768,
  65536,
  131072,
  262144,
  524288,
  1048576,
  2097152,
  4194304,
  8388608,
  16777216,
  33554432,
  67108864,
  134217728,
  268435456,
  536870912,
  1073741824,
  2147483648,
  4294967296
];
function u32and(a, b) {
  const ah = Math.floor(a / POW16);
  const al = a % POW16;
  const bh = Math.floor(b / POW16);
  const bl = b % POW16;
  return (ah & bh) * POW16 + (al & bl);
}
function u32or(a, b) {
  const ah = Math.floor(a / POW16);
  const al = a % POW16;
  const bh = Math.floor(b / POW16);
  const bl = b % POW16;
  return (ah | bh) * POW16 + (al | bl);
}
function u32xor(a, b) {
  const ah = Math.floor(a / POW16);
  const al = a % POW16;
  const bh = Math.floor(b / POW16);
  const bl = b % POW16;
  return (ah ^ bh) * POW16 + (al ^ bl);
}
function u32not(a) {
  return 4294967295 - a;
}
function u32add(a, b) {
  return (a + b) % POW32;
}
function u32rotl(x, n) {
  const p = POW[32 - n];
  const low = x % p;
  const high = Math.floor(x / p);
  return low * POW[n] + high;
}
const S = [
  7,
  12,
  17,
  22,
  7,
  12,
  17,
  22,
  7,
  12,
  17,
  22,
  7,
  12,
  17,
  22,
  5,
  9,
  14,
  20,
  5,
  9,
  14,
  20,
  5,
  9,
  14,
  20,
  5,
  9,
  14,
  20,
  4,
  11,
  16,
  23,
  4,
  11,
  16,
  23,
  4,
  11,
  16,
  23,
  4,
  11,
  16,
  23,
  6,
  10,
  15,
  21,
  6,
  10,
  15,
  21,
  6,
  10,
  15,
  21,
  6,
  10,
  15,
  21
];
const K = [
  3614090360,
  3905402710,
  606105819,
  3250441966,
  4118548399,
  1200080426,
  2821735955,
  4249261313,
  1770035416,
  2336552879,
  4294925233,
  2304563134,
  1804603682,
  4254626195,
  2792965006,
  1236535329,
  4129170786,
  3225465664,
  643717713,
  3921069994,
  3593408605,
  38016083,
  3634488961,
  3889429448,
  568446438,
  3275163606,
  4107603335,
  1163531501,
  2850285829,
  4243563512,
  1735328473,
  2368359562,
  4294588738,
  2272392833,
  1839030562,
  4259657740,
  2763975236,
  1272893353,
  4139469664,
  3200236656,
  681279174,
  3936430074,
  3572445317,
  76029189,
  3654602809,
  3873151461,
  530742520,
  3299628645,
  4096336452,
  1126891415,
  2878612391,
  4237533241,
  1700485571,
  2399980690,
  4293915773,
  2240044497,
  1873313359,
  4264355552,
  2734768916,
  1309151649,
  4149444226,
  3174756917,
  718787259,
  3951481745
];
function utf8Bytes(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128) {
      bytes.push(c);
    } else if (c < 2048) {
      bytes.push(192 | Math.floor(c / 64));
      bytes.push(128 | c % 64);
    } else {
      bytes.push(224 | Math.floor(c / 4096));
      bytes.push(128 | Math.floor(c / 64) % 64);
      bytes.push(128 | c % 64);
    }
  }
  return bytes;
}
function toHexLE(word) {
  const digits = "0123456789abcdef";
  let out = "";
  let w = word;
  for (let i = 0; i < 4; i++) {
    const b = w % 256;
    w = Math.floor(w / 256);
    out += digits.charAt(Math.floor(b / 16));
    out += digits.charAt(b % 16);
  }
  return out;
}
function md5Hex(text) {
  const bytes = utf8Bytes(text);
  const bitLen = bytes.length * 8;
  bytes.push(128);
  while (bytes.length % 64 != 56) bytes.push(0);
  let len = bitLen;
  for (let i = 0; i < 8; i++) {
    bytes.push(len % 256);
    len = Math.floor(len / 256);
  }
  let a0 = 1732584193;
  let b0 = 4023233417;
  let c0 = 2562383102;
  let d0 = 271733878;
  const blocks = bytes.length / 64;
  for (let block = 0; block < blocks; block++) {
    const base = block * 64;
    const m = [];
    for (let i = 0; i < 16; i++) {
      const o = base + i * 4;
      m.push(
        bytes[o] + bytes[o + 1] * 256 + bytes[o + 2] * 65536 + bytes[o + 3] * 16777216
      );
    }
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f = 0;
      let g = 0;
      if (i < 16) {
        f = u32or(u32and(b, c), u32and(u32not(b), d));
        g = i;
      } else if (i < 32) {
        f = u32or(u32and(d, b), u32and(u32not(d), c));
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = u32xor(u32xor(b, c), d);
        g = (3 * i + 5) % 16;
      } else {
        f = u32xor(c, u32or(b, u32not(d)));
        g = 7 * i % 16;
      }
      const tmp = d;
      d = c;
      c = b;
      const sum = u32add(u32add(u32add(a, f), K[i]), m[g]);
      b = u32add(b, u32rotl(sum, S[i]));
      a = tmp;
    }
    a0 = u32add(a0, a);
    b0 = u32add(b0, b);
    c0 = u32add(c0, c);
    d0 = u32add(d0, d);
  }
  return toHexLE(a0) + toHexLE(b0) + toHexLE(c0) + toHexLE(d0);
}
function kgSignature(params, apiver) {
  let key = "OIlwieks28dk2k092lksi2UIkp";
  key = "NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt";
  const list = params.split("&");
  list.sort((x, y) => x < y ? -1 : x > y ? 1 : 0);
  return md5Hex(key + list.join("") + key);
}
function platformHeaders(source) {
  const headers = { "Content-Type": "application/json" };
  if (source === "qq") headers["Referer"] = "https://y.qq.com/";
  else if (source === "kg") headers["Referer"] = "https://www.kugou.com/";
  else if (source === "kw") headers["Referer"] = "https://www.kuwo.cn/";
  else headers["Referer"] = "https://music.163.com/";
  return headers;
}
function buildQuery(params) {
  const parts = [];
  for (const key of Object.keys(params)) {
    parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(params[key]));
  }
  return parts.length > 0 ? "?" + parts.join("&") : "";
}
async function requestJson(request, url, options) {
  const res = await request(url, options);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error("HTTP " + res.statusCode);
  }
  const body = res.body;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("平台接口返回非 JSON 对象");
  }
  return body;
}
const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function decodeBase64Utf8(value) {
  if (value.length === 0) return "";
  const clean = value.replace(/[^A-Za-z0-9+/]/g, "");
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const idx = B64_CHARS.indexOf(clean.charAt(i));
    if (idx < 0) continue;
    buffer = buffer << 6 | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push(buffer >> bits & 255);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
function asObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function asArray(value) {
  return Array.isArray(value) ? value : [];
}
function asString(value) {
  return value !== null && value !== void 0 ? String(value) : "";
}
function asNumber(value) {
  return typeof value === "number" ? value : Number(value) || 0;
}
function joinSingerNames(value) {
  if (typeof value === "string") return value.trim();
  const names = [];
  for (const entry of asArray(value)) {
    const name = entry !== null && typeof entry === "object" ? asString(asObject(entry)["name"]) : asString(entry);
    const trimmed = name.trim();
    if (trimmed.length > 0 && !names.includes(trimmed)) names.push(trimmed);
  }
  return names.join("/");
}
class TtlCache {
  constructor(ttlMs) {
    __publicField(this, "inner", /* @__PURE__ */ new Map());
    this.ttlMs = ttlMs;
  }
  get(key) {
    const entry = this.inner.get(key);
    if (entry === void 0) return "";
    if (Date.now() - entry.at >= this.ttlMs) {
      this.inner.delete(key);
      return "";
    }
    return entry.value;
  }
  set(key, value) {
    if (value.length === 0) return;
    this.inner.set(key, { value, at: Date.now() });
  }
}
function normalizeKgPic(url) {
  if (url.length === 0) return "";
  let out = url.split("{size}").join("300");
  out = out.split("http://").join("https://");
  return out;
}
const KG_HEADERS = platformHeaders("kg");
const WYY_HEADERS$1 = platformHeaders("wyy");
function kgHash(raw) {
  return raw.trim().toUpperCase();
}
function kgDurationSec(value) {
  const raw = asNumber(value);
  return raw > 1e4 ? raw / 1e3 : raw;
}
async function kgNativeLyric(request, song) {
  if (song.id.length === 0) return "";
  const timelength = Math.round(song.interval * 1e3);
  if (timelength <= 0) return "";
  const res = await request(
    "https://m.kugou.com/app/i/krc.php" + buildQuery({ cmd: "100", hash: song.id, timelength: String(timelength) }),
    { headers: KG_HEADERS }
  );
  if (res.statusCode < 200 || res.statusCode >= 300) return "";
  return typeof res.body === "string" ? res.body.replace(/^\uFEFF/, "").trim() : "";
}
let kgLyricPairCache = null;
async function kgLyricWithTranslation(request, song) {
  const key = song.id + ":" + song.name + ":" + song.singer;
  const cached = kgLyricPairCache;
  if (cached != null && cached.key === key) return cached.pair;
  const native = await kgNativeLyric(request, song).catch(() => "");
  const pair = native.length > 0 ? { lyric: native, translation: "" } : await wyyLyricPairBySearch(request, song).catch(() => ({ lyric: "", translation: "" }));
  kgLyricPairCache = { key, pair };
  return pair;
}
async function wyyLyricPairBySearch(request, song) {
  const json = await requestJson(
    request,
    "https://music.163.com/api/search/get" + buildQuery({
      s: song.name + " " + song.singer,
      type: "1",
      limit: "5",
      offset: "0"
    }),
    { headers: WYY_HEADERS$1 }
  );
  const songs = asArray(asObject(json["result"])["songs"]);
  for (const raw of songs) {
    const hit = asObject(raw);
    if (!sameSongName(asString(hit["name"]), song.name)) continue;
    const id = asString(hit["id"]);
    if (id.length === 0) continue;
    const lyricJson = await requestJson(
      request,
      "https://music.163.com/api/song/lyric" + buildQuery({ id, lv: "-1", kv: "-1", tv: "-1" }),
      { headers: WYY_HEADERS$1 }
    );
    const lyric = asString(asObject(lyricJson["lrc"])["lyric"]);
    if (lyric.length === 0) continue;
    return { lyric, translation: asString(asObject(lyricJson["tlyric"])["lyric"]) };
  }
  return { lyric: "", translation: "" };
}
function sameSongName(a, b) {
  const norm = (s) => s.replace(/[（(][^）)]*[)）]/g, "").replace(/\s+/g, "").toLowerCase();
  const na = norm(a);
  return na.length > 0 && na === norm(b);
}
const KG_MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 11_0 like Mac OS X) AppleWebKit/604.1.38 (KHTML, like Gecko) Version/11.0 Mobile/15A372 Safari/604.1";
async function kgRequestJson(request, url) {
  const res = await request(url, { headers: KG_HEADERS });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error("HTTP " + res.statusCode);
  }
  const body = res.body;
  if (typeof body === "string") {
    let text = body.replace("<!--KG_TAG_RES_START-->", "");
    text = text.replace("<!--KG_TAG_RES_END-->", "");
    if (!text.startsWith("{")) {
      throw new Error("平台接口返回非 JSON 数据");
    }
    try {
      return asObject(JSON.parse(text));
    } catch {
      throw new Error("平台接口数据格式异常");
    }
  }
  return asObject(body);
}
async function directText(request, url, referer, userAgent) {
  const ref = referer != null && referer.length > 0 ? referer : "https://music.163.com/";
  const ua = userAgent != null && userAgent.length > 0 ? userAgent : "Mozilla/5.0";
  const res = await request(url, { headers: { "User-Agent": ua, "Referer": ref } });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error("HTTP " + res.statusCode);
  }
  return res.body;
}
async function kgMobileRequest(request, url) {
  const res = await request(url, {
    headers: {
      mid: "1586163242519",
      dfid: "-",
      clienttime: "1586163242519",
      Referer: "https://m3ws.kugou.com/share/index.php",
      "User-Agent": KG_MOBILE_UA
    }
  });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error("HTTP " + res.statusCode);
  }
  const responseData = res.body;
  if (typeof responseData === "string") {
    if (!responseData.startsWith("{")) {
      throw new Error("酷狗接口返回非 JSON 数据");
    }
    try {
      return asObject(JSON.parse(responseData));
    } catch {
      throw new Error("酷狗接口数据格式异常");
    }
  }
  return asObject(responseData);
}
function playlistFromKG(item) {
  const imgurl = asString(item["imgurl"]);
  const img = asString(item["img"]);
  let picUrl = "";
  if (imgurl.length > 0) picUrl = imgurl;
  else if (img.length > 0) picUrl = img;
  return {
    id: asString(item["specialid"]),
    platform: "kg",
    name: asString(item["specialname"]),
    picUrl: normalizeKgPic(picUrl),
    playCount: asString(item["playcount"])
  };
}
function chartFromKG(item) {
  return {
    id: asString(item["rankid"]),
    platform: "kg",
    name: asString(item["rankname"]),
    picUrl: asString(item["imgurl"]).replace("/{size}/", "/"),
    description: ""
  };
}
function songFromKG(item) {
  const hash = kgHash(asString(item["hash"]));
  const albumId = asString(item["album_id"]);
  const id = hash.length > 0 ? hash : albumId;
  const filename = asString(item["filename"]);
  const cover = asString(item["cover"]);
  const parts = filename.indexOf(" - ") >= 0 ? filename.split(" - ") : null;
  const singer = parts !== null ? parts[0] : "";
  const name = parts !== null ? parts[1] : filename;
  return {
    id,
    name,
    singer,
    album: "",
    picUrl: normalizeKgPic(cover),
    interval: kgDurationSec(item["duration"])
  };
}
function songFromKGRankSong(item) {
  const hash = kgHash(asString(item["hash"]));
  const albumId = asString(item["album_id"]);
  const id = hash.length > 0 ? hash : albumId;
  const filename = asString(item["filename"]);
  const songnameVal = item["songname"];
  const singersVal = item["singers"];
  const author = asString(item["author"]);
  const parts = filename.indexOf(" - ") >= 0 ? filename.split(" - ") : null;
  const singer = singersVal != null ? asString(singersVal) : parts !== null ? parts[0] : author;
  const name = songnameVal != null ? asString(songnameVal) : parts !== null ? parts[1] : filename;
  const cover = asString(item["cover"]);
  const albumSizable = item["album_sizable_cover"];
  const transParam = asObject(item["trans_param"]);
  const unionCover = asString(transParam["union_cover"]);
  const albumImg = item["imgUrl"];
  let picUrl = "";
  if (unionCover.length > 0) picUrl = unionCover;
  else if (cover.length > 0) picUrl = cover;
  else if (albumSizable != null) picUrl = asString(albumSizable);
  else if (albumImg != null) picUrl = asString(albumImg);
  picUrl = normalizeKgPic(picUrl);
  return {
    id,
    name,
    singer,
    album: "",
    picUrl,
    interval: kgDurationSec(item["duration"])
  };
}
function songFromKGSingle(item) {
  const albumId = item["album_id"];
  const hash = kgHash(asString(item["hash"]));
  const id = hash.length > 0 ? hash : albumId != null ? String(albumId) : "";
  const songname = asString(item["songname"]);
  const singername = asString(item["singername"]);
  const albumName = asString(item["album_name"]);
  const img = asString(item["img"]);
  const cover = asString(item["cover"]);
  const transParam = asObject(item["trans_param"]);
  const unionCover = asString(transParam["union_cover"]);
  const albumImg = item["imgUrl"];
  let picUrl = "";
  if (unionCover.length > 0) picUrl = unionCover;
  else if (cover.length > 0) picUrl = cover;
  else if (img.length > 0) picUrl = img;
  else if (albumImg != null) picUrl = asString(albumImg);
  picUrl = normalizeKgPic(picUrl);
  return {
    id,
    name: songname,
    singer: singername,
    album: albumName,
    picUrl,
    interval: kgDurationSec(item["duration"])
  };
}
function songFromKGChain(item) {
  const hash = kgHash(asString(item["hash"]));
  const nameRaw = asString(item["name"]);
  const parts = nameRaw.indexOf(" - ") >= 0 ? nameRaw.split(" - ") : null;
  const singer = parts !== null ? parts[0] : "";
  const name = parts !== null && parts.length > 1 ? parts[1] : nameRaw;
  const albumId = asString(item["album_id"]);
  const id = hash.length > 0 ? hash : albumId;
  const duration = kgDurationSec(item["timelen"]);
  let cover = "";
  const trans = asObject(item["trans_param"]);
  const uc = asString(trans["union_cover"]);
  if (uc.length > 0) cover = normalizeKgPic(uc);
  return {
    id,
    name,
    singer,
    album: "",
    picUrl: cover,
    interval: duration
  };
}
function songFromKGShare(item) {
  const hash = kgHash(asString(item["hash"]));
  const albumId = asString(item["album_id"]);
  const id = hash.length > 0 ? hash : albumId;
  const nameRaw = asString(item["name"]);
  let singer = "";
  let name = nameRaw;
  if (nameRaw.indexOf(" - ") >= 0) {
    const parts = nameRaw.split(" - ");
    singer = parts[0];
    name = parts.length > 1 ? parts[1] : "";
  }
  const singers = asArray(item["singerinfo"]);
  if (singers.length > 0) {
    const sn = asString(asObject(singers[0])["name"]);
    if (sn.length > 0) singer = sn;
  }
  const remark = asString(item["remark"]);
  const duration = Math.round(kgDurationSec(item["timelen"]));
  let cover = "";
  const trans = asObject(item["trans_param"]);
  const unionCover = asString(trans["union_cover"]);
  const coverRaw = asString(item["cover"]);
  if (unionCover.length > 0) cover = unionCover;
  else if (coverRaw.length > 0) cover = coverRaw;
  return {
    id,
    name,
    singer,
    album: remark,
    picUrl: normalizeKgPic(cover),
    interval: duration
  };
}
function songFromKGCollection(item) {
  const hash = kgHash(asString(item["hash"]));
  const albumId = asString(item["album_id"]);
  const id = hash.length > 0 ? hash : albumId;
  const filename = asString(item["filename"]);
  let singer = "";
  let name = filename;
  if (filename.indexOf(" - ") >= 0) {
    const parts = filename.split(" - ");
    singer = parts[0];
    name = parts.length > 1 ? parts[1] : "";
  }
  const remark = asString(item["remark"]);
  const cover = asString(item["cover"]);
  const albumSizable = item["album_sizable_cover"];
  const transParam = asObject(item["trans_param"]);
  const unionCover = asString(transParam["union_cover"]);
  const albumImg = item["imgUrl"];
  let picUrl = "";
  if (unionCover.length > 0) picUrl = unionCover;
  else if (cover.length > 0) picUrl = cover;
  else if (albumSizable != null) picUrl = asString(albumSizable);
  else if (albumImg != null) picUrl = asString(albumImg);
  picUrl = normalizeKgPic(picUrl);
  const song = {
    id,
    name,
    singer,
    album: remark,
    picUrl,
    interval: kgDurationSec(item["duration"])
  };
  if (hash.length > 0 && hash.toLowerCase() !== "nohash") song.musicId = hash;
  return song;
}
function artistFromKG(item) {
  const id = asString(item["singerid"]);
  return {
    id,
    platform: "kg",
    name: asString(item["singername"]),
    // 酷狗歌手头像：singerimg.kugou.com/uploadpic/softhead/{size}/{singerid}.jpg
    picUrl: id.length > 0 ? "https://singerimg.kugou.com/uploadpic/softhead/300/" + id + ".jpg" : ""
  };
}
function albumFromKG(item) {
  return {
    id: asString(item["albumid"]),
    platform: "kg",
    name: asString(item["albumname"]),
    artist: asString(item["singername"]),
    picUrl: normalizeKgPic(asString(item["imgurl"]))
  };
}
function isKgCollectionId(id) {
  if (id.length === 0) return false;
  if (id.indexOf("collection_") === 0) return true;
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i);
    if (c < 48 || c > 57) return true;
  }
  return false;
}
function kgMobileUrl(path, params) {
  return "https://mobiles.kugou.com/api/v5/" + path + "?" + params + "&signature=" + kgSignature(params);
}
async function kgChainPlaylist(request, code) {
  const songs = [];
  let nameVal = "";
  let picVal = "";
  let desc = null;
  let count = 0;
  const pageSize = 100;
  let page = 1;
  const maxPages = 100;
  let firstPage = true;
  let prevFirstHash = "";
  while (page <= maxPages) {
    const resp = await kgRequestJson(
      request,
      "https://m3ws.kugou.com/zlist/list" + buildQuery({ chain: code, page: String(page), pagesize: String(pageSize) })
    );
    const infoList = asArray(resp["info"]);
    if (infoList.length === 0) break;
    if (firstPage) {
      firstPage = false;
      if (infoList[0] == null) break;
      const first = asObject(infoList[0]);
      nameVal = asString(first["name"]);
      const picRaw = asString(first["pic"]);
      picVal = picRaw.length > 0 ? normalizeKgPic(picRaw) : "";
      const intro = asString(first["intro"]);
      desc = intro.length > 0 ? intro : null;
      count = asNumber(first["count"]);
    }
    const listObj = asObject(resp["list"]);
    const items = asArray(listObj["info"]);
    if (items.length === 0) break;
    if (items[0] == null) break;
    const fh = asString(asObject(items[0])["hash"]);
    if (!firstPage && fh.length > 0 && fh === prevFirstHash) break;
    prevFirstHash = fh;
    firstPage = false;
    for (const entry of items) songs.push(songFromKGChain(asObject(entry)));
    page++;
  }
  if (picVal.length === 0 && songs.length > 0) {
    picVal = songs[0].picUrl;
  }
  if (nameVal.length === 0) throw new Error("酷狗分享歌单解析失败");
  const playCountVal = count > songs.length ? count : songs.length;
  return {
    id: code,
    platform: "kg",
    name: nameVal,
    picUrl: picVal,
    playCount: String(playCountVal),
    description: desc,
    tracks: songs
  };
}
function parseGcidDecode(json) {
  const root = asObject(json);
  const data = asObject(root["data"]);
  const list = asArray(data["list"]);
  if (list.length === 0 || list[0] == null) return null;
  const id = asString(asObject(list[0])["global_collection_id"]);
  return id.length > 0 ? id : null;
}
async function kgDecodeGcid(request, gcid) {
  try {
    const params = "dfid=-&appid=1005&mid=0&clientver=20109&clienttime=640612895&uuid=-";
    const body = JSON.stringify({ ret_info: 1, data: [{ id: gcid, id_type: 2 }] });
    const kgAndroidKey = "OIlwieks28dk2k092lksi2UIkp";
    const signature = md5Hex(
      kgAndroidKey + params.split("&").sort().join("") + body + kgAndroidKey
    );
    const res = await request(
      "https://t.kugou.com/v1/songlist/batch_decode?" + params + "&signature=" + signature,
      {
        method: "POST",
        headers: {
          "User-Agent": "Mozilla/5.0 (Linux; Android 10; HUAWEI HMA-AL00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0.4103.106 Mobile Safari/537.36",
          "Referer": "https://m.kugou.com/"
        },
        body
      }
    );
    if (res.statusCode < 200 || res.statusCode >= 300) return null;
    const parsed = typeof res.body === "string" ? JSON.parse(res.body) : res.body;
    return parseGcidDecode(parsed);
  } catch {
    return null;
  }
}
async function kgGcidPlaylist(request, gcid) {
  const html = await directText(
    request,
    "https://m.kugou.com/songlist/" + gcid + "/",
    "https://m.kugou.com/",
    KG_MOBILE_UA
  );
  const outputRe = /window\.\$output\s*=\s*(\{[\s\S]*?\})\s*;\s*<\/script>/;
  const outputMatch = outputRe.exec(html);
  if (outputMatch == null || outputMatch.length < 2) throw new Error("酷狗分享歌单解析失败");
  const output = asObject(JSON.parse(outputMatch[1]));
  const infoVal = output["info"];
  if (infoVal == null) throw new Error("酷狗分享歌单解析失败");
  const info = asObject(infoVal);
  let nameVal = "";
  let picVal = "";
  let desc = null;
  let count = 0;
  const listinfo = asObject(info["listinfo"]);
  if (Object.keys(listinfo).length > 0) {
    nameVal = asString(listinfo["name"]);
    const pic = asString(listinfo["pic"]);
    picVal = pic.length > 0 ? normalizeKgPic(pic) : "";
    const intro = asString(listinfo["intro"]);
    desc = intro.length > 0 ? intro : null;
    count = asNumber(listinfo["count"]);
  }
  const songs = [];
  const rawSongs = asArray(info["songs"]);
  for (const entry of rawSongs) {
    if (entry == null) continue;
    songs.push(songFromKGShare(asObject(entry)));
  }
  if (nameVal.length === 0) throw new Error("酷狗分享歌单解析失败");
  if (picVal.length === 0 && songs.length > 0) picVal = songs[0].picUrl;
  const playCountVal = count > songs.length ? count : songs.length;
  return {
    id: gcid,
    platform: "kg",
    name: nameVal,
    picUrl: picVal,
    playCount: String(playCountVal),
    description: desc,
    tracks: songs
  };
}
async function kgSongV2Playlist(request, id) {
  const isCollection = isKgCollectionId(id);
  const idParam = isCollection ? "global_specialid=" + id + "&specialid=0" : "specialid=" + id + "&global_specialid=0";
  try {
    const baseParams = "appid=1058&" + idParam + "&plat=0&version=8000&pagesize=1000&srcappid=2919&clientver=20000&clienttime=1586163263991&mid=1586163263991&uuid=1586163263991&dfid=-";
    const response = await kgMobileRequest(
      request,
      kgMobileUrl("special/song_v2", baseParams + "&page=1")
    );
    const status = response["status"];
    if (status == null || String(status) !== "1") return null;
    const data = asObject(response["data"]);
    const songs = [];
    for (const entry of asArray(data["info"])) {
      songs.push(songFromKGCollection(asObject(entry)));
    }
    const total = asNumber(data["total"]);
    for (let page = 2; page <= 10 && songs.length < total; page += 1) {
      const pageResp = await kgMobileRequest(
        request,
        kgMobileUrl("special/song_v2", baseParams + "&page=" + page)
      );
      const pageStatus = pageResp["status"];
      if (pageStatus == null || String(pageStatus) !== "1") break;
      const pageData = asObject(pageResp["data"]);
      const pageInfo = asArray(pageData["info"]);
      if (pageInfo.length === 0) break;
      for (const entry of pageInfo) {
        songs.push(songFromKGCollection(asObject(entry)));
      }
    }
    let nameVal = "";
    let picVal = "";
    let countVal = "0";
    const infoParams = "appid=1058&" + idParam + "&format=jsonp&srcappid=2919&clientver=20000&clienttime=1586163242519&mid=1586163242519&uuid=1586163242519&dfid=-";
    const infoResp = await kgMobileRequest(request, kgMobileUrl("special/info_v2", infoParams));
    const istatus = infoResp["status"];
    if (istatus != null && String(istatus) === "1") {
      const info = asObject(infoResp["data"]);
      const specialname = info["specialname"];
      if (specialname != null) nameVal = asString(specialname);
      picVal = normalizeKgPic(asString(info["imgurl"]));
      const playcount = info["playcount"];
      if (playcount != null) countVal = String(playcount);
    }
    if (picVal.length === 0 && songs.length > 0) picVal = songs[0].picUrl;
    return {
      id,
      platform: "kg",
      name: nameVal,
      picUrl: picVal,
      playCount: countVal,
      description: null,
      tracks: songs
    };
  } catch {
    return null;
  }
}
const kg = {
  /** 蓝本 search kg 分支 :1146 */
  async search(request, keyword, page, size) {
    const json = await kgRequestJson(
      request,
      "http://mobilecdnbj.kugou.com/api/v3/search/song" + buildQuery({
        version: "9108",
        plat: "0",
        keyword,
        page: String(page),
        pagesize: String(size)
      })
    );
    const data = asObject(json["data"]);
    const out = [];
    for (const entry of asArray(data["info"])) {
      out.push(songFromKGRankSong(asObject(entry)));
    }
    return out;
  },
  /**
   * 歌词：**优先酷狗原生**（按播放键 hash 精确取词，与播放同源）。
   *
   * 蓝本 lyrics kg 分支直接用网易云搜索兜底，是因为当时酷狗歌词接口不稳定；
   * 但按歌名+歌手搜网易云再取第一条，实测经常命中同歌手的另一首
   * （《马文才》→《故里逢春》、《挪威的森林》→《泪桥》），歌词与歌曲完全无关。
   * 故改为：原生精确取词 → 取不到才回落网易云，且**必须命中同名曲**。
   */
  async lyric(request, song) {
    return (await kgLyricWithTranslation(request, song)).lyric;
  },
  /**
   * 酷狗官方歌词接口（krc.php）没有翻译字段，原生词路径恒返回空串；
   * 仅当歌词本文走了网易云同名兜底时，返回同一首的 tlyric——
   * 译文与所显示的原文严格同源同曲，不是跨源兜底。按产品约定不做其他兜底。
   */
  async lyricTranslation(request, song) {
    return (await kgLyricWithTranslation(request, song)).translation;
  },
  /** 蓝本 playlistCategories kg 分支 :571（tagids 固定六组，id 为数字字符串） */
  async playlistCategories(request) {
    const json = await kgRequestJson(
      request,
      "http://www2.kugou.kugou.com/yueku/v9/special/getSpecial?is_smarty=1"
    );
    const categories = [];
    const data = asObject(json["data"]);
    const tagids = asObject(data["tagids"]);
    const groups = ["主题", "语种", "风格", "年代", "心情", "场景"];
    for (const group of groups) {
      const items = asArray(asObject(tagids[group])["data"]);
      for (const entry of items) {
        const item = asObject(entry);
        const id = item["id"];
        const name = item["name"];
        if (id == null || name == null) continue;
        categories.push({ id: String(id), name: String(name), group: null });
      }
    }
    return categories;
  },
  /**
   * 蓝本 playlist kg 分支（music-api.ts:2928-2984）：
   * - collection_ 收藏歌单（global_specialid）→ song_v2 签名接口（须先于 chain 判断，
   *   它含字母，会被 chain 的正则误吞）
   * - gcid_ 全球歌单 → batch_decode 换 collection_ 走 song_v2 全量（SSR 分享页
   *   只渲染一批、超大歌单截断，改为兜底路径）
   * - 含字母短码（t1.kugou.com/<code>）→ zlist/list chain 接口
   * - 纯数字 specialid → song_v2 返回空 info，走 yueku HTML 解析兜底
   * （蓝本 :2939 的 isKgCollectionId 复查在本模块语境下不可达：其两个触发条件
   *  collection_ 前缀与「含非数字字符」均已被上面分支先行接住，故不再重复。）
   */
  async playlistDetail(request, id) {
    if (id.indexOf("collection_") === 0) {
      const v2 = await kgSongV2Playlist(request, id);
      if (v2 != null && v2.tracks.length > 0) return v2;
      throw new Error("酷狗歌单加载失败");
    }
    if (id.indexOf("gcid_") === 0) {
      const collectionId = await kgDecodeGcid(request, id);
      if (collectionId != null) {
        const v2 = await kgSongV2Playlist(request, collectionId);
        if (v2 != null && v2.tracks.length > 0) {
          return { ...v2, id };
        }
      }
      return kgGcidPlaylist(request, id);
    }
    if (!/^[0-9]+$/.test(id)) {
      return kgChainPlaylist(request, id);
    }
    const html = await directText(
      request,
      "http://www2.kugou.kugou.com/yueku/v9/special/single/" + id + "-6-1084.html",
      "https://www.kugou.com/"
    );
    let tracks = [];
    const dataRe = /global\.data\s*=\s*(\[[\s\S]*?\]);/;
    const dataMatch = dataRe.exec(html);
    if (dataMatch != null && dataMatch.length > 1) {
      try {
        const raw = JSON.parse(dataMatch[1]);
        for (const entry of raw) {
          tracks.push(songFromKGSingle(asObject(entry)));
        }
      } catch {
      }
    }
    let nameVal = "";
    let picVal = "";
    const infoRe = /global\s*=\s*\{[\s\S]*?id:\s*"([^"]*)"[\s\S]*?name:\s*"([^"]*)"[\s\S]*?pic:\s*"([^"]*)"[\s\S]*?\};/;
    const infoMatch = infoRe.exec(html);
    if (infoMatch != null && infoMatch.length >= 4) {
      nameVal = infoMatch[2] != null ? infoMatch[2] : "";
      picVal = infoMatch[3] != null ? infoMatch[3] : "";
    }
    if (picVal.length > 0) picVal = normalizeKgPic(picVal);
    if (picVal.length === 0 && tracks.length > 0 && tracks[0].picUrl.length > 0) {
      picVal = tracks[0].picUrl;
    }
    return {
      id,
      platform: "kg",
      name: nameVal,
      picUrl: picVal,
      playCount: "0",
      description: null,
      tracks
    };
  },
  /** 蓝本 recommendations kg 分支 :667（getSpecial，c=0 表示全部） */
  async recommendations(request, category, page) {
    const pageNo = page > 1 ? page : 1;
    const json = await kgRequestJson(
      request,
      "http://www2.kugou.kugou.com/yueku/v9/special/getSpecial" + buildQuery({
        c: category != null && category.length > 0 ? category : "0",
        t: "5",
        p: String(pageNo),
        is_ajax: "1",
        cdn: "cdn"
      })
    );
    const out = [];
    for (const entry of asArray(json["special_db"])) {
      out.push(playlistFromKG(asObject(entry)));
    }
    return out;
  },
  /** 蓝本 latest kg 分支 :765（rank/newsong，page 从 offset+1 起） */
  async latest(request, limit, offset) {
    const json = await kgRequestJson(
      request,
      "http://mobilecdnbj.kugou.com/api/v3/rank/newsong?version=9108&plat=0&with_cover=1&pagesize=" + limit + "&type=1&area_code=1&page=" + (offset + 1) + "&with_res_tag=1"
    );
    const data = asObject(json["data"]);
    const out = [];
    for (const entry of asArray(data["info"])) {
      out.push(songFromKG(asObject(entry)));
    }
    return out;
  },
  /** 蓝本 charts kg 分支 :848（rank/list parentid=0） */
  async charts(request) {
    const json = await kgRequestJson(
      request,
      "http://mobilecdnbj.kugou.com/api/v3/rank/list?version=9108&plat=0&parentid=0&withsong=0"
    );
    const data = asObject(json["data"]);
    const out = [];
    for (const entry of asArray(data["info"])) {
      out.push(chartFromKG(asObject(entry)));
    }
    return out;
  },
  /** 蓝本 chartDetail kg 分支 :2250（rank/song ranktype=2 pagesize=200；空时 throw） */
  async chartDetail(request, chart) {
    const json = await kgRequestJson(
      request,
      "http://mobilecdnbj.kugou.com/api/v3/rank/song" + buildQuery({
        version: "9108",
        ranktype: "2",
        plat: "0",
        pagesize: "200",
        area_code: "1",
        page: "1",
        rankid: chart.id,
        with_res_tag: "1"
      })
    );
    const data = asObject(json["data"]);
    const raw = asArray(data["info"]);
    if (raw.length === 0) throw new Error("酷狗榜单解析失败");
    const out = [];
    for (const entry of raw) {
      out.push(songFromKGRankSong(asObject(entry)));
    }
    return out;
  },
  /** 蓝本 hotWords kg 分支 :1047（search/hot） */
  async hotWords(request) {
    const json = await kgRequestJson(
      request,
      "http://mobilecdnbj.kugou.com/api/v3/search/hot?version=9108&plat=0"
    );
    const data = asObject(json["data"]);
    const words = [];
    for (const entry of asArray(data["info"])) {
      words.push(asString(asObject(entry)["keyword"]));
    }
    return words;
  },
  /** 蓝本 searchPlaylists kg 分支 :1473（search/special）+ playlistFromKG :362 */
  async playlistSearch(request, keyword, page, size) {
    const json = await kgRequestJson(
      request,
      "http://mobilecdnbj.kugou.com/api/v3/search/special" + buildQuery({
        version: "9108",
        plat: "0",
        keyword,
        page: String(page),
        pagesize: String(size)
      })
    );
    const data = asObject(json["data"]);
    const out = [];
    for (const entry of asArray(data["info"])) {
      out.push(playlistFromKG(asObject(entry)));
    }
    return out;
  },
  /** 蓝本 searchArtists kg 分支 :1587（search/singer，data 顶层数组）+ artistFromKG :1309 */
  async artistSearch(request, keyword, page, size) {
    const json = await kgRequestJson(
      request,
      "http://mobilecdnbj.kugou.com/api/v3/search/singer" + buildQuery({
        version: "9108",
        plat: "0",
        keyword,
        page: String(page),
        pagesize: String(size)
      })
    );
    const out = [];
    for (const entry of asArray(json["data"])) {
      out.push(artistFromKG(asObject(entry)));
    }
    return out;
  },
  /** 蓝本 searchAlbums kg 分支 :1712（search/album）+ albumFromKG :1325 */
  async albumSearch(request, keyword, page, size) {
    const json = await kgRequestJson(
      request,
      "http://mobilecdnbj.kugou.com/api/v3/search/album" + buildQuery({
        version: "9108",
        plat: "0",
        keyword,
        page: String(page),
        pagesize: String(size)
      })
    );
    const data = asObject(json["data"]);
    const out = [];
    for (const entry of asArray(data["info"])) {
      out.push(albumFromKG(asObject(entry)));
    }
    return out;
  },
  /**
   * 蓝本 albumDetail kg 分支 :1831（v3/album/info + v3/album/song）。
   * 注意参数名是 albumid（无下划线）：写 album_id 会返回 status=0。
   * info.albumname/imgurl/singername → 名称/封面（normalizeKgPic）/描述，
   * song.info → songFromKGCollection，且逐首回填 album 字段。
   */
  async albumDetail(request, id) {
    const infoJson = await kgRequestJson(
      request,
      "http://mobilecdnbj.kugou.com/api/v3/album/info" + buildQuery({ version: "9108", plat: "0", albumid: id })
    );
    const info = asObject(infoJson["data"]);
    const songJson = await kgRequestJson(
      request,
      "http://mobilecdnbj.kugou.com/api/v3/album/song" + buildQuery({ albumid: id, page: "1", pagesize: "-1" })
    );
    const songData = asObject(songJson["data"]);
    let nameVal = "";
    let picVal = "";
    let singer = "";
    if (Object.keys(info).length > 0) {
      nameVal = asString(info["albumname"]);
      const img = asString(info["imgurl"]);
      if (img.length > 0) picVal = normalizeKgPic(img);
      singer = asString(info["singername"]);
    }
    const tracks = [];
    for (const entry of asArray(songData["info"])) {
      const song = songFromKGCollection(asObject(entry));
      if (nameVal.length > 0) song.album = nameVal;
      tracks.push(song);
    }
    return {
      id,
      platform: "kg",
      name: nameVal,
      picUrl: picVal,
      playCount: String(tracks.length),
      description: singer.length > 0 ? "艺人：" + singer : null,
      tracks
    };
  }
};
let kuwoCookie = "";
let kuwoSecret = "";
function normalizeCookie(cookie) {
  const separator = cookie.indexOf(";");
  return separator >= 0 ? cookie.substring(0, separator) : cookie;
}
function kwLeadingDigits(s) {
  let i = 0;
  const len = s.length;
  if (i < len && (s.charAt(i) == "+" || s.charAt(i) == "-")) i++;
  const start = i;
  while (i < len) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) i++;
    else break;
  }
  return i > start ? s.substring(start, i) : "";
}
function kwParseInt(s) {
  const digits = kwLeadingDigits(s);
  if (digits.length == 0) return 0;
  return parseFloat(digits) ?? 0;
}
function kwToNumber(s) {
  return parseFloat(s) ?? 0;
}
function kwNumberToString(x) {
  if (x >= 0 && x == Math.floor(x) && x < 1e21) {
    return x.toString();
  }
  let s = x.toString();
  const eIdx = s.indexOf("E");
  if (eIdx < 0) return s;
  let mantissa = s.substring(0, eIdx);
  const exp = parseInt(s.substring(eIdx + 1), 10) ?? 0;
  if (mantissa.length >= 2 && mantissa.charAt(mantissa.length - 2) == "." && mantissa.charAt(mantissa.length - 1) == "0") {
    mantissa = mantissa.substring(0, mantissa.length - 2);
  }
  if (exp >= 0) return mantissa + "e+" + Math.trunc(exp).toString();
  return mantissa + "e-" + Math.trunc(-exp).toString();
}
function createKuwoSecret(cookie) {
  const firstCookie = cookie.split(";")[0];
  const separator = firstCookie.indexOf("=");
  if (separator <= 0) return "";
  const key = firstCookie.substring(0, separator);
  const value = firstCookie.substring(separator + 1);
  if (value.length == 0 || key.length == 0) return "";
  let codeText = "";
  for (let index = 0; index < key.length; index++) {
    codeText += key.charCodeAt(index).toString();
  }
  const position = Math.floor(codeText.length / 5) ?? 0;
  const factor = parseInt(
    codeText.charAt(position) + codeText.charAt(position * 2) + codeText.charAt(position * 3) + codeText.charAt(position * 4) + codeText.charAt(position * 5),
    10
  ) ?? 0;
  if (factor < 2) return "";
  const halfLength = Math.ceil(key.length / 2) ?? 0;
  const max = (Math.pow(2, 31) ?? 0) - 1;
  let seed = (Math.round(1e9 * Math.random()) ?? 0) % 1e8;
  let seedText = codeText + Math.trunc(seed).toString();
  let loopCount = 0;
  while (seedText.length > 10) {
    const first = kwParseInt(seedText.substring(0, 10));
    const remain = kwParseInt(seedText.substring(10));
    seedText = kwNumberToString(first + remain);
    loopCount++;
    if (loopCount > 50) break;
  }
  let state = (factor * kwToNumber(seedText) + halfLength) % max;
  let secret = "";
  for (let index = 0; index < value.length; index++) {
    const valueCode = value.charCodeAt(index);
    const encrypted = valueCode ^ Math.floor(state / max * 255);
    const hex = encrypted.toString(16);
    secret += hex.length < 2 ? "0" + hex : hex;
    state = (factor * state + halfLength) % max;
  }
  let suffix = Math.trunc(seed).toString(16);
  while (suffix.length < 8) suffix = "0" + suffix;
  return secret + suffix;
}
function findHmIuvtCookie(cookies) {
  for (let index = 0; index < cookies.length; index++) {
    const c = cookies[index];
    if (c.indexOf("Hm_Iuvt") >= 0) return normalizeCookie(c);
  }
  return "";
}
function applyKuwoCookie(cookies) {
  const hm = findHmIuvtCookie(cookies);
  if (hm.length > 0) {
    kuwoSecret = createKuwoSecret(hm);
  }
  let combined = "";
  for (let index = 0; index < cookies.length; index++) {
    const c = normalizeCookie(cookies[index]);
    if (c.length == 0) continue;
    if (combined.length > 0) combined += "; ";
    combined += c;
  }
  kuwoCookie = combined;
}
let kuwoReady = null;
function initKuwoCookie(request) {
  kuwoCookie = "";
  kuwoSecret = "";
  const promise = new Promise((resolve) => {
    request("https://www.kuwo.cn/", {
      method: "GET",
      headers: {
        Referer: "https://www.kuwo.cn/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:82.0) Gecko/20100101 Firefox/82.0"
      }
    }).then((response) => {
      try {
        const setCookie = response.headers["set-cookie"];
        if (setCookie != null && setCookie.length > 0) {
          const parts = setCookie.split(",");
          const parsed = [];
          for (let index = 0; index < parts.length; index++) {
            const trimmed = parts[index].split(";")[0].trim();
            if (trimmed.length > 0) parsed.push(trimmed);
          }
          if (parsed.length > 0) applyKuwoCookie(parsed);
        }
      } catch {
      }
      resolve();
    }).catch(() => {
      resolve();
    });
  });
  kuwoReady = promise;
  return promise;
}
function ensureKuwoReady(request) {
  if (kuwoReady === null) {
    return initKuwoCookie(request);
  }
  return kuwoReady;
}
async function kwRequest(request, url, method, body, retried) {
  const headers = {
    Referer: "https://www.kuwo.cn/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:82.0) Gecko/20100101 Firefox/82.0",
    // 强制绕过缓存，防止推荐接口返回旧数据
    "Cache-Control": "no-cache"
  };
  if (kuwoCookie.length > 0) headers["Cookie"] = kuwoCookie;
  if (kuwoSecret.length > 0) headers["Secret"] = kuwoSecret;
  const response = await request(url, {
    method,
    headers,
    body: void 0
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error("HTTP " + response.statusCode);
  }
  const responseData = response.body;
  let parsed;
  if (typeof responseData == "string") {
    const text = responseData;
    if (!text.startsWith("{")) {
      throw new Error("平台接口返回非 JSON 数据");
    }
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("平台接口数据格式异常");
    }
  } else if (responseData !== null && typeof responseData == "object" && !Array.isArray(responseData)) {
    parsed = responseData;
  } else {
    throw new Error("平台接口返回非 JSON 数据");
  }
  const code = parsed["code"];
  const success = parsed["success"];
  const failed = code != null && String(code) != "200" || success != null && !success;
  if (failed && retried == 0) {
    kuwoCookie = "";
    kuwoSecret = "";
    kuwoReady = null;
    await initKuwoCookie(request).catch(() => {
    });
    return kwRequest(request, url, method, body, 1);
  }
  return parsed;
}
function kuwoRequest(request, url, method, body) {
  return ensureKuwoReady(request).then(
    () => kwRequest(request, url, method, body, 0)
  );
}
function kwNumberValue(value) {
  if (value == null) return 0;
  return parseFloat(value.toString()) ?? 0;
}
function kwFormatTime(time) {
  const m = Math.floor(time / 60);
  const sec = time % 60;
  const seconds = sec.toFixed(2);
  let mm = m < 10 ? "0" + m.toString() : m.toString();
  let ss = seconds;
  if (sec < 10) ss = "0" + seconds;
  return mm + ":" + ss;
}
function assertKwOk(response) {
  const code = response["code"];
  const success = response["success"];
  const failed = code != null && String(code) != "200" || success != null && !success;
  if (failed) {
    const message = response["message"];
    throw new Error(message != null ? asString(message) : "酷我接口请求失败");
  }
}
function playlistFromKW(item) {
  return {
    id: asString(item["id"]),
    platform: "kw",
    name: asString(item["name"]),
    picUrl: asString(item["img"]),
    playCount: asString(item["listencnt"])
  };
}
function songFromKW(item) {
  const id = asString(item["rid"]);
  const name = asString(item["name"]);
  const singer = asString(item["artist"]);
  const album = asString(item["album"]);
  const picUrl = asString(item["pic"]);
  const durationVal = item["duration"];
  const duration = durationVal != null ? asNumber(durationVal) : 0;
  const musicrid = asString(item["musicrid"]);
  const musicId = musicrid.indexOf("MUSIC_") == 0 ? musicrid.substring(6) : "";
  const song = {
    id,
    name,
    singer,
    album,
    picUrl,
    interval: duration
  };
  if (musicId.length > 0) song.musicId = musicId;
  return song;
}
function songFromKWSearch(item) {
  const id = asString(item["DC_TARGETID"]);
  const name = asString(item["NAME"]);
  const singer = asString(item["ARTIST"]);
  const album = asString(item["ALBUM"]);
  const durationVal = item["DURATION"];
  const duration = durationVal != null ? parseInt(asString(durationVal), 10) || 0 : 0;
  const musicrid = asString(item["MUSICRID"]);
  const picShort = asString(item["web_albumpic_short"]);
  let picUrl = "";
  if (picShort.length > 0) {
    picUrl = "https://img1.kuwo.cn/star/albumcover/" + picShort.replace("120/", "320/");
  }
  const musicId = musicrid.indexOf("MUSIC_") == 0 ? musicrid.substring(6) : "";
  const song = {
    id,
    name,
    singer,
    album,
    picUrl,
    interval: duration
  };
  if (musicId.length > 0) song.musicId = musicId;
  return song;
}
function chartFromKW(item) {
  return {
    id: asString(item["sourceid"]),
    platform: "kw",
    name: asString(item["name"]),
    picUrl: asString(item["pic"]),
    description: asString(item["intro"])
  };
}
function artistFromKW(item) {
  return {
    id: asString(item["id"]),
    platform: "kw",
    name: asString(item["name"]),
    picUrl: asString(item["pic"])
  };
}
function albumFromKW(item) {
  return {
    id: asString(item["albumid"]),
    platform: "kw",
    name: asString(item["album"]),
    artist: asString(item["artist"]),
    picUrl: asString(item["pic"])
  };
}
async function fetchKwLyricText(request, musicId) {
  const response = await kuwoRequest(
    request,
    "https://kuwo.cn/openapi/v1/www/lyric/getlyric" + buildQuery({ musicId, httpsStatus: "1" }),
    "GET"
  );
  const data = asObject(response["data"]);
  const lrclist = asArray(data["lrclist"]);
  let text = "";
  for (const entry of lrclist) {
    const item = asObject(entry);
    const time = item["time"];
    const line = item["lineLyric"];
    if (time != null && line != null) {
      text += "[" + kwFormatTime(kwNumberValue(time)) + "]" + asString(line) + "\n";
    }
  }
  return text;
}
const kw = {
  /** 蓝本 search kw 分支 :1121（免鉴权老接口，蓝本传 source="wyy" 即无鉴权直连） */
  async search(request, keyword, page, size) {
    const query = "?all=" + encodeURIComponent(keyword) + "&pn=" + (page - 1) + "&rn=" + size + "&vipver=1&client=kt&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&mobi=1&issubtitle=1&show_copyright_off=1";
    const json = await requestJson(
      request,
      "https://www.kuwo.cn/search/searchMusicBykeyWord" + query,
      { headers: platformHeaders("wyy") }
    );
    const out = [];
    for (const entry of asArray(json["abslist"])) {
      out.push(songFromKWSearch(asObject(entry)));
    }
    return out;
  },
  /** 蓝本 lyrics kw 分支 :3048 */
  async lyric(request, song) {
    const rawMusicId = song.musicId != null && song.musicId.length > 0 && song.musicId.toLowerCase() != "nohash" ? song.musicId : song.id;
    if (rawMusicId.length == 0) return "";
    const musicId = rawMusicId.replace("MUSIC_", "");
    return fetchKwLyricText(request, musicId);
  },
  /** 蓝本 lyricTranslation kw 分支 :3173（非 wyy/local 一律返回空串） */
  async lyricTranslation(_request, _song) {
    return "";
  },
  /** 蓝本 playlistCategories kw 分支 :546（data 两层展开，id/name 均在才收录） */
  async playlistCategories(request) {
    const json = await kuwoRequest(
      request,
      "https://kuwo.cn/api/www/playlist/getTagList?httpsStatus=1",
      "GET"
    );
    const categories = [];
    for (const groupEntry of asArray(json["data"])) {
      for (const itemEntry of asArray(asObject(groupEntry)["data"])) {
        const item = asObject(itemEntry);
        const id = item["id"];
        const name = item["name"];
        if (id == null || name == null) continue;
        categories.push({ id: asString(id), name: asString(name), group: null });
      }
    }
    return categories;
  },
  /** 蓝本 playlist kw 分支 :2844（首页不 catch；翻页每页 catch 即止；封面走 nplserver 兜底） */
  async playlistDetail(request, id) {
    const songs = [];
    const rn = 30;
    const first = await kuwoRequest(
      request,
      "https://www.kuwo.cn/api/www/playlist/playListInfo" + buildQuery({ pid: id, pn: "1", rn: String(rn), httpsStatus: "1" }),
      "GET"
    );
    const data = asObject(first["data"]);
    const total = asNumber(data["total"]);
    const nameVal = asString(data["name"]);
    let picVal = asString(data["img"]);
    if (picVal.length == 0) picVal = asString(data["pic"]);
    let countVal = data["listencnt"] != null ? asString(data["listencnt"]) : "0";
    for (const entry of asArray(data["musicList"])) {
      songs.push(songFromKW(asObject(entry)));
    }
    const maxPages = total > 0 ? Math.ceil(total / rn) : 30;
    let page = 1;
    while (page < maxPages) {
      page++;
      try {
        const resp = await kuwoRequest(
          request,
          "https://www.kuwo.cn/api/www/playlist/playListInfo" + buildQuery({ pid: id, pn: String(page), rn: String(rn), httpsStatus: "1" }),
          "GET"
        );
        const d = asObject(resp["data"]);
        const list = asArray(d["musicList"]);
        if (list.length == 0) break;
        for (const entry of list) songs.push(songFromKW(asObject(entry)));
      } catch {
        break;
      }
      if (total > 0 && songs.length >= total) break;
    }
    if (picVal.length == 0) {
      try {
        const npl = await kuwoRequest(
          request,
          "https://nplserver.kuwo.cn/pl.svc?op=getlistinfo&encode=utf8&keyset=pl2012&identity=kuwo&pcmp4=1&vipver=MUSIC_9.0.5.0_W1&newver=1" + buildQuery({ pid: id, pn: "0", rn: "1" }),
          "GET"
        );
        if (asString(npl["result"]) == "ok") {
          const npic = asString(npl["pic"]);
          if (npic.length > 0) picVal = npic;
        }
      } catch {
      }
    }
    return {
      id,
      platform: "kw",
      name: nameVal,
      picUrl: picVal,
      playCount: countVal,
      description: null,
      tracks: songs
    };
  },
  /** 蓝本 recommendations kw 分支 :625（getTagPlayList / rcm+时间戳防缓存）+ assertKwOk */
  async recommendations(request, category, page) {
    const pageSize = 30;
    const pageNo = page > 1 ? page : 1;
    if (category != null && category.length > 0) {
      const json2 = await kuwoRequest(
        request,
        "https://kuwo.cn/api/www/classify/playlist/getTagPlayList" + buildQuery({
          id: category,
          rn: String(pageSize),
          pn: String(pageNo),
          httpsStatus: "1"
        }),
        "GET"
      );
      assertKwOk(json2);
      const data2 = asObject(json2["data"]);
      const out2 = [];
      for (const entry of asArray(data2["data"])) {
        out2.push(playlistFromKW(asObject(entry)));
      }
      return out2;
    }
    const recUrl = "https://www.kuwo.cn/api/www/rcm/index/playlist?rn=" + pageSize + "&pn=" + pageNo + "&id=rec&httpsStatus=1&_=" + Date.now();
    const json = await kuwoRequest(request, recUrl, "GET");
    assertKwOk(json);
    const data = asObject(json["data"]);
    const out = [];
    for (const entry of asArray(data["list"])) {
      try {
        out.push(playlistFromKW(asObject(entry)));
      } catch {
      }
    }
    return out;
  },
  /** 蓝本 latest kw 分支 :735（酷我新歌榜：bang/musicList 分页取足量，每榜只给 8 首） */
  async latest(request, limit, offset) {
    const songs = [];
    const rn = 30;
    let page = offset > 0 ? Math.ceil(offset / rn) + 1 : 1;
    let needed = limit;
    let safePages = 0;
    while (needed > 0 && safePages < 20) {
      safePages++;
      try {
        const json = await kuwoRequest(
          request,
          "https://kuwo.cn/api/www/bang/bang/musicList?bangId=17&pn=" + page + "&rn=" + rn + "&httpsStatus=1",
          "GET"
        );
        const data = asObject(json["data"]);
        const list = asArray(data["musicList"]);
        if (list.length == 0) break;
        for (let index = 0; index < list.length && needed > 0; index++) {
          songs.push(songFromKW(asObject(list[index])));
          needed--;
        }
      } catch {
        break;
      }
      page++;
    }
    return songs;
  },
  /** 蓝本 charts kw 分支 :827（bangMenu 按 category.list 两层展开）+ chartFromKW :424 */
  async charts(request) {
    const json = await kuwoRequest(
      request,
      "https://kuwo.cn/api/www/bang/bang/bangMenu?httpsStatus=1",
      "GET"
    );
    const out = [];
    for (const groupEntry of asArray(json["data"])) {
      const category = asObject(groupEntry);
      for (const listEntry of asArray(category["list"])) {
        out.push(chartFromKW(asObject(listEntry)));
      }
    }
    return out;
  },
  /** 蓝本 chartDetail kw 分支 :2223（bang/musicList 翻页 rn=30 最多 20 页，不足一页即止） */
  async chartDetail(request, chart) {
    const songs = [];
    const rn = 30;
    let page = 1;
    let safe = 0;
    while (safe < 20) {
      safe++;
      try {
        const json = await kuwoRequest(
          request,
          "https://kuwo.cn/api/www/bang/bang/musicList?bangId=" + chart.id + "&pn=" + page + "&rn=" + rn + "&httpsStatus=1",
          "GET"
        );
        const data = asObject(json["data"]);
        const list = asArray(data["musicList"]);
        if (list.length == 0) break;
        for (const entry of list) songs.push(songFromKW(asObject(entry)));
        if (list.length < rn) break;
      } catch {
        break;
      }
      page++;
    }
    return songs;
  },
  /** 蓝本 hotWords kw 分支 :1031（www/search/searchKey，kw 鉴权请求） */
  async hotWords(request) {
    const json = await kuwoRequest(
      request,
      "https://www.kuwo.cn/api/www/search/searchKey",
      "GET"
    );
    const data = asObject(json["data"]);
    const words = [];
    for (const entry of asArray(data["list"])) {
      words.push(asString(asObject(entry)["keyword"]));
    }
    return words;
  },
  /** 蓝本 searchPlaylists kw 分支 :1449（searchPlayListBykeyWord，reqId 带 pl 后缀） */
  async playlistSearch(request, keyword, page, size) {
    const json = await kuwoRequest(
      request,
      "https://www.kuwo.cn/api/www/search/searchPlayListBykeyWord" + buildQuery({
        key: keyword,
        pn: String(page),
        rn: String(size),
        httpsStatus: "1",
        reqId: Date.now().toString() + "pl"
      }),
      "GET"
    );
    const data = asObject(json["data"]);
    const out = [];
    for (const entry of asArray(data["list"])) {
      out.push(playlistFromKW(asObject(entry)));
    }
    return out;
  },
  /** 蓝本 searchArtists kw 分支 :1563（searchArtistBykeyWord，reqId 带 at 后缀）+ artistFromKW :1281 */
  async artistSearch(request, keyword, page, size) {
    const json = await kuwoRequest(
      request,
      "https://www.kuwo.cn/api/www/search/searchArtistBykeyWord" + buildQuery({
        key: keyword,
        pn: String(page),
        rn: String(size),
        httpsStatus: "1",
        reqId: Date.now().toString() + "at"
      }),
      "GET"
    );
    const data = asObject(json["data"]);
    const out = [];
    for (const entry of asArray(data["list"])) {
      out.push(artistFromKW(asObject(entry)));
    }
    return out;
  },
  /** 蓝本 searchAlbums kw 分支 :1688（searchAlbumBykeyWord，data.albumList，reqId 带 al 后缀）+ albumFromKW :1294 */
  async albumSearch(request, keyword, page, size) {
    const json = await kuwoRequest(
      request,
      "https://www.kuwo.cn/api/www/search/searchAlbumBykeyWord" + buildQuery({
        key: keyword,
        pn: String(page),
        rn: String(size),
        httpsStatus: "1",
        reqId: Date.now().toString() + "al"
      }),
      "GET"
    );
    const data = asObject(json["data"]);
    const out = [];
    for (const entry of asArray(data["albumList"])) {
      out.push(albumFromKW(asObject(entry)));
    }
    return out;
  },
  /**
   * 蓝本 albumDetail kw 分支 :1796（www/album/albumInfo，albumId 入参，
   * reqId 带 abi 后缀；data.musicList → songFromKW，描述 = 艺人：{artist}）
   */
  async albumDetail(request, id) {
    const json = await kuwoRequest(
      request,
      "https://www.kuwo.cn/api/www/album/albumInfo" + buildQuery({
        albumId: id,
        pn: "1",
        rn: "100",
        httpsStatus: "1",
        reqId: Date.now().toString() + "abi"
      }),
      "GET"
    );
    assertKwOk(json);
    const data = asObject(json["data"]);
    if (Object.keys(data).length === 0) throw new Error("专辑信息为空");
    const tracks = [];
    for (const entry of asArray(data["musicList"])) {
      tracks.push(songFromKW(asObject(entry)));
    }
    const artist = asString(data["artist"]);
    return {
      id,
      platform: "kw",
      name: asString(data["name"]),
      picUrl: asString(data["pic"]),
      playCount: String(tracks.length),
      description: artist.length > 0 ? "艺人：" + artist : null,
      tracks
    };
  }
};
const QQ_HEADERS = platformHeaders("qq");
function playlistFromQQ(item) {
  return {
    id: asString(item["dissid"]),
    platform: "qq",
    name: asString(item["dissname"]),
    picUrl: asString(item["imgurl"]),
    playCount: asString(item["listennum"])
  };
}
function songFromQQ(item) {
  const album = asObject(item["album"]);
  const albumMid = album["mid"];
  return {
    id: asString(item["mid"]),
    name: asString(item["name"]),
    singer: joinSingerNames(item["singer"]),
    album: asString(album["name"]),
    picUrl: albumMid != null ? "https://y.qq.com/music/photo_new/T002R300x300M000" + asString(albumMid) + ".jpg" : "",
    interval: item["interval"] != null ? asNumber(item["interval"]) : 0
  };
}
function chartFromQQ(item) {
  const pic = item["picUrl"];
  return {
    id: asString(item["id"]),
    platform: "qq",
    name: asString(item["topTitle"]),
    picUrl: pic != null ? asString(pic) : "",
    description: ""
  };
}
function albumFromQQ(item) {
  const mid = asString(item["albumMID"]);
  const idVal = item["albumID"];
  const albumPic = asString(item["albumPic"]);
  const id = mid.length > 0 ? mid : idVal != null ? asString(idVal) : "";
  const cover = albumPic.length > 0 ? albumPic : "https://y.qq.com/music/photo_new/T002R300x300M000" + mid + ".jpg";
  return {
    id,
    platform: "qq",
    name: asString(item["albumName"]),
    artist: asString(item["singerName"]),
    picUrl: cover
  };
}
async function qqMusicSearch(request, keyword, searchType, page, size) {
  const header = { "Content-Type": "application/json" };
  header["User-Agent"] = "Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0)";
  const json = await requestJson(request, "https://u.y.qq.com/cgi-bin/musicu.fcg", {
    method: "POST",
    headers: header,
    body: JSON.stringify({
      comm: { ct: "19", cv: "1859", uin: "0" },
      req: {
        module: "music.search.SearchCgiService",
        method: "DoSearchForQQMusicDesktop",
        param: {
          grp: 1,
          num_per_page: size,
          page_num: page,
          query: keyword,
          search_type: searchType
        }
      }
    })
  });
  const code = json["code"];
  if (code != null && code !== 0) {
    throw new Error("QQ 搜索失败");
  }
  return asObject(asObject(asObject(json["req"])["data"])["body"]);
}
function songFromQQSearch(item) {
  const idText = asString(item["songmid"]);
  const fallbackMid = asString(item["mid"]);
  const name1 = asString(item["songname"]);
  const name2 = asString(item["name"]);
  const albumMid = item["albummid"];
  return {
    id: idText.length > 0 ? idText : fallbackMid,
    name: name1.length > 0 ? name1 : name2,
    singer: joinSingerNames(item["singer"]),
    album: asString(item["albumname"]),
    picUrl: albumMid != null ? "https://y.qq.com/music/photo_new/T002R300x300M000" + asString(albumMid) + ".jpg" : "",
    interval: item["interval"] != null ? asNumber(item["interval"]) : 0
  };
}
function songFromQQDetail(item) {
  const albumMid = item["albummid"];
  return {
    id: asString(item["songmid"]),
    name: asString(item["songname"]),
    singer: joinSingerNames(item["singer"]),
    album: asString(item["albumname"]),
    picUrl: albumMid != null ? "https://y.qq.com/music/photo_new/T002R300x300M000" + asString(albumMid) + ".jpg" : "",
    interval: item["interval"] != null ? asNumber(item["interval"]) : 0
  };
}
const qq = {
  /** 蓝本 search qq 分支 :1098 */
  async search(request, keyword, page, size) {
    const json = await requestJson(
      request,
      "https://c.y.qq.com/soso/fcgi-bin/client_search_cp" + buildQuery({
        format: "json",
        w: keyword,
        p: String(page),
        n: String(size),
        platform: "yqq",
        g_tk: "5381"
      }),
      { headers: QQ_HEADERS }
    );
    const data = asObject(json["data"]);
    const song = asObject(data["song"]);
    const out = [];
    for (const entry of asArray(song["list"])) {
      out.push(songFromQQSearch(asObject(entry)));
    }
    return out;
  },
  /** 蓝本 lyrics qq 分支 :3025（retcode != 0 返回空串） */
  async lyric(request, song) {
    const json = await requestJson(
      request,
      "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?format=json&nobase64=1&g_tk=5381&songmid=" + song.id,
      { headers: QQ_HEADERS }
    );
    const retcode = json["retcode"];
    if (retcode != null && asNumber(retcode) !== 0) return "";
    return asString(json["lyric"]);
  },
  /**
   * QQ 官方翻译（musicu.fcg PlayLyricInfo.GetPlayLyricInfo 的 trans 字段，
   * base64 LRC）。实测老 fcg_query_lyric_new 端点 trans 恒为空（2026-09-19），
   * 该模块化端点才有官方翻译数据；国内歌多数无翻译 → 返回空串，不做跨源兜底。
   */
  async lyricTranslation(request, song) {
    if (song.id.length === 0) return "";
    const json = await requestJson(request, "https://u.y.qq.com/cgi-bin/musicu.fcg", {
      method: "POST",
      headers: { ...QQ_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({
        comm: { uin: 0, format: "json", ct: 24, cv: 0 },
        request: {
          module: "music.musichallSong.PlayLyricInfo",
          method: "GetPlayLyricInfo",
          param: { songMID: song.id, songID: 0, qrc: 1, ipc: 1, trans: 1 }
        }
      })
    });
    const payload = asObject(json["request"]);
    if (asNumber(payload["code"]) !== 0) return "";
    const decoded = decodeBase64Utf8(asString(asObject(payload["data"])["trans"]));
    return decoded.split("\n").filter((line) => line.replace(/^\[[^\]]*\]/, "").trim() !== "//").join("\n");
  },
  /** 蓝本 playlistCategories qq 分支 :512（categories 分组的 items，id=categoryId） */
  async playlistCategories(request) {
    const json = await requestJson(
      request,
      "https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_tag_conf.fcg?format=json&inCharset=utf8&outCharset=utf-8",
      { headers: QQ_HEADERS }
    );
    const categories = [];
    const data = asObject(json["data"]);
    for (const groupEntry of asArray(data["categories"])) {
      const items = asArray(asObject(groupEntry)["items"]);
      for (const itemEntry of items) {
        const item = asObject(itemEntry);
        const id = item["categoryId"];
        const name = item["categoryName"];
        if (id == null || name == null) continue;
        categories.push({ id: asString(id), name: asString(name), group: null });
      }
    }
    return categories;
  },
  /** 蓝本 playlist qq 分支 :2826（封面 logo 回退 dir_pic_url；playCount 读 listen_num） */
  async playlistDetail(request, id) {
    const json = await requestJson(
      request,
      "https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg" + buildQuery({
        type: "1",
        json: "1",
        utf8: "1",
        onlysong: "0",
        disstid: id,
        format: "json",
        g_tk: "5381"
      }),
      { headers: QQ_HEADERS }
    );
    const cdlist = asArray(json["cdlist"]);
    const pl = cdlist.length > 0 ? asObject(cdlist[0]) : {};
    const tracks = [];
    for (const entry of asArray(pl["songlist"])) {
      tracks.push(songFromQQDetail(asObject(entry)));
    }
    let picVal = pl["logo"];
    if (picVal == null || asString(picVal).length == 0) picVal = pl["dir_pic_url"];
    const countVal = pl["listen_num"];
    return {
      id,
      platform: "qq",
      name: asString(pl["dissname"]),
      picUrl: picVal != null ? asString(picVal) : "",
      playCount: countVal != null ? asString(countVal) : "0",
      description: null,
      tracks
    };
  },
  /** 蓝本 recommendations qq 分支 :611（categoryId 空=10000000；sin/ein 分页）+ playlistFromQQ :229 */
  async recommendations(request, category, page) {
    const pageSize = 30;
    const offset = (page - 1) * pageSize;
    const categoryId = category != null && category.length > 0 ? category : "10000000";
    const json = await requestJson(
      request,
      "https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg?picmid=1&g_tk=732560869&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0&categoryId=" + categoryId + "&sortId=2&sin=" + offset + "&ein=" + (offset + pageSize - 1),
      { headers: QQ_HEADERS }
    );
    const data = asObject(json["data"]);
    const out = [];
    for (const entry of asArray(data["list"])) {
      out.push(playlistFromQQ(asObject(entry)));
    }
    return out;
  },
  /** 蓝本 latest qq 分支 :717（musicu.fcg new_song.get_new_song_info；QQ 不使用 offset）+ songFromQQ :243 */
  async latest(request, limit, _offset) {
    const json = await requestJson(
      request,
      "https://u.y.qq.com/cgi-bin/musicu.fcg",
      {
        method: "POST",
        headers: QQ_HEADERS,
        body: JSON.stringify({
          comm: { ct: 24, cv: 0 },
          new_song: {
            module: "newsong.NewSongServer",
            method: "get_new_song_info",
            param: { type: 5 }
          }
        })
      }
    );
    const container = asObject(json["new_song"]);
    const data = asObject(container["data"]);
    const raw = asArray(data["songlist"]);
    const out = [];
    for (let index = 0; index < raw.length && index < limit; index++) {
      out.push(songFromQQ(asObject(raw[index])));
    }
    return out;
  },
  /** 蓝本 charts qq 分支 :824（fcg_myqq_toplist.fcg）+ chartFromQQ :411 */
  async charts(request) {
    const json = await requestJson(
      request,
      "https://c.y.qq.com/v8/fcg-bin/fcg_myqq_toplist.fcg?format=json&g_tk=5381&uin=0",
      { headers: QQ_HEADERS }
    );
    const data = asObject(json["data"]);
    const out = [];
    for (const entry of asArray(data["topList"])) {
      out.push(chartFromQQ(asObject(entry)));
    }
    return out;
  },
  /** 蓝本 chartDetail qq 分支 :2203（fcg_v8_toplist_cp.fcg topid；songlist[i].data → songFromQQDetail） */
  async chartDetail(request, chart) {
    const json = await requestJson(
      request,
      "https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg" + buildQuery({
        topid: chart.id,
        format: "json",
        page: "1",
        type: "top",
        song_begin: "0",
        song_num: "200",
        g_tk: "5381"
      }),
      { headers: QQ_HEADERS }
    );
    const out = [];
    for (const entry of asArray(json["songlist"])) {
      out.push(songFromQQDetail(asObject(asObject(entry)["data"])));
    }
    return out;
  },
  /** 蓝本 hotWords qq 分支 :1019（gethotkey.fcg，data.hotkey[].k） */
  async hotWords(request) {
    const json = await requestJson(
      request,
      "https://c.y.qq.com/hotcgi.qq.com/splcloud/fcgi-bin/gethotkey.fcg?format=json&g_tk=5381",
      { headers: QQ_HEADERS }
    );
    const data = asObject(json["data"]);
    const words = [];
    for (const entry of asArray(data["hotkey"])) {
      words.push(asString(asObject(entry)["k"]));
    }
    return words;
  },
  /**
   * 蓝本 searchPlaylists qq 分支 :1413（qqMusicSearch search_type=3 → body.songlist.list；
   * 整体 try/catch，失败返回空数组）
   */
  async playlistSearch(request, keyword, page, size) {
    try {
      const qqBody = await qqMusicSearch(request, keyword, 3, page, size);
      const lists = [];
      for (const entry of asArray(asObject(qqBody["songlist"])["list"])) {
        const item = asObject(entry);
        const idVal = item["dissid"];
        const countVal = item["listennum"];
        lists.push({
          id: idVal != null ? asString(idVal) : "",
          platform: "qq",
          name: asString(item["dissname"]),
          picUrl: asString(item["imgurl"]),
          playCount: countVal != null ? asString(countVal) : "0"
        });
      }
      return lists;
    } catch {
      return [];
    }
  },
  /** 蓝本 searchArtists qq 分支 :1512（client_search_cp t=2；data.zhida.zhida_singer 单个直达歌手） */
  async artistSearch(request, keyword, page, size) {
    const json = await requestJson(
      request,
      "https://c.y.qq.com/soso/fcgi-bin/client_search_cp" + buildQuery({
        format: "json",
        w: keyword,
        t: "2",
        p: String(page),
        n: String(size),
        platform: "yqq",
        g_tk: "5381",
        remoteplace: "txt.yqq.search",
        catZhida: "1"
      }),
      { headers: QQ_HEADERS }
    );
    const data = asObject(json["data"]);
    const zhida = asObject(data["zhida"]);
    const singerObj = asObject(zhida["zhida_singer"]);
    const mid = asString(singerObj["singerMID"]);
    const pic = asString(singerObj["singerPic"]);
    const artists = [];
    if (mid.length > 0) {
      artists.push({
        id: mid,
        platform: "qq",
        name: asString(singerObj["singerName"]),
        picUrl: pic.length > 0 ? pic : "https://y.qq.com/music/photo_new/T001R300x300M000" + mid + ".jpg"
      });
    }
    return artists;
  },
  /** 蓝本 searchAlbums qq 分支 :1671（client_search_cp t=8）+ albumFromQQ :1255 */
  async albumSearch(request, keyword, page, size) {
    const json = await requestJson(
      request,
      "https://c.y.qq.com/soso/fcgi-bin/client_search_cp" + buildQuery({
        format: "json",
        w: keyword,
        t: "8",
        p: String(page),
        n: String(size),
        platform: "yqq",
        g_tk: "5381"
      }),
      { headers: QQ_HEADERS }
    );
    const data = asObject(json["data"]);
    const album = data["album"];
    const albums = [];
    if (album != null) {
      for (const entry of asArray(asObject(album)["list"])) {
        albums.push(albumFromQQ(asObject(entry)));
      }
    }
    return albums;
  },
  /**
   * 蓝本 albumDetail qq 分支 :1760（fcg_v8_album_info_cp.fcg，albummid 入参；
   * data.list → songFromQQSearch；封面 = T002R500x500M000{albummid}.jpg）
   */
  async albumDetail(request, id) {
    const json = await requestJson(
      request,
      "https://c.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg" + buildQuery({
        albummid: id,
        format: "json",
        platform: "yqq",
        g_tk: "5381"
      }),
      { headers: QQ_HEADERS }
    );
    const data = asObject(json["data"]);
    const tracks = [];
    for (const entry of asArray(data["list"])) {
      tracks.push(songFromQQSearch(asObject(entry)));
    }
    const mid = asString(data["albummid"]);
    return {
      id,
      platform: "qq",
      name: asString(data["name"]),
      picUrl: mid.length > 0 ? "https://y.qq.com/music/photo_new/T002R500x500M000" + mid + ".jpg" : "",
      playCount: String(tracks.length),
      description: null,
      tracks
    };
  }
};
const WYY_HEADERS = platformHeaders("wyy");
function songFromWyy(item) {
  const songData = asObject(item["song"]);
  const merged = Object.keys(songData).length > 0 ? songData : item;
  const artistList = asArray(merged["artists"]);
  const arList = asArray(merged["ar"]);
  const finalArtists = artistList.length > 0 ? artistList : arList;
  const albumData = asObject(merged["album"]).id !== void 0 ? asObject(merged["album"]) : asObject(merged["al"]);
  const albumObj = Object.keys(albumData).length > 0 ? albumData : {};
  const cover = asString(item["picUrl"]);
  const albumCover = asString(albumObj["picUrl"]);
  return {
    id: asString(item["id"]),
    name: asString(item["name"]),
    singer: joinSingerNames(finalArtists),
    album: asString(albumObj["name"]),
    picUrl: cover.length > 0 ? cover : albumCover,
    interval: merged["duration"] !== void 0 ? asNumber(merged["duration"]) / 1e3 : merged["dt"] !== void 0 ? asNumber(merged["dt"]) / 1e3 : 0
  };
}
function songFromWyyDetail(item) {
  const arList = asArray(item["ar"]);
  const al = asObject(item["al"]);
  return {
    id: asString(item["id"]),
    name: asString(item["name"]),
    singer: joinSingerNames(arList),
    album: asString(al["name"]),
    picUrl: asString(al["picUrl"]),
    interval: item["dt"] !== void 0 ? asNumber(item["dt"]) / 1e3 : 0
  };
}
async function wyySongDetail(request, ids) {
  const batchSize = 300;
  const all = [];
  for (let start = 0; start < ids.length; start += batchSize) {
    const batch = ids.slice(start, start + batchSize);
    const c = batch.map((x) => '{"id":' + x + "}").join(",");
    const body = await requestJson(
      request,
      "https://music.163.com/api/v3/song/detail",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: "https://music.163.com/"
        },
        body: "c=[" + c + "]"
      }
    ).catch(() => null);
    if (body === null) continue;
    for (const entry of asArray(body["songs"])) {
      all.push(songFromWyyDetail(asObject(entry)));
    }
  }
  return all;
}
const wyy = {
  /** 蓝本 search wyy 分支 :1180 */
  async search(request, keyword, page, size) {
    const json = await requestJson(
      request,
      "https://music.163.com/api/cloudsearch/pc" + buildQuery({
        s: keyword,
        type: "1",
        offset: String((page - 1) * size),
        limit: String(size)
      }),
      { headers: WYY_HEADERS }
    );
    const result = asObject(json["result"]);
    const out = [];
    for (const entry of asArray(result["songs"])) {
      out.push(songFromWyy(asObject(entry)));
    }
    return out;
  },
  /** 蓝本 lyrics wyy 分支 :3012 */
  async lyric(request, song) {
    const json = await requestJson(
      request,
      "https://music.163.com/api/song/lyric" + buildQuery({ id: song.id, lv: "-1", kv: "-1", tv: "-1" }),
      { headers: WYY_HEADERS }
    );
    return asString(asObject(json["lrc"])["lyric"]);
  },
  /** 蓝本 lyricTranslation wyy 分支 :3173（tlyric） */
  async lyricTranslation(request, song) {
    const json = await requestJson(
      request,
      "https://music.163.com/api/song/lyric" + buildQuery({ id: song.id, lv: "-1", kv: "-1", tv: "-1" }),
      { headers: WYY_HEADERS }
    );
    return asString(asObject(json["tlyric"])["lyric"]);
  },
  /** 蓝本 playlistCategories wyy 分支 :494（按分类名筛选，id 即名称） */
  async playlistCategories(request) {
    const json = await requestJson(
      request,
      "https://music.163.com/api/playlist/highquality/tags",
      { headers: WYY_HEADERS }
    );
    const categories = [];
    for (const entry of asArray(json["tags"])) {
      const name = asString(asObject(entry)["name"]);
      if (name.length === 0) continue;
      categories.push({ id: name, name, group: null });
    }
    return categories;
  },
  /** 蓝本 playlist wyy 分支 :2752（trackIds 全量 + 1000/批 detail；回退 tracks） */
  async playlistDetail(request, id) {
    const json = await requestJson(
      request,
      "https://music.163.com/api/v6/playlist/detail" + buildQuery({ id, n: "100000" }),
      { headers: WYY_HEADERS }
    );
    const pl = asObject(json["playlist"]);
    const songIds = [];
    for (const entry of asArray(pl["trackIds"])) {
      const sid = asString(asObject(entry)["id"]);
      if (sid.length > 0) songIds.push(sid);
    }
    let tracks = [];
    if (songIds.length > 0) {
      tracks = await wyySongDetail(request, songIds);
    }
    if (tracks.length === 0) {
      for (const entry of asArray(pl["tracks"])) {
        tracks.push(songFromWyyDetail(asObject(entry)));
      }
    }
    return {
      id,
      platform: "wyy",
      name: asString(pl["name"]),
      picUrl: asString(pl["coverImgUrl"]),
      playCount: pl["playCount"] !== void 0 ? asString(pl["playCount"]) : "0",
      description: null,
      tracks
    };
  },
  /** 蓝本 recommendations wyy 分支 :686 */
  async recommendations(request, category, page) {
    const json = await requestJson(
      request,
      "https://music.163.com/api/playlist/list" + buildQuery({
        cat: category !== null && category.length > 0 ? category : "全部",
        limit: "30",
        offset: String((page - 1) * 30),
        total: "true"
      }),
      { headers: WYY_HEADERS }
    );
    const out = [];
    for (const entry of asArray(json["playlists"])) {
      const item = asObject(entry);
      out.push({
        id: asString(item["id"]),
        platform: "wyy",
        name: asString(item["name"]),
        picUrl: asString(item["coverImgUrl"]),
        playCount: asString(item["playCount"])
      });
    }
    return out;
  },
  /** 蓝本 latest wyy 分支 :786 */
  async latest(request, limit, offset) {
    const json = await requestJson(
      request,
      "https://music.163.com/api/v1/discovery/new/songs" + buildQuery({ limit: String(limit), offset: String(offset), total: "true", areaId: "0" }),
      { headers: WYY_HEADERS }
    );
    const out = [];
    for (const entry of asArray(json["data"])) {
      out.push(songFromWyy(asObject(entry)));
    }
    return out;
  },
  /** 蓝本 charts wyy 分支 :798 + chartFromWyy :397 */
  async charts(request) {
    const json = await requestJson(
      request,
      "https://music.163.com/api/toplist",
      { headers: WYY_HEADERS }
    );
    const out = [];
    for (const entry of asArray(json["list"])) {
      const item = asObject(entry);
      const desc = asString(item["description"]);
      out.push({
        id: asString(item["id"]),
        platform: "wyy",
        name: asString(item["name"]),
        picUrl: asString(item["coverImgUrl"]),
        description: desc.length > 0 ? desc : null
      });
    }
    return out;
  },
  /** 蓝本 chartDetail wyy 分支 :2183（v6/playlist/detail n=500） */
  async chartDetail(request, chart) {
    const json = await requestJson(
      request,
      "https://music.163.com/api/v6/playlist/detail" + buildQuery({ id: chart.id, n: "500" }),
      { headers: WYY_HEADERS }
    );
    const playlistData = asObject(json["playlist"]);
    const out = [];
    for (const entry of asArray(playlistData["tracks"])) {
      out.push(songFromWyyDetail(asObject(entry)));
    }
    return out;
  },
  /** 蓝本 hotWords wyy 分支 :1052 */
  async hotWords(request) {
    const json = await requestJson(
      request,
      "https://music.163.com/api/search/hot",
      { headers: WYY_HEADERS }
    );
    const result = asObject(json["result"]);
    const words = [];
    for (const entry of asArray(result["hots"])) {
      words.push(asString(asObject(entry)["first"]));
    }
    return words;
  },
  /** 蓝本 searchPlaylists wyy 分支 :1488（type=1000）+ playlistFromWyySearch :1201 */
  async playlistSearch(request, keyword, page, size) {
    const json = await requestJson(
      request,
      "https://music.163.com/api/search/get" + buildQuery({
        s: keyword,
        type: "1000",
        limit: String(size),
        offset: String((page - 1) * size)
      }),
      { headers: WYY_HEADERS }
    );
    const result = asObject(json["result"]);
    const out = [];
    for (const entry of asArray(result["playlists"])) {
      const item = asObject(entry);
      out.push({
        id: asString(item["id"]),
        platform: "wyy",
        name: asString(item["name"]),
        picUrl: asString(item["coverImgUrl"]),
        playCount: asString(item["playCount"])
      });
    }
    return out;
  },
  /** 蓝本 searchArtists wyy 分支 :1585（type=100）+ artistFromWyy :1226 */
  async artistSearch(request, keyword, page, size) {
    const json = await requestJson(
      request,
      "https://music.163.com/api/search/get" + buildQuery({
        s: keyword,
        type: "100",
        limit: String(size),
        offset: String((page - 1) * size)
      }),
      { headers: WYY_HEADERS }
    );
    const result = asObject(json["result"]);
    const out = [];
    for (const entry of asArray(result["artists"])) {
      const item = asObject(entry);
      out.push({
        id: asString(item["id"]),
        platform: "wyy",
        name: asString(item["name"]),
        picUrl: asString(item["picUrl"])
      });
    }
    return out;
  },
  /** 蓝本 searchAlbums wyy 分支 :1725（type=10）+ albumFromWyy :1240 */
  async albumSearch(request, keyword, page, size) {
    const json = await requestJson(
      request,
      "https://music.163.com/api/search/get" + buildQuery({
        s: keyword,
        type: "10",
        limit: String(size),
        offset: String((page - 1) * size)
      }),
      { headers: WYY_HEADERS }
    );
    const result = asObject(json["result"]);
    const out = [];
    for (const entry of asArray(result["albums"])) {
      const item = asObject(entry);
      out.push({
        id: asString(item["id"]),
        platform: "wyy",
        name: asString(item["name"]),
        artist: asString(asObject(item["artist"])["name"]),
        picUrl: asString(item["picUrl"])
      });
    }
    return out;
  },
  /**
   * 蓝本 albumDetail wyy 分支 :1888（api/v1/album/{id}）：
   * album.name/picUrl/briefDesc → 名称/封面/描述，songs → songFromWyy。
   */
  async albumDetail(request, id) {
    const json = await requestJson(
      request,
      "https://music.163.com/api/v1/album/" + encodeURIComponent(id),
      { headers: WYY_HEADERS }
    );
    const album = asObject(json["album"]);
    const descVal = asString(album["briefDesc"]);
    const tracks = [];
    for (const entry of asArray(json["songs"])) {
      tracks.push(songFromWyy(asObject(entry)));
    }
    return {
      id,
      platform: "wyy",
      name: asString(album["name"]),
      picUrl: asString(album["picUrl"]),
      playCount: String(tracks.length),
      description: descVal.length > 0 ? descVal : null,
      tracks
    };
  }
};
const PER_SOURCE_TIMEOUT_MS = 4e3;
function withTimeoutMs(work, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} 超时（${ms}ms）`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== void 0) clearTimeout(timer);
  });
}
const ALL_SOURCES = ["wyy", "qq", "kw", "kg"];
function platformModule$1(source) {
  if (source === "qq") return qq;
  if (source === "kw") return kw;
  if (source === "kg") return kg;
  return wyy;
}
async function search(request, source, keyword, page, size) {
  return platformModule$1(source).search(request, keyword, page, size);
}
async function artistSongs(request, source, name, page, size) {
  const songs = await platformModule$1(source).search(request, name, page, size);
  let picUrl = "";
  if (page <= 1) {
    try {
      const artists = await platformModule$1(source).artistSearch(request, name, 1, 1);
      if (artists.length > 0) picUrl = artists[0].picUrl;
    } catch {
    }
  }
  return { picUrl, songs };
}
async function allSearchBatches(request, keyword, page, size) {
  const settled = await Promise.allSettled(
    ALL_SOURCES.map(
      (s) => withTimeoutMs(
        platformModule$1(s).search(request, keyword, page, size),
        PER_SOURCE_TIMEOUT_MS,
        `${s} 搜索`
      )
    )
  );
  const batches = [];
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") {
      batches.push({ source: ALL_SOURCES[i], list: result.value });
    }
  });
  return batches;
}
async function allLatestBatches(request, limit, offset) {
  const perSource = Math.ceil(limit / 4) + 1;
  const settled = await Promise.allSettled(
    ALL_SOURCES.map((s) => {
      const pageOffset = s === "wyy" || s === "kg" ? offset : 0;
      return withTimeoutMs(
        platformModule$1(s).latest(request, perSource, pageOffset),
        PER_SOURCE_TIMEOUT_MS,
        `${s} 最新`
      );
    })
  );
  return settled.map((result, i) => ({
    source: ALL_SOURCES[i],
    list: result.status === "fulfilled" ? result.value : []
  }));
}
async function allCharts(request) {
  const settled = await Promise.allSettled(
    ALL_SOURCES.map(
      (s) => withTimeoutMs(platformModule$1(s).charts(request), PER_SOURCE_TIMEOUT_MS, `${s} 排行榜`)
    )
  );
  const all = [];
  settled.forEach((result) => {
    if (result.status === "fulfilled") all.push(...result.value);
  });
  return all;
}
async function allHotWords(request) {
  const settled = await Promise.allSettled(
    ALL_SOURCES.map(
      (s) => withTimeoutMs(platformModule$1(s).hotWords(request), PER_SOURCE_TIMEOUT_MS, `${s} 热词`)
    )
  );
  const merged = [];
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const w of result.value) {
      if (merged.length >= 30) return merged;
      merged.push(w);
    }
  }
  return merged;
}
const coverCache = new TtlCache(30 * 60 * 1e3);
function platformModule(source) {
  if (source === "qq") return qq;
  if (source === "kw") return kw;
  if (source === "kg") return kg;
  return wyy;
}
async function songCover(request, source, song) {
  if (song.picUrl.length > 0) return song.picUrl;
  const cacheKey = source + ":" + song.id + ":cover";
  const cached = coverCache.get(cacheKey);
  if (cached.length > 0) return cached;
  const keyword = song.name + (song.singer.length > 0 ? " " + song.singer : "");
  let cover = "";
  try {
    const results = await platformModule(source).search(request, keyword, 1, 8);
    for (const hit of results) {
      if (hit.picUrl.length > 0) {
        cover = hit.picUrl;
        break;
      }
    }
  } catch {
  }
  if (cover.length === 0 && source !== "wyy") {
    try {
      const results = await wyy.search(request, keyword, 1, 8);
      for (const hit of results) {
        if (hit.picUrl.length > 0) {
          cover = hit.picUrl;
          break;
        }
      }
    } catch {
    }
  }
  if (cover.length > 0) coverCache.set(cacheKey, cover);
  return cover;
}
async function getLyric(request, source, song) {
  const platform = source === "qq" ? qq : source === "kw" ? kw : source === "kg" ? kg : wyy;
  const lyric = await platform.lyric(request, song).catch(() => "");
  const translation = await platform.lyricTranslation(request, song).catch(() => "");
  return { lyric, translation };
}
async function recommendations(request, source, category, page) {
  const platform = source === "qq" ? qq : source === "kw" ? kw : source === "kg" ? kg : wyy;
  return platform.recommendations(request, category, page);
}
const HOST_API_VERSION = 1;
const META_REVISION = 1;
const PLAY_PACK_MISSING_MESSAGE = "未安装播放音源包：在线播放需要在 设置 → 音源包管理 安装并启用播放音源包";
function platformOf(source) {
  if (source === "qq") return qq;
  if (source === "kw") return kw;
  if (source === "kg") return kg;
  return wyy;
}
function songOf(args) {
  return {
    id: String(args.id == null ? "" : args.id),
    name: String(args.name == null ? "" : args.name),
    singer: String(args.singer == null ? "" : args.singer),
    album: args.album == null ? "" : String(args.album),
    picUrl: args.picUrl == null ? "" : String(args.picUrl),
    interval: Number(args.interval == null ? 0 : args.interval),
    musicId: args.musicId == null ? null : String(args.musicId)
  };
}
function evalPlayPackFactory(code, log) {
  const globalScope = globalThis;
  globalScope.__qtPlayPackFactory = void 0;
  try {
    const run = new Function(code + "\n//# sourceURL=qt-play-bundle.js");
    run();
  } catch (error) {
    log?.(`[meta-entries] 播放包求值失败: ${String(error)}`);
    throw new Error("播放音源包代码执行失败，请确认文件完整或重新安装");
  }
  const factory = globalScope.__qtPlayPackFactory;
  if (typeof factory !== "function") {
    throw new Error("该文件不是有效的播放音源包（缺少装配入口）");
  }
  return factory;
}
function registerQtEntries(host2) {
  const req = host2.request;
  const platform = typeof host2.platform === "number" ? host2.platform : 1101;
  let playPack = null;
  const entries = {
    /** 诊断信息：meta 修订 + 当前播放包（未装为 null） */
    bundleInfo() {
      return JSON.stringify({
        name: "meta-bundle",
        version: "meta." + META_REVISION,
        metaRevision: META_REVISION,
        playPack: playPack == null ? null : { name: playPack.name, version: playPack.version },
        platforms: [platform],
        hostApiVersion: HOST_API_VERSION
      });
    },
    /**
     * 安装/切换播放包：code = play-bundle.js 全文。求值成功后立即生效并覆盖
     * 之前的包（多包共存由宿主侧文件管理，引擎侧只认"最后一次注入"）。
     */
    installPlayPack(args) {
      const code = String(args.code == null ? "" : args.code);
      if (code.length === 0) throw new Error("播放音源包内容为空");
      const factory = evalPlayPackFactory(code, host2.log);
      const pack = factory({ request: host2.request, platform, log: host2.log });
      if (pack == null || typeof pack.getPlayUrl !== "function") {
        throw new Error("播放音源包装配失败（缺少取链接口）");
      }
      playPack = pack;
      return JSON.stringify({ ok: true, playPack: { name: pack.name, version: pack.version } });
    },
    /** 卸载当前播放包（宿主删除/停用包时调用；引擎重启同样回到未装状态） */
    uninstallPlayPack(_args) {
      playPack = null;
      return JSON.stringify({ ok: true });
    },
    /** 取链：路由到播放包；未安装按统一口径抛错（客户端据此引导去设置页） */
    async getPlayUrl(args) {
      if (playPack == null) throw new Error(PLAY_PACK_MISSING_MESSAGE);
      return playPack.getPlayUrl(args);
    },
    /** 装载 chain.json：播放包专属能力，路由；未安装返回失败不抛错（诊断场景） */
    loadChain(chainJson) {
      if (playPack == null) {
        return JSON.stringify({ ok: false, error: PLAY_PACK_MISSING_MESSAGE });
      }
      return playPack.loadChain(chainJson);
    },
    /** 冒烟自检的 Range 预检：判定口径与 PC 的 verifyPlayable 一致 */
    async verifyPlayable(args) {
      const url = String(args.url == null ? "" : args.url);
      if (url.length === 0) return JSON.stringify({ ok: false, status: 0, length: 0 });
      try {
        const res = await host2.request(url, {
          method: "GET",
          headers: { Range: "bytes=0-1" },
          timeoutMs: 5e3
        });
        const status = Number(res.statusCode);
        const headers = res.headers ?? {};
        const length = Number(headers["content-length"] ?? 0) || 0;
        if (status === 403 || status === 416) {
          return JSON.stringify({ ok: true, status, length });
        }
        const contentType = String(headers["content-type"] ?? "");
        const ok = status >= 200 && status < 400 && !/json|html|text\/plain/i.test(contentType);
        return JSON.stringify({ ok, status, length });
      } catch {
        return JSON.stringify({ ok: false, status: 0, length: 0 });
      }
    },
    // ==================== 元数据接口（搜索/歌单/专辑/歌手/榜单/热词/歌词/封面） ====================
    /** 单源搜索歌曲 */
    async search(args) {
      const list = await search(
        req,
        String(args.source),
        String(args.keyword == null ? "" : args.keyword),
        Number(args.page == null ? 1 : args.page),
        Number(args.size == null ? 30 : args.size)
      );
      return JSON.stringify({ list });
    },
    /** 四源聚合搜索：按平台分批返回 [{source, list}]（单源失败跳过） */
    async searchAll(args) {
      const batches = await allSearchBatches(
        req,
        String(args.keyword == null ? "" : args.keyword),
        Number(args.page == null ? 1 : args.page),
        Number(args.size == null ? 30 : args.size)
      );
      return JSON.stringify({ batches });
    },
    /** 歌单搜索 */
    async searchPlaylists(args) {
      const list = await platformOf(String(args.source)).playlistSearch(
        req,
        String(args.keyword == null ? "" : args.keyword),
        Number(args.page == null ? 1 : args.page),
        Number(args.size == null ? 30 : args.size)
      );
      return JSON.stringify({ list });
    },
    /** 歌手搜索 */
    async searchArtists(args) {
      const list = await platformOf(String(args.source)).artistSearch(
        req,
        String(args.keyword == null ? "" : args.keyword),
        Number(args.page == null ? 1 : args.page),
        Number(args.size == null ? 30 : args.size)
      );
      return JSON.stringify({ list });
    },
    /** 专辑搜索 */
    async searchAlbums(args) {
      const list = await platformOf(String(args.source)).albumSearch(
        req,
        String(args.keyword == null ? "" : args.keyword),
        Number(args.page == null ? 1 : args.page),
        Number(args.size == null ? 30 : args.size)
      );
      return JSON.stringify({ list });
    },
    /** 专辑详情（结构与歌单详情一致） */
    async albumDetail(args) {
      const detail = await platformOf(String(args.source)).albumDetail(
        req,
        String(args.id == null ? "" : args.id)
      );
      return JSON.stringify({ detail });
    },
    /**
     * 歌手歌曲（第一页附头像 picUrl）
     */
    async artistSongs(args) {
      const result = await artistSongs(
        req,
        String(args.source),
        String(args.name == null ? "" : args.name),
        Number(args.page == null ? 1 : args.page),
        Number(args.size == null ? 30 : args.size)
      );
      return JSON.stringify(result);
    },
    /** 歌单广场分类 */
    async playlistCategories(args) {
      const list = await platformOf(String(args.source)).playlistCategories(req);
      return JSON.stringify({ list });
    },
    /** 歌单详情（含曲目） */
    async playlistDetail(args) {
      const detail = await platformOf(String(args.source)).playlistDetail(
        req,
        String(args.id == null ? "" : args.id)
      );
      return JSON.stringify({ detail });
    },
    /** 推荐歌单（category 为空时取默认） */
    async recommendations(args) {
      const list = await recommendations(
        req,
        String(args.source),
        args.category == null ? null : String(args.category),
        Number(args.page == null ? 1 : args.page)
      );
      return JSON.stringify({ list });
    },
    /** 单源榜单列表 */
    async charts(args) {
      const list = await platformOf(String(args.source)).charts(req);
      return JSON.stringify({ list });
    },
    /** 四源榜单合并（Chart 自带 platform，单源失败跳过） */
    async allCharts(_args) {
      const list = await allCharts(req);
      return JSON.stringify({ list });
    },
    /** 榜单详情（一次取全量） */
    async chartDetail(args) {
      const chart = args.chart;
      const list = await platformOf(String(args.source)).chartDetail(req, chart);
      return JSON.stringify({ list });
    },
    /** 单源最新歌曲 */
    async latest(args) {
      const list = await platformOf(String(args.source)).latest(
        req,
        Number(args.limit == null ? 30 : args.limit),
        Number(args.offset == null ? 0 : args.offset)
      );
      return JSON.stringify({ list });
    },
    /** 四源最新歌曲交错合并（凑满 limit；wyy/kg 带分页 offset） */
    async allLatest(args) {
      const limit = Number(args.limit == null ? 30 : args.limit);
      const offset = Number(args.offset == null ? 0 : args.offset);
      const batches = await allLatestBatches(req, limit, offset);
      const perSource = Math.ceil(limit / 4) + 1;
      const list = [];
      for (let index = 0; index < perSource && list.length < limit; index++) {
        for (const batch of batches) {
          if (index < batch.list.length) list.push(batch.list[index]);
          if (list.length >= limit) break;
        }
      }
      return JSON.stringify({ list });
    },
    /** 单源热词 */
    async hotWords(args) {
      const list = await platformOf(String(args.source)).hotWords(req);
      return JSON.stringify({ list });
    },
    /** 四源热词合并（封顶 30 条） */
    async allHotWords(_args) {
      const list = await allHotWords(req);
      return JSON.stringify({ list });
    },
    /** 歌词（原文 + 翻译） */
    async lyric(args) {
      const result = await getLyric(req, String(args.source), songOf(args.song));
      return JSON.stringify(result);
    },
    /** 封面：优先平台接口，失败兜底搜索（返回 {url}，空串 = 未取到） */
    async cover(args) {
      const url = await songCover(req, String(args.source), songOf(args.song));
      return JSON.stringify({ url });
    }
  };
  globalThis.__qtEntries = entries;
}
const host = globalThis.__qtHost;
if (host !== void 0 && host !== null && typeof host.request === "function") {
  registerQtEntries(host);
}
export {
  META_REVISION,
  PLAY_PACK_MISSING_MESSAGE,
  registerQtEntries
};
/*__QT_SIGN__{"alg":"ed25519","sig":"iFNVJHkFkt5xSPF58mLfmv75KL5R5OCygj3fSMOZ3LEPWY0w/2sdvOQ3mj4e0EPu/qJfNh5ZM+HXgaAgAzggDw=="}*/

import * as sourceApi from "@/source-scripts";
import { playUrlHitLine } from "@/source-scripts/playurl-line";
import {
  getLyric,
  getPlaybackState,
  notifyLyricManuallyPicked,
  readLocalLyric,
  resolveLocalFile,
  saveLyric,
} from "@/services/ipc";
import { registryHasSource } from "@/stores/sourceRegistry";
import type { PlayUrlLine } from "@/source-engine/client";
import type { Lyric, Quality, SourceId, Track } from "@/types";

/**
 * 本地曲目的在线元数据（酷我按歌名 + 歌手匹配）：歌词 + 翻译 + 封面。
 *
 * 本地文件没有平台 id，直接按 id 向音源要歌词必然 `unsupported`；统一改在酷我
 * 搜一次补齐。按文件路径做进程内缓存（同一路径的并发请求合并成一个
 * Promise），拉取失败也缓存空结果，避免每次渲染重试打网络。
 *
 * 应用不再内置音源实现：搜索/歌词都经 sourceApi（音源包）取。
 */

export interface LocalOnlineMeta {
  lrc: string;
  translation: string;
  picUrl: string;
}

const EMPTY: LocalOnlineMeta = { lrc: "", translation: "", picUrl: "" };

const cache = new Map<string, Promise<LocalOnlineMeta>>();

async function fetchOnlineMeta(
  title: string,
  singer: string,
): Promise<LocalOnlineMeta> {
  if (title.length === 0) return EMPTY;
  const keyword = singer.length > 0 ? `${title} ${singer}` : title;
  const hits = await sourceApi.searchMusic(keyword, "kw", 1, 5);
  const meta: LocalOnlineMeta = { ...EMPTY };
  // 逐个命中取封面 / 歌词：多数情况第 1 条就齐了，歌词为空（纯音乐等）时才看下一条
  for (const hit of hits) {
    if (meta.picUrl.length === 0 && hit.picUrl.length > 0) meta.picUrl = hit.picUrl;
    if (meta.lrc.length === 0) {
      try {
        const lyric = await sourceApi.getLyric(hit);
        if (lyric.lrc.trim().length > 0) {
          meta.lrc = lyric.lrc;
          meta.translation = lyric.translation;
        }
      } catch {
        // 该命中取词失败：继续看下一条
      }
    }
    if (meta.picUrl.length > 0 && meta.lrc.length > 0) break;
  }
  return meta;
}

/** 按路径取在线元数据；path 即本地 Track.id（文件绝对路径） */
export function resolveLocalOnlineMeta(
  path: string,
  title: string,
  singer: string,
): Promise<LocalOnlineMeta> {
  const cached = cache.get(path);
  if (cached) return cached;
  const task = fetchOnlineMeta(title.trim(), singer.trim()).catch(() => EMPTY);
  cache.set(path, task);
  return task;
}

/** 清空本地曲目在线元数据缓存（封面/在线歌词候选，进程内可再生）。 */
export function clearLocalOnlineMetaCache(): number {
  const count = cache.size;
  cache.clear();
  return count;
}

/** 清空播放页歌词缓存（不删除 SQLite 中已保存的歌词）。 */
export function clearPlaybackLyricCache(): number {
  const count = lyricCache.size;
  lyricCache.clear();
  return count;
}

/** 跨源兜底命中信息：target = 实际在播的源；song = 线路上精确命中的那首歌（旧引擎页为 null） */
export interface CrossSourceHit {
  target: SourceId;
  song: Track | null;
}

/** 从命中线路解析跨源兜底（id 形如 `cross:kw`，targetSong 是命中的歌，可能为 null）。
 *  目标源必须仍在数据包注册表里声明（包下线某源后，旧缓存线路不再算数）。 */
export function crossSourceHitFromLine(line: PlayUrlLine | null, currentPlatform: SourceId): CrossSourceHit | null {
  if (line === null || !line.id.startsWith("cross:")) return null;
  const target = line.id.slice("cross:".length);
  if (target === "local" || target === currentPlatform || !registryHasSource(target)) {
    return null;
  }
  return { target: target as SourceId, song: crossSongToTrack(line.targetSong, target as SourceId) };
}

/** 当前实际播放地址是否来自跨源兜底：是则返回目标源与命中歌曲（歌词按它重取），否则 null */
export function crossSourceForPlayback(track: Track | null, quality: Quality | null): CrossSourceHit | null {
  if (track === null || track.platform === "local" || quality === null) return null;
  return crossSourceHitFromLine(playUrlHitLine(track, quality), track.platform);
}

function crossSongToTrack(song: PlayUrlLine["targetSong"], platform: SourceId): Track | null {
  if (song === null) return null;
  return sourceApi.toAppTrack(song, platform);
}

/** 跨源取词：在目标平台搜同名歌，逐个命中取词直到非空（与本地曲目补词同套路） */
async function fetchCrossSourceLyric(
  target: SourceId,
  title: string,
  singer: string,
): Promise<Lyric | null> {
  const keyword = singer.length > 0 ? `${title} ${singer}` : title;
  const hits = await sourceApi.searchMusic(keyword, target, 1, 5);
  for (const hit of hits) {
    try {
      const lyric = await sourceApi.getLyric(hit);
      if (lyric.lrc.trim().length > 0) return lyric;
    } catch {
      // 该命中取词失败：继续看下一条
    }
  }
  return null;
}

/**
 * 播放用歌词。优先级从高到低：
 * 1. **用户手动挑的词**（库里 `manual`）—— 直接回读，连源站都不打；
 * 2. **本地文件自带的词**（库里 `source` 是 `local-lrc` / `local-tag`，或现读文件）——
 *    本地曲目优先用它，离线也有词；
 * 2.5 **在播本地文件的内嵌词**（在线曲目被本地优先命中，`isLocal` 为真）——同样是
 *    「文件里就有这首的词」，优先于在线取词，但不落库（主键归在线源）；
 * 3. 在线词：换源兜底在播（cross 非空）时优先取目标源的词——线路带精确命中歌
 *    （targetSong）就按它取，否则在目标源按歌名搜；目标源取不到词才退回原源；
 *    本地曲目没有平台 id，按歌名 + 歌手走酷我匹配（匹配不到返回空歌词，
 *    由页面显示「没有歌词」）。
 */
async function fetchPlaybackLyric(
  track: Track,
  cross: CrossSourceHit | null,
): Promise<{ lyric: Lyric; fromSaved: boolean }> {
  // 这一份是不是从库里回读的（手动挑的 / 断网兜底）。真从源站取到的才需要再落一次库：
  // 把回读来的词原样写回去，等于用默认 manual=false 覆盖掉用户刚写的手动标记。
  let fromSaved = false;

  // 用户手动挑过的词优先级最高：直接回读，连源站都不打。
  //
  // 不这么做会退化成「换了没生效」：源站把词挂在别的版本上（live / 翻唱）时用户手动
  // 换了一份，可下一次取词照旧打源站、拿回那份错词，用户的选择被静默覆盖。桌面歌词
  // 窗口是独立 WebView、自己走一遍这条链路，表现就是「播放页换了、桌面歌词没换」。
  // 手动标记由 `applyPickedLyric` 落库时写入，自动取词落库会把它交回 false。
  //
  // 本地文件自带的词（source = local-lrc / local-tag）同样直接回读：文件旁边的 .lrc
  // 或文件里内嵌的那份，就是这首歌的词，没必要再去酷我猜一个版本来盖它。
  const saved = await readSavedLyric(track);
  // 标记与来源只在这里用于决策，不往外传 —— Lyric 是四个面的契约，多带字段会让
  // 上层「是不是同一份词」的判断（toEqual 之类）莫名其妙失配。
  if (saved !== null && (saved.manual || isLocalFileLyric(saved.source))) {
    fromSaved = true;
    return { lyric: saved.lyric, fromSaved };
  }

  // 在播的是**本地文件**（本地优先命中，platform 仍是在线源）时，文件自带的内嵌歌词
  // 同样优先于在线词：文件里那份就是这首歌的词，没必要再去源站猜一个版本来盖它。
  // 与「本地曲目」的区别只在于不落库 —— 主键是 `platform:id`，把 local-tag 写进去会占用
  // 在线词槽，之后就算文件被删也一直回读到它。
  const onDisk = await readPlayingLocalFileLyric(track);
  if (onDisk !== null) {
    fromSaved = true;
    return { lyric: onDisk, fromSaved };
  }

  try {
    if (track.platform !== "local" && cross !== null && cross.target !== track.platform) {
      if (cross.song !== null) {
        const exact = await sourceApi.getLyric(cross.song).catch(() => null);
        if (exact !== null && exact.lrc.trim().length > 0) {
          return { lyric: exact, fromSaved };
        }
      }
      const matched = await fetchCrossSourceLyric(
        cross.target,
        track.title.trim(),
        track.singer.trim(),
      ).catch(() => null);
      if (matched !== null) return { lyric: matched, fromSaved };
    }
    if (track.platform !== "local") {
      return { lyric: await sourceApi.getLyric(track), fromSaved };
    }
    // 本地曲目：先看音频文件自带的词（同名 .lrc / 内嵌标签）。扫描时已落过库，这里是
    // 扫描之外的情况——拖进来还没入库的文件、扫描后才放的 .lrc、用户改了 .lrc 内容。
    const fromFile = await readLocalFileLyric(track);
    if (fromFile !== null) {
      // 这份词在 readLocalFileLyric 里已经按文件来源落库了，这里置 fromSaved = true
      // 让调用方那条通用回写闭麦：否则会用 source = "local" 盖掉 "local-lrc"/"local-tag"。
      fromSaved = true;
      return { lyric: fromFile, fromSaved };
    }
    const meta = await resolveLocalOnlineMeta(track.id, track.title, track.singer);
    // 本地曲目的在线元数据走酷我搜索匹配，酷我没有逐字/罗马音面（包里恒空串），
    // 这里也就没有多余字段可带（Lyric 的两个新字段是可选的）。
    return { lyric: { lrc: meta.lrc, translation: meta.translation }, fromSaved };
  } catch (err) {
    // 网络取词失败 → 回读上一次成功落库的正文：断网 / 源站抽风时不至于整页空白，
    // 宁可显示旧词。本地曲目同样有这条兜底（`local:<路径>` 就是它的主键）。
    // 上面读过的那一份直接复用，不重复打一次 IPC。
    if (saved !== null) {
      fromSaved = true;
      return { lyric: saved.lyric, fromSaved };
    }
    throw err;
  }
}

/** 本地文件自带歌词的两个来源标记（后端 `local.rs` 的 LYRIC_SOURCE_SIDECAR / _EMBEDDED） */
const LOCAL_FILE_LYRIC_SOURCES = ["local-lrc", "local-tag"];

/** 这份落库的词是不是「本地文件自带的」（同名 .lrc / 内嵌标签） */
function isLocalFileLyric(source: string): boolean {
  return LOCAL_FILE_LYRIC_SOURCES.includes(source);
}

/**
 * **在播曲目实际用的是本地文件**时，读那个文件自带的歌词（同名 `.lrc` 优先，其次内嵌）。
 *
 * 触发条件只有一条：引擎快照的 `isLocal === true` 且当前曲目就是 `track`。这是唯一
 * 权威信号 —— 本地优先（`play.localFirst`）命中时 `platform` 仍是在线源，靠它猜不出来。
 *
 * 为什么现查播放状态而不是读前端的播放器 store：桌面歌词窗口是独立 WebView，不走
 * 主窗口的 store，只有 IPC 是两边共用的。
 *
 * 拿到路径不落库（见调用点注释），所以这里只返回正文。
 */
async function readPlayingLocalFileLyric(track: Track): Promise<Lyric | null> {
  if (track.platform === "local") return null; // 本地曲目走下面的既有分支
  let localSnapshot: boolean;
  try {
    const st = await getPlaybackState();
    const cur = st.track;
    localSnapshot =
      st.isLocal && cur !== null && cur.id === track.id && cur.platform === track.platform;
  } catch {
    // 非 Tauri 环境（单测）/ 引擎未就绪：当作「不是在播本地文件」
    return null;
  }
  if (!localSnapshot) return null;
  const hit = await resolveLocalFile(track).catch(() => null);
  if (hit === null || hit.path.length === 0) return null;
  const found = await readLocalLyric(hit.path).catch(() => null);
  if (found === null || found.lrc.trim().length === 0) return null;
  return { lrc: found.lrc, translation: "" };
}

/**
 * 本地曲目：读音频文件自带的歌词（同名 `.lrc` 优先，其次内嵌标签）。
 *
 * 取到就顺手按文件来源落库（`source` 记 `local-lrc` / `local-tag`，后端只覆盖同样来自
 * 本地文件的行），下次断网也能从库里回读到，不必再解析一遍容器。
 * 非本地曲目 / 文件里没有任何自带歌词 → null。
 */
async function readLocalFileLyric(track: Track): Promise<Lyric | null> {
  if (track.platform !== "local") return null;
  try {
    const found = await readLocalLyric(track.id);
    if (found === null || found.lrc.trim().length === 0) return null;
    try {
      void saveLyric(`local:${track.id}`, found.lrc, "", "", "", found.source, false).catch(
        () => undefined,
      );
    } catch {
      /* 无 IPC 环境（单测）：跳过落库 */
    }
    return { lrc: found.lrc, translation: "" };
  } catch {
    // 非 Tauri 环境 / 文件已不在：当它没有自带歌词，继续走在线匹配
    return null;
  }
}

/**
 * 回读落库歌词。非 Tauri 环境（单测）里 invoke 会同步抛，故整体 try/catch 兜住。
 *
 * 多带 `manual`（库里 V13 起的标记）与 `source`：调用方要靠它们决定「直接回读」还是
 * 「去源站重取」，所以两者与正文分开返回，正文仍是干净的 `Lyric`。
 *
 * 本地曲目也读库（`local:<路径>` 就是它在 tracks 表里的主键）：扫描时已经把文件自带的
 * 词落进去了，`source` 是 `local-lrc` / `local-tag`。
 */
async function readSavedLyric(
  track: Track,
): Promise<{ lyric: Lyric; manual: boolean; source: string } | null> {
  try {
    const rec = await getLyric(`${track.platform}:${track.id}`);
    if (rec === null || rec.lrc.trim().length === 0) return null;
    // 逐字 / 罗马音一起回读（2026-10-06 起落库就有这两列）：断网时不只是「有词」，
    // 逐字染色和罗马音也还在。老库行这两列是 NULL，Rust 侧统一落成空串。
    return {
      lyric: {
        lrc: rec.lrc,
        translation: rec.translation,
        wordByWord: rec.wordByWord ?? "",
        romanization: rec.romanization ?? "",
      },
      manual: rec.manual === true,
      source: rec.source,
    };
  } catch {
    return null;
  }
}

// ---------- 播放页歌词缓存 ----------

/** 歌词缓存上限（条）。歌词正文几十 KB 级，50 条最坏约 2-3MB，可忽略。 */
export const LYRIC_CACHE_CAP = 50;

/**
 * 歌词 LRU：播放页一退出组件就卸载，歌词 state 全丢，没有这层的话每次进
 * 播放页都重新打一次网络（取词链路 sourceApi.getLyric → 音源包 → 源站）。
 *
 * 存的是 in-flight Promise：并发请求自然合并成一次取词；失败在 catch 里把自己
 * 踢出缓存（下次重进重取），所以只有成功结果常驻——空歌词（纯音乐）也算成功，
 * 同样缓存，避免「没有歌词」的歌每次进页都白打一轮搜索。
 *
 * 键与播放页的去重键同口径：换源兜底改变 cross 时键随之改变，天然不会错配。
 * 桌面歌词窗口是独立 WebView（独立 JS 上下文），各自持有一份实例，互不共享。
 */
const lyricCache = new Map<string, Promise<Lyric>>();

function lyricCacheKey(track: Track, cross: CrossSourceHit | null): string {
  return `${track.platform}:${track.id}:${cross?.target ?? ""}:${cross?.song?.id ?? ""}`;
}

/**
 * 写歌词缓存并做 LRU 淘汰。键已存在时先删再写 = 移到最新端（Map 按插入序迭代）。
 * 取词路径与「用户手动选词」路径共用这一个写入口，避免两套淘汰规则各写各的。
 */
function putLyricCache(key: string, task: Promise<Lyric>): Promise<Lyric> {
  lyricCache.delete(key);
  lyricCache.set(key, task);
  if (lyricCache.size > LYRIC_CACHE_CAP) {
    const oldest = lyricCache.keys().next().value;
    if (oldest !== undefined) lyricCache.delete(oldest);
  }
  return task;
}

/** 把一份已知的歌词塞进缓存（同步生效），键口径与 getPlaybackLyric 完全一致 */
function cacheLyric(track: Track, cross: CrossSourceHit | null, lyric: Lyric): void {
  putLyricCache(lyricCacheKey(track, cross), Promise.resolve(lyric));
}

export function getPlaybackLyric(track: Track, cross: CrossSourceHit | null = null): Promise<Lyric> {
  const key = lyricCacheKey(track, cross);
  const hit = lyricCache.get(key);
  if (hit !== undefined) {
    // 命中后移到最新端（Map 迭代按插入序，最旧的总在第一个）
    lyricCache.delete(key);
    lyricCache.set(key, hit);
    return hit;
  }
  const task = fetchPlaybackLyric(track, cross)
    .then(({ lyric: lyr, fromSaved }) => {
      // 取词成功顺手落库：网络失败时（换源、断网、源站抽风）还能回读到上一次的词，
      // 而不是整页空白。写入失败一律忽略 —— 歌词是锦上添花，不该影响播放。
      // try/catch 是必要的：非 Tauri 环境（单测 / 浏览器直开）里 invoke 会同步抛，
      // 那会把「取词成功」变成一次 rejection，进而误触发下面的缓存剔除。
      //
      // 回读来的词不回写：那份本来就是库里最新的，写回去只会用默认 manual=false
      // 把用户手动挑的标记冲掉（下一次取词就又跑去打源站了）。
      if (!fromSaved) {
        try {
          void saveLyric(
            `${track.platform}:${track.id}`,
            lyr.lrc,
            lyr.wordByWord ?? "",
            lyr.translation,
            lyr.romanization ?? "",
            cross?.target ?? track.platform,
          ).catch(() => undefined);
        } catch {
          /* 无 IPC 环境：跳过落库 */
        }
      }
      return lyr;
    })
    .catch((err: unknown) => {
      // 只剔自己那一条：用户可能刚手动选过词（cacheLyric 已写入同键的新条目），
      // 无差别 delete 会把用户的选择一起抹掉。
      if (lyricCache.get(key) === task) lyricCache.delete(key);
      throw err;
    });
  return putLyricCache(key, task);
}

// ---------- 无词时手动搜索歌词（2026-10-06） ----------
//
// 背景：自动取词只认「当前源 / 跨源兜底源」的同一首歌，源站把词挂到别的版本上
// （live / 翻唱 / 专辑版）时就会拿到空词，页面只能显示「暂无歌词」——用户除了换源
// 没有别的办法。这里给一条手动纠错路径：按「歌名 + 歌手」搜候选，用户挑一个，
// 结果按曲目落库。
//
// **不新增后端能力**：搜索与取词都是既有链路（sourceApi.searchMusic →
// sourceApi.getLyric），与 fetchCrossSourceLyric 同一套路，只是不再「取到第一份
// 就返回」，而是全部带回来交给用户挑。落库复用 cmd_save_lyric，不碰
// lyric_settings.lyric_path（那是本地歌词文件路径列，与在线词无关）。

/** 一个歌词候选：某首歌 + 它在某个源上的词 */
export interface LyricCandidate {
  /** 候选曲目（带 platform 的完整 Track，可直接用于展示与落库来源标记） */
  track: Track;
  lyric: Lyric;
  /** 这份词来自哪个源（落库时写进 `lyrics.source`） */
  source: SourceId;
}

/**
 * 按关键词在指定源搜歌词候选。
 *
 * 只保留**主词非空**的候选：空词（纯音乐 / 该版本源站没挂词）选它等于没选。
 * 单个候选取词失败只跳过它自己，不影响其余候选。
 */
export async function searchLyricCandidates(
  keyword: string,
  source: SourceId,
  size = 8,
): Promise<LyricCandidate[]> {
  const kw = keyword.trim();
  if (kw.length === 0) return [];
  const hits = await sourceApi.searchMusic(kw, source, 1, size);
  // 逐条取词互不依赖：并行发（原先是 8 次串行网络往返，最坏 8×超时）。
  // 结果按 hits 原序保留，空词与失败项各自过滤，语义与串行完全一致。
  const lyrics = await Promise.all(
    hits.map((hit) =>
      sourceApi
        .getLyric(hit)
        .then((lyric) => (lyric.lrc.trim().length === 0 ? null : lyric))
        .catch(() => null),
    ),
  );
  const out: LyricCandidate[] = [];
  for (let i = 0; i < hits.length; i += 1) {
    const lyric = lyrics[i];
    if (lyric === null) continue;
    out.push({ track: hits[i], lyric, source });
  }
  return out;
}

// ---------- 歌词候选缓存（2026-10-07：搜索歌词弹层） ----------
//
// 与换源候选（lib/source-switch.ts）同款：**进程内临时缓存**，不做持久化。
// 理由一致 —— 候选是「此刻各源有没有挂词」的快照，落库后下次打开拿到的是可能
// 已失效的结果；而「关掉弹层再打开」才是真实痛点（换关键字 → 关掉 → 再开 →
// 又等一轮搜索 + 逐条取词）。键 = `源:每页条数:关键字（小写）`。

/** 每页条数：搜出来的候选要逐条取词（getLyric），条数直接等于请求数，8 条封顶 */
export const LYRIC_CANDIDATE_SIZE = 8;
const LYRIC_CANDIDATE_CACHE_MAX = 32;
const LYRIC_CANDIDATE_TTL_MS = 10 * 60 * 1000;

const lyricCandidateCache = new Map<string, { at: number; items: LyricCandidate[] }>();

function lyricCandidateKey(source: SourceId, keyword: string, size: number): string {
  return `${source}:${size}:${keyword.trim().toLowerCase()}`;
}

/** 清空歌词候选缓存（测试隔离 / 手动刷新用 / 设置页可选清理） */
export function clearLyricCandidateCache(): number {
  const count = lyricCandidateCache.size;
  lyricCandidateCache.clear();
  return count;
}

/**
 * 同步窥一眼缓存（未命中/过期返回 null）。
 * 弹层用它决定「要不要进 loading」：命中就直接渲染，不闪「正在搜索歌词…」。
 */
export function peekLyricCandidates(
  source: SourceId,
  keyword: string,
  size: number = LYRIC_CANDIDATE_SIZE,
): LyricCandidate[] | null {
  if (keyword.trim().length === 0) return null;
  const key = lyricCandidateKey(source, keyword, size);
  const hit = lyricCandidateCache.get(key);
  if (hit === undefined) return null;
  if (Date.now() - hit.at > LYRIC_CANDIDATE_TTL_MS) {
    lyricCandidateCache.delete(key);
    return null;
  }
  lyricCandidateCache.delete(key);
  lyricCandidateCache.set(key, hit); // 重新插入 = 移到队尾
  return hit.items;
}

/**
 * 在某源按关键字搜歌词候选（走 searchLyricCandidates，只带回主词非空的）。
 * `force` 为真时跳过缓存并覆盖（弹层的「重新搜索」）。
 *
 * 不做二次排序：源站搜索本身按相关度给出顺序，而这里是**用户手动挑**
 * （与换源不同——换源要跨源合并后才需要按相似度重排）。
 */
export async function findLyricCandidates(
  source: SourceId,
  keyword: string,
  size: number = LYRIC_CANDIDATE_SIZE,
  force = false,
): Promise<LyricCandidate[]> {
  if (keyword.trim().length === 0) return [];
  const key = lyricCandidateKey(source, keyword, size);
  if (!force) {
    const cached = peekLyricCandidates(source, keyword, size);
    if (cached !== null) return cached;
  }
  const items = await searchLyricCandidates(keyword, source, size);
  lyricCandidateCache.delete(key);
  lyricCandidateCache.set(key, { at: Date.now(), items });
  while (lyricCandidateCache.size > LYRIC_CANDIDATE_CACHE_MAX) {
    const oldest = lyricCandidateCache.keys().next();
    if (oldest.done) break;
    lyricCandidateCache.delete(oldest.value);
  }
  return items;
}

/**
 * 用户手动选定歌词后的落地：刷新播放页歌词缓存 + 落库 + 广播给桌面歌词窗口。
 *
 * 缓存必须一起刷：`getPlaybackLyric` 把**空歌词也算成功结果**缓存（见上面的注释），
 * 不刷的话用户选完词、退出再进播放页，命中的还是那条「暂无歌词」的旧 Promise，
 * 表现成「选了没用」。这里复用同一张 Map 与同一套淘汰规则，不另开旁路缓存。
 *
 * 广播是因为桌面歌词窗口是独立 WebView（独立 JS 上下文），它那份 `lyricCache` 与
 * 本窗口互不相通 —— 只刷本地缓存，那边还是旧词。事件里不搬歌词正文（几十 KB 走事件
 * 载荷不合适），只带 `trackId` + 源头，由订阅方自己回读。
 *
 * 落库失败只吞掉（歌词是锦上添花）；缓存已同步刷好，本次会话内至少立刻生效。
 */
export async function applyPickedLyric(
  track: Track,
  cross: CrossSourceHit | null,
  picked: LyricCandidate,
): Promise<void> {
  cacheLyric(track, cross, picked.lyric);
  const trackId = `${track.platform}:${track.id}`;
  try {
    await saveLyric(
      trackId,
      picked.lyric.lrc,
      picked.lyric.wordByWord ?? "",
      picked.lyric.translation,
      picked.lyric.romanization ?? "",
      picked.source,
      // 手动标记：落库后取词链路（含桌面歌词窗口那份）直接回读它，不再回源站重取。
      true,
    );
  } catch {
    /* 无 IPC 环境 / 落库失败：缓存已生效，不打断播放页 */
  }
  // 落库成败都要广播：另一窗口反正自己回去库里读，届时才知道有没有真落上，
  // 读不到新词最多停在旧词，不会因为少这一次广播变成永久不一致。
  try {
    notifyLyricManuallyPicked(trackId, picked.source);
  } catch {
    /* 无 IPC 环境（单测 / 浏览器直开）：emit 会同步抛 */
  }
}

/**
 * 订阅方用：丢掉本进程里这首歌词缓存，让下一次 `getPlaybackLyric` 重新走链路。
 *
 * 手动换词后必须丢缓存再重取 —— 不丢的话命中本地那条旧 Promise，桌面歌词看起来
 * 「换了没反应」，跟播放页那份错位。
 */
export function dropCachedLyric(track: Track, cross: CrossSourceHit | null): void {
  lyricCache.delete(lyricCacheKey(track, cross));
}

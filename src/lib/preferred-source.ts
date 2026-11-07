import type { Track } from "@/types";
import { getSetting, setSetting } from "@/services/ipc";

const KEY = "qt-song-source-choice-v1";
const REVISION_KEY = KEY + ":revision";
type Entry = { key: string; track: Track };
let cachedRaw: string | null | undefined;
let cachedEntries: Entry[] = [];
let cachedIndex = new Map<string, Track>();
let mutationEpoch = 0;
let pendingRead: { epoch: number; promise: Promise<string | null> } | null = null;
let pendingMigration: Promise<{ entries: Entry[]; epoch: number }> | null = null;
let writeTail: Promise<void> = Promise.resolve();
const keyOf = (t: Track): string => `${t.platform}:${t.id}`;
function clean(value: unknown): Track | null {
  if (!value || typeof value !== "object") return null;
  const t = value as Partial<Track>;
  if (typeof t.id !== "string" || !t.id || typeof t.platform !== "string" || !t.platform || t.platform === "local" || t.platform === "podcast") return null;
  return { id: t.id, platform: t.platform, title: typeof t.title === "string" ? t.title : "", singer: typeof t.singer === "string" ? t.singer : "", album: typeof t.album === "string" ? t.album : "", picUrl: typeof t.picUrl === "string" ? t.picUrl : "", duration: typeof t.duration === "number" && Number.isFinite(t.duration) ? t.duration : 0, musicId: typeof t.musicId === "string" ? t.musicId : undefined };
}
function publishCache(entries: Entry[], raw: string | null): void {
  cachedEntries = entries;
  cachedIndex = new Map(entries.map(entry => [entry.key, entry.track]));
  cachedRaw = raw;
}
function parseEntries(raw: string | null): Entry[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((e: unknown): Entry[] => {
      if (!e || typeof e !== "object") return [];
      const row = e as { key?: unknown; track?: unknown }, track = clean(row.track);
      return typeof row.key === "string" && track ? [{ key: row.key, track }] : [];
    });
  } catch { return []; }
}
function readCache(raw: string | null): Entry[] {
  if (raw !== cachedRaw) publishCache(parseEntries(raw), raw);
  return cachedEntries;
}
function serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeTail.then(operation);
  writeTail = result.then(() => undefined, () => undefined);
  return result;
}
async function writeEntries(entries: Entry[]): Promise<void> {
  const raw = JSON.stringify(entries);
  await setSetting(KEY, raw);
  mutationEpoch += 1;
  publishCache(entries, raw);
}
async function readNative(): Promise<{ raw: string | null; epoch: number }> {
  for (;;) {
    const epoch = mutationEpoch;
    if (!pendingRead || pendingRead.epoch !== epoch) pendingRead = { epoch, promise: getSetting(KEY) };
    const pending = pendingRead;
    let raw: string | null;
    try { raw = await pending.promise; }
    finally { if (pendingRead === pending) pendingRead = null; }
    // Only the native request is shared: a retry never awaits its own read loop.
    if (epoch === mutationEpoch) return { raw, epoch };
  }
}
function readLegacy(): { storage: Storage; raw: string } | null {
  try {
    if (typeof window === "undefined") return null;
    const storage = window.localStorage, raw = storage.getItem(KEY);
    return raw === null ? null : { storage, raw };
  } catch { return null; }
}
/** Called only within the write queue, so migration cannot overwrite an explicit save. */
async function readForWrite(): Promise<Entry[]> {
  const { raw } = await readNative();
  if (raw !== null) return readCache(raw);
  const legacy = readLegacy();
  if (!legacy) return readCache(null);
  const entries = parseEntries(legacy.raw);
  await writeEntries(entries);
  try { legacy.storage.removeItem(KEY); } catch { /* Native ACK remains durable. */ }
  try { legacy.storage.removeItem(REVISION_KEY); } catch { /* Cleanup is best effort. */ }
  return entries;
}
async function read(): Promise<Entry[]> {
  for (;;) {
    const { raw, epoch } = await readNative();
    if (epoch !== mutationEpoch) continue;
    if (raw !== null) return readCache(raw);
    if (!pendingMigration) {
      pendingMigration = serializeWrite(async () => {
        const entries = await readForWrite();
        return { entries, epoch: mutationEpoch };
      });
    }
    const migration = pendingMigration;
    try {
      const snapshot = await migration;
      if (snapshot.epoch === mutationEpoch) return snapshot.entries;
    } finally { if (pendingMigration === migration) pendingMigration = null; }
  }
}
/** Explicit choices are durable user data; URLs and automatic fallbacks never write them. */
export async function savePreferredSource(original: Track, candidate: Track): Promise<void> {
  const target = clean(candidate);
  if (!target) throw new Error("这个音源不能保存为播放偏好");
  const from = keyOf(original), to = keyOf(target);
  await serializeWrite(async () => {
    const stored = await readForWrite();
    const family = stored.find(e => e.key === from)?.track;
    const familyKey = family ? keyOf(family) : from;
    const entries = stored.map(e => keyOf(e.track) === from || keyOf(e.track) === familyKey ? { key: e.key, track: target } : e);
    const next = entries.filter(e => e.key !== from && e.key !== to);
    next.push({ key: from, track: target });
    if (to !== from) next.push({ key: to, track: target });
    await writeEntries(next);
  });
}
export async function preferredSource(track: Track): Promise<Track | null> {
  if (track.platform === "local" || track.platform === "podcast") return null;
  await read();
  const target = cachedIndex.get(keyOf(track));
  return target && keyOf(target) !== keyOf(track) ? clean(target) : null;
}

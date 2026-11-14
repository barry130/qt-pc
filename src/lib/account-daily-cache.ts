import type { Track } from "@/types";
import * as ipc from "@/services/ipc";
import { ACCOUNT_DAILY_CACHE_KEY } from "@/lib/storageKeys";
import { localDateKey } from "@/lib/text";
import {
  assertAccountRecommendationContextCurrent,
  type AccountRecommendationContext,
} from "@/lib/account-recommendation";
import { AccountRecommendationError, safeAccountRecommendationError } from "@/lib/account-recommendation-error";

const SCHEMA = 1;
const MAX_RECORDS = 12;
const MAX_TTL_MS = 30 * 60 * 1000;

/** Only platform track data is cached; display text is rebuilt from live context. */
export interface AccountDailyCacheValue {
  date: string;
  generatedAt: number;
  fetchedAt: number;
  expiresAt?: number;
  tracks: Track[];
}
interface CacheEntry extends AccountDailyCacheValue {
  /** Per-write non-secret nonce; retirement must never match a newer entry. */
  entryId: string;
  sourceId: string;
  accountId: string;
  accountSession: string;
  packVersion: string;
  validUntil: number;
}
let tail: Promise<void> = Promise.resolve();
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const task = tail.then(operation);
  tail = task.then(() => undefined, () => undefined);
  return task;
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function text(value: unknown, max = 4096): value is string {
  return typeof value === "string" && value.length <= max;
}
function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 8640000000000000;
}
function track(value: unknown, sourceId: string): Track | null {
  const raw = object(value);
  if (!raw || !text(raw.id, 512) || !raw.id || raw.platform !== sourceId ||
    !text(raw.title) || !raw.title || !text(raw.singer) || !text(raw.album) || !text(raw.picUrl) ||
    typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) return null;
  const result: Track = { id: raw.id, platform: sourceId, title: raw.title, singer: raw.singer,
    album: raw.album, picUrl: raw.picUrl, duration: raw.duration };
  for (const key of ["musicId", "version", "isrc"] as const) {
    const value = raw[key];
    if (value !== undefined) {
      if (value === null) {
        if (key !== "musicId") return null;
        result.musicId = null;
      } else {
        if (!text(value, 512)) return null;
        result[key] = value;
      }
    }
  }
  if (raw.durationReliable !== undefined) {
    if (typeof raw.durationReliable !== "boolean") return null;
    result.durationReliable = raw.durationReliable;
  }
  return result;
}
/** Construct whitelisted objects, never spread decoded disk data back into KV. */
function entry(value: unknown, now: number, date: string): CacheEntry | null {
  const raw = object(value);
  if (!raw || !text(raw.entryId, 128) || !raw.entryId || !text(raw.sourceId, 32) || !raw.sourceId || !text(raw.accountId, 512) || !raw.accountId ||
    !text(raw.accountSession, 128) || !raw.accountSession || !text(raw.packVersion, 512) || !raw.packVersion ||
    raw.date !== date || !timestamp(raw.generatedAt) || raw.generatedAt > now ||
    !timestamp(raw.fetchedAt) || raw.fetchedAt > now || !timestamp(raw.validUntil) || raw.validUntil <= now ||
    raw.validUntil > raw.generatedAt + MAX_TTL_MS || raw.validUntil > raw.fetchedAt + MAX_TTL_MS ||
    (raw.expiresAt !== undefined && (!timestamp(raw.expiresAt) || raw.validUntil > raw.expiresAt)) ||
    !Array.isArray(raw.tracks)) return null;
  const tracks: Track[] = [];
  for (const value of raw.tracks) {
    const parsed = track(value, raw.sourceId);
    // A broken track invalidates the batch; never silently shorten/reorder it.
    if (!parsed) return null;
    tracks.push(parsed);
  }
  return { entryId: raw.entryId, sourceId: raw.sourceId, accountId: raw.accountId, accountSession: raw.accountSession,
    packVersion: raw.packVersion, date, generatedAt: raw.generatedAt, fetchedAt: raw.fetchedAt,
    validUntil: raw.validUntil, tracks,
    ...(raw.expiresAt === undefined ? {} : { expiresAt: raw.expiresAt as number }) };
}
function parse(raw: string | null): CacheEntry[] {
  try {
    const store = object(JSON.parse(raw ?? "null"));
    if (store?.v !== SCHEMA || !Array.isArray(store.records)) return [];
    const now = Date.now();
    const date = localDateKey();
    return store.records.map(value => entry(value, now, date)).filter((value): value is CacheEntry => value !== null)
      .sort((a, b) => b.generatedAt - a.generatedAt).slice(0, MAX_RECORDS);
  } catch { return []; }
}
function matches(value: CacheEntry, context: AccountRecommendationContext, date = localDateKey()): boolean {
  return value.date === date && value.sourceId === context.sourceId && value.accountId === context.accountId &&
    value.accountSession === context.accountSession && value.packVersion === context.packVersion;
}
function assertCurrent(context: AccountRecommendationContext, isCurrent?: () => boolean): void {
  if (isCurrent?.() === false) throw new AccountRecommendationError("STALE_CONTEXT");
  assertAccountRecommendationContextCurrent(context);
}
async function getRaw(): Promise<string | null> {
  try { return await ipc.getSetting(ACCOUNT_DAILY_CACHE_KEY); }
  catch (error) { throw safeAccountRecommendationError(error); }
}
async function setRecords(records: CacheEntry[]): Promise<void> {
  try { await ipc.setSetting(ACCOUNT_DAILY_CACHE_KEY, JSON.stringify({ v: SCHEMA, records })); }
  catch (error) { throw safeAccountRecommendationError(error); }
}
async function read(context: AccountRecommendationContext, isCurrent?: () => boolean): Promise<CacheEntry[]> {
  assertCurrent(context, isCurrent);
  const raw = await getRaw();
  assertCurrent(context, isCurrent);
  return parse(raw);
}
async function persist(records: CacheEntry[], context: AccountRecommendationContext, isCurrent?: () => boolean): Promise<void> {
  assertCurrent(context, isCurrent);
  await setRecords(records);
  assertCurrent(context, isCurrent);
}
/** Called only while holding the cache tail; delete only this exact stale write. */
async function retireEntry(entryId: string): Promise<void> {
  const raw = await getRaw();
  let present = false;
  try {
    const store = object(JSON.parse(raw ?? "null"));
    present = store?.v === SCHEMA && Array.isArray(store.records) &&
      store.records.some(value => object(value)?.entryId === entryId);
  } catch { /* A replacement/corrupt store is not this stale entry. */ }
  if (!present) return;
  const records = parse(raw).filter(value => value.entryId !== entryId);
  await setRecords(records);
}
export function readAccountDailyCache(context: AccountRecommendationContext, isCurrent?: () => boolean): Promise<AccountDailyCacheValue | null> {
  return serialize(async () => {
    const records = await read(context, isCurrent);
    return records.find(value => matches(value, context)) ?? null;
  });
}
export function writeAccountDailyCache(context: AccountRecommendationContext, value: AccountDailyCacheValue, isCurrent?: () => boolean): Promise<void> {
  return serialize(async () => {
    const records = await read(context, isCurrent);
    const validUntil = Math.min(value.generatedAt + MAX_TTL_MS, value.fetchedAt + MAX_TTL_MS,
      value.expiresAt ?? Number.POSITIVE_INFINITY);
    const entryId = globalThis.crypto.randomUUID();
    const next = entry({ entryId, sourceId: context.sourceId, accountId: context.accountId,
      accountSession: context.accountSession, packVersion: context.packVersion,
      date: value.date, generatedAt: value.generatedAt, fetchedAt: value.fetchedAt, validUntil,
      expiresAt: value.expiresAt, tracks: value.tracks }, Date.now(), localDateKey());
    // Already-expired platform batches are not usable as a cache for later calls.
    if (!next) return;
    try {
      await persist([next, ...records.filter(record => !matches(record, context, value.date))].slice(0, MAX_RECORDS), context, isCurrent);
    } catch (error) {
      // Native may have committed before its ACK. Cleanup stays inside this tail,
      // without a now-revoked context authorizing a new account write.
      await retireEntry(entryId);
      throw error;
    }
  });
}
export function clearAccountDailyCache(context: AccountRecommendationContext, isCurrent?: () => boolean): Promise<void> {
  return serialize(async () => {
    const records = await read(context, isCurrent);
    await persist(records.filter(value => !matches(value, context)), context, isCurrent);
  });
}

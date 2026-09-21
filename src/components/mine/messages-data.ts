/**
 * 消息中心数据层（DESIGN §15.4）：标题栏弹出面板与（历史）页面共用同一套
 * 取数与已读缓存。
 *
 * 与移动端对齐的几点：
 * - 未登录也能看：已登录走 `app/message/center`（含反馈 / 需求通知），未登录回退到
 *   公开的 `app/message/active`，按展示位掩码取出「消息中心」那部分（后端 center
 *   接口要求登录，active 游客可见）。
 * - 后端一次性返回完整正文，**没有单独的详情接口**，所以列表只截断显示摘要，
 *   点进去展示全文（前端切视图，不走路由）。
 * - 已读状态后端不返回，移动端也是前端缓存；这里存 localStorage，
 *   同时尝试调一次 read-ack，后端不认也不影响。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { errMsg } from "@/lib/utils";
import { migrateLegacyStorageKey } from "@/lib/legacy-storage";
import * as ipc from "@/services/ipc";
import { useAuthStore } from "@/stores/auth";
import { htmlToText } from "@/lib/richText";

/** 更名前的前缀是 lightlisten.*（见 lib/legacy-storage） */
const READ_KEY = "quietmusic.messages.read";
migrateLegacyStorageKey(READ_KEY);

/** 展示位掩码：1 开屏 2 通告栏 4 消息中心（对齐后端 SysNotice.display） */
const DISPLAY_MESSAGE_CENTER = 4;

export interface MessageItem {
  id: number;
  title: string;
  content: string;
  time: string;
  read: boolean;
  url?: string;
}

export interface MessagesData {
  items: MessageItem[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  markRead: (id: number) => void;
  markAllRead: () => void;
}

export function useMessages(): MessagesData {
  const session = useAuthStore((s) => s.session);

  const [items, setItems] = useState<MessageItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // items 的 ref：markAllRead 要按当前列表算未读，不能闭包旧值
  const itemsRef = useRef<MessageItem[]>([]);
  itemsRef.current = items;

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      // 未登录时 center 接口会 401，改走公开的 active 并只取消息中心展示位
      const data = session
        ? await ipc.astralMessageCenter()
        : messageCenterOfActive(await ipc.astralActiveMessages());
      const readIds = new Set(readReadIds());
      setItems(
        normalizeMessages(data).map((it) => ({
          ...it,
          read: it.read || readIds.has(it.id),
        })),
      );
    } catch (err) {
      setError(errMsg(err));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  const markRead = useCallback((id: number): void => {
    const ids = readReadIds();
    if (!ids.includes(id)) {
      ids.push(id);
      writeReadIds(ids);
    }
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, read: true } : it)),
    );
    // 回执失败无所谓：已读以本地缓存为准
    void ipc.astralAckMessages([id]).catch(() => {});
  }, []);

  const markAllRead = useCallback((): void => {
    const unread = itemsRef.current.filter((it) => !it.read).map((it) => it.id);
    if (unread.length === 0) return;
    writeReadIds([...new Set([...readReadIds(), ...unread])]);
    setItems((prev) => prev.map((it) => ({ ...it, read: true })));
    void ipc.astralAckMessages(unread).catch(() => {});
  }, []);

  return { items, loading, error, reload: load, markRead, markAllRead };
}

/** 摘要：富文本去标签后压成单行并截断 */
export function summary(content: string): string {
  const flat = htmlToText(content).replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "（无正文）";
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

// ---------- 后端结构宽松适配 ----------

/** 公开接口 active 混了所有展示位，未登录时只挑出消息中心那部分 */
function messageCenterOfActive(data: unknown): unknown[] {
  return pickList(data).filter((it) => {
    const o = (it ?? {}) as Record<string, unknown>;
    return (num(o.display ?? o.type ?? 0) & DISPLAY_MESSAGE_CENTER) !== 0;
  });
}

function normalizeMessages(data: unknown): MessageItem[] {
  return pickList(data).map((item, i) => {
    const o = (item ?? {}) as Record<string, unknown>;
    const url = str(o.url ?? o.link);
    return {
      id: num(o.id ?? o.messageId ?? o.msgId ?? i),
      title: str(o.title ?? o.subject ?? o.name ?? "通知"),
      content: str(o.content ?? o.body ?? o.text ?? o.message ?? o.summary),
      time: formatTime(o.createTime ?? o.createdAt ?? o.time ?? o.sendTime),
      read: bool(o.read ?? o.isRead ?? o.readed ?? o.hasRead),
      url: url.length > 0 ? url : undefined,
    };
  });
}

function pickList(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    for (const key of ["list", "records", "items", "rows", "data"]) {
      const v = o[key];
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function num(v: unknown): number {
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function bool(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}

function formatTime(v: unknown): string {
  if (v == null || v === "") return "";
  const n = num(v);
  if (n > 0) {
    const ms = n > 1e12 ? n : n * 1000;
    const d = new Date(ms);
    const pad = (x: number): string => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return str(v);
}

/** 已读 id 缓存：后端不返回已读状态，只能本地记 */
function readReadIds(): number[] {
  try {
    const raw = localStorage.getItem(READ_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is number => typeof x === "number")
      : [];
  } catch {
    return [];
  }
}

function writeReadIds(ids: number[]): void {
  try {
    localStorage.setItem(READ_KEY, JSON.stringify(ids));
  } catch {
    // 存不下就只在本次会话内有效
  }
}

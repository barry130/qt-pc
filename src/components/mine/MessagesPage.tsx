import { useCallback, useEffect, useState } from "react";
import { errMsg } from "@/lib/utils";
import { migrateLegacyStorageKey } from "@/lib/legacy-storage";
import { ArrowLeft } from "lucide-react";
import * as ipc from "@/services/ipc";
import { useAuthStore } from "@/stores/auth";
import { RichText, htmlToText } from "@/lib/richText";

/**
 * 消息中心（路由 /messages，DESIGN §15.4）。
 *
 * 与移动端对齐的几点：
 * - 未登录也能看：已登录走 `app/message/center`（含反馈 / 需求通知），未登录回退到
 *   公开的 `app/message/active`，按展示位掩码取出「消息中心」那部分（后端 center
 *   接口要求登录，active 游客可见）。
 * - 后端一次性返回完整正文，**没有单独的详情接口**，所以列表只截断显示摘要，
 *   点进去展示全文（前端切视图，不走路由）。
 * - 已读状态后端不返回，移动端也是前端缓存；这里存 localStorage，
 *   同时尝试调一次 read-ack，后端不认也不影响。
 * - 正文是富文本（HTML），交给 `lib/richText` 白名单解析渲染；纯文本正文兼容。
 */
/** 更名前的前缀是 lightlisten.*（见 lib/legacy-storage） */
const READ_KEY = "quietmusic.messages.read";
migrateLegacyStorageKey(READ_KEY);

/** 展示位掩码：1 开屏 2 通告栏 4 消息中心（对齐后端 SysNotice.display） */
const DISPLAY_MESSAGE_CENTER = 4;

interface MessageItem {
  id: number;
  title: string;
  content: string;
  time: string;
  read: boolean;
  url?: string;
}

export function MessagesPage(): React.JSX.Element {
  const session = useAuthStore((s) => s.session);

  const [items, setItems] = useState<MessageItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);

  const load = useCallback(async () => {
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

  const markRead = (id: number): void => {
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
  };

  const markAllRead = (): void => {
    const unread = items.filter((it) => !it.read).map((it) => it.id);
    if (unread.length === 0) return;
    writeReadIds([...new Set([...readReadIds(), ...unread])]);
    setItems((prev) => prev.map((it) => ({ ...it, read: true })));
    void ipc.astralAckMessages(unread).catch(() => {});
  };

  const current =
    openId != null ? items.find((it) => it.id === openId) ?? null : null;

  if (current) {
    return (
      <div className="h-full min-w-0 overflow-y-auto px-5 py-5">
        <button
          type="button"
          onClick={() => setOpenId(null)}
          className="mb-4 flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          返回
        </button>

        <h1 className="text-lg font-semibold">{current.title}</h1>
        {current.time && (
          <p className="mt-1 text-xs text-muted-foreground">{current.time}</p>
        )}

        <div className="mt-4">
          <RichText text={current.content} />
        </div>

        {current.url && (
          <a
            href={current.url}
            onClick={(e) => {
              e.preventDefault();
              // Tauri 里 target=_blank 不生效，统一交系统浏览器打开
              void ipc.openExternalUrl(current.url ?? "").catch(() => undefined);
            }}
            className="mt-5 inline-block break-all text-xs text-primary underline underline-offset-2"
          >
            {current.url}
          </a>
        )}
      </div>
    );
  }

  const unread = items.filter((it) => !it.read);

  return (
    <div className="h-full min-w-0 overflow-y-auto px-5 py-5">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">
          消息中心
          {unread.length > 0 && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {unread.length} 条未读
            </span>
          )}
        </h1>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void load()}
            className="h-8 rounded-md border border-border px-3 text-xs transition-colors hover:bg-secondary"
          >
            刷新
          </button>
          <button
            type="button"
            onClick={markAllRead}
            disabled={unread.length === 0}
            className="h-8 rounded-md border border-border px-3 text-xs transition-colors hover:bg-secondary disabled:opacity-40"
          >
            全部已读
          </button>
        </div>
      </div>

      {loading ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          加载中…
        </p>
      ) : error ? (
        <div className="py-16 text-center">
          <p className="text-sm text-muted-foreground">暂时读不到消息</p>
          <p className="mt-2 text-xs text-muted-foreground">{error}</p>
        </div>
      ) : items.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">
          还没有消息
        </p>
      ) : (
        <ul className="mt-4">
          {items.map((it) => (
            <li key={it.id}>
              <button
                type="button"
                onClick={() => {
                  setOpenId(it.id);
                  markRead(it.id);
                }}
                className="w-full border-b border-border/50 py-3 text-left transition-colors hover:bg-secondary/50"
              >
                <div className="flex items-center gap-2">
                  {!it.read && (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {it.title}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {it.time}
                  </span>
                </div>
                {/* 列表只给摘要，全文进详情看 */}
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {summary(it.content)}
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 摘要：富文本去标签后压成单行并截断 */
function summary(content: string): string {
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

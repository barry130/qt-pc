import { useCallback, useEffect, useState } from "react";
import { errMsg } from "@/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Bell } from "lucide-react";
import * as ipc from "@/services/ipc";
import { useAuthStore } from "@/stores/auth";

/**
 * 消息中心（路由 /messages，DESIGN §15.4）。
 *
 * 与移动端对齐的几点：
 * - 后端 `app/message/center` 一次性返回完整正文，**没有单独的详情接口**，
 *   所以列表只截断显示摘要，点进去展示全文（前端切视图，不走路由）。
 * - 已读状态后端不返回，移动端也是前端缓存；这里存 localStorage，
 *   同时尝试调一次 read-ack，后端不认也不影响。
 * - 正文格式是「纯文本 + 换行 + 简单链接」（不是 HTML），所以直接分段渲染 +
 *   把 URL 摘出来做可点击，不需要 dangerouslySetInnerHTML。
 */
const READ_KEY = "lightlisten.messages.read";

interface MessageItem {
  id: number;
  title: string;
  content: string;
  time: string;
  read: boolean;
  url?: string;
}

export function MessagesPage(): React.JSX.Element {
  const navigate = useNavigate();
  const session = useAuthStore((s) => s.session);

  const [items, setItems] = useState<MessageItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await ipc.astralMessageCenter();
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
  }, []);

  useEffect(() => {
    if (!session) {
      setLoading(false);
      return;
    }
    void load();
  }, [session, load]);

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

  if (!session) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <Bell className="h-8 w-8 text-muted-foreground" />
        <p className="mt-4 text-sm">消息需要登录后查看</p>
        <button
          type="button"
          onClick={() => void navigate({ to: "/login" })}
          className="mt-4 h-9 rounded-md bg-primary px-4 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          去登录
        </button>
      </div>
    );
  }

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
            target="_blank"
            rel="noreferrer"
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

/** 摘要：换行压成空格后截断 */
function summary(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "（无正文）";
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

/**
 * 正文渲染：按换行分段，段落里的 URL 做成可点击。
 * 内容实际是「纯文本 + 换行 + 简单链接」，因此不需要 innerHTML，也就没有注入面。
 */
function RichText(props: { text: string }): React.JSX.Element {
  const paragraphs = props.text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (paragraphs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">（这条消息没有正文）</p>
    );
  }

  return (
    <div className="space-y-3">
      {paragraphs.map((p, i) => (
        <p
          key={i}
          className="whitespace-pre-wrap break-words text-sm leading-relaxed"
        >
          {splitLinks(p).map((part, j) =>
            part.type === "link" ? (
              <a
                key={j}
                href={part.value}
                target="_blank"
                rel="noreferrer"
                className="break-all text-primary underline underline-offset-2"
              >
                {part.value}
              </a>
            ) : (
              <span key={j}>{part.value}</span>
            ),
          )}
        </p>
      ))}
    </div>
  );
}

function splitLinks(text: string): { type: "text" | "link"; value: string }[] {
  const parts: { type: "text" | "link"; value: string }[] = [];
  const re = /(https?:\/\/[^\s，。）)、】]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      parts.push({ type: "text", value: text.slice(last, m.index) });
    }
    parts.push({ type: "link", value: m[1] });
    last = m.index + m[1].length;
  }
  if (last < text.length) {
    parts.push({ type: "text", value: text.slice(last) });
  }
  return parts;
}

// ---------- 后端结构宽松适配 ----------

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

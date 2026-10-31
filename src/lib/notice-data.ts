/**
 * 通告数据层（对齐后端 astral `SysNotice` 与移动端 `services/notice.ts`）。
 *
 * 后端 `GET /api/v1/app/message/active` 一次返回**所有展示位**的公告，由客户端按
 * `display` 位掩码分发：1 开屏弹窗、2 首页通告栏、4 消息中心（可叠加）。
 * 此前 qt-pc 只有开屏弹窗自己取一次数，通告栏干脆没有；移动端则是取一次、按
 * `dispatchNotices` 分三份给三个展示位。这里收成同一套：取数 + 归一 + 排序 +
 * 分发都在这一层，开屏弹窗、通告栏、消息中心共用**一次**请求（后端有 60s 缓存，
 * 前端也没必要打三遍）。
 *
 * 归一负责把后端字段宽松适配成稳定结构（`display`/`url`/`isTop` 等可能缺省或
 * 类型漂移），并依 `isTop` 优先、再按 `createTime` 倒序排好 —— 三个展示位要的
 * 顺序是同一个，排序放在这里就不用各写一遍。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { coerceNumber as num, coerceString as str } from "@/lib/coerce";
import { parseNoticeLink, type NoticeLink } from "@/lib/notice-link";
import { errMsg } from "@/lib/utils";
import * as ipc from "@/services/ipc";

/** 展示位掩码：1 开屏 2 通告栏 4 消息中心（对齐后端 SysNotice.display） */
export const DISPLAY_SPLASH = 1;
export const DISPLAY_NOTICE_BAR = 2;
export const DISPLAY_MESSAGE_CENTER = 4;

/** 归一后的通告；字段语义见 astral `SysNotice` */
export interface ActiveNotice {
  id: number;
  /** 展示位位掩码，用 hasDisplay 判断，别直接比较 */
  display: number;
  /** announce（广播）| notice（点对点）| 历史别名 feedback / request */
  noticeType: string;
  title: string;
  content: string;
  /** 后端原始 url：外观层不要直接当链接用，走 link */
  url?: string;
  /** 解析后的跳转目标；undefined = 不可点（含未知协议/未知 host） */
  link?: NoticeLink;
  isTop: boolean;
  /** 通告栏是否跑马灯（后端 marquee 字段） */
  marquee: boolean;
  /** 是否允许用户关闭（开屏弹窗用；false = 必须阅读） */
  dialogClosable: boolean;
  /** 只对首次登录的用户弹一次（开屏弹窗用） */
  firstLoginOnly: boolean;
  /** 非空 = 首次启动免责声明，由 FirstRunDisclaimer 单独渲染，不进通用弹窗 */
  termsVersion: string;
  /** ALL（默认）| LOGGED_IN | NOT_LOGGED_IN */
  audience: string;
  createTime: string;
  /** 声明类公告的强制阅读秒数（通用公告/通告栏不用） */
  readSeconds: number;
}

export function hasDisplay(display: number, bit: number): boolean {
  return (display & bit) !== 0;
}

/**
 * 类型标签文案：与移动端 `noticeTypeLabel` 逐字一致（announce 公告 |
 * feedback 反馈 | request 需求，其余一律当公告）。
 */
export function noticeTypeLabel(noticeType?: string): string {
  if (noticeType === "feedback") return "反馈";
  if (noticeType === "request") return "需求";
  return "公告";
}

/** 受众过滤：未知取值按 ALL（后端默认），避免新枚举把所有端都打成「不可见」 */
export function isAudienceVisible(audience: string | undefined, loggedIn: boolean): boolean {
  switch ((audience ?? "ALL").toUpperCase()) {
    case "LOGGED_IN":
      return loggedIn;
    case "NOT_LOGGED_IN":
      return !loggedIn;
    default:
      return true;
  }
}

/**
 * 归一 + 排序 + 去重。
 *
 * 去重键是「标题 + 正文」：后端偶尔会把同一条公告按渠道各建一行（all 与 pc），
 * 归一后它们完全一样，展示两遍没有意义。
 */
export function normalizeActiveNotices(data: unknown): ActiveNotice[] {
  const seen = new Set<string>();
  return pickList(data)
    .map(toNotice)
    .filter((notice) => notice.display !== 0)
    .sort(byImportance)
    .filter((notice) => {
      const key = `${notice.title}\n${notice.content}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** isTop 优先，再按 createTime 倒序（时间格式是后端统一的 `yyyy-MM-dd HH:mm:ss`，串比即序） */
function byImportance(a: ActiveNotice, b: ActiveNotice): number {
  return Number(b.isTop) - Number(a.isTop) || b.createTime.localeCompare(a.createTime);
}

function toNotice(item: unknown, index: number): ActiveNotice {
  const o = (item ?? {}) as Record<string, unknown>;
  const url = str(o.url ?? o.link);
  // 兼容老字段：早期公告用 type 承载展示位，数字语义与 display 相同
  const display = num(o.display ?? o.type ?? 0);
  return {
    id: num(o.id ?? o.noticeId ?? o.messageId ?? index),
    display,
    noticeType: str(o.noticeType).trim().toLowerCase(),
    title: str(o.title),
    content: str(o.content),
    url: url.length > 0 ? url : undefined,
    link: parseNoticeLink(url) ?? undefined,
    isTop: num(o.isTop) === 1,
    marquee: num(o.marquee) === 1,
    // 后端未下发时按可关闭处理：不可关闭的公告若因字段缺失被误判，用户会被困住
    dialogClosable: num(o.dialogClosable ?? 1) === 1,
    firstLoginOnly: num(o.firstLoginOnly) === 1,
    termsVersion: str(o.termsVersion),
    audience: str(o.audience || "ALL").toUpperCase(),
    createTime: str(o.createTime),
    readSeconds: num(o.readSeconds),
  };
}

/** 通告栏要展示的那些（展示位 2 + 受众命由调用方叠加） */
export function pickNoticeBar(notices: ActiveNotice[], loggedIn: boolean): ActiveNotice[] {
  return notices.filter(
    (notice) =>
      hasDisplay(notice.display, DISPLAY_NOTICE_BAR) &&
      isAudienceVisible(notice.audience, loggedIn),
  );
}

/**
 * 开屏弹窗该弹哪些：与改造前的过滤链逐条一致，只是输入换成归一结果。
 *
 * - 免责声明（termsVersion 非空）由 FirstRunDisclaimer 单独渲染，混进来会两个弹窗叠着弹；
 * - audience 不匹配的不弹；
 * - firstLoginOnly 的按 id 记已弹：老用户看过旧公告，新发布的这条仍该弹。
 */
export function pickSplashNotices(
  notices: ActiveNotice[],
  opts: { loggedIn: boolean; isFirstLoginShown: (id: number) => boolean },
): ActiveNotice[] {
  return notices.filter((notice) => {
    if (!hasDisplay(notice.display, DISPLAY_SPLASH)) return false;
    if (notice.termsVersion.trim().length > 0) return false;
    if (!isAudienceVisible(notice.audience, opts.loggedIn)) return false;
    if (notice.firstLoginOnly && (!opts.loggedIn || opts.isFirstLoginShown(notice.id))) return false;
    return true;
  });
}

// ---------- 取数（模块级缓存，三个展示位共用一次请求） ----------

/** 与后端 Caffeine 缓存同量级：60s 内的重复挂载不再打网络 */
const CACHE_TTL_MS = 60_000;

let cache: { at: number; data: ActiveNotice[] } | null = null;
let inflight: Promise<ActiveNotice[]> | null = null;

/** 测试用：清掉模块级缓存，让每个用例从干净状态开始 */
export function resetActiveNoticeCache(): void {
  cache = null;
  inflight = null;
}

/**
 * 取通告列表。`force` 用于「消息中心手动刷新」。
 * 并发调用共享同一个请求（开屏弹窗与通告栏同时挂载时只会发一次）。
 */
export function loadActiveNotices(force = false): Promise<ActiveNotice[]> {
  if (!force && cache !== null && Date.now() - cache.at < CACHE_TTL_MS) {
    return Promise.resolve(cache.data);
  }
  if (inflight !== null) return inflight;
  inflight = ipc
    .astralActiveMessages()
    .then((raw) => {
      const data = normalizeActiveNotices(raw);
      cache = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export interface ActiveNoticesState {
  notices: ActiveNotice[];
  loading: boolean;
  error: string | null;
  /** 忽略缓存重新取（消息中心「刷新」用） */
  reload: () => void;
}

export function useActiveNotices(): ActiveNoticesState {
  const [notices, setNotices] = useState<ActiveNotice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 卸载后不再 setState：请求可能比组件活得久（缓存命中时又是同步 resolve）
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const load = useCallback((force: boolean): void => {
    setLoading(true);
    setError(null);
    void loadActiveNotices(force)
      .then((data) => {
        if (aliveRef.current) setNotices(data);
      })
      .catch((err: unknown) => {
        if (aliveRef.current) setError(errMsg(err));
      })
      .finally(() => {
        if (aliveRef.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    load(false);
  }, [load]);

  const reload = useCallback((): void => {
    load(true);
  }, [load]);

  return { notices, loading, error, reload };
}

function pickList(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    for (const key of ["list", "records", "items", "rows", "data"]) {
      const value = o[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}

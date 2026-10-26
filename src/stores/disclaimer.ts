import { create } from "zustand";
import * as ipc from "@/services/ipc";
import { coerceNumber as numberValue, coerceString as stringValue } from "@/lib/coerce";
import { DISCLAIMER_KEY } from "@/lib/storageKeys";

/**
 * 首次启动免责声明 / 开源通知（DESIGN §5.6）。
 *
 * **文案由后端下发**：后台「消息管理」发布一条开屏公告（`display` 含 1，
 * 并填了「条款版本号」），本模块从 `app/message/active` 拉回来渲染。
 * 判定一个公告是不是首次启动声明的唯一标识是 **`termsVersion` 非空** ——
 * 这个字段只有声明会填，别的公告留空，因此不需要额外的 scene 约定。
 *
 * 什么时候弹：
 * - 没接受过 → 弹；
 * - 接受过、且条款版本号与下发的不同 → 再弹一次（改了条款要重新确认）；
 * - 接受记录是旧版裸 ISO 字符串（本改动之前写的）→ 不再弹，升级不该骚扰老用户；
 * - 后端没下发声明（离线 / 后台还没发）→ 不弹。**不留硬编码兜底文案**，
 *   否则「改了后台却还弹旧文案」正是这个改动要消灭的坑。
 *
 * 两个入口：
 * - 启动：AppShell 挂 `init()`；
 * - 设置页「重新查看」：`reopen()`，只展示、不改已有接受记录。
 *
 * 读库或网络失败都按「不弹」处理：宁可这次不弹，也不把人卡在弹窗前出不去。
 */
export interface DisclaimerNotice {
  id: number;
  title: string;
  /** 富文本（后台填写），由 `lib/richText` 白名单渲染，不走 innerHTML */
  content: string;
  /** 读秒时长；0 = 不读秒，确认键立即可点 */
  readSeconds: number;
  /** 条款版本号；后端有值时才算「首次启动声明」 */
  termsVersion: string;
  /** 附加链接（后台「跳转链接」栏，通常是官网/完整协议）；空串 = 不显示 */
  url: string;
}

/** 已落库的接受记录 */
interface Acceptance {
  /** 接受时的条款版本号；null = 本改动之前写的裸 ISO 记录（无法判定版本） */
  termsVersion: string | null;
  acceptedAt: string;
}

interface DisclaimerStore {
  /** null = 还没读库（此时不显示，避免闪一下）；true = 需要展示；false = 不展示 */
  pending: boolean | null;
  /** 设置页主动重看：不写标记，只是把弹窗再打开一次 */
  reopened: boolean;
  /** 一个进程只读一次库；测试里把它置回 false 即可重置 */
  inited: boolean;
  /** 后端下发的声明本体；null = 没拉到（不弹） */
  notice: DisclaimerNotice | null;
  init: () => Promise<void>;
  accept: () => Promise<void>;
  /** 设置页「重新查看」。返回 false = 后端没有可展示的声明，调用方该给个提示而不是静默 */
  reopen: () => Promise<boolean>;
}

/** 展示位掩码：开屏（与服务端 FeedbackNoticeService.DISPLAY_SPLASH 同值） */
const DISPLAY_SPLASH = 1;

/**
 * 读秒上限（秒）。后台表单的 `InputNumber max={60}` 已经卡了 60，这里再兜一次：
 * 这个弹窗是全屏遮罩、没有关闭键，只能等读秒走完，是**唯一能把用户锁在界面里**的地方。
 * 绕过表单直接调 API 或手改库写成 600，就等于把所有新用户首次启动锁十分钟。
 * 取 60 而不是「不设上限」：真要点 10 分钟才能用的声明，是文案该改，不是读秒该等。
 */
const MAX_READ_SECONDS = 60;

/**
 * 弹窗此刻是否该显示。抽成导出函数而不是让调用方各写一遍 `pending === true || reopened`：
 * 漏掉 `notice != null` 会让「没拉到声明」时弹出一个空壳，
 * 而 `MetaPackGuide` 要靠这个判断让位 —— 两处判断走偏就会出现两个浮层叠着。
 */
export function disclaimerVisible(state: Pick<DisclaimerStore, "pending" | "reopened" | "notice">): boolean {
  return state.notice != null && (state.pending === true || state.reopened);
}

export const useDisclaimerStore = create<DisclaimerStore>()((set, get) => ({
  pending: null,
  reopened: false,
  inited: false,
  notice: null,
  init: async () => {
    if (get().inited) return;
    set({ inited: true });
    const [saved, notice] = await Promise.all([readAcceptance(), fetchNotice()]);
    set({ notice, pending: shouldShow(saved, notice) });
  },
  accept: async () => {
    const termsVersion = get().notice?.termsVersion ?? "";
    // 先关弹窗再落库：写库失败最多下次再弹一次，不该把人拦在这儿出不去
    set({ pending: false, reopened: false });
    const record: Acceptance = { termsVersion, acceptedAt: new Date().toISOString() };
    try {
      await ipc.setSetting(DISCLAIMER_KEY, JSON.stringify(record));
    } catch {
      // 同上
    }
  },
  reopen: async () => {
    // 启动时网络不通导致没拉到，这里补一次；仍失败就返回 false 让调用方提示
    if (get().notice == null) {
      const notice = await fetchNotice();
      if (notice == null) return false;
      set({ notice });
    }
    set({ reopened: true });
    return true;
  },
}));

/** 是否需要展示。单独抽出来是为了让三条判定（没接受 / 版本变了 / 老记录）一眼可读可测 */
function shouldShow(saved: Acceptance | null, notice: DisclaimerNotice | null): boolean {
  if (notice == null) return false;
  if (saved == null) return true;
  // 旧版裸 ISO 记录：已接受，且没有版本号可比，不因新增版本号机制打扰老用户
  if (saved.termsVersion == null) return false;
  return saved.termsVersion !== notice.termsVersion;
}

/** 读已接受记录：兼容本改动之前的裸 ISO 字符串（那种形态没有版本号） */
async function readAcceptance(): Promise<Acceptance | null> {
  let raw: unknown;
  try {
    raw = await ipc.getSetting(DISCLAIMER_KEY);
  } catch {
    // 库没就绪 / 旧版后端没这个命令：按「已接受」处理（见文件头说明）
    return { termsVersion: null, acceptedAt: "" };
  }
  // getSetting 声明返回 string|null，但它是跨 IPC 边界的值：类型标注管不到运行期，
  // 真机上见过数字 / 对象漏回来的情况。这里按 unknown 收，绝不直接 .trim()
  if (raw != null && typeof raw !== "string") raw = JSON.stringify(raw);
  const value = stringValue(raw).trim();
  if (value.length === 0) return null;
  if (value.startsWith("{")) {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      const version = stringValue(parsed.termsVersion).trim();
      const at = stringValue(parsed.acceptedAt);
      // 结构对但没有版本号 = 记录坏了（早期 mock / 手改过库）。当作没接受过，
      // 让用户确认一次就写回正确结构，能自愈；当成「已接受」则这条声明永远不再出现
      if (version.length === 0) return null;
      return { termsVersion: version, acceptedAt: at };
    } catch {
      // 坏 JSON 当作没接受过：宁可多弹一次，也别把一份读不懂的记录当成同意
      return null;
    }
  }
  // 裸 ISO 时刻（旧版写入）
  return { termsVersion: null, acceptedAt: value };
}

async function fetchNotice(): Promise<DisclaimerNotice | null> {
  try {
    return pickDisclaimer(await ipc.astralActiveMessages());
  } catch {
    return null;
  }
}

/** 从公开的 active 列表里挑出首次启动声明：开屏位 + 条款版本号非空，置顶优先、再按创建时间倒序 */
export function pickDisclaimer(data: unknown): DisclaimerNotice | null {
  if (!Array.isArray(data)) return null;
  const candidates = data
    .filter((item): item is Record<string, unknown> => item != null && typeof item === "object")
    .filter((o) => (numberValue(o.display) & DISPLAY_SPLASH) !== 0)
    .filter((o) => stringValue(o.termsVersion).trim().length > 0)
    .sort(
      (a, b) =>
        numberValue(b.isTop) - numberValue(a.isTop) ||
        stringValue(b.createTime).localeCompare(stringValue(a.createTime)),
    );
  const first = candidates[0];
  if (first == null) return null;
  return {
    id: numberValue(first.id),
    title: stringValue(first.title),
    content: stringValue(first.content),
    readSeconds: Math.min(MAX_READ_SECONDS, Math.max(0, numberValue(first.readSeconds))),
    termsVersion: stringValue(first.termsVersion).trim(),
    url: stringValue(first.url).trim(),
  };
}

// stringValue/numberValue 的实现合并到 `@/lib/coerce`（coerceString/coerceNumber）。

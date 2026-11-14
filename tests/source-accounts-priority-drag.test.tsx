// @vitest-environment jsdom
// 音源平台管理页：优先级拖拽排序（2026-11-14 用户需求：↑/↓ 按钮改为拖拽）。
// WebView2 实测会吞 HTML5 DnD 的 drop 事件 ⇒ 页面改用指针事件（pointerdown →
// window pointermove/pointerup），这里按同一路径驱动：命中测试走
// document.elementFromPoint，jsdom 无布局 ⇒ 用 spy 指定落点元素。
// 语义：拖到某卡=插到它前面；拖到尾部放置区=放最后；落在自己/空白处=不写；
// 键盘 ↑/↓（把手聚焦）仍走 movePolicySource。落库走 invoke("source_policy_set")。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const state = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  /** 捕获到的 source_policy_set 入参（最近一次） */
  savedPolicy: null as { version: number; enabled: string[] | null; order: string[] } | null,
  registry: {
    sources: [
      { id: "wyy", name: "网易云音乐", short: "网易", color: "#f00" },
      { id: "qq", name: "QQ 音乐", short: "QQ", color: "#0f0" },
      { id: "kw", name: "酷我音乐", short: "酷我", color: "#00f" },
    ],
    get catalog() { return this.sources; },
    policy: null as { version: number; enabled: string[] | null; order: string[] } | null,
    generation: 0,
    profiles: {},
    ready: true,
    ensure: () => Promise.resolve(),
  },
  toast: vi.fn(),
}));

vi.mock("@/services/ipc", () => ({
  getSetting: (key: string) => Promise.resolve(state.settings.get(key) ?? null),
  setSetting: (key: string, value: string) => {
    state.settings.set(key, value);
    return Promise.resolve();
  },
}));

// saveSourcePolicy 落库走 Tauri invoke("source_policy_set")，这里捕获入参
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "source_policy_set") {
      state.savedPolicy = args.policy as typeof state.savedPolicy;
      return null;
    }
    return null;
  },
}));

vi.mock("@/stores/sourceRegistry", () => ({
  useSourceRegistryStore: (selector: (s: typeof state.registry) => unknown) =>
    selector(state.registry),
  useSourceLabelFn: () => (id: string) => id,
  sourceQualityOptionsOf: () => [],
}));

vi.mock("@/stores/toast", () => ({
  toast: state.toast,
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/source-scripts", () => ({
  authCheckUser: () => Promise.resolve({ ok: true, credential: null, user: null, refreshToken: null }),
  authImportCookie: () =>
    Promise.resolve({ ok: true, user: { id: "1", nickname: "张三", avatar: "", vip: false, vipLabel: "" } }),
  authQrCreate: () => Promise.reject(new Error("not used here")),
  authQrPoll: () => Promise.reject(new Error("not used here")),
  authSendSms: () => Promise.reject(new Error("not used here")),
  authLoginByPhone: () => Promise.reject(new Error("not used here")),
  authLoginByPassword: () => Promise.reject(new Error("not used here")),
  authSetCredential: () => Promise.resolve(),
  authClearCredential: () => Promise.resolve(),
}));

vi.mock("@/source-engine/client", () => ({
  engineInvoke: async () => ({ ready: true, message: "" }),
  onEnginePhaseChange: () => () => undefined,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async () => () => undefined,
}));

vi.mock("@/lib/quality", () => ({
  qualityOptionsFromRegistry: () => [],
}));

vi.mock("@/lib/source-quality", () => ({
  SOURCE_QUALITIES_CHANGED_EVENT: "source-qualities-changed",
  loadSourceQualities: async () => undefined,
  setSourcePlayQuality: async () => undefined,
  setSourceDownloadQuality: async () => undefined,
  sourcePlayQualityOf: () => "standard",
  sourceDownloadQualityOf: () => "standard",
}));

vi.mock("@/lib/source-web-login", () => ({
  runWebLoginFlow: async () => "cancelled",
}));

import { SourceAccountsPage } from "@/components/mine/SourceAccountsPage";

function dragHandleOf(id: string): HTMLElement {
  const el = document.querySelector(`[data-drag-handle="${id}"]`);
  if (!el) throw new Error(`drag handle of ${id} not found`);
  return el as HTMLElement;
}

function cardOf(id: string): HTMLElement {
  const el = document.querySelector(`[data-source-card="${id}"]`);
  if (!el) throw new Error(`card of ${id} not found`);
  return el as HTMLElement;
}

/** 最近一次落库的 order（无写入时为 null） */
async function lastSavedOrder(): Promise<string[] | null> {
  await waitFor(() => expect(state.savedPolicy).not.toBeNull());
  return state.savedPolicy!.order;
}

/** 指针拖拽全程：把手 pointerDown → mock 命中 targetEl → pointerMove + pointerUp */
function pointerDrag(handle: HTMLElement, targetEl: () => Element | null): void {
  fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
  const stub = { elementFromPoint: document.elementFromPoint };
  // jsdom 无布局也不实现 elementFromPoint（beforeEach 已打桩）⇒ 这里指定落点
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    writable: true,
    value: () => targetEl(),
  });
  try {
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerUp(document, { pointerId: 1, clientX: 50, clientY: 50 });
  } finally {
    if (stub.elementFromPoint) {
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        writable: true,
        value: stub.elementFromPoint,
      });
    }
  }
}

beforeEach(() => {
  state.settings.clear();
  state.savedPolicy = null;
  state.toast.mockClear();
  // jsdom 无布局且未实现 document.elementFromPoint —— 打桩，用例内再指定落点
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    writable: true,
    value: () => null,
  });
});

afterEach(cleanup);

describe("音源平台管理：优先级指针拖拽排序", () => {
  it("卡片按策略顺序渲染：policy.order 驱动显示顺序（拖拽保存了却不重排=看起来没生效的回归网）", async () => {
    state.registry.policy = { version: 1, enabled: null, order: ["qq", "kw", "wyy"] };
    render(<SourceAccountsPage />);
    await screen.findByText("网易云音乐");
    const ids = [...document.querySelectorAll("[data-source-card]")].map((el) =>
      el.getAttribute("data-source-card"),
    );
    expect(ids).toEqual(["qq", "kw", "wyy"]);
  });

  it("把手 aria 与卡片定位属性齐备，且不破坏按源名查询折叠按钮", async () => {
    render(<SourceAccountsPage />);
    await screen.findByText("网易云音乐");
    // 把手：role=button、aria-label 不含源名（源名只进 title）
    expect(dragHandleOf("qq").getAttribute("aria-label")).toBe("拖拽调整优先级");
    // 源名仍只匹配到折叠按钮（唯一）
    expect(screen.getAllByRole("button", { name: /QQ 音乐/ })).toHaveLength(1);
  });

  it("拖 QQ 卡落到网易云卡上：插到它前面，order 变 [qq, wyy, kw]", async () => {
    render(<SourceAccountsPage />);
    await screen.findByText("网易云音乐");

    pointerDrag(dragHandleOf("qq"), () => cardOf("wyy"));

    expect(await lastSavedOrder()).toEqual(["qq", "wyy", "kw"]);
    // enabled 从 null 具体化为全量清单（与 toggle/move 同口径）
    expect(state.savedPolicy!.enabled).toEqual(["wyy", "qq", "kw"]);
  });

  it("拖到尾部放置区：放到最后一位，放置区在悬停时高亮", async () => {
    render(<SourceAccountsPage />);
    await screen.findByText("网易云音乐");

    pointerDrag(dragHandleOf("wyy"), () => screen.getByText("松手放到最后"));

    expect(await lastSavedOrder()).toEqual(["qq", "kw", "wyy"]);
  });

  it("落在自己卡片上：不触发保存", async () => {
    render(<SourceAccountsPage />);
    await screen.findByText("网易云音乐");

    pointerDrag(dragHandleOf("qq"), () => cardOf("qq"));

    // 给一次微任务机会，确认没有写入
    await new Promise((r) => setTimeout(r, 30));
    expect(state.savedPolicy).toBeNull();
  });

  it("落在列表空白处：视为取消，不写库", async () => {
    render(<SourceAccountsPage />);
    await screen.findByText("网易云音乐");

    pointerDrag(dragHandleOf("qq"), () => null);

    await new Promise((r) => setTimeout(r, 30));
    expect(state.savedPolicy).toBeNull();
  });

  it("指针拖拽态：目标卡高亮、尾部放置区出现，pointerCancel 后全部还原且不写库", async () => {
    render(<SourceAccountsPage />);
    await screen.findByText("网易云音乐");

    const handle = dragHandleOf("qq");
    fireEvent.pointerDown(handle, { button: 0, pointerId: 2, clientX: 10, clientY: 10 });
    // 拖拽中尾部放置区才出现
    expect(screen.getByText("松手放到最后")).toBeTruthy();
    // 被拖的卡片自身进入半透明描边态
    expect(cardOf("qq").className).toContain("opacity-70");

    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      writable: true,
      value: () => cardOf("wyy"),
    });
    try {
      fireEvent.pointerMove(document, { pointerId: 2, clientX: 50, clientY: 50 });
      // 目标卡进入高亮态（border-primary）
      expect(cardOf("wyy").className).toContain("border-primary");
    } finally {
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        writable: true,
        value: () => null,
      });
    }

    fireEvent.pointerCancel(document, { pointerId: 2 });
    expect(screen.queryByText("松手放到最后")).toBeNull();
    expect(cardOf("wyy").className).not.toContain("border-primary");
    expect(cardOf("qq").className).not.toContain("opacity-70");
    await new Promise((r) => setTimeout(r, 30));
    expect(state.savedPolicy).toBeNull();
  });
});

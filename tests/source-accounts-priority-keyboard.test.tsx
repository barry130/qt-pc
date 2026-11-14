// @vitest-environment jsdom
// 音源平台管理页：优先级拖拽的键盘兜底。把手聚焦后 ↑/↓ 仍走 movePolicySource
// （在「已启用」子序列内与相邻源交换）。独立成文件：source-policy 模块的内存
// 快照跨用例残留，键盘断言需要从默认 order 起算。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const state = vi.hoisted(() => ({
  savedPolicy: null as { version: number; enabled: string[] | null; order: string[] } | null,
  registry: {
    sources: [
      { id: "wyy", name: "网易云音乐", short: "网易", color: "#f00" },
      { id: "qq", name: "QQ 音乐", short: "QQ", color: "#0f0" },
      { id: "kw", name: "酷我音乐", short: "酷我", color: "#00f" },
    ],
    get catalog() { return this.sources; },
    policy: null,
    generation: 0,
    profiles: {},
    ready: true,
    ensure: () => Promise.resolve(),
  },
  toast: vi.fn(),
}));

vi.mock("@/services/ipc", () => ({
  getSetting: async () => null,
  setSetting: async () => undefined,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "source_policy_set") {
      state.savedPolicy = args.policy as typeof state.savedPolicy;
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

async function awaitSaved(): Promise<string[]> {
  await waitFor(() => expect(state.savedPolicy).not.toBeNull());
  return state.savedPolicy!.order;
}

beforeEach(() => {
  state.savedPolicy = null;
  state.toast.mockClear();
});

afterEach(cleanup);

describe("音源平台管理：优先级键盘排序（把手 ↑/↓ 兜底）", () => {
  it("↑ 把 qq 上移到第一；随后 ↓ 再把它降回第二", async () => {
    render(<SourceAccountsPage />);
    await screen.findByText("网易云音乐");

    // 默认 order [] → 渲染序 [wyy, qq, kw]；↑ 上移 qq 与 wyy 交换
    fireEvent.keyDown(dragHandleOf("qq"), { key: "ArrowUp" });
    expect(await awaitSaved()).toEqual(["qq", "wyy", "kw"]);

    // 等上一次保存 accept 后再操作，避免读到旧快照
    await new Promise((r) => setTimeout(r, 10));
    state.savedPolicy = null;
    fireEvent.keyDown(dragHandleOf("qq"), { key: "ArrowDown" });
    expect(await awaitSaved()).toEqual(["wyy", "qq", "kw"]);
  });
});

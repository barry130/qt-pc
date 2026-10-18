// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { NetConfigView } from "@/types";

const mocks = vi.hoisted(() => ({
  getNetConfig: vi.fn(),
  setNetConfig: vi.fn(),
  testNetConfig: vi.fn(),
}));
vi.mock("@/services/ipc", () => mocks);
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
import { SettingsPage } from "@/components/SettingsPage";

const initial: NetConfigView = { proxyMode: "system", proxyUrl: "", sourceTimeoutMs: 10000 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function button(container: HTMLElement, text: string) {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`missing button: ${text}`);
  return found;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.getNetConfig.mockResolvedValue(initial);
  mocks.setNetConfig.mockImplementation(async (proxyMode: string, proxyUrl: string, sourceTimeoutMs: number) => ({ proxyMode, proxyUrl, sourceTimeoutMs }));
});
afterEach(cleanup);

describe("网络设置", () => {
  it("首次选择自定义时保留地址入口，填好地址后才发送保存", async () => {
    const { container } = render(<SettingsPage section="network" />);
    await waitFor(() => expect(container.textContent).toContain("跟随系统"));
    fireEvent.click(button(container, "自定义"));
    const input = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    expect(input).toBeTruthy();
    expect(mocks.setNetConfig).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "socks5://127.0.0.1:1080" } });
    fireEvent.blur(input);
    await waitFor(() => expect(mocks.setNetConfig).toHaveBeenCalledWith("custom", "socks5://127.0.0.1:1080", 10000));
  });

  it("连续修改先顺序保存，再保持最后一次选择，旧响应不覆盖新表单", async () => {
    const first = deferred<NetConfigView>();
    const second = deferred<NetConfigView>();
    mocks.setNetConfig.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { container } = render(<SettingsPage section="network" />);
    await waitFor(() => expect(container.textContent).toContain("跟随系统"));
    fireEvent.click(button(container, "直连"));
    await waitFor(() => expect(mocks.setNetConfig).toHaveBeenCalledTimes(1));
    fireEvent.click(button(container, "30 秒"));
    expect(mocks.setNetConfig).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve({ ...initial, proxyMode: "none" }));
    await waitFor(() => expect(mocks.setNetConfig).toHaveBeenNthCalledWith(2, "none", "", 30000));
    expect(button(container, "30 秒").className).toContain("bg-primary");
    await act(async () => second.resolve({ ...initial, proxyMode: "none", sourceTimeoutMs: 30000 }));
    expect(button(container, "直连").className).toContain("bg-primary");
    expect(button(container, "30 秒").className).toContain("bg-primary");
  });
});

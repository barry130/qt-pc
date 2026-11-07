// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DlnaButton } from "@/components/player/DlnaButton";
import { connectDlna, discoverDlna, disconnectDlna } from "@/services/ipc";
import { usePlayerStore } from "@/stores/player";
import type { DlnaCastState } from "@/types";

vi.mock("@/services/ipc", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/services/ipc")>(),
  discoverDlna: vi.fn(),
  connectDlna: vi.fn(),
  disconnectDlna: vi.fn(),
}));
vi.mock("@/hooks/useTauriEvent", () => ({ useTauriEvent: vi.fn() }));

const cast: DlnaCastState = {
  sessionId: 1, generation: 1, deviceId: "uuid:living-room", deviceName: "客厅电视",
  capabilities: { seek: true, volume: true, pause: true },
};

beforeEach(() => {
  vi.clearAllMocks();
  usePlayerStore.setState((state) => ({ state: state.state ? { ...state.state, cast: null } : null }));
  vi.mocked(discoverDlna).mockResolvedValue([{ id: cast.deviceId, name: cast.deviceName, capabilities: cast.capabilities }]);
  vi.mocked(connectDlna).mockResolvedValue(cast);
  vi.mocked(disconnectDlna).mockResolvedValue(undefined);
});

afterEach(() => {
  usePlayerStore.setState((state) => ({ state: state.state ? { ...state.state, cast: null } : null }));
});

describe("DLNA device selection", () => {
  it("discovers on open and connects using the native device identity", async () => {
    render(<DlnaButton />);
    expect(discoverDlna).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "DLNA 投屏" }));
    fireEvent.click(await screen.findByRole("button", { name: "客厅电视" }));
    await waitFor(() => expect(connectDlna).toHaveBeenCalledWith("uuid:living-room"));
    await waitFor(() => expect(screen.queryByRole("region", { name: "DLNA 投屏设备" })).toBeNull());
  });

  it("shows discovery errors and allows a retry", async () => {
    vi.mocked(discoverDlna).mockRejectedValueOnce(new Error("网络发现失败"));
    render(<DlnaButton />);
    fireEvent.click(screen.getByRole("button", { name: "DLNA 投屏" }));
    expect((await screen.findByRole("alert")).textContent).toContain("网络发现失败");
    fireEvent.click(screen.getByRole("button", { name: "刷新投屏设备" }));
    expect(await screen.findByRole("button", { name: "客厅电视" })).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("makes returning to local playback an explicit action", async () => {
    usePlayerStore.setState((state) => ({ state: state.state ? { ...state.state, cast } : null }));
    render(<DlnaButton />);
    fireEvent.click(screen.getByRole("button", { name: "投屏：客厅电视" }));
    const local = await screen.findByRole("button", { name: "切回本机播放" });
    await waitFor(() => expect((local as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(local);
    await waitFor(() => expect(disconnectDlna).toHaveBeenCalledWith(true));
  });
});

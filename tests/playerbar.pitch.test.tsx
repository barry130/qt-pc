// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(async () => vi.fn()) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => ({ history: { canGoBack: () => false, back: vi.fn() } }),
  useRouterState: (options?: { select?: (state: unknown) => unknown }) => {
    const state = { location: { pathname: "/" } };
    return options?.select ? options.select(state) : state;
  },
}));

import { PlayerBar } from "@/components/PlayerBar";
import { SoundSection } from "@/components/settings/sections/SoundSection";
import { PlayerBarSection } from "@/components/settings/sections/PlayerBarSection";
import { PLAYER_BAR_BUTTONS, PLAYER_BAR_DEFAULT_VISIBLE, PLAYER_BAR_MAX_VISIBLE, playerBarButtonMeta } from "@/lib/player-bar";
import { PLAYER_BAR_VISIBLE_KEY, usePlayerBarStore } from "@/stores/playerBar";
import { usePlayerStore } from "@/stores/player";
import { usePitchStore } from "@/stores/pitch";

beforeEach(() => {
  native.invoke.mockReset();
  native.listen.mockClear();
  native.invoke.mockImplementation(async (command: string, args?: { semitones: number }) => {
    if (command === "get_fx_state") return {
      eq: { enabled: false, preampDb: 0, gainsDb: Array(10).fill(0) },
      loudnorm: false, fade: { enabled: false, durationMs: 300 },
      spectrum: false, replayGain: "off", pitchSemitones: 3,
    };
    if (command === "set_pitch") return args?.semitones;
    return null;
  });
  usePlayerStore.setState({ state: null });
  usePlayerBarStore.setState({ visible: [], loaded: true });
  usePitchStore.setState({ semitones: 0, loaded: false, saving: false, error: null });
});

describe("播放条升降调入口", () => {
  it("默认隐藏；设置开关落盘，隐藏和重新显示均保留当前半音", async () => {
    expect(playerBarButtonMeta("pitch")?.slot).toBe("inline");
    expect(PLAYER_BAR_DEFAULT_VISIBLE).not.toContain("pitch");
    render(<><SoundSection /><PlayerBarSection /><PlayerBar /></>);
    const soundSlider = await screen.findByRole("slider", { name: "升降调（半音）" });
    expect(screen.queryByRole("button", { name: /^升降调：/ })).toBeNull();
    const toggle = screen.getByRole("switch", { name: "升降调" });
    fireEvent.click(toggle);
    await screen.findByRole("button", { name: "升降调：+3 半音" });
    expect(native.invoke).toHaveBeenCalledWith("set_setting", { key: PLAYER_BAR_VISIBLE_KEY, value: '["pitch"]' });

    fireEvent.change(soundSlider, { target: { value: "-5" } });
    await screen.findByRole("button", { name: "升降调：-5 半音" });
    await waitFor(() => expect(usePitchStore.getState().saving).toBe(false));
    native.invoke.mockClear();
    fireEvent.click(toggle);
    expect(screen.queryByRole("button", { name: /^升降调：/ })).toBeNull();
    expect((soundSlider as HTMLInputElement).value).toBe("-5");
    expect(native.invoke.mock.calls.some(([command]) => command === "set_pitch")).toBe(false);
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "升降调：-5 半音" })).toBeTruthy();
  });

  it("两处值实时共享，只注册一个 native 事件；弹层支持加减、滑条、恢复原调", async () => {
    usePlayerBarStore.setState({ visible: ["pitch"], loaded: true });
    render(<><SoundSection /><PlayerBar /></>);
    const soundSlider = await screen.findByRole("slider", { name: "升降调（半音）" });
    const trigger = await screen.findByRole("button", { name: "升降调：+3 半音" });
    const subscriptions = native.listen.mock.calls as unknown as Array<[string, (...args: unknown[]) => unknown]>;
    expect(subscriptions.filter(([event]) => event === "pitch-changed")).toHaveLength(1);
    fireEvent.click(trigger);
    const popup = screen.getByRole("dialog", { name: "升降调" });
    fireEvent.click(within(popup).getByRole("button", { name: "升高一个半音" }));
    await waitFor(() => expect((soundSlider as HTMLInputElement).value).toBe("4"));
    expect(trigger.textContent).toBe("+4");
    fireEvent.click(within(popup).getByRole("button", { name: "降低一个半音" }));
    await waitFor(() => expect((soundSlider as HTMLInputElement).value).toBe("3"));
    fireEvent.change(within(popup).getByRole("slider"), { target: { value: "-8" } });
    await waitFor(() => expect((soundSlider as HTMLInputElement).value).toBe("-8"));
    fireEvent.click(within(popup).getByRole("button", { name: "恢复原调" }));
    await waitFor(() => expect(trigger.textContent).toBe("0"));
    await waitFor(() => expect(usePitchStore.getState().saving).toBe(false));
    expect(native.invoke).toHaveBeenLastCalledWith("set_pitch", { semitones: 0 });
  });

  it("已用满10个inline名额时升降调开关置灰", () => {
    const full = PLAYER_BAR_BUTTONS.filter((button) => button.slot === "inline" && button.id !== "pitch" && !button.adminOnly)
      .slice(0, PLAYER_BAR_MAX_VISIBLE).map((button) => button.id);
    usePlayerBarStore.setState({ visible: full, loaded: true });
    render(<PlayerBarSection />);
    expect((screen.getByRole("switch", { name: "升降调" }) as HTMLButtonElement).disabled).toBe(true);
    expect(PLAYER_BAR_MAX_VISIBLE).toBe(10);
  });
});

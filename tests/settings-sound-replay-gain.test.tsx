// @vitest-environment jsdom
// 设置 → 音效 → ReplayGain（A1）：三档切换要落到后端命令，且回读的设置值
// 要如实反映到选中态（引擎那边 off / track / album 三档口径一致）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  getFxState: vi.fn(),
  setEq: vi.fn(() => Promise.resolve()),
  setLoudnorm: vi.fn(() => Promise.resolve()),
  setFade: vi.fn(() => Promise.resolve()),
  setSpectrum: vi.fn(() => Promise.resolve()),
  setReplayGainMode: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/services/ipc", () => mocks);

import { SoundSection } from "@/components/settings/sections/SoundSection";
import type { FxState } from "@/types";

function fxState(over: Partial<FxState> = {}): FxState {
  return {
    eq: { enabled: false, preampDb: 0, gainsDb: new Array(10).fill(0) },
    loudnorm: false,
    fade: { enabled: false, durationMs: 300 },
    spectrum: false,
    replayGain: "off",
    ...over,
  };
}

/** ReplayGain 那一组单选（Segmented 用 role="radiogroup" + aria-label） */
function gainRadios(): HTMLElement[] {
  const group = screen.getByRole("radiogroup", { name: "ReplayGain 响度模式" });
  return [...group.querySelectorAll<HTMLElement>('[role="radio"]')];
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockClear();
  mocks.getFxState.mockResolvedValue(fxState());
});

afterEach(cleanup);

describe("设置 → 音效 → ReplayGain", () => {
  it("默认关闭：三档都在，关闭是选中态", async () => {
    render(<SoundSection />);
    await screen.findByText("ReplayGain 响度");
    const radios = gainRadios();
    expect(radios.map((r) => r.textContent)).toEqual(["关闭", "单曲", "专辑"]);
    expect(radios[0]?.getAttribute("aria-checked")).toBe("true");
  });

  it("点「专辑」把模式写到后端并就地切换选中态", async () => {
    render(<SoundSection />);
    await screen.findByText("ReplayGain 响度");
    fireEvent.click(screen.getByRole("radio", { name: "专辑" }));
    expect(mocks.setReplayGainMode).toHaveBeenCalledTimes(1);
    expect(mocks.setReplayGainMode).toHaveBeenCalledWith("album");
    await waitFor(() => {
      expect(screen.getByRole("radio", { name: "专辑" }).getAttribute("aria-checked")).toBe("true");
    });
  });

  it("回读到的模式决定初始选中态（track → 单曲）", async () => {
    mocks.getFxState.mockResolvedValue(fxState({ replayGain: "track" }));
    render(<SoundSection />);
    await screen.findByText("ReplayGain 响度");
    expect(screen.getByRole("radio", { name: "单曲" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "关闭" }).getAttribute("aria-checked")).toBe("false");
  });

  it("后端报错时把原因显示出来，不静默失败", async () => {
    mocks.setReplayGainMode.mockRejectedValueOnce(new Error("数据库不可用"));
    render(<SoundSection />);
    await screen.findByText("ReplayGain 响度");
    fireEvent.click(screen.getByRole("radio", { name: "单曲" }));
    expect(await screen.findByText(/数据库不可用/)).toBeTruthy();
  });
});

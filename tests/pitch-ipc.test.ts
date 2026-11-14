import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import * as ipc from "@/services/ipc";

beforeEach(() => invoke.mockReset());

describe("独立升降调 IPC", () => {
  it("传入整数半音并返回后端实际生效值，不改变倍速", async () => {
    invoke.mockResolvedValueOnce(12);
    const applied = await ipc.setPitch(12);
    expect(applied).toBe(12);
    expect(invoke.mock.calls).toEqual([["set_pitch", { semitones: 12 }]]);
  });
});

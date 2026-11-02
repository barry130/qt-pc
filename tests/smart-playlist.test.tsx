// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * 智能歌单（A5 / 分析文档 §4.5）的规则编辑器口径：
 * - 新建：名称 + 一层条件（字段/运算符/值）+ 条数上限 + 排序 → createSmartPlaylist；
 * - 值为空的条件在保存时丢掉（不能把空值当条件发下去）；
 * - 换字段要把运算符一起重置（不然会留下「流派 不小于 4」这种组合）；
 * - 编辑态：先读回已有规则再允许保存，保存走 updateSmartPlaylist，不新建。
 */
const mocks = vi.hoisted(() => ({
  createSmartPlaylist: vi.fn(async (): Promise<string> => "pl-new"),
  updateSmartPlaylist: vi.fn(async (): Promise<void> => undefined),
  getSmartPlaylist: vi.fn(async (): Promise<null | Record<string, unknown>> => null),
  renamePlaylist: vi.fn(async (): Promise<void> => undefined),
}));

// 弹层只碰智能歌单这几个 IPC，其余用真模块即可。
vi.mock("@/services/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/ipc")>();
  return {
    ...actual,
    createSmartPlaylist: mocks.createSmartPlaylist,
    updateSmartPlaylist: mocks.updateSmartPlaylist,
    getSmartPlaylist: mocks.getSmartPlaylist,
    renamePlaylist: mocks.renamePlaylist,
  };
});

import { SmartPlaylistDialog, describeRules } from "@/components/mine/SmartPlaylistDialog";

beforeEach(() => {
  mocks.createSmartPlaylist.mockReset();
  mocks.createSmartPlaylist.mockResolvedValue("pl-new");
  mocks.updateSmartPlaylist.mockReset();
  mocks.updateSmartPlaylist.mockResolvedValue(undefined);
  mocks.getSmartPlaylist.mockReset();
  mocks.getSmartPlaylist.mockResolvedValue(null);
  mocks.renamePlaylist.mockReset();
  mocks.renamePlaylist.mockResolvedValue(undefined);
});

function valueInput(index = 1): HTMLInputElement {
  return screen.getByLabelText(`第 ${index} 个条件的值`) as HTMLInputElement;
}

function save(): void {
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
}

describe("智能歌单规则编辑器", () => {
  it("新建：名称 + 条件下发，未填上限就是不限", async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<SmartPlaylistDialog onClose={onClose} onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText(/歌单名称/), { target: { value: "摇滚五星" } });
    fireEvent.change(valueInput(), { target: { value: "摇滚" } });
    save();

    await waitFor(() => expect(mocks.createSmartPlaylist).toHaveBeenCalledTimes(1));
    expect(mocks.createSmartPlaylist).toHaveBeenCalledWith(
      "摇滚五星",
      { matchAll: true, rules: [{ field: "genre", op: "contains", value: "摇滚" }] },
      null,
      "added_desc",
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("pl-new"));
    expect(onClose).toHaveBeenCalled();
  });

  it("值为空的条件不当条件发下去（等于整个曲库）", async () => {
    render(<SmartPlaylistDialog onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/歌单名称/), { target: { value: "全都要" } });
    save();

    await waitFor(() => expect(mocks.createSmartPlaylist).toHaveBeenCalledTimes(1));
    const [, rules] = mocks.createSmartPlaylist.mock.calls[0] as unknown as [
      string,
      { matchAll: boolean; rules: unknown[] },
    ];
    expect(rules.rules).toEqual([]);
    expect(rules.matchAll).toBe(true);
  });

  it("换字段时运算符跟着重置（年份只能比大小）", async () => {
    render(<SmartPlaylistDialog onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/歌单名称/), { target: { value: "老歌" } });

    fireEvent.change(screen.getByLabelText("第 1 个条件的字段"), { target: { value: "year" } });
    // 从「流派包含」换成「年份不小于」，运算符不该还是 contains
    expect((screen.getByLabelText("第 1 个条件的运算符") as HTMLSelectElement).value).toBe("gte");
    fireEvent.change(valueInput(), { target: { value: "1999" } });
    save();

    await waitFor(() => expect(mocks.createSmartPlaylist).toHaveBeenCalledTimes(1));
    const [, rules] = mocks.createSmartPlaylist.mock.calls[0] as unknown as [
      string,
      { rules: { field: string; op: string; value: string }[] },
    ];
    expect(rules.rules).toEqual([{ field: "year", op: "gte", value: "1999" }]);
  });

  it("编辑态：读回规则后改名保存走更新，不新建", async () => {
    mocks.getSmartPlaylist.mockResolvedValue({
      pid: "pl-9",
      name: "摇滚歌单",
      rules: { matchAll: false, rules: [{ field: "genre", op: "contains", value: "摇滚" }] },
      limit: 30,
      sort: "rating",
      updatedAt: 0,
    });
    render(<SmartPlaylistDialog playlist={{ pid: "pl-9", name: "摇滚歌单" }} onClose={vi.fn()} />);

    await waitFor(() => expect(valueInput().value).toBe("摇滚"));
    expect((screen.getByLabelText(/歌单名称/) as HTMLInputElement).value).toBe("摇滚歌单");
    expect((screen.getByLabelText("最多多少首") as HTMLInputElement).value).toBe("30");

    fireEvent.change(screen.getByLabelText(/歌单名称/), { target: { value: "摇滚精选" } });
    save();

    await waitFor(() => expect(mocks.updateSmartPlaylist).toHaveBeenCalledTimes(1));
    expect(mocks.updateSmartPlaylist).toHaveBeenCalledWith(
      "pl-9",
      { matchAll: false, rules: [{ field: "genre", op: "contains", value: "摇滚" }] },
      30,
      "rating",
    );
    // 名字改了才调改名，规则保存本身不负责改名
    await waitFor(() => expect(mocks.renamePlaylist).toHaveBeenCalledWith("pl-9", "摇滚精选"));
    expect(mocks.createSmartPlaylist).not.toHaveBeenCalled();
  });

  it("保存失败留在弹层里报错，不关窗", async () => {
    const onClose = vi.fn();
    mocks.createSmartPlaylist.mockRejectedValue(new Error("数据库忙"));
    render(<SmartPlaylistDialog onClose={onClose} />);

    fireEvent.change(screen.getByLabelText(/歌单名称/), { target: { value: "摇滚" } });
    save();

    expect((await screen.findByRole("alert")).textContent).toContain("数据库忙");
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("describeRules", () => {
  it("把规则说成人话，空规则说明是整库", () => {
    expect(describeRules({ matchAll: true, rules: [] })).toBe("整个曲库");
    expect(describeRules({ matchAll: true, rules: [] }, 50)).toBe("整个曲库（取前 50 首）");
    expect(
      describeRules({
        matchAll: true,
        rules: [
          { field: "genre", op: "contains", value: "摇滚" },
          { field: "rating", op: "gte", value: "4" },
        ],
      }),
    ).toBe("流派包含「摇滚」 且 评分不小于 4");
    expect(
      describeRules({
        matchAll: false,
        rules: [
          { field: "lastPlayed", op: "within", value: "30" },
          { field: "liked", op: "is", value: "true" },
        ],
      }),
    ).toBe("最近播放在最近 30 天内 或 是否收藏 是");
  });
});

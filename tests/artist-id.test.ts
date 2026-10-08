import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearArtistIdCache, peekArtistId, resolveArtistId } from "@/lib/artist-id";

const searchArtists = vi.fn();

vi.mock("@/source-scripts", () => ({
  searchArtists: (...args: unknown[]) => searchArtists(...args),
}));

beforeEach(() => {
  searchArtists.mockReset();
  clearArtistIdCache();
});

describe("resolveArtistId", () => {
  it("名字完全对上时取那一条（同名歌手有多条不能取第一条）", async () => {
    searchArtists.mockResolvedValue([
      { id: "wrong", name: "周杰伦模仿秀" },
      { id: "real", name: "周杰伦" },
      { id: "other", name: "周杰伦 / 林妙可" },
    ]);
    const id = await resolveArtistId("wyy" as never, "周杰伦");
    expect(id).toBe("real");
  });

  it("忽略大小写与空白差异", async () => {
    searchArtists.mockResolvedValue([{ id: "a1", name: "Taylor Swift" }]);
    const id = await resolveArtistId("qq" as never, "taylor  swift");
    expect(id).toBe("a1");
  });

  it("没有完全匹配时取第一条（搜索已按相关度排）", async () => {
    searchArtists.mockResolvedValue([{ id: "b1", name: "近似名" }]);
    const id = await resolveArtistId("kw" as never, "某歌手");
    expect(id).toBe("b1");
  });

  it("结果按 平台:名字 缓存，第二次不再打接口", async () => {
    searchArtists.mockResolvedValue([{ id: "c1", name: "周杰伦" }]);
    await resolveArtistId("wyy" as never, "周杰伦");
    await resolveArtistId("wyy" as never, "周杰伦");
    expect(searchArtists).toHaveBeenCalledTimes(1);
    expect(peekArtistId("wyy" as never, "周杰伦")).toBe("c1");
  });

  it("并发只查一次（同一歌手同时进页）", async () => {
    searchArtists.mockResolvedValue([{ id: "d1", name: "周杰伦" }]);
    const [a, b] = await Promise.all([
      resolveArtistId("kg" as never, "周杰伦"),
      resolveArtistId("kg" as never, "周杰伦"),
    ]);
    expect(a).toBe("d1");
    expect(b).toBe("d1");
    expect(searchArtists).toHaveBeenCalledTimes(1);
  });

  it("接口抛错 / 空列表 → 空串（调用方退回名字搜索，不白屏）", async () => {
    searchArtists.mockRejectedValue(new Error("风控了"));
    expect(await resolveArtistId("qq" as never, "某人")).toBe("");
    searchArtists.mockResolvedValue([]);
    expect(await resolveArtistId("qq" as never, "另一人")).toBe("");
  });

  it("本地音乐与空名不查接口", async () => {
    expect(await resolveArtistId("local" as never, "某人")).toBe("");
    expect(await resolveArtistId("wyy" as never, "")).toBe("");
    expect(searchArtists).not.toHaveBeenCalled();
  });
});

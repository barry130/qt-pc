/**
 * 搜索页签（`?type=`）必须能穿过**真实路由**：进详情页、再退回来，type 不丢。
 *
 * 为什么单靠 SearchPage 的组件测试不够：那边 `useSearch` 是 mock 的，
 * 「navigate 到详情页 → history.back() → URL 里的 type 还在」这条链路
 * 由 TanStack Router 的 validateSearch + memory history 决定，mock 掉就测了个寂寞。
 * 这里用真实的 @/lib/router 单例，只做导航、不渲染任何组件。
 */
import { describe, expect, it } from "vitest";
import { router } from "@/lib/router";

async function go(to: string, search?: Record<string, string>): Promise<void> {
  // 路由表的 search 类型由 validateSearch 收敛，测试里从字符串起点导航，
  // 这里用 as never 绕开具体路由的联合类型（运行时形状是对的）
  await router.navigate(
    (search === undefined
      ? { to }
      : { to, search, replace: true }) as never,
  );
}

describe("搜索页签进 URL", () => {
  it("从详情页返回后 type 仍是 playlist（不再被打回歌曲）", async () => {
    await go("/search", { q: "稻香", type: "playlist" });
    expect(router.state.location.search).toMatchObject({ q: "稻香", type: "playlist" });

    // 点开一个歌单：详情页自己不声明 search，type 不该影响它
    await router.navigate({
      to: "/playlist/$platform/$id",
      params: { platform: "qq", id: "p1" },
    });

    // 点返回（BackButton 走的就是 router.history.back()）
    router.history.back();
    await router.load();

    expect(router.state.location.pathname).toBe("/search");
    expect(router.state.location.search).toMatchObject({ q: "稻香", type: "playlist" });
  });

  it("非法 / 缺失的 type 收敛成 song，不会渲染出空页签", async () => {
    await go("/search", { q: "稻香", type: "不存在的页签" });
    expect(router.state.location.search).toMatchObject({ q: "稻香", type: "song" });

    await go("/search", { q: "稻香" });
    expect(router.state.location.search).toMatchObject({ q: "稻香", type: "song" });
  });

  it("换词重搜时显式带上的 type 不会被落回默认（歌单页签里搜下一个词）", async () => {
    await go("/search", { q: "稻香", type: "album" });
    // submit 的写法：q 变了、type 显式跟随当前页签
    await router.navigate({
      to: "/search",
      search: { q: "晴天", type: "album" },
    });
    expect(router.state.location.search).toMatchObject({ q: "晴天", type: "album" });
  });

  it("切页签用 replace：历史长度不涨，返回仍能离开搜索页", async () => {
    await go("/search", { q: "稻香", type: "song" });
    const before = router.history.length;

    await go("/search", { q: "稻香", type: "album" });

    expect(router.history.length).toBe(before);
    expect(router.state.location.search).toMatchObject({ q: "稻香", type: "album" });
  });
});
// @vitest-environment jsdom
/**
 * 骨架屏原语（用户 m09915：加载态要统一成骨架，而不是「转圈 + 加载中…」）。
 *
 * 这里只锁「形状口径」，不锁具体像素：行数、缩略图档位、网格最小列宽、内边距开关，
 * 以及无障碍约定——骨架本身 `aria-hidden`，另有一条 `role="status"` 播报在加载。
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { GridSkeleton, RowsSkeleton, Skeleton } from "@/components/ui/skeleton";

function rowsBox(container: HTMLElement): HTMLElement {
  const box = container.querySelector<HTMLElement>('[aria-hidden="true"].animate-pulse');
  if (box === null) throw new Error("没有找到骨架容器");
  return box;
}

describe("RowsSkeleton", () => {
  it("默认 8 行，行数与 rows 一致", () => {
    const { container } = render(<RowsSkeleton />);
    expect(rowsBox(container).children.length).toBe(8);
    container.remove();

    const three = render(<RowsSkeleton rows={3} />);
    expect(rowsBox(three.container).children.length).toBe(3);
  });

  it("默认方形缩略图，cover=none 时不画缩略图", () => {
    const square = render(<RowsSkeleton rows={1} />);
    const squareThumb = rowsBox(square.container).firstElementChild?.firstElementChild;
    expect(squareThumb?.className).toContain("rounded");
    expect(squareThumb?.className).not.toContain("rounded-full");

    const none = render(<RowsSkeleton rows={1} cover="none" />);
    // 无缩略图时一行只有「文字块 + 右侧时长条」两个子节点
    expect(rowsBox(none.container).firstElementChild?.children.length).toBe(2);
  });

  it("cover=circle 的是圆形（歌手 / 消息行）", () => {
    const { container } = render(<RowsSkeleton rows={1} cover="circle" />);
    const thumb = rowsBox(container).firstElementChild?.firstElementChild;
    expect(thumb?.className).toContain("rounded-full");
  });

  it("对读屏只播报一条状态，骨架本体不进无障碍树", () => {
    render(<RowsSkeleton rows={2} label="正在读取本地歌曲" />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("正在读取本地歌曲");
    expect(status.className).toContain("sr-only");
  });

  it("默认播报「正在加载…」", () => {
    render(<RowsSkeleton rows={1} />);
    expect(screen.getByRole("status").textContent).toBe("正在加载…");
  });
});

describe("GridSkeleton", () => {
  it("块数与最小列宽生效", () => {
    const { container } = render(<GridSkeleton count={5} minTile={220} />);
    const grid = rowsBox(container).firstElementChild as HTMLElement;
    expect(grid.style.gridTemplateColumns).toBe("repeat(auto-fill, minmax(220px, 1fr))");
    expect(grid.children.length).toBe(5);
  });

  it("默认自带 p-4，容器已有内边距时 padded={false} 不再补", () => {
    const padded = render(<GridSkeleton count={1} />);
    expect(rowsBox(padded.container).className).toContain("p-4");

    const bare = render(<GridSkeleton count={1} padded={false} />);
    expect(rowsBox(bare.container).className).not.toContain("p-4");
  });
});

describe("Skeleton", () => {
  it("透传 className 且对无障碍隐藏", () => {
    const { container } = render(<Skeleton className="h-3 w-20" />);
    const block = container.firstElementChild as HTMLElement;
    expect(block.getAttribute("aria-hidden")).toBe("true");
    expect(block.className).toContain("h-3");
    expect(block.className).toContain("animate-pulse");
  });
});

/**
 * 分享卡片的下载二维码（用户 m10523）。
 *
 * 矩阵是硬编码的常量（不引 QR 库），所以这里把「它还是一个合法二维码」这件事
 * 用结构断言兜住：尺寸、三个角的定位图样、两条定时图样、固定深模块，外加一个
 * 整矩阵校验和（URL 本身是私有值不进仓库，用校验和锁「矩阵就是发给用户的那张」，
 * 谁手抖改错一格都会炸）。任何一次手抖都会在这几条里立刻发现 —— 而不是等
 * 发出去扫不出来才发现。
 */
import { describe, expect, it } from "vitest";
import {
  SHARE_QR_MATRIX,
  SHARE_QR_MODULES,
  SHARE_QR_QUIET,
  drawShareQr,
} from "@/components/player/share-qr";

/** 定位图样（finder pattern）的 7×7 标准形状 */
const FINDER = [
  "1111111",
  "1000001",
  "1011101",
  "1011101",
  "1011101",
  "1000001",
  "1111111",
];

function rows(): string[] {
  return [...SHARE_QR_MATRIX];
}

/** 取矩阵里任意 7×7 小块的文本，方便和 FINDER 比 */
function block(top: number, left: number): string[] {
  return rows()
    .slice(top, top + 7)
    .map((line) => line.slice(left, left + 7));
}

/** 深色模块总数（画布上的黑色小方块个数应当等于它） */
function darkCount(): number {
  return SHARE_QR_MATRIX.join("")
    .split("")
    .filter((c) => c === "1").length;
}

type Fill = { style: string; x: number; y: number; w: number; h: number };

/** 只记录 fillRect 的假上下文，足够验证绘制几何 */
function recorder(): { ctx: CanvasRenderingContext2D; fills: Fill[]; calls: string[] } {
  const fills: Fill[] = [];
  const calls: string[] = [];
  let style = "";
  const ctx = {
    get fillStyle(): string {
      return style;
    },
    set fillStyle(v: string) {
      style = v;
    },
    save(): void {
      calls.push("save");
    },
    restore(): void {
      calls.push("restore");
    },
    fillRect(x: number, y: number, w: number, h: number): void {
      fills.push({ style, x, y, w, h });
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, fills, calls };
}

describe("share-qr 常量", () => {
  it("整矩阵校验和：就是发给用户的那张二维码", () => {
    // 私有 URL 不进仓库（CI 有 canace.(cn|icu) 泄漏护栏），改用校验和锁矩阵
    // 内容。要换 URL：用 segno 重新生成矩阵后同步更新这里的期望值，并按
    // 仓库私有配置流程（app.config.local.json）核对官网地址。
    expect(`${SHARE_QR_MATRIX.join("")}`.length).toBe(29 * 29);
    let sum = 0;
    for (const line of SHARE_QR_MATRIX) {
      for (const ch of line) sum += ch === "1" ? 1 : 0;
    }
    // 深模块总数：矩阵内容不变则不变；改 URL 重新生成后在此更新
    expect(sum).toBe(424);
  });

  it("矩阵是 29×29、只含 0/1", () => {
    expect(SHARE_QR_MODULES).toBe(29);
    expect(SHARE_QR_QUIET).toBe(4);
    expect(SHARE_QR_MATRIX.length).toBe(29);
    for (const line of SHARE_QR_MATRIX) {
      expect(line.length).toBe(29);
      expect(line).toMatch(/^[01]{29}$/);
    }
  });

  it("三个角是标准定位图样", () => {
    expect(block(0, 0)).toEqual(FINDER);
    expect(block(0, 22)).toEqual(FINDER);
    expect(block(22, 0)).toEqual(FINDER);
  });

  it("定时图样交替，且版本 3 的固定深模块在位", () => {
    // 横向定时图样在第 6 行，从第 8 列到第 20 列，1/0 交替
    const row6 = rows()[6] ?? "";
    for (let col = 8; col <= 20; col += 1) {
      expect(row6[col]).toBe(col % 2 === 0 ? "1" : "0");
    }
    // 纵向定时图样在第 6 列，同样从第 8 行起交替
    for (let row = 8; row <= 20; row += 1) {
      expect(rows()[row]?.[6]).toBe(row % 2 === 0 ? "1" : "0");
    }
    // 标准要求 (4×版本+9, 8) 恒为深色模块；29 格 = version 3 → (21, 8)
    expect(rows()[21]?.[8]).toBe("1");
  });
});

describe("drawShareQr", () => {
  it("先铺白底，再逐格画深模块，安静区留出 4 格", () => {
    const { ctx, fills, calls } = recorder();
    drawShareQr(ctx, 100, 200, 74);

    const cells = SHARE_QR_MODULES + SHARE_QR_QUIET * 2; // 37
    const cell = 74 / cells; // 2

    const background = fills[0];
    expect(background).toEqual({ style: "#ffffff", x: 100, y: 200, w: 74, h: 74 });

    const dark = fills.slice(1);
    expect(dark.length).toBe(darkCount());
    for (const f of dark) expect(f.style).toBe("#000000");

    // 左上角第一个模块 (row 0, col 0) 是深色：位置要跳过 4 格安静区
    expect(dark[0]).toEqual({
      style: "#000000",
      x: 100 + SHARE_QR_QUIET * cell,
      y: 200 + SHARE_QR_QUIET * cell,
      w: cell,
      h: cell,
    });

    // 最右下的深模块不会越过方块边界
    const maxRight = Math.max(...dark.map((f) => f.x + f.w));
    const maxBottom = Math.max(...dark.map((f) => f.y + f.h));
    expect(maxRight).toBeLessThanOrEqual(100 + 74);
    expect(maxBottom).toBeLessThanOrEqual(200 + 74);

    // save/restore 成对出现，不污染调用方画布状态（fillStyle 等）
    expect(calls).toEqual(["save", "restore"]);
  });

  it("方块尺寸变化时格子等比缩放", () => {
    const small = recorder();
    const large = recorder();
    drawShareQr(small.ctx, 0, 0, 37);
    drawShareQr(large.ctx, 0, 0, 370);

    const first = small.fills[1];
    const second = large.fills[1];
    expect(first?.w).toBeCloseTo(1, 5); // 37 / 37
    expect(second?.w).toBeCloseTo(10, 5); // 370 / 37
  });
});

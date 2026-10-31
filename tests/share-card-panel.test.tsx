// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const getPlaybackLyric = vi.fn(async () => ({ lrc: "", translation: "" }));
const pickSavePath = vi.fn(async (_name: string, _title: string) => null);
const saveBinaryFile = vi.fn(async () => undefined);

vi.mock("@/lib/localOnline", () => ({ getPlaybackLyric }));
// 面板只用到这两条 IPC（另存对话框 + 写盘），其余不必进渲染路径
vi.mock("@/services/ipc", () => ({ pickSavePath, saveBinaryFile }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));

const TRACK = {
  id: "1",
  platform: "wyy",
  title: "越",
  singer: "孙楠",
  album: "",
  // 留空即无封面：跳过 Image 加载（jsdom 不会真的加载远程图），按钮立刻可用
  picUrl: "",
  duration: 259000,
};

/**
 * jsdom 没实现 canvas（`getContext` 直接抛 "Not implemented"），这里给一个够用的
 * 假 2D 上下文：只量字宽按字符数估，其余绘制指令全是 no-op。
 */
function stubCanvas(ctx: unknown): void {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ctx,
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", {
    configurable: true,
    value: () => "data:image/png;base64,QUJD",
  });
}

function fakeCtx(): unknown {
  const noop = (): void => undefined;
  return {
    canvas: null,
    font: "",
    fillStyle: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    globalAlpha: 1,
    measureText: (t: string) => ({ width: t.length * 10 }),
    fillText: noop,
    fillRect: noop,
    clearRect: noop,
    scale: noop,
    save: noop,
    restore: noop,
    clip: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    quadraticCurveTo: noop,
    closePath: noop,
    fill: noop,
    drawImage: noop,
  };
}

// 首次 render 就会画一次（预览即导出源），所以桩要在导入组件之前装好
stubCanvas(fakeCtx());

type Fill = { style: string; x: number; y: number; w: number; h: number };

/** 记录每次 fillRect 的假上下文：用来确认二维码真的画进了卡片右下角 */
function recordingCtx(): { ctx: unknown; fills: Fill[] } {
  const fills: Fill[] = [];
  let style = "";
  return {
    fills,
    ctx: {
      ...(fakeCtx() as Record<string, unknown>),
      get fillStyle(): string {
        return style;
      },
      set fillStyle(v: string) {
        style = v;
      },
      fillRect: (x: number, y: number, w: number, h: number): void => {
        fills.push({ style, x, y, w, h });
      },
    },
  };
}

describe("ShareCardPanel", () => {
  afterEach(() => {
    cleanup();
    getPlaybackLyric.mockClear();
    pickSavePath.mockClear();
    saveBinaryFile.mockClear();
    stubCanvas(fakeCtx());
  });

  it("默认歌曲卡片，切到歌词卡片才去取词", async () => {
    const { ShareCardPanel } = await import("@/components/player/ShareCardPanel");
    render(<ShareCardPanel track={TRACK} />);

    expect(getPlaybackLyric).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("歌词卡片"));
    // 取词是「切过去才做」的：歌曲卡片模式不该为一段用不上的词等网络
    await waitFor(() => expect(getPlaybackLyric).toHaveBeenCalledTimes(1));
  });

  it("另存为对话框取消时不写盘", async () => {
    const { ShareCardPanel } = await import("@/components/player/ShareCardPanel");
    render(<ShareCardPanel track={TRACK} />);

    fireEvent.click(screen.getByText("保存为图片"));
    await waitFor(() => expect(pickSavePath).toHaveBeenCalledTimes(1));
    expect(saveBinaryFile).not.toHaveBeenCalled();
  });

  it("画布不可用时给出提示而不是静默失败", async () => {
    // 浏览器不会走到这里（返回 null 只可能是不支持 canvas 的极端环境），
    // 但出图失败必须让用户看见，而不是点了没反应
    stubCanvas(null);
    const { ShareCardPanel } = await import("@/components/player/ShareCardPanel");
    render(<ShareCardPanel track={TRACK} />);

    fireEvent.click(screen.getByText("保存为图片"));
    await waitFor(() => expect(screen.getByText("生成图片失败")).toBeTruthy());
    expect(saveBinaryFile).not.toHaveBeenCalled();
  });

  it("卡片右下角画了下载二维码：白底方块 + 29×29 的黑色模块", async () => {
    const rec = recordingCtx();
    stubCanvas(rec.ctx);
    const { ShareCardPanel } = await import("@/components/player/ShareCardPanel");
    render(<ShareCardPanel track={TRACK} />);

    // 白底方块：边长 64（含 4 格安静区），贴在右边距 PAD=18 上
    const white = rec.fills.filter((f) => f.style === "#ffffff");
    expect(white.length).toBeGreaterThanOrEqual(1);
    for (const f of white) {
      expect(f.w).toBe(64);
      expect(f.h).toBe(64);
      expect(f.x).toBe(300 - 18 - 64);
    }
    // 黑模块总数 = 矩阵里 1 的个数 × 重画次数
    const { SHARE_QR_MATRIX } = await import("@/components/player/share-qr");
    const perDraw = SHARE_QR_MATRIX.join("")
      .split("")
      .filter((c) => c === "1").length;
    const dark = rec.fills.filter((f) => f.style === "#000000");
    expect(dark.length).toBe(perDraw * white.length);
    // 二维码方块整体落在卡片内（不越出右边距，也不压到上方封面）
    for (const f of dark) {
      expect(f.x).toBeGreaterThanOrEqual(300 - 18 - 64);
      expect(f.x + f.w).toBeLessThanOrEqual(300 - 18);
    }
  });

  it("另存默认文件名带上歌名与歌手，且去掉 Windows 非法字符", async () => {
    const { ShareCardPanel } = await import("@/components/player/ShareCardPanel");
    render(<ShareCardPanel track={{ ...TRACK, title: 'a/b:c*d?"e<f>g|h', singer: "x" }} />);

    fireEvent.click(screen.getByText("保存为图片"));
    await waitFor(() => expect(pickSavePath).toHaveBeenCalledTimes(1));
    const name = String(pickSavePath.mock.calls[0]?.[0] ?? "");
    expect(name.endsWith(".png")).toBe(true);
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
  });
});

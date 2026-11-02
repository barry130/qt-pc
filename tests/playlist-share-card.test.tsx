// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const pickSavePath = vi.fn(async (_name: string, _title: string) => null);
const saveBinaryFile = vi.fn(async (_path: string, _b64: string) => undefined);

// 面板只用到这两条 IPC（另存对话框 + 写盘），其余不必进渲染路径
vi.mock("@/services/ipc", () => ({ pickSavePath, saveBinaryFile }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));

function track(id: number, title: string, picUrl: string): {
  id: string;
  platform: string;
  title: string;
  singer: string;
  album: string;
  picUrl: string;
  duration: number;
} {
  return {
    id: String(id),
    platform: "wyy",
    title,
    singer: `歌手${id}`,
    album: "",
    picUrl,
    duration: 200000,
  };
}

/** 画过的文字：用来断言卡片里到底写了什么（canvas 内容不在 DOM 里） */
let texts: string[] = [];

function fakeCtx(): unknown {
  const noop = (): void => undefined;
  let style = "";
  return {
    canvas: null,
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    lineWidth: 1,
    textWidth: 0,
    get fillStyle(): string {
      return style;
    },
    set fillStyle(v: string) {
      style = v;
    },
    get strokeStyle(): string {
      return style;
    },
    set strokeStyle(v: string) {
      style = v;
    },
    globalAlpha: 1,
    measureText: (t: string) => ({ width: t.length * 10 }),
    fillText: (t: string) => {
      texts.push(t);
    },
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
    stroke: noop,
    drawImage: noop,
  };
}

/**
 * jsdom 没有 canvas；`Image` 也不会真的加载远程图（onload 永远不来）。
 * 这里给一个「拿到 src 就成功」的假 Image，并记下构造次数（= 加载了几张封面）。
 */
let imageLoads = 0;

class FakeImage {
  width = 600;
  height = 600;
  crossOrigin = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_v: string) {
    imageLoads += 1;
    // 放到微任务里完成：组件是先挂 onload 再设 src 的
    void Promise.resolve().then(() => this.onload?.());
  }
}

function installStubs(): void {
  texts = [];
  imageLoads = 0;
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => fakeCtx(),
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", {
    configurable: true,
    value: () => "data:image/png;base64,QUJD",
  });
  Object.defineProperty(globalThis, "Image", {
    configurable: true,
    writable: true,
    value: FakeImage,
  });
}

installStubs();

const TRACKS = [
  track(1, "一", "http://x/1.jpg"),
  track(2, "二", "http://x/2.jpg"),
  track(3, "三", "http://x/3.jpg"),
  track(4, "四", "http://x/4.jpg"),
  track(5, "五", "http://x/5.jpg"),
  track(6, "六", "http://x/6.jpg"),
];

describe("PlaylistShareCard", () => {
  beforeEach(() => {
    installStubs();
  });

  afterEach(() => {
    cleanup();
    pickSavePath.mockClear();
    saveBinaryFile.mockClear();
  });

  it("只加载前 4 首的封面，卡片上画歌单名与曲目数", async () => {
    const { PlaylistShareCard } = await import("@/components/player/PlaylistShareCard");
    render(<PlaylistShareCard name="夜跑歌单" tracks={TRACKS} />);

    // 100 首的歌单也只画 4 张：多加载的封面纯粹是等网络
    expect(imageLoads).toBe(4);
    await waitFor(() => expect(screen.getByText("分享「夜跑歌单」")).toBeTruthy());
    await waitFor(() => expect(texts).toContain("夜跑歌单"));
    expect(texts).toContain("共 6 首歌曲");
    expect(texts).toContain("轻听音乐");
    expect(texts).toContain("扫码下载客户端");
  });

  it("曲目数优先用传入的 count（在线歌单曲目不落本地时靠它）", async () => {
    const { PlaylistShareCard } = await import("@/components/player/PlaylistShareCard");
    render(<PlaylistShareCard name="大歌单" tracks={TRACKS.slice(0, 2)} count={120} />);

    await waitFor(() => expect(texts).toContain("共 120 首歌曲"));
  });

  it("没有封面的歌单不卡在加载态，照样能出图", async () => {
    const { PlaylistShareCard } = await import("@/components/player/PlaylistShareCard");
    const { container } = render(
      <PlaylistShareCard name="本地歌单" tracks={[track(1, "一", ""), track(2, "二", "")]} />,
    );

    expect(imageLoads).toBe(0);
    await waitFor(() =>
      expect(container.querySelector("canvas")?.getAttribute("data-drawn")).toBe("1"),
    );
    expect(screen.queryByText("封面加载中…")).toBeNull();
  });

  it("没名字的歌单用「未命名歌单」兜底", async () => {
    const { PlaylistShareCard } = await import("@/components/player/PlaylistShareCard");
    render(<PlaylistShareCard name="   " tracks={TRACKS.slice(0, 1)} />);

    await waitFor(() => expect(texts).toContain("未命名歌单"));
  });

  it("保存为图片用歌单名做文件名，并剔除非法字符", async () => {
    const { PlaylistShareCard } = await import("@/components/player/PlaylistShareCard");
    render(<PlaylistShareCard name={'a/b:c*d?"e'} tracks={TRACKS.slice(0, 1)} />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /保存为图片/ })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: /保存为图片/ }));
    await waitFor(() => expect(pickSavePath).toHaveBeenCalledTimes(1));
    expect(pickSavePath.mock.calls[0][0]).toBe("abcde-歌单.png");
    expect(pickSavePath.mock.calls[0][1]).toBe("保存分享卡片");
  });
});

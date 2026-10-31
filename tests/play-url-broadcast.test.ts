/**
 * 命中线路广播（`src/lib/play-url-broadcast.ts`）。
 *
 * 守的契约是「换了源，歌词也要跟着换」在**跨窗口**这一段的最后一步：
 * 桌面歌词窗口是独立 WebView、独立 JS 上下文，读不到主窗口的线路记忆，
 * 只能靠 `play-url-line` 事件知道「当前地址被哪个源接走了」。
 *
 * 历史坑（用户报「换了源歌词没换」的两条真实路径）：
 * 1. 事件以前只在引擎问前端 `play_url_request` 时发出；用户点播放时地址由前端
 *    预解析塞进引擎缓存，引擎不再问前端 —— 这条路径一个事件都发不出来。
 *    → 现在取链漏斗 resolvePlayUrlWithFallback 出链即广播。
 * 2. 桌面歌词窗口在取链之后才打开，监听挂上时事件早已发过，crossLineByTrack
 *    永远空着。→ 现在窗口启动时发 `request-play-url-line` 请主窗口补发一次。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { emitMock } = vi.hoisted(() => ({ emitMock: vi.fn() }));

vi.mock("@tauri-apps/api/event", () => ({ emit: emitMock }));

import {
  broadcastPlayUrlLine,
  PLAY_URL_LINE_EVENT,
  PLAY_URL_LINE_REQUEST_EVENT,
} from "@/lib/play-url-broadcast";
import { clearPlayUrlLines, rememberPlayUrlLine } from "@/source-scripts/playurl-line";
import type { PlayUrlLine } from "@/source-engine/client";
import type { Quality, Track } from "@/types";

const track: Track = {
  platform: "kg",
  id: "abc123",
  title: "测试曲目",
  singer: "测试歌手",
} as Track;

const crossLine: PlayUrlLine = {
  id: "cross:kw=228908",
  name: "kw",
  kind: "cross",
  targetSong: {
    id: "228908",
    name: "测试曲目",
    singer: "测试歌手",
    album: "测试专辑",
    interval: 240,
    picUrl: "",
  },
};

beforeEach(() => {
  emitMock.mockReset();
  emitMock.mockResolvedValue(undefined);
  clearPlayUrlLines();
});

describe("broadcastPlayUrlLine", () => {
  it("事件名与歌词窗口启动请求的名字稳定（跨窗口契约）", () => {
    expect(PLAY_URL_LINE_EVENT).toBe("play-url-line");
    expect(PLAY_URL_LINE_REQUEST_EVENT).toBe("request-play-url-line");
  });

  it("命中跨源线路时把原始结构（含 targetSong）广播出去", () => {
    rememberPlayUrlLine(track, "320" as Quality, crossLine);

    broadcastPlayUrlLine(track, "320" as Quality);

    expect(emitMock).toHaveBeenCalledTimes(1);
    const [name, payload] = emitMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe("play-url-line");
    expect(payload.platform).toBe("kg");
    expect(payload.id).toBe("abc123");
    const line = payload.line as PlayUrlLine;
    expect(line.id).toBe("cross:kw=228908");
    expect(line.targetSong?.id).toBe("228908");
  });

  it("没有线路记忆时也照发一条 line=null（让对端知道这首没被跨源接走）", () => {
    broadcastPlayUrlLine(track, "320" as Quality);

    expect(emitMock).toHaveBeenCalledTimes(1);
    const [, payload] = emitMock.mock.calls[0] as [string, { line: unknown }];
    expect(payload.line).toBeNull();
  });

  it("曲目为空（停止状态）时什么都不发", () => {
    broadcastPlayUrlLine(null, "320" as Quality);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("非 Tauri 环境里 emit 同步抛也不能影响播放", () => {
    emitMock.mockImplementation(() => {
      throw new Error("__TAURI_INTERNALS__ is not defined");
    });

    expect(() => broadcastPlayUrlLine(track, "320" as Quality)).not.toThrow();
  });

  it("emit 返回的 Promise 拒绝也不冒泡（没有窗口在听）", () => {
    emitMock.mockImplementation(() => Promise.reject(new Error("no listeners")));

    expect(() => broadcastPlayUrlLine(track, "320" as Quality)).not.toThrow();
  });
});

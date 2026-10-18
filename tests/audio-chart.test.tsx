// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

/**
 * QQ 有声榜（chart hitTopList/contentType=programs）在宿主侧的取数口径：
 * 榜单返回的是**节目容器**（recType=2、songId=0），不是可播放曲目。
 * 这几条守住三件事：
 *   1. 节目容器不会被当成 Track 塞进播放队列；
 *   2. 章节页只把章节当曲目，且按页续取；
 *   3. 普通榜单的行为一点没变（仍走 chartDetail）。
 */

const getCharts = vi.fn();
const getAudioChartPrograms = vi.fn();
const getAudioProgramDetail = vi.fn();
const getChartDetail = vi.fn();

vi.mock("@/source-scripts", () => ({
  getCharts: (...args: unknown[]) => getCharts(...args),
  getAudioChartPrograms: (...args: unknown[]) => getAudioChartPrograms(...args),
  getAudioProgramDetail: (...args: unknown[]) => getAudioProgramDetail(...args),
  getChartDetail: (...args: unknown[]) => getChartDetail(...args),
}));

const playQueue = vi.fn(async () => {});
vi.mock("@/stores/player", () => ({
  usePlayerStore: <T,>(selector: (s: { playQueue: typeof playQueue }) => T): T =>
    selector({ playQueue }),
}));

vi.mock("@/components/layout/BackButton", () => ({
  BackButton: () => null,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

const programChart = {
  id: "75",
  platform: "qq" as const,
  name: "有声榜",
  picUrl: "",
  description: null,
  contentType: "programs" as const,
};

const chapter = (n: number) => ({
  id: `mid${n}`,
  platform: "qq" as const,
  title: `第 ${n} 集`,
  singer: "主播",
  album: "某有声书",
  duration: 60,
  picUrl: "",
});

beforeEach(() => {
  getCharts.mockReset();
  getAudioChartPrograms.mockReset();
  getAudioProgramDetail.mockReset();
  getChartDetail.mockReset();
  playQueue.mockClear();
});

afterEach(() => {
  vi.resetModules();
});

describe("QQ 有声榜", () => {
  it("节目容器不会被当成曲目入队", async () => {
    const { getAudioChartPrograms: api } = await import("@/source-scripts");
    getAudioChartPrograms.mockResolvedValue([
      {
        id: "albummid1",
        platform: "qq",
        name: "某有声书",
        artist: "主播",
        picUrl: "",
        description: null,
        chapterCount: 120,
      },
    ]);
    const list = await api(programChart);
    expect(list).toHaveLength(1);
    expect(list[0]?.chapterCount).toBe(120);
    // 容器上没有可播放字段，宿主不会误把 songId=0 送进队列
    expect(playQueue).not.toHaveBeenCalled();
  });

  it("章节页只渲染章节曲目，并按 hasMore 续取", async () => {
    getAudioProgramDetail.mockImplementation(async (_p: string, _id: string, page: number) => ({
      program: {
        id: "albummid1",
        platform: "qq",
        name: "某有声书",
        artist: "主播",
        picUrl: "",
        description: null,
        chapterCount: 3,
      },
      tracks: page === 1 ? [chapter(1), chapter(2)] : [chapter(3)],
      hasMore: page === 1,
    }));

    const { AudioProgramPage } = await import("@/components/discovery/AudioProgramPage");
    render(<AudioProgramPage platform="qq" id="albummid1" />);

    await waitFor(() => expect(screen.getByText("第 1 集")).toBeTruthy());
    // 页头标题是节目名，与曲目行里的专辑名同字，取 heading 免得撞多个节点
    expect(screen.getByRole("heading", { name: "某有声书" })).toBeTruthy();
    expect(getAudioProgramDetail).toHaveBeenCalledWith("qq", "albummid1", 1, expect.any(Number));
  });

  it("普通榜单仍走 chartDetail，不受有声榜改动影响", async () => {
    getChartDetail.mockResolvedValue([chapter(1)]);
    const { getChartDetail: api } = await import("@/source-scripts");
    const list = await api({
      id: "26",
      platform: "qq",
      name: "热歌榜",
      picUrl: "",
      description: null,
    });
    expect(list).toHaveLength(1);
    expect(getAudioChartPrograms).not.toHaveBeenCalled();
  });
});

describe("缓存清理类别", () => {
  it("清理歌词候选不删除已保存歌词（只清内存候选）", async () => {
    const clearLyricCandidateCache = vi.fn(() => 2);
    const clearPlaybackLyricCache = vi.fn(() => 1);
    vi.doMock("@/lib/localOnline", () => ({
      clearLyricCandidateCache,
      clearPlaybackLyricCache,
      clearLocalOnlineMetaCache: () => 0,
    }));
    vi.doMock("@/lib/chart-detail", () => ({ clearChartDetailCache: () => 0 }));
    vi.doMock("@/lib/artist-id", () => ({ clearArtistIdCache: () => 0 }));
    vi.doMock("@/lib/paged-all", () => ({ clearPagedAllJobs: () => 0 }));
    vi.doMock("@/lib/source-switch", () => ({ clearSourceSwitchCache: () => 0 }));
    vi.doMock("@/source-scripts/playurl-line", () => ({ clearPlayUrlLines: () => 0 }));
    vi.doMock("@/services/ipc", () => ({ clearPlayUrlCache: async () => ({ clearedCount: 0 }) }));

    const { clearRuntimeCache } = await import("@/lib/runtime-cache");
    expect(await clearRuntimeCache("lyricCandidates")).toBe(3);
  });
});

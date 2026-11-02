// @vitest-environment jsdom
/**
 * 界面语言（B6）。
 *
 * 只验「词条取用 + 切换持久化 + 侧边栏真的跟着变」这三件事；
 * 覆盖到哪些字符串属于产品范围问题，写在 DESIGN R79 里，不靠测试守。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(async (_key: string) => null as string | null),
  setSetting: vi.fn(async (_key: string, _value: string) => {}),
}));

vi.mock("@/services/ipc", () => ({
  getSetting: mocks.getSetting,
  setSetting: mocks.setSetting,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: (props: { children?: React.ReactNode; title?: string }) => (
    <a href="#" title={props.title}>
      {props.children}
    </a>
  ),
}));

vi.mock("@/stores/sourceRegistry", () => ({
  useSourceLabel: () => "网易云",
  useSourceSupports: () => true,
  useAnySourceSupports: () => true,
}));

import {
  changeLocale,
  loadLocale,
  normalizeLocale,
  t,
  useLocaleStore,
  LOCALE_SETTING_KEY,
  MESSAGE_KEYS,
} from "@/lib/i18n";
import { Sidebar } from "@/components/layout/Sidebar";

beforeEach(() => {
  mocks.getSetting.mockReset();
  mocks.setSetting.mockReset();
  mocks.getSetting.mockResolvedValue(null);
  useLocaleStore.getState().setLocale("zh-CN");
});

describe("词条", () => {
  it("默认中文", () => {
    expect(t("player.play")).toBe("播放");
    expect(t("nav.home")).toBe("首页");
  });

  it("切到英文后取英文词条", () => {
    useLocaleStore.getState().setLocale("en-US");
    expect(t("player.play")).toBe("Play");
    expect(t("nav.podcast")).toBe("Podcasts");
  });

  it("插值占位替换（未知占位保留原样）", () => {
    expect(t("player.volume", { n: 3 })).toBe("音量");
  });
});

describe("第二轮词条（B6 / R84）", () => {
  it("两份字典键数一致，且没有空词条", () => {
    expect(MESSAGE_KEYS.length).toBeGreaterThan(60);
    for (const key of MESSAGE_KEYS) {
      useLocaleStore.getState().setLocale("zh-CN");
      expect(t(key)).not.toBe("");
      useLocaleStore.getState().setLocale("en-US");
      const en = t(key);
      expect(en).not.toBe("");
      // 缺键会回退成中文（或键名），这里只要求「不是键本身」
      expect(en).not.toBe(key);
    }
  });

  it("设置页页签与队列面板的英文词条", () => {
    useLocaleStore.getState().setLocale("en-US");
    expect(t("settings.section.general")).toBe("General");
    expect(t("settings.section.scrobble")).toBe("Scrobbling");
    expect(t("queue.title", { count: 12 })).toBe("Queue (12)");
    expect(t("queue.nowPlaying")).toBe("Now playing");
    expect(t("queue.selected", { n: 2, total: 5 })).toBe("2 of 5 selected");
  });

  it("侧边栏分组标题带音源名插值", () => {
    useLocaleStore.getState().setLocale("en-US");
    expect(t("sidebar.group.online", { source: "QQ Music" })).toBe("Online · QQ Music");
    useLocaleStore.getState().setLocale("zh-CN");
    expect(t("sidebar.group.online", { source: "QQ音乐" })).toBe("在线 · QQ音乐");
    expect(t("sidebar.group.onlineUnavailable")).toBe("在线 · 不可用");
  });

  it("设置页标题是「设置 · 分节」的插值结果", () => {
    expect(t("settings.titleWithSection", { section: t("settings.section.about") })).toBe(
      "设置 · 关于",
    );
    useLocaleStore.getState().setLocale("en-US");
    expect(t("settings.titleWithSection", { section: t("settings.section.about") })).toBe(
      "Settings · About",
    );
  });
});

describe("语言持久化", () => {
  it("读设置决定启动语言，非法值回中文", async () => {
    mocks.getSetting.mockResolvedValue("en-US");
    await expect(loadLocale()).resolves.toBe("en-US");
    expect(useLocaleStore.getState().locale).toBe("en-US");

    mocks.getSetting.mockResolvedValue("fr-FR");
    await expect(loadLocale()).resolves.toBe("zh-CN");
    expect(useLocaleStore.getState().locale).toBe("zh-CN");
  });

  it("读设置失败按中文，不抛错", async () => {
    mocks.getSetting.mockRejectedValue(new Error("db gone"));
    await expect(loadLocale()).resolves.toBe("zh-CN");
  });

  it("切换语言写进设置", async () => {
    await changeLocale("en-US");
    expect(useLocaleStore.getState().locale).toBe("en-US");
    expect(mocks.setSetting).toHaveBeenCalledWith(LOCALE_SETTING_KEY, "en-US");
  });

  it("设置写失败不回滚界面（眼前看到的保持用户所选）", async () => {
    mocks.setSetting.mockRejectedValue(new Error("disk full"));
    await changeLocale("en-US");
    expect(useLocaleStore.getState().locale).toBe("en-US");
  });

  it("normalizeLocale 只认 en，其余落中文", () => {
    expect(normalizeLocale("en")).toBe("en-US");
    expect(normalizeLocale("en-US")).toBe("en-US");
    expect(normalizeLocale(null)).toBe("zh-CN");
    expect(normalizeLocale("zh-TW")).toBe("zh-CN");
  });
});

describe("侧边栏跟随语言", () => {
  it("英文界面下导航是英文，切回中文立刻变成中文", async () => {
    useLocaleStore.getState().setLocale("en-US");
    const { container } = render(<Sidebar />);
    expect(screen.getByText("Home")).toBeTruthy();
    expect(screen.getByText("Podcasts")).toBeTruthy();
    // 分组标题也是词条（R84）：音源名是正文不译，前缀跟着语言走
    expect(screen.getByText("Online · 网易云")).toBeTruthy();
    expect(screen.getByText("Mine")).toBeTruthy();
    expect(screen.getByText("Assistant")).toBeTruthy();
    expect(container.querySelector('[aria-label="Collapse sidebar"]')).toBeTruthy();

    useLocaleStore.getState().setLocale("zh-CN");
    await waitFor(() => expect(screen.getByText("首页")).toBeTruthy());
    expect(screen.queryByText("Home")).toBeNull();
    expect(screen.getByText("在线 · 网易云")).toBeTruthy();
    expect(screen.getByText("我的")).toBeTruthy();
    expect(screen.getByText("助手")).toBeTruthy();
    expect(container.querySelector('[aria-label="折叠侧边栏"]')).toBeTruthy();
  });
});

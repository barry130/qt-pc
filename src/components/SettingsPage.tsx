import { PageContainer } from "@/components/layout/PageContainer";
import { useSourceUpdateStore } from "@/stores/source-update";
import { useNavigate } from "@tanstack/react-router";
import { GenericSection } from "@/components/settings/controls";
import { DesktopLyricSection } from "@/components/settings/sections/DesktopLyricSection";
import { PlaybackSection } from "@/components/settings/sections/PlaybackSection";
import { PlayerBarSection } from "@/components/settings/sections/PlayerBarSection";
import { SoundSection } from "@/components/settings/sections/SoundSection";
import { GeneralSection } from "@/components/settings/sections/GeneralSection";
import { SourcePackageSection } from "@/components/settings/sections/SourcePackageSection";
import { AboutSection } from "@/components/settings/sections/AboutSection";
import { ShortcutSection } from "@/components/settings/sections/ShortcutSection";
import { DownloadSection } from "@/components/settings/sections/DownloadSection";
import { DislikeSection } from "@/components/settings/sections/DislikeSection";
import { NetworkSection } from "@/components/settings/sections/NetworkSection";
import { AiSection } from "@/components/settings/sections/AiSection";
import { ScrobbleSection } from "@/components/settings/sections/ScrobbleSection";
import { useT, type MessageKey } from "@/lib/i18n";

// 页签文案走 i18n（B6 第二轮，R84）：这里只存键，显示时再取当前语言的词条
const SECTION_TITLES: Record<string, MessageKey> = {
  general: "settings.section.general",
  // 「外观」不在这里：它已提为一级页面 /appearance，入口在标题栏右侧「皮肤」按钮
  // （用户 2026-10-31 要求「把设置里面的外观删掉，改为这个按键进去」）
  "desktop-lyric": "settings.section.desktopLyric",
  playback: "settings.section.playback",
  "player-bar": "settings.section.playerBar",
  sound: "settings.section.sound",
  download: "settings.section.download",
  network: "settings.section.network",
  scrobble: "settings.section.scrobble",
  ai: "settings.section.ai",
  dislike: "settings.section.dislike",
  "source-package": "settings.section.sourcePackage",
  shortcut: "settings.section.shortcut",
  about: "settings.section.about",
};

function SettingsTabs(props: { active: string }): React.JSX.Element {
  const navigate = useNavigate();
  const tr = useT();
  // 音源包有可用更新时标签亮红点（发现只提示，进设置页逐条应用）
  const offers = useSourceUpdateStore((s) => s.offers);
  const sourceDot = offers.length > 0;
  return (
    <div className="mb-4 flex gap-1 border-b border-border">
      {Object.entries(SECTION_TITLES).map(([key, labelKey]) => (
        <button
          key={key}
          type="button"
          onClick={() =>
            void navigate({ to: "/settings/$section", params: { section: key } })
          }
          className={`relative px-3 py-2 text-xs transition-colors ${
            props.active === key
              ? "border-b-2 border-[var(--primary)] font-medium text-[var(--primary)]"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {tr(labelKey)}
          {key === "source-package" && sourceDot && (
            <span
              aria-label="有可用更新"
              className="absolute right-0.5 top-1.5 inline-block h-1.5 w-1.5 rounded-full bg-destructive"
            />
          )}
        </button>
      ))}
    </div>
  );
}

export function SettingsPage(props: { section: string }): React.JSX.Element {
  const tr = useT();
  const labelKey = SECTION_TITLES[props.section];
  const title = labelKey ? tr(labelKey) : tr("settings.title");
  return (
    // 分节标签固定在顶部（滚动区外），内容滚动时始终可见
    <PageContainer
      title={tr("settings.titleWithSection", { section: title })}
      stickyHeader={<SettingsTabs active={props.section} />}
    >
      {props.section === "general" ? (
        <GeneralSection />
      ) : props.section === "desktop-lyric" ? (
        // 桌面歌词独立成一个标签页（配置够多，塞在外观里太挤）
        <DesktopLyricSection />
      ) : props.section === "playback" ? (
        <PlaybackSection />
      ) : props.section === "player-bar" ? (
        <PlayerBarSection />
      ) : props.section === "sound" ? (
        <SoundSection />
      ) : props.section === "download" ? (
        <DownloadSection />
      ) : props.section === "network" ? (
        <NetworkSection />
      ) : props.section === "scrobble" ? (
        <ScrobbleSection />
      ) : props.section === "ai" ? (
        // 两步一页：AI 引擎 + （仅本地模型精选时展开的）模型配置，详见 AiSection
        <AiSection />
      ) : props.section === "dislike" ? (
        <DislikeSection />
      ) : props.section === "source-package" ? (
        <SourcePackageSection />
      ) : props.section === "shortcut" ? (
        <ShortcutSection />
      ) : props.section === "about" ? (
        <AboutSection />
      ) : (
        <GenericSection hint={title} />
      )}
    </PageContainer>
  );
}

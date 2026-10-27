import { PageContainer } from "@/components/layout/PageContainer";
import { useSourceUpdateStore } from "@/stores/source-update";
import { useNavigate } from "@tanstack/react-router";
import { GenericSection } from "@/components/settings/controls";
import { DesktopLyricSection } from "@/components/settings/sections/DesktopLyricSection";
import { AppearanceSection } from "@/components/settings/sections/AppearanceSection";
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

const SECTION_TITLES: Record<string, string> = {
  general: "通用",
  appearance: "外观",
  "desktop-lyric": "桌面歌词",
  playback: "播放",
  "player-bar": "播放条",
  sound: "音效",
  download: "下载",
  network: "网络",
  ai: "AI",
  dislike: "不喜欢列表",
  "source-package": "音源包",
  shortcut: "快捷键",
  about: "关于",
};

function SettingsTabs(props: { active: string }): React.JSX.Element {
  const navigate = useNavigate();
  // 音源包有可用更新时标签亮红点（发现只提示，进设置页逐条应用）
  const offers = useSourceUpdateStore((s) => s.offers);
  const sourceDot = offers.length > 0;
  return (
    <div className="mb-4 flex gap-1 border-b border-border">
      {Object.entries(SECTION_TITLES).map(([key, label]) => (
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
          {label}
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
  const title = SECTION_TITLES[props.section] ?? "设置";
  return (
    // 分节标签固定在顶部（滚动区外），内容滚动时始终可见
    <PageContainer
      title={`设置 · ${title}`}
      stickyHeader={<SettingsTabs active={props.section} />}
    >
      {props.section === "general" ? (
        <GeneralSection />
      ) : props.section === "appearance" ? (
        <AppearanceSection />
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
      ) : props.section === "ai" ? (
        // 全局 AI 模式 + 客户端直连模型的接口配置（详见文件末尾 AiSection）
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

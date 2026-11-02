import { useEffect } from "react";
import { type MessageKey, useT } from "@/lib/i18n";
import { PLAYER_BAR_BUTTONS, PLAYER_BAR_MAX_VISIBLE, countPlayerBarVisible, playerBarCounts } from "@/lib/player-bar";
import { isAdmin, useAuthStore } from "@/stores/auth";
import { usePlayerBarStore } from "@/stores/playerBar";
import { SettingRow, Switch } from "../controls";

/** 按钮元数据在 lib/player-bar.ts 里只有中文默认值；设置页按 id 取当前语言的文案 */
const BUTTON_KEYS = {
  playUrl: ["settings.playerBar.buttons.playUrl.label", "settings.playerBar.buttons.playUrl.hint"],
  speed: ["settings.playerBar.buttons.speed.label", "settings.playerBar.buttons.speed.hint"],
  sleep: ["settings.playerBar.buttons.sleep.label", "settings.playerBar.buttons.sleep.hint"],
  collect: ["settings.playerBar.buttons.collect.label", "settings.playerBar.buttons.collect.hint"],
  dislike: ["settings.playerBar.buttons.dislike.label", "settings.playerBar.buttons.dislike.hint"],
  mode: ["settings.playerBar.buttons.mode.label", "settings.playerBar.buttons.mode.hint"],
  desktopLyric: [
    "settings.playerBar.buttons.desktopLyric.label",
    "settings.playerBar.buttons.desktopLyric.hint",
  ],
  mini: ["settings.playerBar.buttons.mini.label", "settings.playerBar.buttons.mini.hint"],
  queue: ["settings.playerBar.buttons.queue.label", "settings.playerBar.buttons.queue.hint"],
  download: [
    "settings.playerBar.buttons.download.label",
    "settings.playerBar.buttons.download.hint",
  ],
  quality: ["settings.playerBar.buttons.quality.label", "settings.playerBar.buttons.quality.hint"],
  artist: ["settings.playerBar.buttons.artist.label", "settings.playerBar.buttons.artist.hint"],
  spectrum: [
    "settings.playerBar.buttons.spectrum.label",
    "settings.playerBar.buttons.spectrum.hint",
  ],
  equalizer: [
    "settings.playerBar.buttons.equalizer.label",
    "settings.playerBar.buttons.equalizer.hint",
  ],
  share: ["settings.playerBar.buttons.share.label", "settings.playerBar.buttons.share.hint"],
  source: ["settings.playerBar.buttons.source.label", "settings.playerBar.buttons.source.hint"],
  volume: ["settings.playerBar.buttons.volume.label", "settings.playerBar.buttons.volume.hint"],
} satisfies Record<string, [MessageKey, MessageKey]>;

export function PlayerBarSection(): React.JSX.Element {
  const tr = useT();
  const visible = usePlayerBarStore((s) => s.visible);
  const loaded = usePlayerBarStore((s) => s.loaded);
  const load = usePlayerBarStore((s) => s.load);
  const toggle = usePlayerBarStore((s) => s.toggle);
  const profile = useAuthStore((s) => s.profile);
  const admin = isAdmin(profile);

  useEffect(() => {
    void load();
  }, [load]);

  const items = PLAYER_BAR_BUTTONS.filter((b) => !b.adminOnly || admin);
  // 非音量的已展示名额（音量在 slot:"end"，不占名额）：满了之后「开启」动作置灰。
  // 计数走 lib 的统一口径（按声明元数据判 counted，非 admin 时 playUrl 不进 items）
  const countedVisible = countPlayerBarVisible(
    items.filter((b) => visible.includes(b.id)).map((b) => b.id),
  );
  const full = countedVisible >= PLAYER_BAR_MAX_VISIBLE;

  return (
    <div className="max-w-4xl">
      <p className="pb-2 pt-1 text-xs text-muted-foreground">
        {tr("settings.playerBar.hint", {
          max: PLAYER_BAR_MAX_VISIBLE,
          selected: countedVisible,
        })}
      </p>
      <div className="divide-y divide-border">
        {items.map((b) => {
          const checked = visible.includes(b.id);
          const counted = playerBarCounts(b.id);
          const keys = BUTTON_KEYS[b.id as keyof typeof BUTTON_KEYS];
          return (
            <SettingRow
              key={b.id}
              title={keys ? tr(keys[0]) : b.label}
              description={keys ? tr(keys[1]) : b.hint}
            >
              <Switch
                checked={checked}
                disabled={!checked && counted && full}
                onToggle={() => toggle(b.id)}
              />
            </SettingRow>
          );
        })}
      </div>
      {!loaded && (
        <p className="py-2 text-xs text-muted-foreground">{tr("settings.playerBar.loading")}</p>
      )}
    </div>
  );
}

/** 音效设置：均衡器 / 响度归一化 / 淡入淡出（引擎侧 DSP，立即生效） */

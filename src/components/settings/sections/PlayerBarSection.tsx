import { useEffect } from "react";
import { PLAYER_BAR_BUTTONS, PLAYER_BAR_MAX_VISIBLE, countPlayerBarVisible, playerBarCounts } from "@/lib/player-bar";
import { isAdmin, useAuthStore } from "@/stores/auth";
import { usePlayerBarStore } from "@/stores/playerBar";
import { SettingRow, Switch } from "../controls";

export function PlayerBarSection(): React.JSX.Element {
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
        播放条上除「上一首 / 播放 / 下一首」以外的按钮都能自行开关；关掉后剩下的按钮按数量自动
        分到播放键两侧，中间的播放键保持居中。默认只开收藏 / 播放模式 / 桌面歌词 / 下载 / 音质 /
        音量，其余默认关闭。除音量外最多同时展示 {PLAYER_BAR_MAX_VISIBLE} 个，名额满了先关一个
        再开。无曲目时不显示倍速 / 下载 / 音质，本地音乐不显示音质，与开关无关。当前已展示
        {countedVisible}/{PLAYER_BAR_MAX_VISIBLE} 个。
      </p>
      <div className="divide-y divide-border">
        {items.map((b) => {
          const checked = visible.includes(b.id);
          const counted = playerBarCounts(b.id);
          return (
            <SettingRow key={b.id} title={b.label} description={b.hint}>
              <Switch
                checked={checked}
                disabled={!checked && counted && full}
                onToggle={() => toggle(b.id)}
              />
            </SettingRow>
          );
        })}
      </div>
      {!loaded && <p className="py-2 text-xs text-muted-foreground">正在读取播放条设置…</p>}
    </div>
  );
}

/** 音效设置：均衡器 / 响度归一化 / 淡入淡出（引擎侧 DSP，立即生效） */

import { useCallback, useEffect, useState } from "react";
import { SPEED_OPTIONS, speedLabel } from "@/lib/fx";
import { GAPLESS_KEY } from "@/lib/storageKeys";
import { useT } from "@/lib/i18n";
import { errMsg } from "@/lib/utils";
import * as ipc from "@/services/ipc";
import { SettingRow, Switch } from "../controls";

export function PlaybackSection(): React.JSX.Element {
  const tr = useT();
  const [devices, setDevices] = useState<string[]>([]);
  const [current, setCurrent] = useState<string>("");
  const [speed, setSpeedState] = useState(1);
  const [gapless, setGaplessState] = useState(false);
  const [localFirst, setLocalFirstState] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [list, snap, savedGapless, savedLocalFirst] = await Promise.all([
        ipc.listOutputDevices(),
        ipc.getPlaybackState(),
        ipc.getSetting(GAPLESS_KEY),
        ipc.getLocalFirst().catch(() => true),
      ]);
      setGaplessState(savedGapless === "true");
      setLocalFirstState(savedLocalFirst);
      setDevices(list);
      setCurrent(snap?.outputDevice ?? "");
      if (snap?.speed) setSpeedState(snap.speed);
    } catch (err) {
      setError(errMsg(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const choose = async (name: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      // 空串 = 跟随系统默认
      await ipc.setOutputDevice(name || undefined);
      await load();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const chooseGapless = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await ipc.setGapless(!gapless);
      setGaplessState(!gapless);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const chooseLocalFirst = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await ipc.setLocalFirst(!localFirst);
      setLocalFirstState(!localFirst);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const chooseSpeed = async (v: number): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await ipc.setSpeed(v);
      setSpeedState(v);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-4xl divide-y divide-border">
      <SettingRow
        title={tr("settings.playback.outputDevice.title")}
        description={tr("settings.playback.outputDevice.desc")}
      >
        <select
          value={current}
          disabled={busy}
          onChange={(e) => void choose(e.target.value)}
          className="max-w-52 rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          aria-label={tr("settings.playback.outputDevice.title")}
        >
          <option value="">{tr("settings.playback.outputDevice.followSystem")}</option>
          {devices.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </SettingRow>
      {/* 默认播放音质已改为按平台独立设置（音源账号页），此处不再有全局入口 */}
      <SettingRow
        title={tr("settings.playback.gapless.title")}
        description={tr("settings.playback.gapless.desc")}
      >
        <Switch checked={gapless} disabled={busy} onToggle={() => void chooseGapless()} />
      </SettingRow>
      <SettingRow
        title={tr("settings.playback.localFirst.title")}
        description={tr("settings.playback.localFirst.desc")}
      >
        <Switch
          checked={localFirst}
          disabled={busy}
          onToggle={() => void chooseLocalFirst()}
        />
      </SettingRow>
      <SettingRow
        title={tr("settings.playback.speed.title")}
        description={tr("settings.playback.speed.desc", { speed: speedLabel(speed) })}
      >
        <select
          value={speed}
          disabled={busy}
          aria-label={tr("settings.playback.speed.title")}
          onChange={(e) => void chooseSpeed(Number(e.target.value))}
          className="rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {SPEED_OPTIONS.map((v) => (
            <option key={v} value={v}>
              {speedLabel(v)}
            </option>
          ))}
        </select>
      </SettingRow>
      {error && <p className="py-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

/**
 * 播放条按钮（设置 → 播放条）：播放条上除「上一首 / 播放 / 下一首」以外的
 * 按钮都能自行开关。开关存「展示中的按钮 id」（见 lib/player-bar.ts），
 * 默认只开 收藏 / 播放模式 / 桌面歌词 / 下载 / 音质 / 音量（用户 m07452），
 * 非音量按钮最多展示 10 个 —— 名额满了其余开关置灰，先关一个再开。
 * 「播放链接」是 qt_admin 专属入口，只对内部账号列出。
 */

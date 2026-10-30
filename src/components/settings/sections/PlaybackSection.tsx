import { useCallback, useEffect, useState } from "react";
import { SPEED_OPTIONS, speedLabel } from "@/lib/fx";
import { GAPLESS_KEY } from "@/lib/storageKeys";
import { errMsg } from "@/lib/utils";
import * as ipc from "@/services/ipc";
import { SettingRow, Switch } from "../controls";

export function PlaybackSection(): React.JSX.Element {
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
        title="音频输出设备"
        description="连蓝牙耳机后自动无声？选「跟随系统默认」即可跟随设备变化；固定设备适合挂多套输出。主动切换时当前曲目从原进度续播；设备被拔掉（蓝牙断开）则暂停播放并保留进度。"
      >
        <select
          value={current}
          disabled={busy}
          onChange={(e) => void choose(e.target.value)}
          className="max-w-52 rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          aria-label="音频输出设备"
        >
          <option value="">跟随系统默认</option>
          {devices.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </SettingRow>
      {/* 默认播放音质已改为按平台独立设置（音源账号页），此处不再有全局入口 */}
      <SettingRow
        title="无缝播放"
        description="提前加载下一首，缩短连续播放时的间隔。默认关闭；在线歌曲的衔接效果取决于网络和音源响应。"
      >
        <Switch checked={gapless} disabled={busy} onToggle={() => void chooseGapless()} />
      </SettingRow>
      <SettingRow
        title="本地优先播放"
        description="开启后，播放前先在下载文件、本地曲库里找同名歌曲（标题+歌手+时长都对上才算），找到就直接放本地文件：断网、播放地址过期都不影响；本地收藏指向的文件被移动/删除时，会自动找替身接着播，不改收藏内容。关闭则始终走在线播放（包括已下载的歌曲），适合要在线高音质的情况。默认开启。"
      >
        <Switch
          checked={localFirst}
          disabled={busy}
          onToggle={() => void chooseLocalFirst()}
        />
      </SettingRow>
      <SettingRow
        title="默认倍速"
        description={`当前 ${speedLabel(speed)}。播放条上的倍速菜单与本处相同：立即生效并记忆，所有歌曲通用。`}
      >
        <select
          value={speed}
          disabled={busy}
          aria-label="默认倍速"
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

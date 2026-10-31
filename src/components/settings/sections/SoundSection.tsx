import { useCallback, useEffect, useRef, useState } from "react";
import { EQ_BANDS, EQ_GAIN_LIMIT_DB, EQ_PRESETS, FADE_DURATION_OPTIONS, eqBandLabel } from "@/lib/fx";
import { errMsg } from "@/lib/utils";
import * as ipc from "@/services/ipc";
import { type EqParams, type FxState } from "@/types";
import { Segmented, SettingRow, Switch } from "../controls";

export function SoundSection(): React.JSX.Element {
  const [fx, setFx] = useState<FxState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 滑条拖动会高频触发，统一走本地状态 + 120ms 防抖下发
  const eqTimerRef = useRef<number | null>(null);

  useEffect(() => {
    void ipc
      .getFxState()
      .then(setFx)
      .catch((err) => setError(errMsg(err)));
    return () => {
      if (eqTimerRef.current !== null) window.clearTimeout(eqTimerRef.current);
    };
  }, []);

  const pushEq = useCallback((next: EqParams): void => {
    setFx((f) => (f ? { ...f, eq: next } : f));
    if (eqTimerRef.current !== null) window.clearTimeout(eqTimerRef.current);
    eqTimerRef.current = window.setTimeout(() => {
      void ipc.setEq(next).catch((err) => setError(errMsg(err)));
    }, 120);
  }, []);

  if (!fx) {
    return (
      <div className="max-w-4xl">
        {error ? (
          <p className="py-4 text-xs text-destructive">{error}</p>
        ) : (
          <p className="py-4 text-xs text-muted-foreground">正在读取音效设置…</p>
        )}
      </div>
    );
  }

  const eq = fx.eq;
  const activePreset = EQ_PRESETS.find(
    (p) => p.gains.every((g, i) => Math.abs(g - (eq.gainsDb[i] ?? 0)) < 0.5),
  );

  return (
    <div className="max-w-4xl divide-y divide-border">
      <SettingRow
        title="响度归一化"
        description="按曲目实际响度自动调增益（±12dB），切歌不再忽大忽小"
      >
        <Switch
          checked={fx.loudnorm}
          onToggle={() => {
            const next = !fx.loudnorm;
            setFx({ ...fx, loudnorm: next });
            void ipc.setLoudnorm(next).catch((err) => setError(errMsg(err)));
          }}
        />
      </SettingRow>
      <SettingRow
        title="淡入淡出"
        description="暂停淡出、恢复淡入"
      >
        <div className="flex items-center gap-2">
          {fx.fade.enabled && (
            <Segmented
              value={String(fx.fade.durationMs)}
              options={FADE_DURATION_OPTIONS.map((ms) => ({
                value: String(ms),
                label: `${ms}ms`,
              }))}
              onChange={(v) => {
                const next = { ...fx.fade, durationMs: Number(v) };
                setFx({ ...fx, fade: next });
                void ipc.setFade(next).catch((err) => setError(errMsg(err)));
              }}
            />
          )}
          <Switch
            checked={fx.fade.enabled}
            onToggle={() => {
              const next = { ...fx.fade, enabled: !fx.fade.enabled };
              setFx({ ...fx, fade: next });
              void ipc.setFade(next).catch((err) => setError(errMsg(err)));
            }}
          />
        </div>
      </SettingRow>

      <SettingRow
        title="频谱背景"
        description="播放条实时频谱；关闭后不做计算"
      >
        <Switch
          checked={fx.spectrum}
          onToggle={() => {
            const next = !fx.spectrum;
            setFx({ ...fx, spectrum: next });
            void ipc.setSpectrum(next).catch((err) => setError(errMsg(err)));
          }}
        />
      </SettingRow>

      <div className="py-3">
        <div className="flex items-center justify-between">
          <div className="min-w-0 flex-1">
            <p className="text-sm">均衡器</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              十段均衡（±12dB），自动防削波
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <select
              value={activePreset?.name ?? "自定义"}
              disabled={!eq.enabled}
              aria-label="均衡器预设"
              onChange={(e) => {
                const preset = EQ_PRESETS.find((p) => p.name === e.target.value);
                if (preset) pushEq({ ...eq, gainsDb: [...preset.gains] });
              }}
              className="rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              {EQ_PRESETS.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
              {!activePreset && <option value="自定义">自定义</option>}
            </select>
            <Switch
              checked={eq.enabled}
              onToggle={() => pushEq({ ...eq, enabled: !eq.enabled })}
            />
          </div>
        </div>

        {eq.enabled && (
          <div className="mt-4">
            <div className="flex items-center justify-between gap-4 text-xs">
              <span className="shrink-0 text-muted-foreground">前置放大</span>
              <input
                type="range"
                min={-EQ_GAIN_LIMIT_DB}
                max={EQ_GAIN_LIMIT_DB}
                step={0.5}
                value={eq.preampDb}
                onChange={(e) => pushEq({ ...eq, preampDb: Number(e.target.value) })}
                className="w-48 accent-[var(--primary)]"
                aria-label="前置放大"
              />
              <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">
                {eq.preampDb > 0 ? "+" : ""}
                {eq.preampDb.toFixed(1)}dB
              </span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-x-8 gap-y-2.5">
              {EQ_BANDS.map((hz, i) => (
                <div key={hz} className="flex items-center gap-2 text-xs">
                  <span className="w-8 shrink-0 text-right tabular-nums text-muted-foreground">
                    {eqBandLabel(hz)}
                  </span>
                  <input
                    type="range"
                    min={-EQ_GAIN_LIMIT_DB}
                    max={EQ_GAIN_LIMIT_DB}
                    step={1}
                    value={eq.gainsDb[i] ?? 0}
                    onChange={(e) => {
                      const gainsDb = [...eq.gainsDb];
                      gainsDb[i] = Number(e.target.value);
                      pushEq({ ...eq, gainsDb });
                    }}
                    className="min-w-0 flex-1 accent-[var(--primary)]"
                    aria-label={`${eqBandLabel(hz)}Hz 增益`}
                  />
                  <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">
                    {(eq.gainsDb[i] ?? 0) > 0 ? "+" : ""}
                    {eq.gainsDb[i] ?? 0}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {error && <p className="py-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

import { useState } from "react";
import { SKINS, getSkin } from "@/lib/skins";
import { useAppearanceStore } from "@/stores/appearance";
import { SettingRow, Switch, modeOptions } from "../controls";
import { useT } from "@/lib/i18n";

export function AppearanceSection(): React.JSX.Element {
  const tr = useT();
  const modes = modeOptions(tr);
  const preference = useAppearanceStore((s) => s.preference);
  const update = useAppearanceStore((s) => s.update);
  const saveError = useAppearanceStore((s) => s.saveError);
  const retrySave = useAppearanceStore((s) => s.retrySave);
  const followCover = preference.followCoverColor;
  const activeSkin = getSkin(preference.skinId, preference.customColor);
  const [bgError, setBgError] = useState<string | null>(null);

  const handleBgImage = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setBgError(tr("appearance.bgTooLarge"));
      return;
    }
    setBgError(null);
    const reader = new FileReader();
    reader.onload = () => {
      void update({ bgImage: reader.result as string });
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="max-w-4xl">
      {/* 写库失败必须看得见：以前是「界面已生效、重启却回滚」而用户无从察觉（P2-8）。
          role="alert" 让读屏器也念出来（P2-10）。 */}
      {saveError !== null && (
        <div
          role="alert"
          className="mb-4 flex items-start justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <span>{saveError}</span>
          <button
            type="button"
            onClick={() => void retrySave()}
            className="shrink-0 rounded border border-destructive/40 px-2 py-0.5 transition-colors hover:bg-destructive/10"
          >
            {tr("common.retry")}
          </button>
        </div>
      )}
      <SettingRow title={tr("appearance.mode")} description={tr("appearance.modeHint")}>
        <div className="flex overflow-hidden rounded-md border border-border">
          {modes.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => void update({ mode: opt.value })}
              className={`px-3 py-1.5 text-xs transition-colors ${
                preference.mode === opt.value
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-accent"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </SettingRow>

      <SettingRow
        title={tr("appearance.fontScale")}
        description={tr("appearance.fontScaleHint", { percent: (preference.fontScale * 100).toFixed(0) })}
      >
        <div className="flex w-[200px] shrink-0 items-center gap-[12px]">
          <input
            type="range"
            min={0.85}
            max={1.25}
            step={0.05}
            value={preference.fontScale}
            onChange={(e) => void update({ fontScale: Number(e.target.value) })}
            className="w-full accent-[var(--primary)]"
            aria-label={tr("appearance.fontScale")}
          />
          <span className="w-[46px] shrink-0 text-right text-xs tabular-nums text-muted-foreground">
            {Math.round(preference.fontScale * 100)}%
          </span>
        </div>
      </SettingRow>

      <SettingRow title={tr("appearance.reduceMotion")} description={tr("appearance.reduceMotionHint")}>
        <Switch
          checked={preference.reduceMotion}
          onToggle={() => void update({ reduceMotion: !preference.reduceMotion })}
        />
      </SettingRow>

      <SettingRow
        title={tr("appearance.followCover")}
        description={tr("appearance.followCoverHint")}
      >
        <Switch
          checked={preference.followCoverColor}
          onToggle={() => void update({ followCoverColor: !preference.followCoverColor })}
        />
      </SettingRow>

      <div className="border-t border-border py-4">
        <h3 className="text-sm font-medium">{tr("appearance.skins")}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {followCover
            ? tr("appearance.skinsFollowCover")
            : tr("appearance.skinsHint")}
        </p>

        <div
          className={`mt-3 flex flex-wrap gap-2 ${
            followCover ? "pointer-events-none opacity-40" : ""
          }`}
        >
          {SKINS.map((skin) => {
            const active = preference.skinId === skin.id;
            return (
              <button
                key={skin.id}
                type="button"
                onClick={() => void update({ skinId: skin.id })}
                className={`flex items-center gap-2 rounded-xl border-2 p-2 pr-3 transition-colors ${
                  active
                    ? "border-primary shadow-sm"
                    : "border-border/60 hover:border-border"
                }`}
                style={{ backgroundColor: skin.bgLight }}
              >
                <div
                  className="h-7 w-7 rounded-lg"
                  style={{ backgroundColor: skin.primaryLight }}
                />
                <div
                  className="h-7 w-1.5 rounded-full"
                  style={{ backgroundColor: skin.sidebarLight }}
                />
                <span className="text-xs font-medium">{skin.name}</span>
              </button>
            );
          })}

          {/* 自定义皮肤 */}
          <div
            className="flex items-center gap-2 rounded-xl border-2 border-dashed border-border/80 p-2 pr-3 transition-all hover:border-border"
            style={{
              backgroundColor: preference.skinId === "custom" ? activeSkin.bgLight : "#fafafa",
            }}
          >
            <label className="relative cursor-pointer">
              <input
                type="color"
                value={preference.customColor}
                onChange={(e) =>
                  void update({ skinId: "custom", customColor: e.target.value })
                }
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                aria-label={tr("appearance.customColor")}
              />
              <div
                className="h-7 w-7 rounded-lg"
                style={{ backgroundColor: preference.customColor }}
              />
            </label>
            <span className="text-xs font-medium">{tr("appearance.custom")}</span>
          </div>
        </div>
      </div>

      <div className="border-t border-border py-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium">{tr("appearance.bgImage")}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {tr("appearance.bgImageHint")}
            </p>
          </div>
          {preference.bgImage && (
            <button
              type="button"
              onClick={() => void update({ bgImage: "" })}
              className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            >
              {tr("appearance.bgClear")}
            </button>
          )}
        </div>

        {preference.bgImage ? (
          <div className="mt-3 overflow-hidden rounded-lg border border-border">
            <img
              src={preference.bgImage}
              alt={tr("appearance.bgPreview")}
              className="h-32 w-full object-cover"
            />
          </div>
        ) : (
          <label className="mt-3 flex h-24 cursor-pointer items-center justify-center rounded-lg border-2 border-dashed border-border transition-colors hover:border-primary/40">
            <input
              type="file"
              accept="image/*"
              onChange={handleBgImage}
              className="hidden"
            />
            <div className="text-center text-xs text-muted-foreground">
              <p>{tr("appearance.bgPick")}</p>
              <p className="mt-1 text-3xs">{tr("appearance.bgFormats")}</p>
            </div>
          </label>
        )}

        {bgError && (
          <p className="mt-2 text-xs text-destructive">{bgError}</p>
        )}
      </div>
    </div>
  );
}


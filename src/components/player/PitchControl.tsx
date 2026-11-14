import { Minus, Plus, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { usePitchStore, PITCH_LIMIT } from "@/stores/pitch";

function pitchLabel(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

/** Shared compact controls for the sound settings row and player-bar popover. */
export function PitchControls(props: { className?: string }): React.JSX.Element {
  const t = useT();
  const value = usePitchStore((state) => state.semitones);
  const error = usePitchStore((state) => state.error);
  const change = usePitchStore((state) => state.change);

  return (
    <div className={props.className}>
      <div className="flex w-full min-w-0 items-center gap-1.5">
        <Button
          variant="ghost"
          size="xs"
          icon={<Minus className="h-3.5 w-3.5" />}
          aria-label={t("settings.sound.pitch.lower")}
          title={t("settings.sound.pitch.lower")}
          disabled={value <= -PITCH_LIMIT}
          onClick={() => change(value - 1)}
        />
        <input
          type="range"
          min={-PITCH_LIMIT}
          max={PITCH_LIMIT}
          step={1}
          value={value}
          onChange={(event) => change(Number(event.target.value))}
          aria-label={t("settings.sound.pitch.slider")}
          className="min-w-12 flex-1 accent-[var(--primary)]"
        />
        <output className="w-10 shrink-0 text-center text-xs tabular-nums text-muted-foreground" aria-live="polite">
          {pitchLabel(value)}
        </output>
        <Button
          variant="ghost"
          size="xs"
          icon={<Plus className="h-3.5 w-3.5" />}
          aria-label={t("settings.sound.pitch.raise")}
          title={t("settings.sound.pitch.raise")}
          disabled={value >= PITCH_LIMIT}
          onClick={() => change(value + 1)}
        />
        <Button
          variant="ghost"
          size="xs"
          icon={<RotateCcw className="h-3.5 w-3.5" />}
          aria-label={t("settings.sound.pitch.reset")}
          title={t("settings.sound.pitch.reset")}
          disabled={value === 0}
          onClick={() => change(0)}
        />
      </div>
      {error && <p role="alert" className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}

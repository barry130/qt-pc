import { memo, useRef, useState } from "react";
import { Check, ImagePlus, PanelsTopLeft } from "lucide-react";
import { Popover } from "@/components/common/Popover";
import { PLAYING_STYLES, usePlayingStyleStore } from "@/stores/playingStyle";
import { cn } from "@/lib/utils";
import { PLAYING_BACKGROUNDS, readPlayingBackgroundImage, type PlayingBackgroundKind } from "@/lib/playing-background";

export const PlayingStyleControl = memo(function PlayingStyleControl(): React.JSX.Element {
  const style = usePlayingStyleStore((s) => s.style);
  const select = usePlayingStyleStore((s) => s.select);
  const saveError = usePlayingStyleStore((s) => s.saveError);
  const background = usePlayingStyleStore((s) => s.background);
  const selectBackground = usePlayingStyleStore((s) => s.selectBackground);
  const backgroundSaveError = usePlayingStyleStore((s) => s.backgroundSaveError);
  const retrySave = usePlayingStyleStore((s) => s.retrySave);
  const [open, setOpen] = useState(false);
  const [imageError, setImageError] = useState("");
  const [readingImage, setReadingImage] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const unsaved = saveError || backgroundSaveError;

  const changeOpen = (next: boolean): void => {
    if (!next && panelRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
    setOpen(next);
  };
  const chooseBackground = (kind: PlayingBackgroundKind): void => {
    setImageError("");
    if (kind === "image" && !background.image) inputRef.current?.click();
    else void selectBackground({ ...background, kind });
  };
  const chooseImage = async (file: File): Promise<void> => {
    setImageError("");
    setReadingImage(true);
    try {
      const image = await readPlayingBackgroundImage(file);
      await selectBackground({ kind: "image", image });
    } catch (error) {
      setImageError(error instanceof Error ? error.message : "图片无法读取，请重新选择");
    } finally {
      setReadingImage(false);
    }
  };

  return (
    <>
      <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" aria-label="选择播放页背景图片"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void chooseImage(file);
        }} />
      <Popover
        open={open}
        onOpenChange={changeOpen}
        trigger={(t) => (
          <button
            ref={triggerRef}
            type="button"
            aria-label="播放页风格"
            aria-haspopup="dialog"
            aria-expanded={t.open}
            title={`播放页风格：${PLAYING_STYLES.find((item) => item.id === style)?.label}`}
            onMouseDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onClick={t.toggle}
            className="flex h-8 items-center gap-1.5 rounded-full px-3 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <PanelsTopLeft className="h-4 w-4" aria-hidden />
            风格
            {unsaved ? <span className="text-2xs text-destructive" role="status">未保存</span> : null}
          </button>
        )}
      >
        {(close) => (
          <div
            ref={panelRef}
            role="dialog"
            aria-label="播放页风格"
            className="qt-style-panel absolute right-0 top-full z-30 mt-2 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-raised"
          >
            <p className="mb-3 text-sm font-medium">播放页风格</p>
            <div className="grid grid-cols-2 gap-2">
              {PLAYING_STYLES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-label={item.label}
                  aria-pressed={style === item.id}
                  autoFocus={style === item.id}
                  onClick={() => {
                    void select(item.id);
                    close();
                    triggerRef.current?.focus();
                  }}
                  className={cn(
                    "rounded-lg border p-1.5 text-left transition-colors duration-fast hover:bg-accent",
                    style === item.id ? "border-primary bg-primary/10" : "border-border",
                  )}
                >
                  <span className={`qt-style-preview qt-style-preview-${item.id}`} aria-hidden>
                    {item.id === "classic" ? (
                      <><i className="qt-style-preview-disc" /><span className="qt-style-preview-lines"><i /><i /><i /></span></>
                    ) : item.id === "rhythm" ? (
                      <span className="qt-style-preview-words"><i>随</i><i>心</i><i>而</i><i>动</i></span>
                    ) : item.id === "gallery" ? (
                      <><i className="qt-style-preview-album" /><span className="qt-style-preview-lines"><i /><i /><i /></span></>
                    ) : (
                      <span className="qt-style-preview-lines"><i /><i /><i /></span>
                    )}
                  </span>
                  <span className="mt-2 flex items-center justify-between gap-1 text-xs font-medium">
                    {item.label}
                    {style === item.id ? <Check className="h-3.5 w-3.5 text-primary" aria-hidden /> : null}
                  </span>
                  <span className="mt-1 block text-2xs leading-relaxed text-muted-foreground">{item.description}</span>
                </button>
              ))}
            </div>
            <div role="group" aria-label="播放页背景" className="mt-3 border-t border-border pt-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-medium">背景</span>
                <span className="text-2xs text-muted-foreground">{PLAYING_BACKGROUNDS.find((item) => item.id === background.kind)?.label}</span>
              </div>
              <div className="flex gap-2">
                {PLAYING_BACKGROUNDS.map((item) => (
                  <button key={item.id} type="button" title={item.label} aria-label={item.label}
                    aria-pressed={background.kind === item.id} disabled={readingImage}
                    onClick={() => chooseBackground(item.id)}
                    className={cn("qt-background-swatch", `qt-background-swatch-${item.id}`)}>
                    {item.id === "image" ? background.image ? <img src={background.image} alt="" /> : <ImagePlus className="h-4 w-4" aria-hidden /> : null}
                    {background.kind === item.id ? <Check className="qt-background-check h-3.5 w-3.5" aria-hidden /> : null}
                  </button>
                ))}
              </div>
              {background.image ? (
                <div className="mt-2 flex justify-end gap-3 text-2xs text-muted-foreground">
                  <button type="button" disabled={readingImage} onClick={() => inputRef.current?.click()} className="rounded hover:text-foreground">更换图片</button>
                  <button type="button" disabled={readingImage} onClick={() => {
                    setImageError("");
                    void selectBackground({ kind: background.kind === "image" ? "auto" : background.kind, image: "" });
                  }} className="rounded hover:text-foreground">移除图片</button>
                </div>
              ) : null}
              {readingImage ? <p role="status" className="mt-2 text-2xs text-muted-foreground">正在处理图片…</p> : null}
              {imageError ? <p role="alert" className="mt-2 text-xs text-destructive">{imageError}</p> : null}
            </div>
            {unsaved ? (
              <p role="status" className="mt-3 text-xs text-destructive">
                选择已生效，但未能保存。
                <button type="button" onClick={() => void retrySave()} className="ml-1 underline">重试</button>
              </p>
            ) : <p className="mt-3 text-2xs text-muted-foreground">风格与背景可自由搭配，下次打开沿用。</p>}
          </div>
        )}
      </Popover>
    </>
  );
});

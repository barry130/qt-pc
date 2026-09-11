import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Check, Disc3, FolderPlus } from "lucide-react";
import type { SourceId } from "@/types";
import * as ipc from "@/services/ipc";
import { useMusicSourceStore } from "@/stores/musicSource";

/** 引导完成标记（settings 表 key，DESIGN §12 首次启动引导） */
export const ONBOARDING_KEY = "onboarded";

// 引导只让用户先挑一个「默认音源」，不暴露具体平台名（DESIGN §12）
const SOURCES: { id: SourceId; name: string; desc: string }[] = [
  { id: "wyy", name: "音源一", desc: "曲库全、歌单丰富" },
  { id: "kw", name: "音源二", desc: "搜索稳定、新歌快" },
  { id: "qq", name: "音源三", desc: "版权多、榜单全" },
  { id: "kg", name: "音源四", desc: "曲库广、MV 多" },
];

/**
 * 首次启动引导（路由 /onboarding）。
 * 三步：认识轻听 → 选默认音源 → 完成（可顺手去加本地音乐）。
 * 完成后写 settings.onboarded，下次启动不再进（AppShell 负责判断）。
 */
export function OnboardingPage(): React.JSX.Element {
  const navigate = useNavigate();
  const activeSourceId = useMusicSourceStore((s) => s.activeSourceId);
  const setActiveSource = useMusicSourceStore((s) => s.setActiveSource);

  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);

  const finish = async (): Promise<void> => {
    setSaving(true);
    try {
      await ipc.setSetting(ONBOARDING_KEY, "1");
    } catch {
      // 标记没写上最多是下次再引导一次，不该卡住用户
    }
    await navigate({ to: "/" });
    setSaving(false);
  };

  return (
    <div className="flex h-full flex-col items-center justify-center overflow-y-auto px-6 py-8">
      <div className="w-full max-w-md">
        <div className="mb-6 flex justify-center gap-1.5">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className={`h-1 w-10 rounded-full transition-colors ${
                i <= step ? "bg-primary" : "bg-secondary"
              }`}
            />
          ))}
        </div>

        {step === 0 && (
          <section className="text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl bg-primary/15">
              <Disc3 className="h-7 w-7 text-primary" />
            </div>
            <h1 className="mt-4 text-lg font-semibold">欢迎使用轻听</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              一个安静的桌面音乐播放器。聚合多个在线音源在线试听，
              也能把本地音乐文件夹扫进曲库；不登录也可以使用。
            </p>
          </section>
        )}

        {step === 1 && (
          <section>
            <h1 className="text-center text-lg font-semibold">选择默认音源</h1>
            <p className="mt-1 text-center text-xs text-muted-foreground">
              之后随时可以在发现页顶部切换
            </p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              {SOURCES.map((s) => {
                const active = activeSourceId === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setActiveSource(s.id)}
                    className={`relative rounded-lg border p-3 text-left transition-colors ${
                      active
                        ? "border-primary bg-primary/10"
                        : "border-border hover:bg-secondary"
                    }`}
                  >
                    <div className="text-sm font-medium">{s.name}</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {s.desc}
                    </div>
                    {active && (
                      <Check className="absolute right-2 top-2 h-3.5 w-3.5 text-primary" />
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl bg-primary/15">
              <FolderPlus className="h-7 w-7 text-primary" />
            </div>
            <h1 className="mt-4 text-lg font-semibold">还可以导入本地音乐</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              在「音乐文件夹」里添加存放音乐的目录，轻听会把里面的音频文件
              读进本地曲库。这一步可以之后再做。
            </p>
            <button
              type="button"
              onClick={async () => {
                await ipc.setSetting(ONBOARDING_KEY, "1").catch(() => {});
                await navigate({ to: "/library/folders" });
              }}
              className="mt-4 text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
            >
              现在就去添加
            </button>
          </section>
        )}

        <div className="mt-8 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0}
            className="h-9 rounded-md px-4 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
          >
            上一步
          </button>

          {step < 2 ? (
            <button
              type="button"
              onClick={() => setStep((s) => s + 1)}
              className="h-9 rounded-md bg-primary px-5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              下一步
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void finish()}
              disabled={saving}
              className="h-9 rounded-md bg-primary px-5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {saving ? "处理中…" : "开始使用"}
            </button>
          )}
        </div>

        {step === 0 && (
          <button
            type="button"
            onClick={() => void finish()}
            className="mt-3 w-full text-center text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            跳过
          </button>
        )}
      </div>
    </div>
  );
}

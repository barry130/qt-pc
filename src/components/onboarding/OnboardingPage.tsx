import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Check, Disc3, FolderPlus } from "lucide-react";
import type { SourceId } from "@/types";
import * as ipc from "@/services/ipc";
import { useMusicSourceStore } from "@/stores/musicSource";

/** 引导完成标记（settings 表 key，DESIGN §12 首次启动引导）。
 *  真正的定义在 `@/lib/storageKeys`：AppShell 也要用它，而 AppShell 静态 import
 *  本页面会让整页引导流程被绑进主 chunk、页面懒加载失效。这里保留转出以兼容旧引用。 */
export { ONBOARDING_KEY } from "@/lib/storageKeys";
import { ONBOARDING_KEY } from "@/lib/storageKeys";

// 引导让用户挑「默认音乐来源」：本地音乐是推荐默认（应用定位本地播放器），
// 在线音源仅作可选项（需在「设置 → 音源包」安装音源包后才可用）
const SOURCES: { id: SourceId; name: string; desc: string }[] = [
  { id: "local", name: "本地音乐", desc: "播放自己电脑里的音乐（推荐）" },
  { id: "wyy", name: "音源一", desc: "曲库全、歌单丰富" },
  { id: "kw", name: "音源二", desc: "搜索稳定、新歌快" },
  { id: "qq", name: "音源三", desc: "版权多、榜单全" },
  { id: "kg", name: "音源四", desc: "曲库广、MV 多" },
];

/**
 * 首次启动引导（路由 /onboarding）。
 * 三步：认识轻听 → 选默认音乐来源（本地推荐） → 完成（可顺手去加本地音乐）。
 * 完成后写 settings.onboarded，下次启动不再进（AppShell 负责判断）。
 */
export function OnboardingPage(): React.JSX.Element {
  const navigate = useNavigate();
  const activeSourceId = useMusicSourceStore((s) => s.activeSourceId);
  const setActiveSource = useMusicSourceStore((s) => s.setActiveSource);

  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);

  // 本地优先：引导只跑一次（settings.onboarded 门控），进来先把默认来源
  // 收敛到本地音乐；在线音源需要用户在引导里主动选择才切换。
  useEffect(() => {
    setActiveSource("local");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
              一个安静的本地音乐播放器。先把电脑里的音乐收进曲库，
              也能按需安装音源包扩展在线试听；不登录也可以使用。
            </p>
          </section>
        )}

        {step === 1 && (
          <section>
            <h1 className="text-center text-lg font-semibold">选择默认音乐来源</h1>
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
                    } ${s.id === "local" ? "col-span-2" : ""}`}
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
            <p className="mt-3 text-center text-[11px] leading-relaxed text-muted-foreground">
              在线音源需在「设置 → 音源包」安装音源包后可用，可以先选本地音乐，之后再装。
            </p>
          </section>
        )}

        {step === 2 && (
          <section className="text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl bg-primary/15">
              <FolderPlus className="h-7 w-7 text-primary" />
            </div>
            <h1 className="mt-4 text-lg font-semibold">导入本地音乐</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              在「音乐文件夹」里添加存放音乐的目录，轻听会把里面的音频文件
              读进本地曲库——这是使用轻听的第一步。这一步也可以之后再做。
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

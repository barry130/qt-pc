import { useCallback, useEffect, useState } from "react";
import { AiProvidersDialog } from "@/components/settings/AiProvidersPanel";
import { AI_MODE_HINT, AI_MODE_LABEL, aiModeOptionsFor, readAiMode, resolveAiMode, type AiEngineMode } from "@/lib/ai-mode";
import { DAILY_TASTE_LABEL, DAILY_TASTE_ORDER, readTaste, saveMode, saveTaste, type DailyTaste } from "@/lib/daily-recommend";
import { errMsg } from "@/lib/utils";
import { isAdmin, isSessionValid, useAuthStore } from "@/stores/auth";
import { toastError } from "@/stores/toast";
import { Segmented, SettingRow } from "../controls";

// ---------- AI 设置（全局 AI 模式 + 客户端直连模型） ----------

/** 推荐口味（推荐策略）：与上面的「AI 模式」（要不要叫模型）互相独立 */
const DAILY_TASTE_OPTIONS: { value: DailyTaste; label: string }[] = DAILY_TASTE_ORDER.map(
  (value) => ({ value, label: DAILY_TASTE_LABEL[value] }),
);


/**
 * AI 设置（`/settings/ai`）。
 *
 * 这个分区分成两块：上面那行「AI 模式」是**全局 AI 模式**（存储键沿用
 * `dailyRecommend.mode`），「音乐助手」（`/ai-assistant`）与「每日推荐」
 * （`/daily-recommend`）都按它执行；下面的「接口配置」只服务本地模型精选 ——
 * 只有模式选「本地模型精选」时那套地址/Key 才用得到。
 *
 * ---------------------------------------------------------------------------
 * 多套配置档，任选其一生效
 * ---------------------------------------------------------------------------
 * 用户往往不止一个可用接口：官方 API 一个、中转网关一个、本机 Ollama 一个。
 * 所以这里存的是**列表**（`ai.profiles` JSON + `ai.activeProfile`），而不是一组
 * baseUrl/model/key。列表里点哪套就哪套生效（`activeId`），调用方（`ai_local.rs`）
 * 只认生效的那一套 —— 换接口不用重填、也不会把上一套的 Key 丢掉。
 *
 * 模型名支持两种填法：手输，或点「获取」拉 `GET /models` 出来选。
 * 有些网关不实现 /models，所以拉失败只提示、不阻断手输。
 *
 * ---------------------------------------------------------------------------
 * 为什么 Key 是「保存后前端再也拿不到」
 * ---------------------------------------------------------------------------
 * 调用模型走的是 Rust 侧命令（`ai_local.rs`），前端只传 baseUrl/model/messages。
 * 读配置的 `aiLocalConfig()` **只回 `hasKey` 布尔**，不回明文，所以 Key 不会
 * 出现在 WebView 的 JS 堆里，也不会被 DevTools / 崩溃转储带出来。
 * 代价：本机 SQLite 的 settings 表里存的是明文（项目没有 keyring 依赖，
 * 不为这一项新增原生依赖），所以下面必须明说这一点。
 *
 * 地址支持三种填法，Rust 侧会归一：`https://api.openai.com`、
 * `https://api.openai.com/v1`、以及完整端点 `.../v1/chat/completions`。
 * 本机模型（Ollama / LM Studio）填 `http://localhost:11434/v1` 也可以 ——
 * 这条通道**不复用**音源脚本的请求通道（那条被 `net_guard` 拦内网防跳板），
 * 只认这里填的地址，Key 留空即不发 Authorization 头。
 *
 * ---------------------------------------------------------------------------
 * 提示一律走右上角 toast
 * ---------------------------------------------------------------------------
 * 这个分区里没有一行「已保存 / 保存失败 / 测试结果」的内联文字：全部走
 * `toast*`（右上角浮层）。设置页表单是逐字段回车/失焦保存的，内联提示会把
 * 行高顶起来、按钮跟着上下跳；浮层几秒自己走，页面布局不动。
 */

export function AiSection(): React.JSX.Element {
  /**
   * 当前显示的模式 / 口味。
   *
   * `null` = 还没从库里读回来。旧实现把初值直接写成 "rule" / "heart" 就渲染，
   * 选了「本地模型精选」的用户每次进设置页都先看到「纯规则」再跳过去 ——
   * 读回来之前先渲染「载入中」，不让错误值闪一下。
   */
  const [mode, setMode] = useState<AiEngineMode | null>(null);
  const [taste, setTaste] = useState<DailyTaste | null>(null);
  /**
   * 库里存的原始值是不是「服务端 AI」。
   *
   * 单独记一份：非管理员的按钮组里根本没有这一项，若只留「有效模式」，
   * 就分不清「本来就选的是规则」和「选了服务端但被降级」，
   * 下面那句说明也就没法只在该说的时候说。
   */
  const [storedServer, setStoredServer] = useState(false);
  /**
   * 是否登录了 astral（会话有效）。
   *
   * 「服务端 AI」要登录才生效：没登录时后端会退回规则，提示里必须当场说清楚，
   * 否则用户选了服务端却拿到规则结果，会以为是坏了。登录态在 AppShell 启动时
   * 已由 `useAuthStore.init()` 从本机会话恢复，这里直接读，不再单独发一次 IPC。
   */
  const session = useAuthStore((s) => s.session);
  const loggedIn = isSessionValid(session);
  /**
   * 「服务端 AI」是管理员专属（2026-10-24，与移动端 `isQtAdmin()` 同口径）。
   *
   * 后端登录响应/profile 里已经带 `permissions`（管理员是 `admin:qt:admin`），
   * 前端据此隐藏这一项并降级执行 —— 后端仍按智能体权限码校验，前端隐藏不是安全边界。
   * 订阅 profile 而不是只在挂载时取快照：AppShell 恢复登录态是异步的，
   * 只在挂载时取的话，管理员刷新页面后会一直看不到「服务端 AI」。
   */
  const profile = useAuthStore((s) => s.profile);
  const canUseServer = isAdmin(profile);
  /** 供应商配置弹窗：设置页只留一行入口，点开是一个弹窗（用户 2026-10-24 要求）。 */
  const [providersOpen, setProvidersOpen] = useState(false);

  useEffect(() => {
    let disposed = false;
    // 读库里的**原值**（ai-mode 的 readAiMode），不用 daily-recommend 的 readMode：
    // 后者已经按管理员身份收敛过，非管理员永远读不到 server，`storedServer` 就永远
    // 是 false、下面那句「仅管理员可用」的说明也永远出不来。降级在这里自己做。
    void Promise.all([readAiMode(), readTaste()])
      .then(([storedMode, storedTaste]) => {
        if (disposed) return;
        setStoredServer(storedMode === "server");
        // 非管理员即使库里存过服务端模式也按规则显示：按钮组里没有 server，
        // 还挂着选中态会让人以为选中了一个不存在的选项。
        setMode(resolveAiMode(storedMode, canUseServer));
        setTaste(storedTaste);
      })
      .catch(() => {
        // 设置库读坏了也不能让整页空着：按默认值收敛（与 readMode/readTaste 的兜底一致）
        if (!disposed) {
          setMode("rule");
          setTaste("heart");
        }
      });
    return () => {
      disposed = true;
    };
  }, [canUseServer]);

  const pickMode = useCallback(
    (next: AiEngineMode): void => {
      // 按钮组已经过滤掉 server，这里再收一次是兜底：非管理员任何路径都存不进 server
      const chosen = resolveAiMode(next, canUseServer);
      setMode(chosen);
      setStoredServer(chosen === "server");
      void saveMode(chosen).catch((e: unknown) => {
        toastError(`保存 AI 模式失败：${errMsg(e)}`);
      });
    },
    [canUseServer],
  );

  const pickTaste = useCallback((next: DailyTaste): void => {
    setTaste(next);
    void saveTaste(next).catch((e: unknown) => {
      toastError(`保存推荐口味失败：${errMsg(e)}`);
    });
  }, []);


  return (
    <div className="max-w-4xl divide-y divide-border">
      <SettingRow
        title="AI 模式"
        description="音乐助手和每日推荐共用这一个模式。纯规则不联网、永远可用；本地模型精选调用下面配置的接口，只让模型在已搜好的候选里挑，挂了自动退回规则；服务端 AI 走登录后的 astral 音乐助手，每日推荐与助手都用服务端生成，需要登录、且仅管理员可选，失败同样退回规则。"
      >
        {mode === null ? (
          <span className="text-xs text-muted-foreground">载入中…</span>
        ) : (
          // 非管理员只看到 rule/local：服务端 AI 的入口从设置页就藏掉，
          // 执行层再各自降级一次（见 lib/ai-mode.ts 的 resolveAiMode）
          <Segmented value={mode} options={aiModeOptionsFor(canUseServer)} onChange={pickMode} />
        )}
      </SettingRow>

      <SettingRow
        title="推荐口味"
        description="决定候选怎么搜、怎么排序，和上面「AI 模式」互不影响（三种模式都能配三种口味）。心动＝从收藏（喜欢的单曲 + 在线收藏歌单 + 本地自建歌单）和最近在听出发；常听＝以常听歌手为主轴；探索＝尽量推你没听过的歌手。三种口味都会把同一歌手的歌摊开，不会连着排。"
      >
        {taste === null ? (
          <span className="text-xs text-muted-foreground">载入中…</span>
        ) : (
          <Segmented value={taste} options={DAILY_TASTE_OPTIONS} onChange={pickTaste} />
        )}
      </SettingRow>

      {mode !== null && (
        <p className="py-3 text-xs text-muted-foreground">
          {AI_MODE_HINT[mode]}
          {mode === "server" && !loggedIn ? " 当前未登录服务端，实际会退回规则。" : ""}
          {/* 库里存过服务端、但当前账号不是管理员：说清楚为什么实际按规则跑，
              否则用户会发现「设置里没这个选项，结果却和以前不一样」 */}
          {storedServer && !canUseServer ? " 服务端 AI 仅管理员可用，当前按纯规则运行。" : ""}
        </p>
      )}

      <SettingRow
        title="接口配置"
        description="AI 供应商按「列表 → 详情」管理：Base URL、协议（OpenAI / OpenAI Responses / Anthropic / Gemini）、多把密钥（第一把生效）、模型多选、图标与证书校验都在弹窗里改。密钥保存后前端不再回显明文，只显示掩码。"
      >
        <button
          type="button"
          onClick={() => setProvidersOpen(true)}
          className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-secondary"
        >
          管理供应商…
        </button>
      </SettingRow>

      {providersOpen ? <AiProvidersDialog onClose={() => setProvidersOpen(false)} /> : null}

      <p className="py-3 text-xs text-muted-foreground">
        每日推荐默认每天第一次进页面时生成一次，当天再进直接读缓存；「换一批」会立刻重算。
        候选来自全部已装音源的搜索，近 7 天推过的歌会排到后面（不再硬排除，池子不够时也能兜底）。
        {mode !== null ? `当前 AI 模式：${AI_MODE_LABEL[mode]}。` : ""}
        {taste !== null ? `当前口味：${DAILY_TASTE_LABEL[taste]}。` : ""}
      </p>
    </div>
  );
}

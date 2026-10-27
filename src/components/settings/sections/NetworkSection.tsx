import { useCallback, useEffect, useRef, useState } from "react";
import { errMsg } from "@/lib/utils";
import * as ipc from "@/services/ipc";
import { type NetConfigView, type NetTestResult } from "@/types";
import { Segmented, SettingRow } from "../controls";

// ---------- 网络设置（第二波：代理与单源超时） ----------

const PROXY_MODE_OPTIONS: { value: string; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "none", label: "直连" },
  { value: "custom", label: "自定义" },
];

/** 单源超时预设（秒）；不在预设里的存量值走自定义输入 */
const SOURCE_TIMEOUT_PRESETS = [5, 10, 15, 30, 60];

export function NetworkSection(): React.JSX.Element {
  const [cfg, setCfg] = useState<NetConfigView | null>(null);
  const [urlDraft, setUrlDraft] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [timeoutCustom, setTimeoutCustom] = useState(false);
  const [timeoutDraft, setTimeoutDraft] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<NetTestResult | null>(null);
  const cfgRef = useRef<NetConfigView | null>(null);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const saveVersion = useRef(0);

  useEffect(() => {
    let alive = true;
    void ipc
      .getNetConfig()
      .then((c) => {
        if (!alive) return;
        cfgRef.current = c;
        setCfg(c);
        setUrlDraft(c.proxyUrl);
      })
      .catch((e: unknown) => {
        if (alive) setSaveError(`读取网络设置失败：${errMsg(e)}`);
      });
    return () => {
      alive = false;
    };
  }, []);

  const save = useCallback(
    async (patch: Partial<NetConfigView>): Promise<void> => {
      if (!cfgRef.current) return;
      const next = { ...cfgRef.current, ...patch };
      const version = ++saveVersion.current;
      cfgRef.current = next;
      setCfg(next);
      setSaveError(null);
      // 首次选择自定义时先露出地址框，填好后再应用，避免空地址被拒后入口消失。
      if (next.proxyMode === "custom" && !next.proxyUrl.trim()) {
        setSaveError("填入代理地址后应用自定义代理");
        return;
      }
      // 顺序发送，且仅最后一次响应回写表单，避免失焦保存覆盖紧接着的模式/超时选择。
      const pending = saveChain.current.then(async () => {
        try {
          const saved = await ipc.setNetConfig(next.proxyMode, next.proxyUrl, next.sourceTimeoutMs);
          if (version !== saveVersion.current) return;
          cfgRef.current = saved;
          setCfg(saved);
          setSaveError(null);
        } catch (e) {
          if (version !== saveVersion.current) return;
          setSaveError(errMsg(e));
          try {
            const saved = await ipc.getNetConfig();
            if (version !== saveVersion.current) return;
            cfgRef.current = saved;
            setCfg(saved);
          } catch {
            // 回读失败仍保留草稿，错误行可见。
          }
        }
      });
      saveChain.current = pending;
      await pending;
    },
    [],
  );

  const applyUrlDraft = useCallback(async (): Promise<void> => {
    if (!cfg) return;
    const trimmed = urlDraft.trim();
    if (trimmed === cfg.proxyUrl) return;
    await save({ proxyUrl: trimmed });
  }, [cfg, save, urlDraft]);

  const applyTimeoutDraft = useCallback(async (): Promise<void> => {
    if (!cfg) return;
    const seconds = Number(timeoutDraft);
    if (!Number.isFinite(seconds)) {
      setSaveError("超时秒数需要是数字");
      return;
    }
    // 与 Rust 侧 net_config 的钳制范围一致（2–60 秒），前端先钳省一次来回
    const clamped = Math.min(60, Math.max(2, Math.round(seconds)));
    setTimeoutCustom(false);
    await save({ sourceTimeoutMs: clamped * 1000 });
  }, [cfg, save, timeoutDraft]);

  const runTest = useCallback(async (): Promise<void> => {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      // 试连用「表单值」：自定义模式下用输入框草稿，可以先试再存
      const mode = cfg?.proxyMode ?? "system";
      const url = mode === "custom" ? urlDraft.trim() : (cfg?.proxyUrl ?? "");
      setTestResult(await ipc.testNetConfig(mode, url));
    } catch (e) {
      setTestResult({ ok: false, status: null, elapsedMs: 0, error: errMsg(e) });
    } finally {
      setTesting(false);
    }
  }, [cfg, testing, urlDraft]);

  const timeoutSeconds = cfg ? cfg.sourceTimeoutMs / 1000 : null;
  const isPreset =
    timeoutSeconds !== null && SOURCE_TIMEOUT_PRESETS.includes(timeoutSeconds);
  const showTimeoutInput = timeoutCustom || !isPreset;

  return (
    <div className="max-w-4xl divide-y divide-border">
      <SettingRow
        title="代理模式"
        description="音源、在线播放、封面、下载及账号与更新请求都使用此代理。改动对下一次请求生效，不打断正在播放的歌。"
      >
        {cfg ? (
          <Segmented
            value={cfg.proxyMode}
            options={PROXY_MODE_OPTIONS}
            onChange={(v) => void save({ proxyMode: v })}
          />
        ) : (
          <span className="text-xs text-muted-foreground">…</span>
        )}
      </SettingRow>
      {cfg?.proxyMode === "custom" && (
        <SettingRow
          title="代理地址"
          description="支持 http://、https://、socks5://、socks5h://，可带用户名密码（回车或失焦保存）"
        >
          <span className="flex w-full flex-col items-end gap-1">
            <input
              type="text"
              value={urlDraft}
              placeholder="http://127.0.0.1:7890"
              onChange={(e) => {
                setUrlDraft(e.target.value);
                setSaveError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void applyUrlDraft();
              }}
              onBlur={() => void applyUrlDraft()}
              spellCheck={false}
              className="w-full rounded-md border border-border bg-transparent px-2 py-1 text-xs outline-none focus:border-primary"
            />
          </span>
        </SettingRow>
      )}
      <SettingRow
        title="单源超时"
        description="单个音源 HTTP 请求的默认超时；音源脚本显式声明的超时优先。网络差时调大可减少「音源不可用」。"
      >
        {cfg && timeoutSeconds !== null ? (
          <div className="flex items-center gap-2">
            <Segmented
              value={isPreset && !timeoutCustom ? String(timeoutSeconds) : "custom"}
              options={[
                ...SOURCE_TIMEOUT_PRESETS.map((s) => ({ value: String(s), label: `${s} 秒` })),
                { value: "custom", label: "自定义" },
              ]}
              onChange={(v) => {
                if (v === "custom") {
                  setTimeoutCustom(true);
                  setTimeoutDraft(String(timeoutSeconds));
                  return;
                }
                setTimeoutCustom(false);
                void save({ sourceTimeoutMs: Number(v) * 1000 });
              }}
            />
            {showTimeoutInput && (
              <span className="flex items-center gap-1">
                <input
                  type="number"
                  inputMode="numeric"
                  min={2}
                  max={60}
                  value={timeoutDraft}
                  placeholder="10"
                  onChange={(e) => {
                    setTimeoutDraft(e.target.value);
                    setSaveError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void applyTimeoutDraft();
                  }}
                  onBlur={() => void applyTimeoutDraft()}
                  className="w-16 rounded-md border border-border bg-transparent px-2 py-1 text-xs outline-none focus:border-primary"
                />
                <span className="text-xs text-muted-foreground">秒</span>
              </span>
            )}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">…</span>
        )}
      </SettingRow>
      {saveError && <p role="alert" className="py-3 text-xs text-destructive">{saveError}</p>}
      <SettingRow
        title="测试连接"
        description="按当前表单里的代理设置试连一次（不修改已保存的配置）"
      >
        <span className="flex w-full flex-col items-end gap-1">
          <button
            type="button"
            disabled={testing || !cfg}
            onClick={() => void runTest()}
            className="rounded-md border border-border px-3 py-1 text-xs transition-colors hover:border-primary disabled:opacity-40"
          >
            {testing ? "测试中…" : "测试"}
          </button>
          {testResult && (
            <p
              className={`text-xs ${
                testResult.ok ? "text-muted-foreground" : "text-destructive"
              }`}
            >
              {testResult.ok
                ? `连通 · ${
                    testResult.status !== null ? `HTTP ${testResult.status} · ` : ""
                  }${testResult.elapsedMs} ms`
                : `失败 · ${testResult.error ?? "未知错误"}`}
            </p>
          )}
        </span>
      </SettingRow>
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { errMsg } from "@/lib/utils";
import * as ipc from "@/services/ipc";
import { Switch } from "../controls";

/** 快捷键动作 id → 中文名（模块级常量：原先定义在组件体内，每次渲染都重建一遍） */
const LABELS: Record<string, string> = {
  play_pause: "播放 / 暂停",
  previous: "上一首",
  next: "下一首",
  volume_up: "音量加",
  volume_down: "音量减",
  mute: "静音",
  desktop_lyric: "桌面歌词开关",
  lock_lyric: "锁定 / 解锁桌面歌词",
};

/** 播放设置：全局快捷键（可改键 / 可禁用，保存即热重载） */

export function ShortcutSection(): React.JSX.Element {
  const [entries, setEntries] = useState<ipc.ShortcutEntry[]>([]);
  const [draft, setDraft] = useState<
    Record<string, { key: string; enabled: boolean }>
  >({});
  const [listening, setListening] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const list = await ipc.listShortcuts();
      setEntries(list);
      const next: Record<string, { key: string; enabled: boolean }> = {};
      for (const e of list) next[e.id] = { key: e.accelerator, enabled: e.enabled };
      setDraft(next);
    } catch (err) {
      setError(errMsg(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 录制模式：下一次按键即设为该动作的加速键
  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent): void => {
      // Esc = 取消录制。必须放在 preventDefault 之前单独处理：
      // 这个监听挂在 capture 阶段并且会 stopPropagation，输入框自身的
      // onKeyDown 永远收不到事件；何况下面"排除修饰键"的列表里没有 Escape，
      // 漏掉这一行就会把 Esc 本身存成该动作的快捷键。
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setListening(null);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      // 单独的修饰键不构成快捷键
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      const parts: string[] = [];
      if (e.ctrlKey) parts.push("Ctrl");
      if (e.shiftKey) parts.push("Shift");
      if (e.altKey) parts.push("Alt");
      const keyName = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      parts.push(keyName);
      setDraft((d) => ({ ...d, [listening]: { ...d[listening], key: parts.join("+") } }));
      setListening(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [listening]);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const list = await ipc.saveShortcuts(draft);
      setEntries(list);
      // draft 必须跟着后端返回值重建（与 reset() 一致）：若返回列表里出现了
      // draft 中不存在的 id，下面开关的 setter 就会读到 undefined 而抛错。
      const next: Record<string, { key: string; enabled: boolean }> = {};
      for (const e of list) next[e.id] = { key: e.accelerator, enabled: e.enabled };
      setDraft(next);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setSaving(false);
    }
  };

  const reset = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      // 全部恢复默认（key 清空 = 沿用默认，全部启用）
      const back: Record<string, { key: string; enabled: boolean }> = {};
      for (const e of entries) back[e.id] = { key: "", enabled: true };
      const list = await ipc.saveShortcuts(back);
      setEntries(list);
      const next: Record<string, { key: string; enabled: boolean }> = {};
      for (const e of list) next[e.id] = { key: e.accelerator, enabled: e.enabled };
      setDraft(next);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-4xl divide-y divide-border">
      {entries.length === 0 && !error && (
        <p className="py-4 text-sm text-muted-foreground">加载中…</p>
      )}
      {entries.map((e) => {
        const d = draft[e.id] ?? { key: e.accelerator, enabled: e.enabled };
        const changed = d.key !== e.accelerator || d.enabled !== e.enabled;
        return (
          <div key={e.id} className="flex items-center justify-between gap-6 py-3">
            <div className="min-w-0">
              <p className="text-sm">{LABELS[e.id] ?? e.id}</p>
              {listening === e.id && (
                <p className="mt-0.5 text-xs text-[var(--primary)]">
                  按下新的快捷键组合（Esc 取消）…
                </p>
              )}
              {/* 注册失败 = 这个键被别的程序占着（Windows 上是 RegisterHotKey 1409）。
                  不提示的话表现就是"按了没反应"，会被当成播放器的 bug。 */}
              {e.conflict && listening !== e.id && (
                <p className="mt-0.5 text-xs text-destructive">
                  该快捷键已被其它程序占用，当前无效；请点右侧输入框改绑一个组合。
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <input
                readOnly
                value={listening === e.id ? "按下新组合…" : d.key}
                onFocus={() => setListening(e.id)}
                onClick={() => setListening(e.id)}
                onKeyDown={(ev) => {
                  if (ev.key === "Escape") setListening(null);
                }}
                aria-label={`${LABELS[e.id] ?? e.id} 快捷键`}
                className={`w-36 rounded-md border px-2 py-1.5 text-center text-xs outline-none transition-colors ${
                  listening === e.id
                    ? "border-[var(--primary)] ring-2 ring-ring"
                    : "border-input bg-background"
                }`}
              />
              <Switch
                checked={d.enabled}
                onToggle={() =>
                  setDraft((prev) => {
                    // 与渲染处 `draft[e.id] ?? {…}` 同样的兜底：缺项时用 entries 的值，
                    // 否则展开 undefined 会抛 TypeError（再撞上未处理拒绝就整窗报错）
                    const cur = prev[e.id] ?? { key: e.accelerator, enabled: e.enabled };
                    return { ...prev, [e.id]: { ...cur, enabled: !cur.enabled } };
                  })
                }
              />
              {changed && (
                <button
                  type="button"
                  onClick={() =>
                    setDraft((prev) => ({
                      ...prev,
                      [e.id]: { key: e.accelerator, enabled: e.enabled },
                    }))
                  }
                  className="rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  还原
                </button>
              )}
            </div>
          </div>
        );
      })}

      {error && <p className="py-2 text-xs text-destructive">{error}</p>}

      <div className="flex items-center justify-end gap-2 py-3">
        <button
          type="button"
          onClick={() => void reset()}
          disabled={saving}
          className="rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent disabled:opacity-50"
        >
          恢复默认
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !entries.some((e) => {
            const d = draft[e.id];
            return d && (d.key !== e.accelerator || d.enabled !== e.enabled);
          })}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {saving ? "保存中…" : "保存并生效"}
        </button>
      </div>
    </div>
  );
}

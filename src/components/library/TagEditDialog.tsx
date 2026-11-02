import { useCallback, useEffect, useMemo, useState } from "react";
import { Tag } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { Spinner } from "@/components/ui/spinner";
import * as ipc from "@/services/ipc";
import type { Track } from "@/types";

/**
 * 标签编辑弹层（A2，对照分析文档 §4.2）。
 *
 * 两种模式共用一层壳：
 * - **单曲**：打开就把文件里的原值填进表单，「清空某项」= 删掉那个标签；
 * - **批量**：表单留空，**留空 = 不修改** —— 批量场景下不能拿空值把一批歌的
 *   专辑名全抹了，这是与单曲完全相反的口径，所以按模式分别解释输入。
 *
 * 所有写入都由 Rust 侧先落撤销清单再动文件（`tags.rs` + `tag_edits` 表），
 * 因此这里能给出「撤销上次修改」——不只是本次会话，重启后也还在（最近 20 批）。
 */

type TextKey = "title" | "artist" | "album" | "albumArtist" | "genre";
type NumberKey = "year" | "trackNo" | "discNo";
type FieldKey = TextKey | NumberKey;

const TEXT_FIELDS: { key: TextKey; label: string; placeholder: string }[] = [
  { key: "title", label: "标题", placeholder: "歌曲名" },
  { key: "artist", label: "歌手", placeholder: "多位用 / 分隔" },
  { key: "album", label: "专辑", placeholder: "专辑名" },
  { key: "albumArtist", label: "专辑艺人", placeholder: "常用于合辑" },
  { key: "genre", label: "流派", placeholder: "如 流行 / 民谣" },
];

const NUMBER_FIELDS: { key: NumberKey; label: string; placeholder: string }[] = [
  { key: "year", label: "年份", placeholder: "如 2019" },
  { key: "trackNo", label: "音轨号", placeholder: "如 3" },
  { key: "discNo", label: "碟号", placeholder: "如 1" },
];

const EMPTY_FORM: Record<FieldKey, string> = {
  title: "",
  artist: "",
  album: "",
  albumArtist: "",
  genre: "",
  year: "",
  trackNo: "",
  discNo: "",
};

/** 空串 → 0，非数字 → null（拒绝把垃圾写进文件）。 */
function parseIntOrNull(raw: string): number | null {
  const text = raw.trim();
  if (text === "") return 0;
  const n = Number.parseInt(text, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export function TagEditDialog(props: {
  tracks: Track[];
  onClose: () => void;
  /** 保存成功 / 撤销之后刷新列表（曲名、专辑可能已经变了） */
  onChanged?: () => void;
  onError?: (message: string) => void;
}): React.JSX.Element {
  const { tracks, onClose, onChanged, onError } = props;

  // CUE 虚拟分轨的 id 形如 `D:/x.cue#cue:3`，文件是整轨，Rust 侧会拒绝写入。
  const editable = useMemo(() => tracks.filter((t) => !t.id.includes("#cue:")), [tracks]);
  const skipped = tracks.length - editable.length;
  const single = editable.length === 1 ? editable[0] : null;

  const [form, setForm] = useState<Record<FieldKey, string>>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failures, setFailures] = useState<ipc.TagWriteFailure[]>([]);
  const [undoBatch, setUndoBatch] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);

  const setField = useCallback((key: FieldKey, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  // 打开时：拿最近一批「可撤销」，单曲模式再把文件里的原值读出来
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [batch, values] = await Promise.all([
        ipc.lastTagEditBatch().catch(() => null),
        single ? ipc.readLocalTags(single.id) : Promise.resolve(null),
      ]);
      if (!alive) return;
      setUndoBatch(batch);
      if (values) {
        setForm({
          title: values.title,
          artist: values.artist,
          album: values.album,
          albumArtist: values.albumArtist,
          genre: values.genre,
          year: values.year === null ? "" : String(values.year),
          trackNo: values.trackNo === null ? "" : String(values.trackNo),
          discNo: values.discNo === null ? "" : String(values.discNo),
        });
      }
      setLoading(false);
    })().catch((err: unknown) => {
      if (!alive) return;
      setLoading(false);
      const message = single ? errMsg(err) : "读取撤销记录失败";
      setError(message);
      onError?.(message);
    });
    return () => {
      alive = false;
    };
  }, [single, onError]);

  const save = useCallback(async () => {
    if (editable.length === 0) return;
    // 单曲：表单就是原值，空 = 清掉；批量：只有填了的才写
    const patch: ipc.LocalTagPatch = {};
    for (const field of TEXT_FIELDS) {
      const value = form[field.key].trim();
      if (single) patch[field.key] = value;
      else if (value !== "") patch[field.key] = value;
    }
    for (const field of NUMBER_FIELDS) {
      const raw = form[field.key].trim();
      if (!single && raw === "") continue;
      const n = parseIntOrNull(raw);
      if (n === null) {
        const message = `${field.label}必须是数字`;
        setError(message);
        onError?.(message);
        return;
      }
      patch[field.key] = n;
    }
    if (Object.keys(patch).length === 0) {
      const message = "没有填写任何要修改的字段";
      setError(message);
      onError?.(message);
      return;
    }
    setSaving(true);
    setError(null);
    setFailures([]);
    try {
      const summary = await ipc.writeLocalTags(
        editable.map((t) => t.id),
        patch,
      );
      setUndoBatch(summary.batch);
      setFailures(summary.failed);
      if (summary.updated > 0) onChanged?.();
      // 全部成功就关窗；有失败留在窗里让用户看原因
      if (summary.failed.length === 0) onClose();
      else setError(`${summary.failed.length} 首没能写入，见下方原因`);
    } catch (err) {
      const message = errMsg(err);
      setError(message);
      onError?.(message);
    } finally {
      setSaving(false);
    }
  }, [editable, form, onChanged, onClose, onError, single]);

  const undo = useCallback(async () => {
    if (!undoBatch) return;
    setUndoing(true);
    setError(null);
    try {
      const restored = await ipc.undoTagEdit(undoBatch);
      setUndoBatch(null);
      if (restored > 0) onChanged?.();
      onClose();
    } catch (err) {
      const message = errMsg(err);
      setError(message);
      onError?.(message);
    } finally {
      setUndoing(false);
    }
  }, [onChanged, onClose, onError, undoBatch]);

  const hint = single
    ? "文件里的原值已填好；清空某一项 = 删掉这个标签"
    : "只写入填了的字段，留空 = 不修改";

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      icon={<Tag className="h-4 w-4" />}
      title={single ? "编辑标签" : `批量编辑标签（${editable.length} 首）`}
      description={hint}
      closeOnBackdrop={!saving && !undoing}
      footer={
        <>
          {undoBatch ? (
            <Button
              variant="ghost"
              disabled={saving || undoing}
              onClick={() => void undo()}
            >
              {undoing ? "撤销中…" : "撤销上次修改"}
            </Button>
          ) : null}
          <Button variant="outline" disabled={saving || undoing} onClick={onClose}>
            取消
          </Button>
          <Button disabled={saving || undoing || loading || editable.length === 0} onClick={() => void save()}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </>
      }
      footerClassName="justify-end gap-2"
    >
      {loading ? (
        <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
          <Spinner /> 正在读取标签…
        </div>
      ) : (
        <div className="space-y-3">
          {single ? (
            <p className="text-3xs text-muted-foreground">
              {single.title} — {single.singer}
            </p>
          ) : (
            <p className="text-3xs text-muted-foreground">
              会写进每一首选中的歌；不想动的字段留空即可。
            </p>
          )}
          {skipped > 0 ? (
            <p className="text-3xs text-amber-600 dark:text-amber-400">
              已跳过 {skipped} 首 CUE 分轨（整轨标签不能在分轨上改）
            </p>
          ) : null}
          {TEXT_FIELDS.map((field) => (
            <Field key={field.key} label={field.label}>
              <Input
                value={form[field.key]}
                placeholder={field.placeholder}
                disabled={saving}
                onChange={(e) => setField(field.key, e.target.value)}
              />
            </Field>
          ))}
          <div className="grid grid-cols-3 gap-2">
            {NUMBER_FIELDS.map((field) => (
              <Field key={field.key} label={field.label}>
                <Input
                  value={form[field.key]}
                  placeholder={field.placeholder}
                  inputMode="numeric"
                  disabled={saving}
                  onChange={(e) => setField(field.key, e.target.value)}
                />
              </Field>
            ))}
          </div>
          {error ? (
            <p role="alert" className="text-3xs text-destructive">
              {error}
            </p>
          ) : null}
          {failures.length > 0 ? (
            <ul className="max-h-24 space-y-1 overflow-y-auto text-3xs text-destructive">
              {failures.slice(0, 20).map((f) => (
                <li key={f.path}>
                  {f.path}：{f.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

/** tauri invoke 的错误是字符串（Rust 侧 `String`），其它异常兜住对象。 */
function errMsg(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

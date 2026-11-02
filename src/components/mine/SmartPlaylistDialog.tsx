import { useEffect, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { SmartPlaylistMeta, SmartRule, SmartRules } from "@/types";
import * as ipc from "@/services/ipc";
import { Button, Field, Input, Modal, Segmented, Select } from "@/components/ui";
import { errMsg } from "@/lib/utils";

/**
 * 智能歌单规则编辑器（A5，对照分析文档 §4.5）。
 *
 * 交互口径：
 * - **一层 AND / OR，不做嵌套**（分析文档明确把嵌套列为不做）：一行 = 「字段 + 运算符 + 值」，
 *   顶部一个「全部满足 / 任意满足」的开关决定行与行之间是 AND 还是 OR；
 * - 值一律按字符串收，交给后端按字段类型解析；解析不了的条件后端会**忽略**（不报错），
 *   所以这里也不对「流派填了数字」这类输入做过早拦截；
 * - 空行的条件不会提交（用户加了一行又懒得填，不该因此变成一条永远匹配不上的规则）；
 * - 保存即生效：曲目是每次打开现算的，不需要刷新成员。
 *
 * 为什么字段/运算符做成两张静态表而不是让后端下发：规则语言本身是产品约定
 * （分析文档 §4.5 列了九个维度），两边同步的成本低于一次 IPC 往返，而且
 * 前端的标签文案本来就只能在前端写。
 */

type FieldKind = "text" | "number" | "days" | "bool";

interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  /** 数值字段的单位说明，拼在标签后面 */
  unit?: string;
  /** 值输入框的占位文案 */
  placeholder: string;
}

const FIELDS: FieldDef[] = [
  { key: "genre", label: "流派", kind: "text", placeholder: "如 摇滚" },
  { key: "year", label: "年份", kind: "number", placeholder: "如 2010" },
  { key: "bpm", label: "BPM", kind: "number", placeholder: "如 128（只认标签里有的）" },
  { key: "rating", label: "我的评分", kind: "number", placeholder: "1–5" },
  { key: "playCount", label: "播放次数", kind: "number", placeholder: "如 10" },
  { key: "bitrate", label: "码率", kind: "number", unit: "kbps", placeholder: "如 320" },
  { key: "duration", label: "时长", kind: "number", unit: "秒", placeholder: "如 240" },
  { key: "lastPlayed", label: "最近播放", kind: "days", unit: "天", placeholder: "如 30" },
  { key: "added", label: "加入曲库", kind: "days", unit: "天", placeholder: "如 7" },
  { key: "liked", label: "是否收藏", kind: "bool", placeholder: "" },
  { key: "title", label: "歌名", kind: "text", placeholder: "包含的文字" },
  { key: "singer", label: "歌手", kind: "text", placeholder: "包含的文字" },
  { key: "album", label: "专辑", kind: "text", placeholder: "包含的文字" },
  { key: "format", label: "格式", kind: "text", placeholder: "如 flac" },
];

const OPS: Record<FieldKind, { key: string; label: string }[]> = {
  text: [
    { key: "contains", label: "包含" },
    { key: "not_contains", label: "不包含" },
    { key: "is", label: "等于" },
    { key: "is_not", label: "不等于" },
  ],
  number: [
    { key: "gte", label: "不小于 ≥" },
    { key: "lte", label: "不大于 ≤" },
    { key: "eq", label: "等于 =" },
  ],
  days: [
    { key: "within", label: "在最近 N 天内" },
    { key: "older_than", label: "超过 N 天" },
  ],
  bool: [{ key: "is", label: "是" }],
};

const SORTS = [
  { key: "added_desc", label: "最近加入的在前" },
  { key: "added_asc", label: "最早加入的在前" },
  { key: "title", label: "按歌名" },
  { key: "singer", label: "按歌手" },
  { key: "album", label: "按专辑" },
  { key: "play_count", label: "播放最多的在前" },
  { key: "last_played", label: "最近播放的在前" },
  { key: "rating", label: "评分高的在前" },
  { key: "random", label: "随机" },
];

function fieldDef(key: string): FieldDef {
  return FIELDS.find((f) => f.key === key) ?? FIELDS[0];
}

interface RuleRow {
  /** 行标识（只用做 React key，换了字段也不重置输入框） */
  id: number;
  field: string;
  op: string;
  value: string;
}

function rowFrom(rule: SmartRule, id: number): RuleRow {
  return { id, field: rule.field, op: rule.op, value: rule.value };
}

/** 把规则渲染成一句人话（详情页顶部提示条用）。空规则 = 整个曲库。 */
export function describeRules(rules: SmartRules, limit?: number | null): string {
  if (rules.rules.length === 0) {
    return `整个曲库${limit ? `（取前 ${limit} 首）` : ""}`;
  }
  const parts = rules.rules.map((r) => {
    const def = fieldDef(r.field);
    const rawOp = (OPS[def.kind].find((o) => o.key === r.op) ?? { label: r.op }).label;
    // 描述句里去掉为下拉框好认而加的修饰：「我的评分」→「评分」、「不小于 ≥」→「不小于」
    const label = def.label.replace(/^我的/, "");
    if (def.kind === "bool") return `${label} ${r.value === "false" ? "否" : "是"}`;
    if (def.kind === "days") return `${label}${rawOp.replace("N", r.value)}`;
    const unit = def.unit ? ` ${def.unit}` : "";
    if (def.kind === "text") return `${label}${rawOp}「${r.value}」`;
    return `${label}${rawOp.replace(/[=≥≤]\s*$/, "").trim()} ${r.value}${unit}`;
  });
  return parts.join(rules.matchAll ? " 且 " : " 或 ");
}

/**
 * 新建 / 编辑智能歌单。
 *
 * `playlist` 传了就进编辑态（挂载时读规则）；不传是新建态。
 */
export function SmartPlaylistDialog(props: {
  /** 编辑既有智能歌单：`{ pid, name }` */
  playlist?: { pid: string; name: string } | null;
  onClose: () => void;
  /** 保存成功后回调（父组件据此刷新列表 / 跳转） */
  onSaved?: (pid: string) => void;
  onError?: (message: string) => void;
}): React.JSX.Element {
  const editing = props.playlist ?? null;
  const [name, setName] = useState(editing?.name ?? "");
  const [matchAll, setMatchAll] = useState(true);
  const [rows, setRows] = useState<RuleRow[]>([{ id: 0, field: "genre", op: "contains", value: "" }]);
  const [limit, setLimit] = useState("");
  const [sort, setSort] = useState("added_desc");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(Boolean(editing));
  const nextId = useRef(1);

  const newRow = (field = "genre", op = "contains", value = ""): RuleRow => {
    const id = nextId.current;
    nextId.current += 1;
    return { id, field, op, value };
  };

  // 编辑态：读回已有规则
  useEffect(() => {
    if (!editing) return;
    let cancelled = false;
    void ipc
      .getSmartPlaylist(editing.pid)
      .then((meta: SmartPlaylistMeta | null) => {
        if (cancelled || !meta) return;
        setMatchAll(meta.rules.matchAll);
        const list = meta.rules.rules;
        setRows(list.length === 0 ? [newRow()] : list.map((r) => rowFrom(r, nextId.current++)));
        setLimit(meta.limit === null ? "" : String(meta.limit));
        setSort(meta.sort);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(`读取规则失败：${errMsg(err)}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // 只在打开时读一次；newRow 只动 ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.pid]);

  const changeField = (rowId: number, field: string): void => {
    const def = fieldDef(field);
    setRows((prev) =>
      prev.map((r) =>
        r.id === rowId
          ? {
              ...r,
              field,
              // 换了字段类型，运算符与值都得跟着换，否则会留下 "流派 不小于 4" 这种组合
              op: OPS[def.kind][0].key,
              value: def.kind === "bool" ? "true" : "",
            }
          : r,
      ),
    );
  };

  const save = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("给歌单起个名字");
      return;
    }
    setSaving(true);
    setError(null);
    const rules: SmartRules = {
      matchAll,
      rules: rows
        // 空值行不提交：加了一行没填等于没加这个条件
        .filter((r) => {
          const def = fieldDef(r.field);
          return def.kind === "bool" ? true : r.value.trim() !== "";
        })
        .map((r) => ({ field: r.field, op: r.op, value: r.value.trim() })),
    };
    const limitValue = limit.trim() === "" ? null : Number.parseInt(limit, 10);
    const safeLimit = limitValue === null || Number.isNaN(limitValue) ? null : Math.min(Math.max(limitValue, 1), 5000);
    try {
      let pid = editing?.pid ?? "";
      if (editing) {
        await ipc.updateSmartPlaylist(editing.pid, rules, safeLimit, sort);
        if (trimmed !== editing.name) await ipc.renamePlaylist(editing.pid, trimmed);
      } else {
        pid = await ipc.createSmartPlaylist(trimmed, rules, safeLimit, sort);
      }
      props.onSaved?.(pid);
      props.onClose();
    } catch (err) {
      const message = errMsg(err);
      setError(message);
      props.onError?.(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={props.onClose}
      title={editing ? "编辑智能歌单" : "新建智能歌单"}
      description="按条件自动收集曲目：每次打开都重新筛选，新加入的歌、刚打的评分会立刻反映进来。"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving || loading}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 px-5 py-4">
        <Field label="歌单名称" required>
          <Input
            autoFocus
            value={name}
            placeholder="如 我的摇滚五星"
            onChange={(e) => setName(e.target.value)}
            disabled={loading}
          />
        </Field>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">条件之间</span>
          <Segmented<"all" | "any">
            label="条件之间的关系"
            value={matchAll ? "all" : "any"}
            options={[
              { value: "all", label: "全部满足" },
              { value: "any", label: "任意满足" },
            ]}
            onChange={(next) => setMatchAll(next === "all")}
          />
        </div>

        <div className="flex flex-col gap-2">
          {rows.map((row, index) => {
            const def = fieldDef(row.field);
            const ops = OPS[def.kind];
            return (
              <div key={row.id} className="flex items-end gap-2">
                <span className="w-6 pb-2 text-right text-xs text-muted-foreground">{index + 1}.</span>
                <div className="w-36">
                  <Select
                    aria-label={`第 ${index + 1} 个条件的字段`}
                    value={row.field}
                    onChange={(e) => changeField(row.id, e.target.value)}
                  >
                    {FIELDS.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.unit ? `${f.label}（${f.unit}）` : f.label}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="w-36">
                  <Select
                    aria-label={`第 ${index + 1} 个条件的运算符`}
                    value={row.op}
                    onChange={(e) =>
                      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, op: e.target.value } : r)))
                    }
                  >
                    {ops.map((o) => (
                      <option key={o.key} value={o.key}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="min-w-0 flex-1">
                  {def.kind === "bool" ? (
                    <Select
                      aria-label={`第 ${index + 1} 个条件的值`}
                      value={row.value || "true"}
                      onChange={(e) =>
                        setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, value: e.target.value } : r)))
                      }
                    >
                      <option value="true">是（已收藏）</option>
                      <option value="false">否（未收藏）</option>
                    </Select>
                  ) : (
                    <Input
                      aria-label={`第 ${index + 1} 个条件的值`}
                      inputMode={def.kind === "text" ? undefined : "numeric"}
                      placeholder={def.placeholder}
                      value={row.value}
                      onChange={(e) =>
                        setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, value: e.target.value } : r)))
                      }
                    />
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`删除第 ${index + 1} 个条件`}
                  disabled={rows.length <= 1}
                  onClick={() => setRows((prev) => prev.filter((r) => r.id !== row.id))}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            );
          })}
          <div>
            <Button variant="outline" size="sm" onClick={() => setRows((prev) => [...prev, newRow()])}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              添加条件
            </Button>
          </div>
        </div>

        <div className="flex gap-3">
          <Field label="最多多少首" hint="留空 = 不限（上限 5000）" className="w-40">
            <Input
              inputMode="numeric"
              placeholder="不限"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
            />
          </Field>
          <Field label="排序" className="w-48">
            <Select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="智能歌单排序">
              {SORTS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <p className="text-xs text-muted-foreground">
          当前规则：{describeRules({ matchAll, rules: rows.map((r) => ({ field: r.field, op: r.op, value: r.value })) })}
        </p>

        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

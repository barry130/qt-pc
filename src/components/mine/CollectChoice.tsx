import { useState } from "react";
import { Button, Checkbox } from "@/components/ui";
import { useSourceLabelFn } from "@/stores/sourceRegistry";
import { collectKey, resolveCollectChoice, type CollectChoicePlan } from "@/lib/collect-choice";

/** Embedded in the existing collection popover: no second modal/dismissal stack. */
export function CollectChoice({ plan, busy, onSave, onCancel }: {
  plan: CollectChoicePlan; busy: boolean;
  onSave: (plan: CollectChoicePlan) => void; onCancel: () => void;
}): React.JSX.Element {
  const sourceLabel = useSourceLabelFn();
  const [selected, setSelected] = useState(() => plan.groups.flatMap(g => g.existingKeys.length ? g.existingKeys : [collectKey(g.songs[0])]));
  const valid = plan.groups.every(g => g.songs.some(t => selected.includes(collectKey(t))));
  return <div className="border-t border-border p-2" data-testid="collect-choice">
    <p className="mb-2 text-xs leading-relaxed">选择保留的歌曲。未勾选的已有版本只从此歌单移除，每组至少保留一个。</p>
    <div className="max-h-72 overflow-y-auto">
      {plan.groups.map((g, index) => <fieldset key={g.id} className="mb-3 min-w-0 space-y-1">
        <legend className="text-2xs text-muted-foreground">重复组 {index + 1} · {g.songs.length} 个版本</legend>
        {g.songs.map(t => <label key={collectKey(t)} className="flex cursor-pointer items-start gap-2 rounded px-1 py-2 hover:bg-secondary">
          <Checkbox disabled={busy} checked={selected.includes(collectKey(t))} onChange={() => setSelected(prev => prev.includes(collectKey(t)) ? prev.filter(k => k !== collectKey(t)) : [...prev, collectKey(t)])} className="mt-1" />
          <span className="min-w-0 text-xs"><span className="block break-words">{t.title}</span><span className="block break-words text-2xs text-muted-foreground">{t.singer} · {sourceLabel(t.platform)} · {t.album}{t.duration > 0 ? ` · ${Math.floor(t.duration / 60)}:${String(Math.floor(t.duration % 60)).padStart(2, "0")}` : ""} · {g.existingKeys.includes(collectKey(t)) ? "已在歌单" : "待收藏"}</span></span>
        </label>)}
      </fieldset>)}
    </div>
    <div className="flex justify-end gap-2"><Button disabled={busy} variant="outline" onClick={onCancel}>取消</Button><Button disabled={busy || !valid} variant="primary" onClick={() => onSave(resolveCollectChoice(plan, selected))}>保存选择</Button></div>
  </div>;
}

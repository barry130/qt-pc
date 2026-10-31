import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import {
  Bot,
  Brain,
  Check,
  ChevronLeft,
  Cloud,
  Copy,
  Cpu,
  Database,
  Image as ImageIcon,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Wand2,
  X,
  Zap,
} from "lucide-react";
import * as ipc from "@/services/ipc";
import type {
  AiLocalConfigView,
  AiProfileInput,
  AiProfileView,
  AiProviderProtocol,
} from "@/types";
import { errMsg } from "@/lib/utils";
import { toast, toastError, toastSuccess } from "@/stores/toast";
import { Modal } from "@/components/ui";
import { Spinner } from "@/components/ui";

/**
 * AI 供应商的主从配置（2026-10-24，用户要求按截图改造「接口配置」）：
 * - 列表 = 外面只看到供应商名 / 地址 / 模型数 / 掩码 Key / 是否生效，点一行进详情；
 * - 详情 = 名称、ID、Base URL + 协议、账号密钥（第一把生效）、图标、跳过证书校验、模型多选；
 * - 数据仍走 `ipc.aiLocal*`，字段见 `AiProfileView` / `AiProfileInput`（Rust 侧 `ai_local.rs`）。
 */

const PROTOCOL_OPTIONS: { value: AiProviderProtocol; label: string }[] = [
  { value: "openai", label: "OpenAI 兼容" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic", label: "Anthropic 兼容" },
  { value: "gemini", label: "Gemini 兼容" },
];

const PROTOCOL_LABEL: Record<AiProviderProtocol, string> = {
  openai: "OpenAI 兼容",
  "openai-responses": "OpenAI Responses",
  anthropic: "Anthropic 兼容",
  gemini: "Gemini 兼容",
};

/** 内置图标：名字存进 `AiProfileView.icon`，前端按名字渲染（不落 SVG 字符串） */
const ICON_CHOICES: { name: string; label: string; Icon: typeof Sparkles }[] = [
  { name: "sparkles", label: "星芒", Icon: Sparkles },
  { name: "bot", label: "机器人", Icon: Bot },
  { name: "zap", label: "闪电", Icon: Zap },
  { name: "brain", label: "大脑", Icon: Brain },
  { name: "cloud", label: "云", Icon: Cloud },
  { name: "cpu", label: "芯片", Icon: Cpu },
  { name: "wand", label: "魔杖", Icon: Wand2 },
  { name: "database", label: "数据库", Icon: Database },
];

const ICON_BY_NAME = new Map(ICON_CHOICES.map((item) => [item.name, item.Icon]));

const INPUT_CLASS =
  "h-8 w-full rounded-lg border border-input bg-background px-2.5 text-xs outline-none transition-colors focus:border-primary/60";
const LABEL_CLASS = "text-2xs font-medium text-muted-foreground";
const GHOST_BUTTON_CLASS =
  "inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY_BUTTON_CLASS =
  "inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60";
const DANGER_BUTTON_CLASS =
  "inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50";

function letterOf(profile: Pick<AiProfileView, "name" | "baseUrl">): string {
  const source = profile.name.trim() || profile.baseUrl.trim();
  return (Array.from(source)[0] ?? "A").toUpperCase();
}

function maskOf(profile: AiProfileView): string {
  return profile.keyMask || (profile.hasKey ? "已保存" : "");
}

/** 列表行里的一行文字，避免 null/undefined 拼进字符串 */
function textOf(value: string | null | undefined): string {
  return value ?? "";
}

interface EditingDraft {
  isNew: boolean;
  id: string;
  name: string;
  baseUrl: string;
  protocol: AiProviderProtocol;
  models: string[];
  icon: string;
  skipCertVerify: boolean;
  /** 已存的 Key 掩码（原顺序；第 1 把生效） */
  keyMasks: string[];
  /** 待删除的已存 Key 下标（相对原顺序） */
  removedKeyIndexes: number[];
  /** 待追加的 Key 明文 */
  pendingKeys: string[];
  /** 已存 Key 里想置顶的下标（= 设为使用中；0 表示不变） */
  activeKeyIndex: number | null;
  /** 新输入的一把 Key（保存在 apiKey 字段里，覆盖/新增都由它触发） */
  keyDraft: string;
  /** 显式清除已保存的全部 Key */
  clearSavedKey: boolean;
  /** 从接口拉回来的模型（「供应商列表」tab 用） */
  vendorModels: string[] | null;
}

function toInput(profile: AiProfileView): AiProfileInput {
  return {
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    protocol: profile.protocol,
    model: profile.model,
    models: [...profile.models],
    icon: profile.icon,
    skipCertVerify: profile.skipCertVerify,
  };
}

function draftFromView(profile: AiProfileView): EditingDraft {
  return {
    isNew: false,
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    protocol: profile.protocol,
    models: [...profile.models],
    icon: profile.icon,
    skipCertVerify: profile.skipCertVerify,
    keyMasks: [...profile.keyMasks],
    removedKeyIndexes: [],
    pendingKeys: [],
    activeKeyIndex: null,
    keyDraft: "",
    clearSavedKey: false,
    vendorModels: null,
  };
}

function emptyDraft(): EditingDraft {
  return {
    isNew: true,
    id: "",
    name: "新供应商",
    baseUrl: "https://api.openai.com/v1",
    protocol: "openai",
    models: [],
    icon: "",
    skipCertVerify: false,
    keyMasks: [],
    removedKeyIndexes: [],
    pendingKeys: [],
    activeKeyIndex: null,
    keyDraft: "",
    clearSavedKey: false,
    vendorModels: null,
  };
}

/** 开关：尺寸与动效跟设置页其它分区的开关保持一致（`SettingsPage` 里的 Switch），
 * 关键是「关在左、开在右」——用 `left-*` 明确给出两个端点，别用 translate 叠加静态位置。 */
function SwitchButton(props: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}): JSX.Element {
  const { checked, onChange, label } = props;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
        checked ? "bg-primary" : "bg-muted-foreground/30"
      }`}
    >
      <span
        className={`absolute top-[0.125rem] h-4 w-4 rounded-full bg-background shadow transition-[left,transform] duration-base ${
          checked ? "left-[1.125rem]" : "left-[0.125rem]"
        }`}
      />
    </button>
  );
}

function IconBadge(props: { icon: string; name: string; baseUrl: string }): JSX.Element {
  const { icon, name, baseUrl } = props;
  if (icon.startsWith("data:")) {
    return (
      <img
        src={icon}
        alt=""
        className="h-7 w-7 shrink-0 rounded-md bg-secondary object-cover ring-1 ring-border"
      />
    );
  }
  const Icon = ICON_BY_NAME.get(icon);
  if (Icon) {
    return (
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground ring-1 ring-border">
        <Icon className="h-4 w-4" />
      </span>
    );
  }
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-secondary text-xs font-medium text-muted-foreground ring-1 ring-border">
      {letterOf({ name, baseUrl })}
    </span>
  );
}

/**
 * AI 供应商列表 + 详情。自己被 `SettingsPage` 的 AiSection 内联进「AI 配置」那一行，
 * 不自己管理 AI 模式 / 推荐口味（那些仍由设置页管）。
 */
export function AiProvidersPanel(): JSX.Element {
  const [view, setView] = useState<AiLocalConfigView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [checking, setChecking] = useState(false);
  /** 「测试连接」的结果就地显示在详情页标题行（不放浮层——用户要能一直看着它） */
  const [checkNote, setCheckNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [filter, setFilter] = useState("");
  const [draft, setDraft] = useState<EditingDraft | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const applyView = useCallback((next: AiLocalConfigView | null) => {
    if (alive.current) setView(next);
  }, []);

  const reload = useCallback(async (): Promise<AiLocalConfigView | null> => {
    try {
      const next = await ipc.aiLocalConfig();
      applyView(next);
      return next;
    } catch (err) {
      toastError(`读取 AI 配置失败：${errMsg(err)}`);
      return null;
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [applyView]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const profiles = useMemo(() => view?.profiles ?? [], [view]);
  const filtered = useMemo(() => {
    const keyword = filter.trim().toLowerCase();
    if (!keyword) return profiles;
    return profiles.filter((profile) =>
      [profile.name, profile.baseUrl, profile.model, profile.id]
        .join(" ")
        .toLowerCase()
        .includes(keyword),
    );
  }, [filter, profiles]);

  const patchDraft = useCallback((patch: Partial<EditingDraft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    // 改了任何字段，上一次「测试连接」的结论就过期了（用户看着标题行，别留旧结论）
    setCheckNote(null);
  }, []);

  const buildInput = useCallback((current: EditingDraft): AiProfileInput => {
    const visibleKeys = current.keyMasks.filter(
      (_, index) => !current.removedKeyIndexes.includes(index),
    );
    const input: AiProfileInput = {
      id: current.id,
      name: current.name.trim(),
      baseUrl: current.baseUrl.trim(),
      protocol: current.protocol,
      model: current.models[0] ?? "",
      models: [...current.models],
      icon: current.icon,
      skipCertVerify: current.skipCertVerify,
    };
    if (current.pendingKeys.length > 0) input.addKeys = [...current.pendingKeys];
    if (current.removedKeyIndexes.length > 0) {
      input.removeKeyIndexes = [...current.removedKeyIndexes];
    }
    if (
      current.activeKeyIndex !== null &&
      current.removedKeyIndexes.length === 0 &&
      visibleKeys.length > 0
    ) {
      input.activeKeyIndex = current.activeKeyIndex;
    }
    if (current.keyDraft.trim()) input.apiKey = current.keyDraft.trim();
    if (current.clearSavedKey) input.apiKey = "";
    return input;
  }, []);

  const saveDraft = useCallback(async (): Promise<void> => {
    if (!draft || saving) return;
    if (!draft.baseUrl.trim()) {
      toastError("请先填写 Base URL");
      return;
    }
    setSaving(true);
    try {
      const input = buildInput(draft);
      const inputs = profiles.map((profile) =>
        profile.id === draft.id ? input : toInput(profile),
      );
      if (draft.isNew) inputs.push(input);
      // 新供应商保存后让它生效；改已有的保持原来的生效项
      const nextActive = draft.isNew ? draft.id : (view?.activeId ?? "");
      const saved = await ipc.aiLocalSaveConfig(inputs, nextActive);
      applyView(saved);
      if (draft.isNew) {
        const created = saved.profiles.find(
          (profile) => !profiles.some((old) => old.id === profile.id),
        );
        if (created && saved.activeId !== created.id) {
          const activated = await ipc.aiLocalSaveConfig(
            saved.profiles.map(toInput),
            created.id,
          );
          applyView(activated);
        }
      }
      toastSuccess("AI 配置已保存");
      setDraft(null);
    } catch (err) {
      toastError(`保存失败：${errMsg(err)}`);
    } finally {
      if (alive.current) setSaving(false);
    }
  }, [applyView, buildInput, draft, profiles, saving, view?.activeId]);

  const removeDraft = useCallback(async (): Promise<void> => {
    if (!draft || saving) return;
    if (draft.isNew) {
      setDraft(null);
      return;
    }
    if (profiles.length <= 1) {
      toast("至少要保留一个供应商");
      return;
    }
    setSaving(true);
    try {
      const remain = profiles.filter((profile) => profile.id !== draft.id);
      const saved = await ipc.aiLocalSaveConfig(
        remain.map(toInput),
        view?.activeId === draft.id ? (remain[0]?.id ?? "") : (view?.activeId ?? ""),
      );
      applyView(saved);
      toastSuccess("已移除该供应商");
      setDraft(null);
    } catch (err) {
      toastError(`移除失败：${errMsg(err)}`);
    } finally {
      if (alive.current) setSaving(false);
    }
  }, [applyView, draft, profiles, saving, view?.activeId]);

  const duplicateDraft = useCallback(() => {
    if (!draft) return;
    const base = draft.name.trim() || "供应商";
    setDraft({
      ...draft,
      isNew: true,
      id: "",
      name: `${base} 副本`,
      pendingKeys: [],
      keyMasks: [],
      removedKeyIndexes: [],
      activeKeyIndex: null,
      keyDraft: "",
      clearSavedKey: false,
      vendorModels: null,
    });
  }, [draft]);

  const setActive = useCallback(
    async (profile: AiProfileView): Promise<void> => {
      if (!view || view.activeId === profile.id) return;
      try {
        const saved = await ipc.aiLocalSaveConfig(
          view.profiles.map(toInput),
          profile.id,
        );
        applyView(saved);
        toastSuccess(`已切换到「${profile.name || profile.baseUrl}」`);
      } catch (err) {
        toastError(`切换失败：${errMsg(err)}`);
      }
    },
    [applyView, view],
  );

  const fetchModels = useCallback(async (): Promise<void> => {
    if (!draft || fetchingModels) return;
    setFetchingModels(true);
    try {
      const names = await ipc.aiLocalListModels(
        draft.baseUrl.trim(),
        draft.keyDraft.trim() || undefined,
        draft.protocol,
        draft.skipCertVerify,
      );
      patchDraft({ vendorModels: names });
      if (names.length === 0) toast("接口没返回任何模型");
    } catch (err) {
      toastError(`获取模型失败：${errMsg(err)}`);
    } finally {
      if (alive.current) setFetchingModels(false);
    }
  }, [draft, fetchingModels, patchDraft]);

  const detectProtocol = useCallback(async (): Promise<void> => {
    if (!draft || testing) return;
    const baseUrl = draft.baseUrl.trim();
    if (!baseUrl) {
      toastError("请先填写 Base URL");
      return;
    }
    setTesting(true);
    try {
      const model = draft.models[0] ?? "";
      // 四路并发探测，再按 PROTOCOL_OPTIONS 原优先级取首个成功项：
      // 串行时最坏要吃满 4 次超时，并发后总耗时≈单次超时，优先级语义不变。
      const results = await Promise.all(
        PROTOCOL_OPTIONS.map((option) =>
          ipc
            .aiLocalTest(
              baseUrl,
              model,
              draft.keyDraft.trim() || undefined,
              option.value,
              draft.skipCertVerify,
            )
            .then((r) => (r.ok ? option.value : null))
            .catch(() => null),
        ),
      );
      const matched: AiProviderProtocol | null =
        results.find((v): v is AiProviderProtocol => v !== null) ?? null;
      if (matched) {
        patchDraft({ protocol: matched });
        toastSuccess(`协议检测通过：${PROTOCOL_LABEL[matched]}`);
      } else {
        toastError("四种协议都没连通，检查地址 / Key / 网络");
      }
    } finally {
      if (alive.current) setTesting(false);
    }
  }, [draft, patchDraft, testing]);

  /**
   * 「测试连接」：用表单里的值发一句「你好」，把成功/失败都讲清楚。
   * 与「检测协议」的区别——检测协议是四路并发猜协议、只回一句通不通；
   * 这里用**当前选中的协议**真发一次请求，成功回耗时与模型回复片段，
   * 失败回具体原因（401 是 Key 不对、404 多半是 Base URL 少了 /v1），
   * 让用户不用保存就能确认这套配置能不能用。
   */
  const checkConnect = useCallback(async (): Promise<void> => {
    if (!draft || checking) return;
    const baseUrl = draft.baseUrl.trim();
    if (!baseUrl) {
      toastError("请先填写 Base URL");
      return;
    }
    const model = draft.models[0] ?? "";
    if (!model) {
      toastError("请先选一个模型，或点「获取列表」拉取");
      return;
    }
    setChecking(true);
    try {
      const result = await ipc.aiLocalTest(
        baseUrl,
        model,
        draft.keyDraft.trim() || undefined,
        draft.protocol,
        draft.skipCertVerify,
      );
      if (!alive.current) return;
      if (result.ok) {
        const reply = (result.reply ?? "").trim().replace(/\s+/g, " ");
        const head = `连接正常 · ${model} · ${result.elapsedMs}ms`;
        setCheckNote({
          ok: true,
          text: reply.length > 0 ? `${head} · 回复：${reply}` : head,
        });
      } else {
        setCheckNote({ ok: false, text: `连接失败：${result.error ?? "未知错误"}` });
      }
    } catch (err) {
      if (alive.current) setCheckNote({ ok: false, text: `连接失败：${errMsg(err)}` });
    } finally {
      if (alive.current) setChecking(false);
    }
  }, [checking, draft]);

  const pickIconFile = useCallback(
    (file: File | null) => {
      if (!file) return;
      if (file.size > 512 * 1024) {
        toastError("图标图片不要超过 512KB");
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const data = typeof reader.result === "string" ? reader.result : "";
        if (data.startsWith("data:")) patchDraft({ icon: data });
      };
      reader.readAsDataURL(file);
    },
    [patchDraft],
  );

  const toggleModel = useCallback(
    (name: string) => {
      setDraft((current) => {
        if (!current) return current;
        const next = current.models.includes(name)
          ? current.models.filter((item) => item !== name)
          : [...current.models, name];
        return { ...current, models: next };
      });
    },
    [],
  );

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
        <Spinner size="sm" className="h-3.5 w-3.5" />
        正在读取 AI 配置…
      </div>
    );
  }

  if (!draft) {
    return (
      <div className="flex flex-col gap-2 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium">供应商</span>
          <span className="flex items-center gap-1.5">
            <span className="relative inline-flex items-center">
              <Search className="pointer-events-none absolute left-2 h-3 w-3 text-muted-foreground" />
              <input
                type="text"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="查找供应商"
                className="h-7 w-40 rounded-md border border-input bg-background pl-7 pr-2 text-xs outline-none transition-colors focus:border-primary/60"
              />
            </span>
            <button
              type="button"
              onClick={() => setDraft(emptyDraft())}
              className={PRIMARY_BUTTON_CLASS}
            >
              <Plus className="h-3.5 w-3.5" />
              添加供应商
            </button>
          </span>
        </div>

        <ul className="flex flex-col overflow-hidden rounded-xl border border-border">
          {filtered.length === 0 ? (
            <li className="px-3 py-6 text-center text-xs text-muted-foreground">
              {profiles.length === 0
                ? "还没有配置供应商，点右上角「添加供应商」开始"
                : "没有匹配的供应商"}
            </li>
          ) : (
            filtered.map((profile) => {
              const active = view?.activeId === profile.id;
              return (
                <li key={profile.id} className="border-b border-border last:border-b-0">
                  <div className="flex items-center gap-2.5 px-3 py-2 transition-colors hover:bg-secondary/40">
                    <span className="text-muted-foreground/40" aria-hidden>
                      ⋮⋮
                    </span>
                    <IconBadge icon={profile.icon} name={profile.name} baseUrl={profile.baseUrl} />
                    <button
                      type="button"
                      onClick={() => setDraft(draftFromView(profile))}
                      className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
                    >
                      <span className="flex w-full items-center gap-1.5">
                        <span className="truncate text-sm font-medium">
                          {profile.name || profile.baseUrl}
                        </span>
                        <span className="shrink-0 text-2xs text-muted-foreground">
                          {textOf(profile.baseUrl)}
                        </span>
                      </span>
                      <span className="flex items-center gap-2 text-2xs text-muted-foreground">
                        <span>{profile.models.length} 个模型</span>
                        {maskOf(profile) ? (
                          <span className="truncate font-mono text-3xs">{maskOf(profile)}</span>
                        ) : (
                          <span>未设 Key</span>
                        )}
                        <span>{PROTOCOL_LABEL[profile.protocol]}</span>
                      </span>
                    </button>
                    <SwitchButton
                      checked={active}
                      onChange={() => void setActive(profile)}
                      label={active ? "正在使用" : "设为使用中"}
                    />
                    <button
                      type="button"
                      onClick={() => setDraft(draftFromView(profile))}
                      className="rounded p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                      aria-label={`配置 ${profile.name || profile.baseUrl}`}
                    >
                      <ChevronLeft className="h-4 w-4 rotate-180" />
                    </button>
                  </div>
                </li>
              );
            })
          )}
        </ul>
      </div>
    );
  }

  const visibleKeys = draft.keyMasks
    .map((mask, index) => ({ mask, index }))
    .filter((item) => !draft.removedKeyIndexes.includes(item.index));
  const vendorModels = draft.vendorModels ?? [];
  const modelChoices = vendorModels.length > 0 ? vendorModels : draft.models;

  return (
    <div className="flex flex-col gap-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setDraft(null)}
          className={GHOST_BUTTON_CLASS}
        >
          <ChevronLeft className="h-4 w-4" />
          返回
        </button>
        {/* 测试连接的结论就地留在这行（用户要能一直看着它，浮层几秒就飘走了）。
            不再放「编辑「某某」」标题：名称下面输入框里就有，重复且占地方。 */}
        <span className="flex min-w-0 items-center">
          {checking ? (
            <span className="flex items-center gap-1 text-3xs text-muted-foreground">
              <Spinner size="xs" className="h-2.5 w-2.5" />
              正在测试连接…
            </span>
          ) : checkNote ? (
            <span
              role={checkNote.ok ? "status" : "alert"}
              title={checkNote.text}
              className={`flex max-w-[26rem] items-center gap-1 text-3xs ${
                checkNote.ok ? "text-success" : "text-destructive"
              }`}
            >
              {checkNote.ok ? (
                <Check className="h-2.5 w-2.5 shrink-0" strokeWidth={3} />
              ) : (
                <X className="h-2.5 w-2.5 shrink-0" strokeWidth={3} />
              )}
              <span className="truncate">{checkNote.text}</span>
            </span>
          ) : null}
        </span>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-border p-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className={LABEL_CLASS}>名称</span>
            <input
              type="text"
              value={draft.name}
              onChange={(event) => patchDraft({ name: event.target.value })}
              placeholder="例如 官方 / 中转 / 本机"
              spellCheck={false}
              className={INPUT_CLASS}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className={LABEL_CLASS}>ID</span>
            <input
              type="text"
              value={draft.id}
              readOnly
              placeholder="保存后自动生成"
              spellCheck={false}
              className={`${INPUT_CLASS} font-mono text-muted-foreground`}
            />
          </label>
        </div>

        <div className="flex flex-col gap-1">
          <span className={LABEL_CLASS}>Base URL</span>
          <div className="flex flex-wrap gap-1.5">
            {PROTOCOL_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => patchDraft({ protocol: option.value })}
                className={`inline-flex h-7 items-center rounded-md border px-2 text-2xs transition-colors ${
                  draft.protocol === option.value
                    ? "border-primary/60 bg-secondary text-foreground"
                    : "border-transparent bg-secondary/40 text-muted-foreground hover:bg-secondary"
                }`}
              >
                {option.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => void detectProtocol()}
              disabled={testing}
              className={GHOST_BUTTON_CLASS}
            >
              {testing ? <Spinner size="xs" className="h-3 w-3" /> : null}
              检测协议
            </button>
          </div>
          <input
            type="text"
            value={draft.baseUrl}
            onChange={(event) => patchDraft({ baseUrl: event.target.value })}
            placeholder="https://api.openai.com/v1"
            spellCheck={false}
            className={`${INPUT_CLASS} font-mono`}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <span className={LABEL_CLASS}>账号 · 密钥（第一把生效）</span>
          {visibleKeys.map((item) => {
            const active = item.index === 0 && draft.removedKeyIndexes.length === 0;
            return (
              <div
                key={`key-${item.index}`}
                className="flex items-center gap-2 rounded-md border border-border px-2 py-1"
              >
                <span className="flex-1 truncate font-mono text-2xs text-muted-foreground">
                  {item.mask || "空 Key"}
                </span>
                {active ? (
                  <span className="rounded bg-secondary px-1.5 py-0.5 text-3xs text-muted-foreground">
                    使用中
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => patchDraft({ activeKeyIndex: item.index })}
                    className="text-2xs text-muted-foreground transition-colors hover:text-foreground"
                  >
                    设为使用中
                  </button>
                )}
                <button
                  type="button"
                  onClick={() =>
                    patchDraft({
                      removedKeyIndexes: [...draft.removedKeyIndexes, item.index],
                    })
                  }
                  className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  aria-label="删除这把 Key"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            );
          })}
          {draft.pendingKeys.map((key, index) => (
            <div
              key={`pending-${index}`}
              className="flex items-center gap-2 rounded-md border border-dashed border-border px-2 py-1"
            >
              <span className="flex-1 truncate font-mono text-2xs text-muted-foreground">
                {key.length <= 4 ? "••••" : `••••••${key.slice(-2)}`}
              </span>
              <span className="rounded bg-secondary px-1.5 py-0.5 text-3xs text-muted-foreground">
                待保存
              </span>
              <button
                type="button"
                onClick={() =>
                  patchDraft({
                    pendingKeys: draft.pendingKeys.filter((_, i) => i !== index),
                  })
                }
                className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                aria-label="移除这把待保存的 Key"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={draft.keyDraft}
              onChange={(event) =>
                patchDraft({ keyDraft: event.target.value, clearSavedKey: false })
              }
              placeholder={draft.keyMasks.length > 0 ? "输入新 Key（保存后追加）" : "粘贴 API Key"}
              spellCheck={false}
              autoComplete="off"
              className={`${INPUT_CLASS} font-mono`}
            />
            <button
              type="button"
              disabled={!draft.keyDraft.trim()}
              onClick={() =>
                patchDraft({
                  pendingKeys: [...draft.pendingKeys, draft.keyDraft.trim()],
                  keyDraft: "",
                })
              }
              className={GHOST_BUTTON_CLASS}
            >
              <Plus className="h-3.5 w-3.5" />
              添加另一个密钥
            </button>
            {(draft.keyMasks.length > 0 || draft.pendingKeys.length > 0) && (
              <button
                type="button"
                onClick={() =>
                  patchDraft({
                    removedKeyIndexes: draft.keyMasks.map((_, index) => index),
                    pendingKeys: [],
                    clearSavedKey: true,
                    keyDraft: "",
                  })
                }
                className={DANGER_BUTTON_CLASS}
              >
                清空
              </button>
            )}
          </div>
          <span className="text-3xs text-muted-foreground">
            Key 明文只存在本机数据库，不回到前端；列表里只显示掩码。
          </span>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className={LABEL_CLASS}>图标</span>
          <div className="flex flex-wrap items-center gap-1.5">
            <IconBadge icon={draft.icon} name={draft.name} baseUrl={draft.baseUrl} />
            {ICON_CHOICES.map(({ name, label, Icon }) => (
              <button
                key={name}
                type="button"
                onClick={() => patchDraft({ icon: name })}
                title={label}
                className={`flex h-7 w-7 items-center justify-center rounded-md border transition-colors ${
                  draft.icon === name
                    ? "border-primary/60 bg-secondary text-foreground"
                    : "border-transparent bg-secondary/40 text-muted-foreground hover:bg-secondary"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            ))}
            <label className={`${GHOST_BUTTON_CLASS} cursor-pointer`}>
              <ImageIcon className="h-3.5 w-3.5" />
              选择图片
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => pickIconFile(event.target.files?.[0] ?? null)}
              />
            </label>
            {draft.icon ? (
              <button
                type="button"
                onClick={() => patchDraft({ icon: "" })}
                className={GHOST_BUTTON_CLASS}
              >
                清除图标
              </button>
            ) : null}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="flex flex-col">
            <span className={LABEL_CLASS}>跳过证书校验</span>
            <span className="text-3xs text-muted-foreground">
              本机自签 / 自建中转连不上 HTTPS 时打开，只影响这一家供应商
            </span>
          </span>
          <SwitchButton
            checked={draft.skipCertVerify}
            onChange={(next) => patchDraft({ skipCertVerify: next })}
            label="跳过证书校验"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className={LABEL_CLASS}>模型</span>
            <span className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => patchDraft({ vendorModels: null })}
                className={GHOST_BUTTON_CLASS}
                disabled={draft.vendorModels === null}
              >
                仅所选
              </button>
              <button
                type="button"
                onClick={() => {
                  if (draft.models.length === 0) return;
                  patchDraft({ models: [] });
                }}
                className={GHOST_BUTTON_CLASS}
                disabled={draft.models.length === 0}
              >
                全不选
              </button>
              <button
                type="button"
                onClick={() => {
                  const all = vendorModels.length > 0 ? vendorModels : draft.models;
                  patchDraft({ models: [...all] });
                }}
                className={GHOST_BUTTON_CLASS}
                disabled={modelChoices.length === 0}
              >
                全选
              </button>
              <button
                type="button"
                onClick={() => void fetchModels()}
                disabled={fetchingModels}
                className={GHOST_BUTTON_CLASS}
              >
                {fetchingModels ? (
                  <Spinner size="xs" className="h-3 w-3" />
                ) : (
                  <RefreshCw className="h-3 w-3" />
                )}
                获取列表
              </button>
            </span>
          </div>
          <span className="text-3xs text-muted-foreground">
            {draft.vendorModels === null
              ? `已选 ${draft.models.length} 个（点「获取列表」拉供应商的模型）`
              : `供应商返回 ${vendorModels.length} 个，已选 ${draft.models.length} 个`}
          </span>
          <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
            {modelChoices.length === 0 ? (
              <span className="text-2xs text-muted-foreground">还没有模型，先获取列表</span>
            ) : (
              modelChoices.map((name) => {
                const selected = draft.models.includes(name);
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => toggleModel(name)}
                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-3xs transition-colors ${
                      selected
                        ? "border-primary/60 bg-secondary text-foreground"
                        : "border-border text-muted-foreground hover:bg-secondary"
                    }`}
                  >
                    {selected ? <Check className="h-2.5 w-2.5" /> : null}
                    {name}
                  </button>
                );
              })
            )}
          </div>
          {draft.models.length > 1 ? (
            <span className="text-3xs text-muted-foreground">
              第一个「{draft.models[0]}」是默认模型
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void removeDraft()}
            disabled={saving || draft.isNew}
            className={DANGER_BUTTON_CLASS}
          >
            <Trash2 className="h-3.5 w-3.5" />
            移除
          </button>
          <button
            type="button"
            onClick={duplicateDraft}
            disabled={saving}
            className={GHOST_BUTTON_CLASS}
          >
            <Copy className="h-3.5 w-3.5" />
            复制
          </button>
          <button
            type="button"
            onClick={() => void checkConnect()}
            disabled={checking || saving}
            title="用当前填的地址、模型、Key 真发一句话，确认这套配置能不能用"
            className={GHOST_BUTTON_CLASS}
          >
            {checking ? <Spinner size="xs" className="h-3 w-3" /> : <Zap className="h-3.5 w-3.5" />}
            测试连接
          </button>
        </span>
        <span className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setDraft(null)}
            disabled={saving}
            className={GHOST_BUTTON_CLASS}
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void saveDraft()}
            disabled={saving}
            className={PRIMARY_BUTTON_CLASS}
          >
            {saving ? <Spinner size="sm" className="h-3.5 w-3.5" /> : null}
            保存
          </button>
        </span>
      </div>
    </div>
  );
}

/**
 * 供应商配置的弹窗外壳（2026-10-24 用户反馈：不要一页展开，点开弹窗改）。
 * `AiProvidersPanel` 本身还是「列表 → 详情」两态，弹窗只负责一层遮罩、
 * 一个标题栏和关闭行为；点遮罩、按 Esc、点右上角 X 都能关。
 */
export function AiProvidersDialog(props: { onClose: () => void }): JSX.Element {
  return (
    <Modal
      open
      onClose={props.onClose}
      title="AI 供应商"
      description="点一行进去改地址、协议、密钥和模型；第一把密钥、第一个模型生效。"
      closeLabel="关闭 AI 供应商设置"
      size="lg"
      className="max-w-3xl"
      bodyClassName="px-5 pb-5"
    >
      <AiProvidersPanel />
    </Modal>
  );
}

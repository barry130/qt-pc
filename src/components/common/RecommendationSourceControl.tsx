import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Settings2, UserRound } from "lucide-react";
import { Button, IconButton, Segmented, Select } from "@/components/ui";
import { cn } from "@/lib/utils";
import { onSourceMetaAuthChange, prepareSourceMetaAuth, sourceMetaAuthSnapshotIsCurrent, type SourceMetaAuthSnapshot } from "@/lib/source-auth";
import { useRecommendationSourceStore, type RecommendationFeature, type RecommendationSelection } from "@/stores/recommendation-source";
import { useSourceRegistryStore } from "@/stores/sourceRegistry";

const ORIGIN_OPTIONS: { value: RecommendationSelection["origin"]; label: string }[] = [
  { value: "app", label: "应用推荐" },
  { value: "account", label: "平台账号" },
];

/** Daily and FM keep separate choices; selecting an account never changes global AI or auth permission. */
export function RecommendationSourceControl(props: { feature: RecommendationFeature; className?: string; children?: React.ReactNode }): React.JSX.Element {
  const navigate = useNavigate();
  const selection = useRecommendationSourceStore((s) => s[props.feature]);
  const load = useRecommendationSourceStore((s) => s.load);
  const setSelection = useRecommendationSourceStore((s) => s.setSelection);
  const sources = useSourceRegistryStore((s) => s.sources);
  const ensure = useSourceRegistryStore((s) => s.ensure);
  const [error, setError] = useState<string | null>(null);
  const [accountProblem, setAccountProblem] = useState<{ sourceId: string; message: string } | null>(null);
  // Only the non-secret metadata snapshot can enter React state, never account Cookie records.
  const [account, setAccount] = useState<SourceMetaAuthSnapshot | null>(null);
  const label = props.feature === "daily" ? "每日推荐来源" : "私人 FM 来源";
  const supported = sources.filter((source) => source.accountRecommendations?.[props.feature] === true);
  const selectedSource = sources.find((source) => source.id === selection.sourceId);
  const supportedSelection = selectedSource?.accountRecommendations?.[props.feature] === true;
  const unsupported = selection.origin === "account" && !supportedSelection;

  useEffect(() => {
    let current = true;
    void load().catch(() => { if (current) setError("推荐来源读取失败，请重试。"); });
    void ensure().catch(() => undefined);
    return () => { current = false; };
  }, [load, ensure]);

  const [authEpoch, setAuthEpoch] = useState(0);
  useEffect(() => onSourceMetaAuthChange((sourceId) => {
    if (selection.origin !== "account" || (sourceId !== undefined && sourceId !== selection.sourceId)) return;
    setAccount(null);
    setAccountProblem(null);
    setAuthEpoch((epoch) => epoch + 1);
  }), [selection.origin, selection.sourceId]);

  useEffect(() => {
    let current = true;
    setAccountProblem(null);
    setAccount(null);
    if (selection.origin === "account" && supportedSelection) {
      void prepareSourceMetaAuth(selection.sourceId).then((snapshot) => {
        if (current && sourceMetaAuthSnapshotIsCurrent(snapshot)) setAccount(snapshot);
      }).catch((err: unknown) => {
        if (!current) return;
        const reason = err instanceof Error ? err.message : "";
        const message = reason.includes("ACCOUNT_AUTH_REQUIRED") ? "请先登录该音源账号。"
          : reason.includes("ACCOUNT_META_DISABLED") ? "数据面登录授权已关闭。请在音源平台管理页中明确开启；播放授权不受影响。"
          : "账号状态读取失败，请检查音源账号与数据包设置后重试。";
        setAccountProblem({ sourceId: selection.sourceId, message });
      });
    }
    return () => { current = false; };
  }, [selection.origin, selection.sourceId, supportedSelection, authEpoch]);

  const changeOrigin = (origin: RecommendationSelection["origin"]): void => {
    const sourceId = selection.sourceId || supported[0]?.id || "";
    if (origin === "account" && sourceId === "") {
      setError(`当前音源包尚未提供${label}的账号推荐，请升级音源包。`);
      return;
    }
    setError(null);
    void setSelection(props.feature, { origin, sourceId }).catch(() => setError("推荐来源保存失败，请重试。"));
  };

  const currentAccount = account?.sourceId === selection.sourceId && sourceMetaAuthSnapshotIsCurrent(account) ? account : null;
  const currentAccountProblem = currentAccount === null && accountProblem?.sourceId === selection.sourceId ? accountProblem.message : null;

  return (
    <section aria-label={`${label}设置`} className={cn("@container flex min-w-0 shrink-0 flex-col gap-2", props.className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Segmented value={selection.origin} options={ORIGIN_OPTIONS} onChange={changeOrigin} label={label}
          className="h-8 shrink-0 whitespace-nowrap bg-card/80 [&>button]:focus-visible:outline-none [&>button]:focus-visible:ring-2 [&>button]:focus-visible:ring-ring/60" />
        {selection.origin === "account" ? (
          <Select aria-label={props.feature === "daily" ? "每日推荐平台" : "私人 FM 平台"}
            className="w-30 shrink-0 bg-card/80 @[24rem]:w-36" value={selection.sourceId} onChange={(event) => {
              setError(null);
              void setSelection(props.feature, { origin: "account", sourceId: event.target.value }).catch(() => setError("推荐来源保存失败，请重试。"));
            }}>
            {unsupported ? <option value={selection.sourceId} disabled>{selectedSource?.name || selection.sourceId}（当前音源包不支持）</option> : null}
            {supported.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
          </Select>
        ) : null}
        {selection.origin === "account" && supportedSelection ? (
          <div className="flex min-w-10 flex-1 items-center gap-1.5">
            {currentAccount ? (
              <>
                <span className="sr-only">账号：{currentAccount.nickname}（{currentAccount.accountId}）</span>
                <span aria-hidden="true" className="hidden min-w-0 items-center gap-1.5 text-xs text-muted-foreground @[24rem]:inline-flex"
                  title={`账号：${currentAccount.nickname}（${currentAccount.accountId}）`}>
                  <UserRound className="h-3.5 w-3.5 shrink-0" />
                  <span className="max-w-40 truncate">{currentAccount.nickname}</span>
                </span>
              </>
            ) : currentAccountProblem === null ? (
              <span role="status" className="truncate text-xs text-muted-foreground">正在读取账号…</span>
            ) : null}
            <IconButton size="lg" label="管理音源平台" hover="secondary"
              className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              onClick={() => void navigate({ to: "/source-accounts" })}>
              <Settings2 />
            </IconButton>
          </div>
        ) : null}
        {props.children}
      </div>
      {selection.origin === "account" && supportedSelection && currentAccountProblem !== null
        ? <p role="alert" className="text-xs text-destructive">{currentAccountProblem}</p> : null}
      {unsupported ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-xs text-destructive">当前音源包不支持{selectedSource?.name || selection.sourceId}的{props.feature === "daily" ? "账号每日推荐" : "账号私人 FM"}。请明确选择其他来源或升级音源包。</p>
          <Button variant="link" onClick={() => void navigate({ to: "/settings/$section", params: { section: "source-package" } })}>音源包设置</Button>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </section>
  );
}

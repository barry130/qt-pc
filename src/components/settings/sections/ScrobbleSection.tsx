import { useCallback, useEffect, useState } from "react";
import { useT, type MessageKey } from "@/lib/i18n";
import { errMsg } from "@/lib/utils";
import * as ipc from "@/services/ipc";
import { type ScrobbleView } from "@/types";
import { Button, Card, Input, Switch } from "@/components/ui";
import { Segmented, SettingRow } from "../controls";

/**
 * 听歌上报（A8，对照分析文档 §4.8）：Last.fm / ListenBrainz。
 *
 * 界面按「先选目标、只看选中那家」组织（用户反馈：实际用法是二选一，两块上下平铺
 * 太吵）：顶部一个分段器切目标，下面只渲染选中目标的接入与开关；另一家如果也在
 * 上报，给一行提示和「只上报当前目标」的快捷关闭。后端仍是两路独立开关 —— 这里
 * 只是展示层的聚焦，不悄悄替用户关掉另一路。
 *
 * 两家接入方式不一样：
 * - Last.fm 要用户自备应用凭据（api key / secret），再走「浏览器里授权 → 回来点完成」
 *   两步。凭据是用户自己的应用，不内置（内置等于把 secret 发给每个安装包）。
 * - ListenBrainz 只要一个 user token，填进去就能校验。
 *
 * 上报是旁路：网络断了进队列退避重试，绝不阻塞播放，所以这里也不做「必须连通」
 * 的强制校验 —— 连接失败只提示，不挡用户听歌。
 */

type ScrobbleTarget = "lastfm" | "listenbrainz";

/** 未手动选择时的默认目标：优先正在上报的那家，其次已连接的；全新用户给 ListenBrainz（免自建应用）。 */
function deriveTarget(view: ScrobbleView | null): ScrobbleTarget {
  const lastfm = view?.lastfm;
  const lb = view?.listenbrainz;
  if (lb?.enabled) return "listenbrainz";
  if (lastfm?.enabled) return "lastfm";
  if (lb?.connected) return "listenbrainz";
  if (lastfm?.connected) return "lastfm";
  return "listenbrainz";
}

function targetState(
  connected: boolean,
  enabled: boolean,
  user: string,
  tr: (key: MessageKey, vars?: Record<string, string | number>) => string,
): { text: string; tone: string } {
  if (!connected) return { text: tr("settings.scrobble.statusDisconnected"), tone: "text-muted-foreground" };
  const who = user ? tr("settings.scrobble.userSuffix", { user }) : "";
  return enabled
    ? { text: tr("settings.scrobble.statusReporting", { who }), tone: "text-emerald-600 dark:text-emerald-400" }
    : { text: tr("settings.scrobble.statusIdle", { who }), tone: "text-amber-600 dark:text-amber-400" };
}

export function ScrobbleSection(): React.JSX.Element {
  const tr = useT();
  const [view, setView] = useState<ScrobbleView | null>(null);
  const [pick, setPick] = useState<ScrobbleTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [token, setToken] = useState("");

  const load = useCallback(async (): Promise<void> => {
    try {
      setView(await ipc.getScrobbleSettings());
    } catch (err) {
      setError(errMsg(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (task: () => Promise<void>): Promise<void> => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        await task();
      } catch (err) {
        setError(errMsg(err));
      } finally {
        setBusy(false);
        await load();
      }
    },
    [load],
  );

  const saveCredentials = (): Promise<void> =>
    run(async () => {
      await ipc.setLastfmCredentials(apiKey, apiSecret);
      setApiKey("");
      setApiSecret("");
      setNotice(tr("settings.scrobble.credentialsSaved", { service: "Last.fm" }));
    });

  const beginAuth = (): Promise<void> =>
    run(async () => {
      const url = await ipc.beginLastfmAuth();
      await ipc.openExternalUrl(url);
      setNotice(tr("settings.scrobble.authOpened"));
    });

  const finishAuth = (): Promise<void> =>
    run(async () => {
      const user = await ipc.finishLastfmAuth();
      setNotice(
        user
          ? tr("settings.scrobble.connectedTo", { service: "Last.fm", user })
          : tr("settings.scrobble.connected", { service: "Last.fm" }),
      );
    });

  const toggle = (target: ScrobbleTarget, enabled: boolean): Promise<void> =>
    run(async () => {
      await ipc.setScrobbleEnabled(target, enabled);
    });

  const retry = (): Promise<void> =>
    run(async () => {
      const out = await ipc.scrobbleFlush();
      const head = tr("settings.scrobble.retried", {
        sent: out.sent,
        retrying: out.retrying,
        dead: out.dead,
      });
      setNotice(
        out.error ? `${head}${tr("settings.scrobble.errorSuffix", { error: out.error })}` : head,
      );
    });

  const queue = view?.queue;
  const lastfm = view?.lastfm;
  const lb = view?.listenbrainz;
  const target = pick ?? deriveTarget(view);
  const other: ScrobbleTarget = target === "lastfm" ? "listenbrainz" : "lastfm";
  const otherState = other === "lastfm" ? lastfm : lb;
  const bothReporting = otherState !== undefined && otherState.connected && otherState.enabled;

  const lastfmState = targetState(
    lastfm?.connected === true,
    lastfm?.enabled === true,
    lastfm?.user ?? "",
    tr,
  );
  const lbState = targetState(lb?.connected === true, lb?.enabled === true, lb?.user ?? "", tr);

  return (
    <div className="max-w-4xl divide-y divide-border">
      <div className="py-3">
        <SettingRow
          title={tr("settings.scrobble.target")}
          description={tr("settings.scrobble.targetHint")}
        >
          <Segmented
            label={tr("settings.scrobble.targetAria")}
            value={target}
            options={[
              { value: "listenbrainz", label: "ListenBrainz" },
              { value: "lastfm", label: "Last.fm" },
            ]}
            onChange={(value) => setPick(value)}
          />
        </SettingRow>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span>
            {tr("settings.scrobble.serviceLabel", { service: "ListenBrainz" })}
            <span className={lbState.tone}>{lbState.text}</span>
          </span>
          <span>
            {tr("settings.scrobble.serviceLabel", { service: "Last.fm" })}
            <span className={lastfmState.tone}>{lastfmState.text}</span>
          </span>
        </div>
      </div>

      {target === "listenbrainz" ? (
        <>
          {bothReporting && (
            <SettingRow
              title={tr("settings.scrobble.otherReporting", { service: "Last.fm" })}
              description={tr("settings.scrobble.otherReportingHint", {
                keep: "ListenBrainz",
                other: "Last.fm",
              })}
            >
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void toggle("lastfm", false)}
              >
                {tr("settings.scrobble.onlyReport", { service: "ListenBrainz" })}
              </Button>
            </SettingRow>
          )}
          {!lb?.connected && (
            <SettingRow
              title={tr("settings.scrobble.userToken")}
              description={tr("settings.scrobble.userTokenHint", { service: "ListenBrainz" })}
            >
              <div className="flex gap-2">
                <Input
                  value={token}
                  placeholder={tr("settings.scrobble.userTokenPlaceholder")}
                  type="password"
                  aria-label={tr("settings.scrobble.userTokenAria")}
                  onChange={(e) => setToken(e.target.value)}
                />
                <Button
                  variant="outline"
                  disabled={busy || !token.trim()}
                  onClick={() =>
                    void run(async () => {
                      const user = await ipc.connectListenBrainz(token);
                      setToken("");
                      setNotice(
                        user
                          ? tr("settings.scrobble.connectedTo", {
                              service: "ListenBrainz",
                              user,
                            })
                          : tr("settings.scrobble.connected", { service: "ListenBrainz" }),
                      );
                    })
                  }
                >
                  {tr("settings.scrobble.connect")}
                </Button>
              </div>
            </SettingRow>
          )}
          {lb?.connected && (
            <>
              <SettingRow
                title={tr("settings.scrobble.connectionStatus")}
                description={tr("settings.scrobble.connectedAs", {
                  who: lb.user ? tr("settings.scrobble.userSuffix", { user: lb.user }) : "",
                })}
              >
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void run(() => ipc.disconnectListenBrainz())}
                >
                  {tr("settings.scrobble.disconnect")}
                </Button>
              </SettingRow>
              <SettingRow
                title={tr("settings.scrobble.reportTo", { service: "ListenBrainz" })}
                description={tr("settings.scrobble.reportToHint")}
              >
                <Switch
                  checked={lb.enabled}
                  disabled={busy}
                  onToggle={() => void toggle("listenbrainz", !lb.enabled)}
                />
              </SettingRow>
            </>
          )}
        </>
      ) : (
        <>
          {bothReporting && (
            <SettingRow
              title={tr("settings.scrobble.otherReporting", { service: "ListenBrainz" })}
              description={tr("settings.scrobble.otherReportingHint", {
                keep: "Last.fm",
                other: "ListenBrainz",
              })}
            >
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void toggle("listenbrainz", false)}
              >
                {tr("settings.scrobble.onlyReport", { service: "Last.fm" })}
              </Button>
            </SettingRow>
          )}
          <div className="py-3">
            <p className="text-xs text-muted-foreground">
              {tr("settings.scrobble.lastfmIntro", { service: "Last.fm" })}
            </p>
          </div>
          {!lastfm?.hasCredentials && (
            <>
              <SettingRow
                title={tr("settings.scrobble.apiKey")}
                description={tr("settings.scrobble.apiKeyHint", { service: "Last.fm" })}
              >
                <Input
                  value={apiKey}
                  placeholder={tr("settings.scrobble.apiKeyPlaceholder")}
                  aria-label={tr("settings.scrobble.apiKeyAria")}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </SettingRow>
              <SettingRow
                title={tr("settings.scrobble.sharedSecret")}
                description={tr("settings.scrobble.sharedSecretHint")}
              >
                <Input
                  value={apiSecret}
                  placeholder={tr("settings.scrobble.sharedSecretPlaceholder")}
                  type="password"
                  aria-label={tr("settings.scrobble.sharedSecretAria")}
                  onChange={(e) => setApiSecret(e.target.value)}
                />
              </SettingRow>
              <SettingRow
                title={tr("settings.scrobble.saveCredentials")}
                description={tr("settings.scrobble.saveCredentialsHint")}
              >
                <Button
                  variant="outline"
                  disabled={busy || !apiKey.trim() || !apiSecret.trim()}
                  onClick={() => void saveCredentials()}
                >
                  {tr("common.save")}
                </Button>
              </SettingRow>
            </>
          )}
          {lastfm?.hasCredentials && (
            <>
              <SettingRow
                title={tr("settings.scrobble.connectionStatus")}
                description={
                  lastfm.connected
                    ? tr("settings.scrobble.connectedAs", {
                        who: lastfm.user
                          ? tr("settings.scrobble.userSuffix", { user: lastfm.user })
                          : "",
                      })
                    : lastfm.awaitingAuth
                      ? tr("settings.scrobble.awaitingAuth")
                      : tr("settings.scrobble.notConnectedYet")
                }
              >
                {lastfm.connected ? (
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void run(() => ipc.disconnectLastfm())}
                  >
                    {tr("settings.scrobble.disconnect")}
                  </Button>
                ) : (
                  <div className="flex gap-2">
                    <Button variant="outline" disabled={busy} onClick={() => void beginAuth()}>
                      {lastfm.awaitingAuth
                        ? tr("settings.scrobble.reopenAuth")
                        : tr("settings.scrobble.connectService", { service: "Last.fm" })}
                    </Button>
                    {lastfm.awaitingAuth && (
                      <Button disabled={busy} onClick={() => void finishAuth()}>
                        {tr("settings.scrobble.authDone")}
                      </Button>
                    )}
                  </div>
                )}
              </SettingRow>
              <SettingRow
                title={tr("settings.scrobble.reportTo", { service: "Last.fm" })}
                description={tr("settings.scrobble.reportToHint")}
              >
                <Switch
                  checked={lastfm.enabled}
                  disabled={busy || !lastfm.connected}
                  onToggle={() => void toggle("lastfm", !lastfm.enabled)}
                />
              </SettingRow>
            </>
          )}
        </>
      )}

      {queue && (
        <div className="py-3">
          <SettingRow
            title={tr("settings.scrobble.queue")}
            description={tr("settings.scrobble.queueStats", {
              pending: queue.pending,
              sent: queue.sent,
              dead: queue.dead,
            })}
          >
            <Button
              variant="outline"
              disabled={busy || queue.pending === 0}
              onClick={() => void retry()}
            >
              {tr("settings.scrobble.retryNow")}
            </Button>
          </SettingRow>
          {queue.lastError && (
            <p className="mt-1 text-xs text-destructive">
              {tr("settings.scrobble.lastError", { error: queue.lastError })}
            </p>
          )}
          {queue.recent.length > 0 && (
            <Card className="mt-2 p-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                {tr("settings.scrobble.recent")}
              </p>
              <ul className="space-y-1">
                {queue.recent.map((r) => (
                  <li
                    key={`${r.target}-${r.playedAt}-${r.title}`}
                    className="flex items-center justify-between gap-2 text-xs"
                  >
                    <span className="truncate">
                      {r.title}
                      {r.artist ? ` · ${r.artist}` : ""}
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      {r.target === "lastfm" ? "Last.fm" : "ListenBrainz"}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}

      {notice && (
        <p className="py-2 text-xs text-muted-foreground" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="py-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

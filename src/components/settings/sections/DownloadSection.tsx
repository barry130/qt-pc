import { useCallback, useEffect, useState } from "react";
import { errMsg } from "@/lib/utils";
import * as ipc from "@/services/ipc";
import { SettingRow, Switch } from "../controls";

/**
 * 超过这个数就要二次确认。
 *
 * 批量下载不限流会被音源 / CDN 当成爬虫：LX Music 就是因为默认放开并发被临时封过 IP
 * （issue #1992，34 条讨论），它同样把 3 当成「安全线」、>3 才弹确认。这里对齐这个口径。
 */
const SAFE_DOWNLOAD_CONCURRENCY = 3;

/** 可选的同时下载数，与 Rust `download::MIN/MAX_CONCURRENCY` 一致 */
const CONCURRENCY_CHOICES = [1, 2, 3, 4, 5, 6];

/** 下载设置：保存位置（默认安装目录/Download，可选任意位置） */

export function DownloadSection(): React.JSX.Element {
  const [dir, setDir] = useState("");
  const [nameFormat, setNameFormat] = useState<"artist" | "song">("artist");
  const [concurrency, setConcurrency] = useState(ipc.DEFAULT_DOWNLOAD_CONCURRENCY);
  // 选了 >3 时先挂在这里等用户确认。沿用全项目唯一的二次确认手法：原地换文案再点第二下
  const [pendingConcurrency, setPendingConcurrency] = useState<number | null>(null);
  // 下载成功的就地附件（封面原图 / 歌词），Rust 侧默认开，这里只做镜像
  const [saveCover, setSaveCover] = useState(true);
  const [saveLyric, setSaveLyric] = useState(true);
  // 封面 / 歌词的存储方式：内嵌进音频标签（默认）/ 同目录 sidecar 文件
  const [storage, setStorage] = useState<ipc.DownloadStorageMode>("embed");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [d, f, c, sc, sl, st] = await Promise.all([
        ipc.getDownloadDir(),
        ipc.getDownloadNameFormat(),
        ipc.getDownloadConcurrency(),
        ipc.getDownloadSaveCover(),
        ipc.getDownloadSaveLyric(),
        ipc.getDownloadStorage(),
      ]);
      setDir(d);
      setNameFormat(f);
      setConcurrency(c);
      setSaveCover(sc);
      setSaveLyric(sl);
      setStorage(st);
    } catch (err) {
      setError(errMsg(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const choose = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const picked = await ipc.chooseDownloadDir();
      if (picked) setDir(picked);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setDir(await ipc.resetDownloadDir());
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const chooseNameFormat = async (f: "artist" | "song"): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await ipc.setDownloadNameFormat(f);
      setNameFormat(f);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  // 附件开关是「只影响之后完成的任务」：关掉时已落盘的封面 / .lrc 不回收，
  // 描述里说清楚了，这里不弹确认
  const chooseSaveCover = async (v: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await ipc.setDownloadSaveCover(v);
      setSaveCover(v);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const chooseSaveLyric = async (v: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await ipc.setDownloadSaveLyric(v);
      setSaveLyric(v);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  // 存储方式同样是「只影响之后完成的任务」：切到内嵌不会回头重写已落盘的
  // sidecar，反之亦然。描述里说清楚了，不弹确认
  const chooseStorage = async (mode: ipc.DownloadStorageMode): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await ipc.setDownloadStorage(mode);
      setStorage(mode);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const applyConcurrency = async (n: number): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      // Rust 侧会再夹一次到 1–6，并以实际生效值回传（避免前后端口径漂移）
      setConcurrency(await ipc.setDownloadConcurrency(n));
      setPendingConcurrency(null);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const chooseConcurrency = (n: number): void => {
    // 3 以内直接生效；>3 先弹确认 —— 批量下载不限流会被音源/CDN 判成爬虫，
    // LX Music 就因此被封过 IP（issue #1992），它同样把 >3 做成需要确认。
    //
    // 「待确认的就是这一项」才算第二下。少了这个判断，第二下只会把同一个值再
    // set 一遍（React 看到值没变，不重渲染也不提交），按钮永远停在「6 个？」。
    // 与卸载音源包（armed?.packId !== pack.id）、删歌单（confirmRemoveId !== p.pid）
    // 同一套写法；点别的数字则改成武装那一项。
    if (n > SAFE_DOWNLOAD_CONCURRENCY && pendingConcurrency !== n) {
      setPendingConcurrency(n);
      return;
    }
    setPendingConcurrency(null);
    void applyConcurrency(n);
  };

  return (
    <div className="max-w-4xl divide-y divide-border">
      <SettingRow
        title="下载保存位置"
        description="默认为安装目录下的 Download 文件夹；重名歌曲自动加序号，不会互相覆盖。"
      >
        <div className="flex items-center gap-2">
          <span
            className="max-w-52 truncate rounded border border-input bg-background px-2 py-1.5 text-xs text-muted-foreground"
            title={dir}
          >
            {dir || "…"}
          </span>
          <button
            type="button"
            onClick={() => void choose()}
            disabled={busy}
            className="rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent disabled:opacity-50"
          >
            更改位置
          </button>
          <button
            type="button"
            onClick={() => void reset()}
            disabled={busy}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            恢复默认
          </button>
        </div>
      </SettingRow>
      {/* 默认下载音质已改为按平台独立设置（音源账号页），此处不再有全局入口 */}
      <SettingRow
        title="下载文件名格式"
        description="下载歌曲的存盘文件名顺序：歌手-歌名 或 歌名-歌手。仅影响设置变更后新开始的下载。"
      >
        <select
          value={nameFormat}
          disabled={busy}
          aria-label="下载文件名格式"
          onChange={(e) => void chooseNameFormat(e.target.value as "artist" | "song")}
          className="rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <option value="artist">歌手 - 歌名</option>
          <option value="song">歌名 - 歌手</option>
        </select>
      </SettingRow>
      <SettingRow
        title="同时下载封面"
        description={
          storage === "embed"
            ? "下载完成后把封面写进歌曲文件标签（MP3/FLAC/M4A/WAV 等；原文件已有封面则保留，不支持的格式自动存为同目录图片）。仅影响之后完成的任务。"
            : "下载完成后把封面原图存到歌曲旁边（文件名与歌曲相同）。仅影响之后完成的任务。"
        }
      >
        <Switch checked={saveCover} onToggle={() => void chooseSaveCover(!saveCover)} />
      </SettingRow>
      <SettingRow
        title="同时下载歌词"
        description={
          storage === "embed"
            ? "下载完成后把歌词写进歌曲文件标签（优先用已缓存的词，没有才联网补取；不支持的格式自动存为同名 .lrc）。仅影响之后完成的任务。"
            : "下载完成后把歌词存为同名 .lrc 文件（优先用已缓存的词，没有才联网补取）。仅影响之后完成的任务。"
        }
      >
        <Switch checked={saveLyric} onToggle={() => void chooseSaveLyric(!saveLyric)} />
      </SettingRow>
      <SettingRow
        title="下载存储方式"
        description="封面 / 歌词跟歌走的形式：内嵌进音频文件标签（部分播放器可直接读出），或存为歌曲旁边的独立文件。仅影响之后完成的任务，已落盘的不来回改。"
      >
        <select
          value={storage}
          disabled={busy}
          aria-label="下载存储方式"
          onChange={(e) => void chooseStorage(e.target.value as ipc.DownloadStorageMode)}
          className="rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <option value="embed">音乐内嵌</option>
          <option value="sidecar">同目录文件</option>
        </select>
      </SettingRow>
      <SettingRow
        title="同时下载数"
        description="批量下载时最多同时进行几个任务，超出的排队等待。数字越大越快，但也更容易被音源限流甚至封 IP，建议不超过 3。"
      >
        <div className="flex items-center gap-2">
          {CONCURRENCY_CHOICES.map((n) => {
            const active = concurrency === n;
            // 待确认的那一项原地变文案 + 变红，点第二下才真正提交
            const confirming = pendingConcurrency === n;
            return (
              <button
                key={n}
                type="button"
                onClick={() => chooseConcurrency(n)}
                disabled={busy}
                aria-label={confirming ? `确认将同时下载数改为 ${n}` : `同时下载数 ${n}`}
                aria-pressed={active}
                className={
                  confirming
                    ? "rounded-md border border-destructive px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
                    : active
                      ? "rounded-md border border-primary bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition-colors disabled:opacity-50"
                      : "rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent disabled:opacity-50"
                }
              >
                {confirming ? `${n} 个？` : String(n)}
              </button>
            );
          })}
        </div>
      </SettingRow>
      {pendingConcurrency !== null && (
        <p className="py-2 text-xs text-destructive">
          同时下载 {pendingConcurrency} 个可能被音源判定为异常流量并临时封禁 IP，再点一次「
          {pendingConcurrency} 个？」确认。
        </p>
      )}
      {error && <p className="py-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

/**
 * 不喜欢列表（屏蔽规则）管理。
 *
 * 规则按「歌名 + 歌手」匹配而不按曲目 id —— id 是音源私有的，同一首歌换源兜底后
 * id 与 platform 都会变，按 id 屏蔽等于换个源就失效。代价是匹配必须容许吵闹，
 * 归一化那套在 Rust 侧 `db/store/dislikes.rs`，这里只管展示与删除。
 *
 * LX 的 `dislike_list` 把 delete/update/clear 三个 dbHelper 整体注释掉了，用户只能
 * 追加或整体覆盖；我们这里 `id` 是真主键，逐条删除是一等公民。
 */

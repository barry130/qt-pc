import { useRef, useState } from "react";
import { Cast, RefreshCw } from "lucide-react";
import { Popover } from "@/components/common/Popover";
import { connectDlna, discoverDlna, disconnectDlna } from "@/services/ipc";
import { usePlayerStore } from "@/stores/player";
import type { DlnaDevice } from "@/types";
import { errMsg } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { toast } from "@/stores/toast";

/** Discovery runs only while requested; progress stays in the shared playback store. */
export function DlnaButton(): React.JSX.Element {
  useTauriEvent<string>("dlna-notice", (event) => toast(event.payload));
  const deviceId = usePlayerStore((state) => state.state?.cast?.deviceId ?? null);
  const deviceName = usePlayerStore((state) => state.state?.cast?.deviceName ?? null);
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<DlnaDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const revision = useRef(0);

  const scan = async (): Promise<void> => {
    const current = ++revision.current;
    setBusy(true);
    setError("");
    try {
      const result = await discoverDlna();
      if (revision.current === current) setDevices(result);
    } catch (error) {
      if (revision.current === current) setError(errMsg(error));
    } finally {
      if (revision.current === current) setBusy(false);
    }
  };

  const choose = async (id: string): Promise<void> => {
    const current = ++revision.current;
    setBusy(true);
    setError("");
    try {
      await connectDlna(id);
      if (revision.current === current) setOpen(false);
    } catch (error) {
      if (revision.current === current) setError(errMsg(error));
    } finally {
      if (revision.current === current) setBusy(false);
    }
  };

  const disconnect = async (local: boolean): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      await disconnectDlna(local);
      setOpen(false);
    } catch (error) { setError(errMsg(error)); }
    finally { setBusy(false); }
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={() => (
        <button
          type="button"
          aria-label={deviceName ? `投屏：${deviceName}` : "DLNA 投屏"}
          aria-expanded={open}
          title={deviceName ? `投屏到 ${deviceName}` : "DLNA 投屏"}
          onClick={() => {
            if (open) setOpen(false);
            else { setOpen(true); void scan(); }
          }}
          className={cn("flex h-8 w-8 items-center justify-center rounded-full transition-colors duration-fast hover:bg-secondary",
            deviceId ? "text-primary" : "text-muted-foreground")}
        >
          <Cast className="h-4 w-4" />
        </button>
      )}
    >
      {() => (
        <section aria-label="DLNA 投屏设备" className="absolute bottom-full right-0 z-50 mb-3 w-80 rounded-xl border border-border bg-background p-4 shadow-xl">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">DLNA 投屏</h3>
              <p className="mt-1 text-xs text-muted-foreground">{deviceName ? `正在投放到 ${deviceName}` : "电视或音箱需开启 DLNA 并连接同一局域网"}</p>
            </div>
            <button type="button" aria-label="刷新投屏设备" disabled={busy} onClick={() => void scan()}
              className="rounded-md p-2 transition-colors duration-fast hover:bg-secondary disabled:opacity-40">
              <RefreshCw className={cn("h-4 w-4", busy && "animate-spin")} />
            </button>
          </div>
          <div className="mt-3 max-h-64 overflow-y-auto">
            {busy && devices.length === 0 ? <p role="status" className="py-5 text-center text-sm text-muted-foreground">正在搜索设备…</p>
              : devices.length === 0 ? <p className="py-5 text-center text-sm text-muted-foreground">未发现设备，请确认设备已开启 DLNA</p>
              : devices.map((device) => (
                <button key={device.id} type="button" disabled={busy} aria-pressed={deviceId === device.id}
                  onClick={() => void choose(device.id)}
                  className={cn("mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm transition-colors duration-fast hover:bg-secondary disabled:opacity-50",
                    deviceId === device.id && "bg-primary/10 text-primary")}>
                  <Cast className="h-4 w-4 shrink-0" /><span className="truncate">{device.name || "DLNA 播放设备"}</span>
                </button>
              ))}
          </div>
          {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
          {deviceId ? (
            <div className="mt-3 flex gap-2 border-t border-border pt-3">
              <button type="button" disabled={busy} onClick={() => void disconnect(false)}
                className="flex-1 rounded-lg bg-secondary px-3 py-2 text-xs transition-colors duration-fast hover:bg-secondary/80 disabled:opacity-50">断开投屏</button>
              <button type="button" disabled={busy} onClick={() => void disconnect(true)}
                className="flex-1 rounded-lg bg-primary px-3 py-2 text-xs text-primary-foreground transition-colors duration-fast hover:bg-primary/90 disabled:opacity-50">切回本机播放</button>
            </div>
          ) : null}
        </section>
      )}
    </Popover>
  );
}

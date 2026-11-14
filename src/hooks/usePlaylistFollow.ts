import { useEffect } from "react";
import { refreshDuePlaylistFollows } from "@/lib/playlist-follow";
import { useDisclaimerStore } from "@/stores/disclaimer";

export function usePlaylistFollow(): void {
  useEffect(() => {
    const check = (): void => {
      if (document.hidden) return;
      // Match the app's existing first-run network gate.
      if (useDisclaimerStore.getState().pending !== false) return;
      void refreshDuePlaylistFollows().catch(() => undefined);
    };
    const first = setTimeout(check, 30_000);
    const timer = setInterval(check, 60 * 60_000);
    document.addEventListener("visibilitychange", check);
    return () => { clearTimeout(first); clearInterval(timer); document.removeEventListener("visibilitychange", check); };
  }, []);
}

import { create } from "zustand";
import { getSetting, setSetting } from "@/services/ipc";
import { RECOMMENDATION_SOURCE_KEY } from "@/lib/storageKeys";

export type RecommendationFeature = "daily" | "fm";
export interface RecommendationSelection { origin: "app" | "account"; sourceId: string }
interface RecommendationSourceStore {
  daily: RecommendationSelection;
  fm: RecommendationSelection;
  loaded: boolean;
  dailyRevision: number;
  fmRevision: number;
  load: () => Promise<void>;
  setSelection: (feature: RecommendationFeature, selection: RecommendationSelection) => Promise<void>;
}
const appSelection = (): RecommendationSelection => ({ origin: "app", sourceId: "" });
function parseSelection(value: unknown): RecommendationSelection {
  if (!value || typeof value !== "object") return appSelection();
  const raw = value as Record<string, unknown>;
  const sourceId = typeof raw.sourceId === "string" ? raw.sourceId.trim() : "";
  return { origin: raw.origin === "account" && sourceId !== "" ? "account" : "app", sourceId };
}
let loading: Promise<void> | null = null;
let writeTail: Promise<void> = Promise.resolve();

export const useRecommendationSourceStore = create<RecommendationSourceStore>((set, get) => ({
  daily: appSelection(), fm: appSelection(), loaded: false, dailyRevision: 0, fmRevision: 0,
  load: () => {
    if (get().loaded) return Promise.resolve();
    if (loading) return loading;
    const { dailyRevision, fmRevision } = get();
    loading = (async () => {
      const stored = await getSetting(RECOMMENDATION_SOURCE_KEY);
      let parsed: Record<string, unknown> = {};
      try { const value: unknown = JSON.parse(stored ?? "{}"); if (value && typeof value === "object") parsed = value as Record<string, unknown>; } catch { /* Defaults preserve existing application behavior. */ }
      set({ loaded: true,
        ...(get().dailyRevision === dailyRevision ? { daily: parseSelection(parsed.daily) } : {}),
        ...(get().fmRevision === fmRevision ? { fm: parseSelection(parsed.fm) } : {}),
      });
    })().finally(() => { loading = null; });
    return loading;
  },
  setSelection: async (feature, value) => {
    // Begin hydration before the synchronous choice, so a slow read cannot overwrite it.
    const hydrated = get().load();
    const choice = parseSelection(value);
    const previous = get()[feature];
    if (!get().loaded || previous.origin !== choice.origin || previous.sourceId !== choice.sourceId) {
      const revisionKey = feature === "daily" ? "dailyRevision" : "fmRevision";
      set({ [feature]: choice, [revisionKey]: get()[revisionKey] + 1 });
    }
    await hydrated;
    const write = writeTail.then(async () => {
      const { daily, fm } = get();
      await setSetting(RECOMMENDATION_SOURCE_KEY, JSON.stringify({ v: 1, daily, fm }));
    });
    writeTail = write.catch(() => undefined);
    await write;
  },
}));

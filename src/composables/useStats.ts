import { useQuery } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import type { Stats, StatsRange } from "../../shared/types";
import { useTrafficStore } from "@/stores/traffic";

// Stats for the last 7 / 30 / 90 days (daily totals, top app, busiest day…) from the backend's SQLite
// history. Cached by TanStack Query and refreshed every 10 s while the page is visible.
export function useStats(days: Ref<StatsRange>) {
  const traffic = useTrafficStore();
  const query = useQuery({
    queryKey: computed(() => ["stats", days.value]),
    queryFn: async ({ queryKey }) => {
      const stats = (await window.tiny.api.call("getStats", { days: queryKey[1] })) as Stats;
      if (stats.topApp) traffic.absorbIcons([stats.topApp]);
      return stats.topApp ? { ...stats, topApp: { ...stats.topApp, icon: undefined } } : stats;
    },
    staleTime: 5_000,
    refetchInterval: 10_000,
  });

  const stats = computed(() => {
    const data = query.data.value;
    if (!data) return null;
    const peak = Math.max(1, ...data.days.map((d) => d.down + d.up));
    return {
      ...data,
      topApp: data.topApp ? { ...data.topApp, icon: traffic.icons[data.topApp.name] } : null,
      // each bar is the day's total traffic, split into upload (top) and download (below)
      bars: data.days.map((d) => {
        const total = d.down + d.up;
        return {
          ...d,
          total,
          pct: total > 0 ? Math.max(4, (total / peak) * 100) : 0,
          upPct: total > 0 ? (d.up / total) * 100 : 0,
        };
      }),
    };
  });
  return { stats, isLoading: query.isPending };
}

import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, onMounted, onUnmounted } from "vue";
import type { AppsPayload, Period, TopApp } from "../../shared/types";
import { useTrafficStore } from "@/stores/traffic";

const key = (period: Period) => ["top-apps", period] as const;
const withoutIcon = ({ icon: _icon, ...app }: TopApp): TopApp => app; // icons are cached separately

// Top apps for the selected period. Each period is cached by TanStack Query, so
// switching tabs shows the last result at once (and refetches when it is stale);
// the backend also pushes live updates for the visible tab straight into the cache.
export function useTopApps() {
  const traffic = useTrafficStore();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: computed(() => key(traffic.period)),
    queryFn: async ({ queryKey }) => {
      const { apps } = (await window.tiny.api.call("getApps", {
        period: queryKey[1],
      })) as AppsPayload;
      traffic.absorbIcons(apps);
      return apps.map(withoutIcon);
    },
    staleTime: 10_000,
  });

  let off: (() => void) | undefined;
  onMounted(() => {
    off = window.tiny?.api.on("apps", ({ period, apps }: AppsPayload) => {
      traffic.absorbIcons(apps);
      queryClient.setQueryData(key(period), apps.map(withoutIcon));
    });
  });
  onUnmounted(() => off?.());

  const apps = computed(() =>
    (query.data.value ?? []).map((app) => ({ ...app, icon: traffic.icons[app.name] })),
  );
  return { apps, isLoading: query.isPending };
}

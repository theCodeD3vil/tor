import { defineStore } from "pinia";
import { ref } from "vue";
import type { Period, Snapshot, TopApp, Traffic } from "../../shared/types";

// Live traffic pushed by the backend once a second (see backend/main.ts).
// The top-apps list lives in TanStack Query (src/composables/useTopApps.ts).
export const useTrafficStore = defineStore("traffic", () => {
  const rate = ref<Traffic>({ down: 0, up: 0 }); // bytes/s
  const today = ref<Traffic>({ down: 0, up: 0 }); // bytes so far today
  const series = ref<Snapshot["series"]>([]); // { id, down, up } bytes/s, 5 s each, oldest first

  const icons = ref<Record<string, string>>({}); // app name → data URL (the backend sends each icon once)
  const period = ref<Period>("today");

  function setPeriod(next: Period): void {
    period.value = next;
    void window.tiny?.api.call("setAppsPeriod", { period: next });
  }

  function absorbIcons(list: TopApp[]): void {
    for (const a of list) if (a.icon) icons.value[a.name] = a.icon;
  }

  function apply(snapshot: Snapshot): void {
    rate.value = snapshot.rate;
    today.value = snapshot.today;
    series.value = snapshot.series;
  }

  function listen() {
    // a (re)loaded page has an empty icon cache: ask for every icon again
    void window.tiny?.api.call("resetIcons");
    return window.tiny?.api.on("stats", apply);
  }

  return { rate, today, series, icons, period, setPeriod, absorbIcons, apply, listen };
});

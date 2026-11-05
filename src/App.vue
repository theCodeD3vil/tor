<script setup lang="ts">
import {
  IconActivity,
  IconArrowBigDownFilled,
  IconArrowBigUpFilled,
  IconFlame,
  IconArrowLeft,
  IconDownload,
  IconInfoCircle,
  IconSettings,
} from "@tabler/icons-vue";
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import type { Period, StatsRange } from "../shared/types";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatBytes, formatDay, formatRate } from "@/lib/format";
import logoUrl from "@/assets/logo.svg";
import UpdatePage from "@/pages/UpdatePage.vue";
import AboutPage from "@/pages/AboutPage.vue";
import SettingsPage from "@/pages/SettingsPage.vue";
import StatTile from "@/components/StatTile.vue";
import { Skeleton } from "@/components/ui/skeleton";
import { useUpdates } from "@/composables/useUpdates";
import { useAppearance } from "@/composables/useAppearance";
import { useStats } from "@/composables/useStats";
import { useTopApps } from "@/composables/useTopApps";
import { useSettingsStore } from "@/stores/settings";
import { useTrafficStore } from "@/stores/traffic";

const traffic = useTrafficStore();
const settingsStore = useSettingsStore();
useAppearance();
const rate = (bytesPerSec: number): string => formatRate(bytesPerSec, settingsStore.settings.unit);

let stopListening: (() => void) | undefined;
let stopOpened: (() => void) | undefined;
// reopening the popover always starts on the home page, without the slide
const instant = ref(false);
onMounted(() => {
  stopListening = traffic.listen();
  settingsStore.listen();
  stopOpened = window.tiny?.api.on("reset", async () => {
    instant.value = true;
    page.value = "home";
    await nextTick();
    instant.value = false;
  });
});
onUnmounted(() => {
  stopListening?.();
  stopOpened?.();
});

// two pages share the panel: the dashboard and settings, switched with a slide
type Page = "home" | "settings" | "about" | "update";
const page = ref<Page>("home");
// home → settings → about: going deeper slides forward, going up slides back
const DEPTH: Record<Page, number> = { home: 0, settings: 1, about: 2, update: 3 };
// the update page opens from any page and goes back to it
const cameFrom = ref<Page>("home");
const direction = ref<"page-forward" | "page-back">("page-forward");
const pageTransition = computed(() => (instant.value ? "page-instant" : direction.value));
const go = (next: Page): void => {
  if (next === "update") cameFrom.value = page.value;
  direction.value = DEPTH[next] > DEPTH[page.value] ? "page-forward" : "page-back";
  page.value = next;
};
const BACK: Record<Exclude<Page, "home">, () => Page> = {
  settings: () => "home",
  about: () => "settings",
  update: () => cameFrom.value,
};
const goBack = (): void => go(page.value === "home" ? "home" : BACK[page.value]());
const PAGE_TITLES: Record<Exclude<Page, "home">, string> = {
  settings: "Settings",
  about: "About Tor",
  update: "Update",
};
const pageTitle = computed(() => (page.value === "home" ? "" : PAGE_TITLES[page.value]));
const updates = useUpdates();

const BARS = 60;
// each half scales to its own peak, so a chip's value is the tallest bar above/below it
const peakUp = computed(() => Math.max(0, ...traffic.series.map((s) => s.up)));
const peakDown = computed(() => Math.max(0, ...traffic.series.map((s) => s.down)));
const pct = (rate: number, peak: number): number =>
  rate > 0 && peak > 0 ? Math.max(4, (rate / peak) * 100) : 0;

const { apps, isLoading } = useTopApps();
const statsDays = ref<StatsRange>(30);
const setStatsDays = (value: string | number): void => {
  statsDays.value = Number(value) as StatsRange;
};
const setPeriod = (value: string | number): void => traffic.setPeriod(value as Period);
const { stats, isLoading: statsLoading } = useStats(statsDays);
const statsRangeLabel = computed(() =>
  statsDays.value === 7 ? "7 days ago" : `${statsDays.value} days ago`,
);
const topUsage = computed(() => Math.max(1, ...apps.value.map((a) => a.down + a.up)));
const quit = () => window.tiny?.api.call("quit");

// click outside → close; only after the panel really had focus (it can blur while opening)
let hadFocus = false;
const onFocus = (): void => {
  hadFocus = true;
  // opening the popover must not park the focus ring on the tab bar
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
};
const onBlur = (): void => {
  if (!hadFocus) return;
  hadFocus = false;
  void window.tiny?.api.call("hidePopover");
};
onMounted(() => {
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
});
onUnmounted(() => {
  window.removeEventListener("focus", onFocus);
  window.removeEventListener("blur", onBlur);
});
</script>

<template>
  <main
    class="flex h-screen flex-col bg-transparent! text-foreground select-none dark:bg-black/55!"
  >
    <!-- sticky header: no border, no background -->
    <header class="relative h-14 shrink-0">
      <Transition name="chrome" mode="out-in">
        <div
          v-if="page === 'home'"
          key="home"
          class="absolute inset-0 flex items-center gap-2 px-4 pb-2"
        >
          <img :src="logoUrl" alt="" class="size-6 shrink-0" draggable="false" />
          <p class="text-sm font-semibold">Tor</p>
        </div>
        <div
          v-else
          :key="page"
          class="absolute inset-0 flex items-center justify-between px-4 pb-2"
        >
          <Button variant="ghost" size="icon-sm" aria-label="Back" @click="goBack">
            <IconArrowLeft class="size-4" />
          </Button>
          <p class="text-sm font-semibold">{{ pageTitle }}</p>
        </div>
      </Transition>
    </header>

    <div class="relative min-h-0 flex-1 overflow-hidden">
      <Transition :name="pageTransition" :css="!instant">
        <div
          v-if="page === 'home'"
          key="home"
          class="page no-scrollbar absolute inset-0 mx-4 flex flex-col gap-8 overflow-y-auto rounded-2xl"
        >
          <div class="flex flex-col gap-3">
            <section class="flex flex-col gap-3 rounded-2xl bg-foreground/5 p-4">
              <div class="grid grid-cols-2 gap-3">
                <div
                  class="flex items-center justify-between gap-2 rounded-xl bg-chart-2/25 px-3 py-2"
                >
                  <IconArrowBigUpFilled class="size-5 shrink-0 text-chart-2" />
                  <span class="text-sm font-semibold tabular-nums">
                    {{ rate(traffic.rate.up) }}
                  </span>
                </div>
                <div
                  class="flex items-center justify-between gap-2 rounded-xl bg-download/25 px-3 py-2"
                >
                  <IconArrowBigDownFilled class="size-5 shrink-0 text-download" />
                  <span class="text-sm font-semibold tabular-nums">
                    {{ rate(traffic.rate.down) }}
                  </span>
                </div>
              </div>

              <TransitionGroup tag="div" name="bar" class="relative flex h-24 overflow-hidden">
                <div
                  v-for="sample in traffic.series"
                  :key="sample.id"
                  class="bar flex h-full flex-col"
                  :style="{ flex: `0 0 ${100 / BARS}%` }"
                >
                  <div class="flex flex-1 items-end px-px">
                    <div
                      class="bar-fill w-full rounded-t-full bg-chart-2"
                      :style="{
                        height: `${pct(sample.up, peakUp)}%`,
                        minHeight: '2px',
                        opacity: sample.up > 0 ? 1 : 0.35,
                      }"
                    />
                  </div>
                  <div class="flex flex-1 items-start px-px">
                    <div
                      class="bar-fill w-full rounded-b-full bg-download"
                      :style="{
                        height: `${pct(sample.down, peakDown)}%`,
                        minHeight: '2px',
                        opacity: sample.down > 0 ? 1 : 0.35,
                      }"
                    />
                  </div>
                </div>
              </TransitionGroup>

              <div class="flex justify-between text-[10px] text-muted-foreground">
                <span>5 minutes ago</span>
                <span>now</span>
              </div>
            </section>

            <section class="grid grid-cols-2 gap-3">
              <StatTile
                :icon="IconArrowBigDownFilled"
                label="Downloaded"
                tone="download"
                :value="formatBytes(traffic.today.down)"
              />
              <StatTile
                :icon="IconArrowBigUpFilled"
                label="Uploaded"
                tone="upload"
                :value="formatBytes(traffic.today.up)"
              />
            </section>
          </div>

          <div class="flex flex-col gap-3">
            <div class="flex items-center justify-between">
              <p class="text-xs font-medium text-muted-foreground">Top apps</p>
              <Tabs :model-value="traffic.period" @update:model-value="setPeriod">
                <TabsList class="h-6 px-1.5 py-0.5">
                  <TabsTrigger
                    value="today"
                    class="px-1.5 text-[11px] data-active:border-transparent data-active:bg-foreground/[0.07] dark:data-active:border-transparent dark:data-active:bg-foreground/8"
                    >Today</TabsTrigger
                  >
                  <TabsTrigger
                    value="7d"
                    class="px-1.5 text-[11px] data-active:border-transparent data-active:bg-foreground/[0.07] dark:data-active:border-transparent dark:data-active:bg-foreground/8"
                    >7d</TabsTrigger
                  >
                  <TabsTrigger
                    value="30d"
                    class="px-1.5 text-[11px] data-active:border-transparent data-active:bg-foreground/[0.07] dark:data-active:border-transparent dark:data-active:bg-foreground/8"
                    >30d</TabsTrigger
                  >
                </TabsList>
              </Tabs>
            </div>
            <section class="rounded-2xl bg-foreground/5 p-4">
              <ul v-if="isLoading" class="flex flex-col gap-3.5" aria-busy="true">
                <li v-for="n in 6" :key="n" class="flex items-center gap-2.5">
                  <Skeleton class="size-8 shrink-0 rounded-lg" />
                  <div class="flex flex-1 flex-col gap-1.5">
                    <div class="flex justify-between gap-6">
                      <Skeleton class="h-3 flex-1 rounded-full" />
                      <Skeleton class="h-3 w-12 rounded-full" />
                    </div>
                    <Skeleton class="h-1.5 rounded-full" :style="{ width: `${100 - n * 12}%` }" />
                  </div>
                </li>
              </ul>
              <p v-else-if="!apps.length" class="py-2 text-xs text-muted-foreground">
                {{ traffic.period === "today" ? "Collecting usage…" : "No usage recorded yet" }}
              </p>
              <TransitionGroup v-else tag="ul" name="app" class="relative flex flex-col gap-3.5">
                <li v-for="app in apps" :key="app.name" class="app-row flex items-center gap-2.5">
                  <img
                    v-if="app.icon"
                    :src="app.icon"
                    alt=""
                    class="size-8 shrink-0 rounded-lg"
                    draggable="false"
                  />
                  <div
                    v-else
                    class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground/10 text-xs font-semibold"
                  >
                    {{ app.name.slice(0, 1) }}
                  </div>
                  <div class="flex min-w-0 flex-1 flex-col gap-1">
                    <div class="flex items-baseline justify-between gap-2 text-xs">
                      <span class="min-w-0 truncate font-medium">{{ app.name }}</span>
                      <span class="shrink-0 text-muted-foreground tabular-nums">
                        {{ formatBytes(app.down + app.up) }}
                      </span>
                    </div>
                    <div
                      class="flex h-1.5 overflow-hidden rounded-full transition-[width] duration-300"
                      :style="{
                        width: `${((app.down + app.up) / topUsage) * 100}%`,
                        minWidth: '6px',
                      }"
                    >
                      <div class="bg-download" :style="{ flex: app.down }" />
                      <div class="bg-chart-2" :style="{ flex: app.up }" />
                    </div>
                  </div>
                </li>
              </TransitionGroup>
            </section>
          </div>

          <div class="flex flex-col gap-3">
            <div class="flex items-center justify-between">
              <p class="text-xs font-medium text-muted-foreground">Stats</p>
              <Tabs :model-value="String(statsDays)" @update:model-value="setStatsDays">
                <TabsList class="h-6 px-1.5 py-0.5">
                  <TabsTrigger
                    value="7"
                    class="px-1.5 text-[11px] data-active:border-transparent data-active:bg-foreground/[0.07] dark:data-active:border-transparent dark:data-active:bg-foreground/8"
                    >7d</TabsTrigger
                  >
                  <TabsTrigger
                    value="30"
                    class="px-1.5 text-[11px] data-active:border-transparent data-active:bg-foreground/[0.07] dark:data-active:border-transparent dark:data-active:bg-foreground/8"
                    >30d</TabsTrigger
                  >
                  <TabsTrigger
                    value="90"
                    class="px-1.5 text-[11px] data-active:border-transparent data-active:bg-foreground/[0.07] dark:data-active:border-transparent dark:data-active:bg-foreground/8"
                    >90d</TabsTrigger
                  >
                </TabsList>
              </Tabs>
            </div>
            <section class="flex flex-col gap-3 rounded-2xl bg-foreground/5 p-4">
              <Skeleton v-if="statsLoading" class="h-20 rounded-lg" />
              <template v-else-if="stats">
                <div class="flex h-20 items-end">
                  <div
                    v-for="bar in stats.bars"
                    :key="bar.day"
                    class="flex h-full flex-1 items-end px-px"
                    :title="`${formatDay(bar.day)} · ↓ ${formatBytes(bar.down)} · ↑ ${formatBytes(bar.up)}`"
                  >
                    <div
                      class="bar-fill flex w-full flex-col overflow-hidden rounded-full"
                      :style="{
                        height: `${bar.pct}%`,
                        minHeight: '2px',
                        opacity: bar.total > 0 ? 1 : 0.35,
                      }"
                    >
                      <div class="bg-chart-2" :style="{ height: `${bar.upPct}%` }" />
                      <div class="min-h-0 flex-1 bg-download" />
                    </div>
                  </div>
                </div>
                <div class="flex justify-between text-[10px] text-muted-foreground">
                  <span>{{ statsRangeLabel }}</span>
                  <span>today</span>
                </div>
              </template>
            </section>

            <section class="grid grid-cols-2 gap-3">
              <template v-if="statsLoading || !stats">
                <Skeleton
                  v-for="n in 5"
                  :key="n"
                  class="h-20 rounded-2xl"
                  :class="{ 'col-span-2': n === 1 }"
                />
              </template>
              <template v-else>
                <div
                  class="col-span-2 flex flex-col items-start gap-3 rounded-2xl bg-foreground/5 p-4 text-left"
                >
                  <p class="text-[11px] font-medium text-muted-foreground">Most data used</p>
                  <div
                    v-if="stats.topApp"
                    class="flex w-full min-w-0 items-center justify-between gap-3"
                  >
                    <div class="flex min-w-0 items-center gap-2.5">
                      <img
                        v-if="stats.topApp.icon"
                        :src="stats.topApp.icon"
                        alt=""
                        class="size-8 shrink-0 rounded-lg"
                        draggable="false"
                      />
                      <div
                        v-else
                        class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground/10 text-xs font-semibold"
                      >
                        {{ stats.topApp.name.slice(0, 1) }}
                      </div>
                      <p class="truncate text-sm font-semibold">{{ stats.topApp.name }}</p>
                    </div>
                    <p class="shrink-0 text-3xl leading-none font-bold tracking-tight tabular-nums">
                      {{ formatBytes(stats.topApp.down + stats.topApp.up) }}
                    </p>
                  </div>
                  <p v-else class="text-xs text-muted-foreground">No usage recorded yet</p>
                </div>
                <StatTile
                  :icon="IconArrowBigDownFilled"
                  label="Downloaded"
                  tone="download"
                  :value="formatBytes(stats.totals.down)"
                />
                <StatTile
                  :icon="IconArrowBigUpFilled"
                  label="Uploaded"
                  tone="upload"
                  :value="formatBytes(stats.totals.up)"
                />
                <StatTile
                  :icon="IconFlame"
                  label="Busiest day"
                  tone="amber"
                  :value="stats.busiest ? formatBytes(stats.busiest.down + stats.busiest.up) : '—'"
                  :sub="stats.busiest ? formatDay(stats.busiest.day) : ''"
                />
                <StatTile
                  :icon="IconActivity"
                  label="Daily average"
                  tone="violet"
                  :value="formatBytes(stats.avgPerDay)"
                  sub="on active days"
                />
              </template>
            </section>
          </div>
        </div>
        <SettingsPage
          v-else-if="page === 'settings'"
          key="settings"
          class="page no-scrollbar absolute inset-0 mx-4 overflow-y-auto rounded-2xl"
        />
        <AboutPage
          v-else-if="page === 'about'"
          key="about"
          class="page no-scrollbar absolute inset-0 mx-4 overflow-y-auto rounded-2xl"
        />
        <UpdatePage
          v-else
          key="update"
          class="page no-scrollbar absolute inset-0 mx-4 overflow-y-auto rounded-2xl"
        />
      </Transition>
    </div>

    <!-- sticky footer: no border, no background -->
    <footer class="relative h-14 shrink-0">
      <Transition name="chrome" mode="out-in">
        <div
          v-if="page === 'home'"
          key="home"
          class="absolute inset-0 flex items-center justify-end gap-1 px-4 pt-2"
        >
          <Button variant="ghost" size="icon-sm" aria-label="Settings" @click="go('settings')">
            <IconSettings class="size-4" />
          </Button>
          <Button variant="ghost" size="sm" @click="quit">Quit</Button>
        </div>
        <div
          v-else-if="page === 'settings'"
          key="settings"
          class="absolute inset-0 flex items-center justify-end gap-2 px-4 pt-2"
        >
          <span class="text-xs text-muted-foreground tabular-nums">{{
            settingsStore.version
          }}</span>
          <Button variant="ghost" size="icon-sm" aria-label="About" @click="go('about')">
            <IconInfoCircle class="size-4" />
          </Button>
        </div>
        <div
          v-else-if="page === 'update'"
          key="update"
          class="absolute inset-0 flex items-center justify-end px-4 pt-2"
        >
          <Button size="sm" :disabled="updates.isInstalling.value" @click="updates.install()">
            {{ updates.isInstalling.value ? "Installing…" : "Install and restart" }}
          </Button>
        </div>
        <div v-else key="about" class="absolute inset-0" />
      </Transition>
      <!-- stays put while the pages slide; the update page has its own install button -->
      <Transition name="chrome">
        <button
          v-if="updates.available.value && page !== 'update'"
          type="button"
          class="absolute inset-y-0 left-4 my-auto flex h-7 translate-y-1 items-center gap-1.5 rounded-full bg-download/20 px-2.5 text-xs font-medium text-download outline-none transition-colors hover:bg-download/30 focus-visible:ring-2 focus-visible:ring-ring"
          @click="go('update')"
        >
          <IconDownload class="size-3.5" />
          Update available
        </button>
      </Transition>
    </footer>
  </main>
</template>

<style>
html,
body {
  background: transparent !important;
}

.no-scrollbar {
  scrollbar-width: none;
}
.no-scrollbar::-webkit-scrollbar {
  display: none;
}

/* chart: bars grow smoothly, and slide left when a new 5 s bucket starts */
.bar-fill {
  transition:
    height 0.6s cubic-bezier(0.22, 1, 0.36, 1),
    opacity 0.3s;
}
.bar-move,
.bar-enter-active,
.bar-leave-active {
  transition:
    transform 0.5s cubic-bezier(0.22, 1, 0.36, 1),
    opacity 0.5s;
}
.bar-enter-from {
  opacity: 0;
  transform: translateX(100%);
}
.bar-leave-to {
  opacity: 0;
}
.bar-leave-active {
  position: absolute;
}

/* header and footer content cross-fades while the page slides */
.chrome-enter-active,
.chrome-leave-active {
  transition: opacity 0.18s ease;
}
.chrome-enter-from,
.chrome-leave-to {
  opacity: 0;
}

/* pages: the dashboard and settings slide past each other */
.page {
  transition:
    transform 0.35s cubic-bezier(0.22, 1, 0.36, 1),
    opacity 0.35s cubic-bezier(0.22, 1, 0.36, 1);
}
.page-forward-enter-from,
.page-back-leave-to {
  opacity: 0;
  transform: translateX(100%);
}
.page-forward-leave-to,
.page-back-enter-from {
  opacity: 0;
  transform: translateX(-100%);
}

/* top apps: rows glide to their new rank, new ones fade in, dropped ones fade out */
.app-move,
.app-enter-active,
.app-leave-active {
  transition:
    transform 0.45s cubic-bezier(0.22, 1, 0.36, 1),
    opacity 0.3s;
}
.app-enter-from,
.app-leave-to {
  opacity: 0;
  transform: scale(0.96);
}
.app-leave-active {
  position: absolute;
  left: 0;
  right: 0;
}
</style>

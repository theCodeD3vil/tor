<script setup lang="ts">
import { computed } from "vue";
import ReleaseNotes from "@/components/ReleaseNotes.vue";
import { useUpdates } from "@/composables/useUpdates";
import { formatBytes } from "@/lib/format";

const updates = useUpdates();
const status = computed(() => updates.status.data.value);

// null = the server sent no size, so the bar can't show a fraction; until the first
// bytes arrive the bar is simply empty rather than indeterminate
const percent = computed(() => {
  const p = updates.progress.value;
  if (!p) return null;
  if (p.total) return Math.min(100, Math.round((p.received / p.total) * 100));
  return p.received === 0 ? 0 : null;
});
</script>

<template>
  <div class="grid content-start gap-y-4 pt-3 pb-1">
    <div v-if="status" class="grid gap-0.5">
      <h2 class="text-base font-semibold tracking-tight">Tor {{ status.latest }}</h2>
      <p class="text-xs text-muted-foreground">You have {{ status.current }}</p>
    </div>

    <div v-if="updates.progress.value" class="grid gap-1.5 rounded-2xl bg-foreground/5 p-4">
      <div class="flex items-baseline justify-between text-xs text-muted-foreground tabular-nums">
        <span>Downloading…</span>
        <span>
          {{ formatBytes(updates.progress.value.received) }}
          <template v-if="updates.progress.value.total">
            / {{ formatBytes(updates.progress.value.total) }}
          </template>
        </span>
      </div>
      <div class="h-1.5 overflow-hidden rounded-full bg-foreground/10">
        <div
          class="h-full rounded-full bg-download transition-[width] duration-200"
          :class="percent === null && 'w-1/3 animate-pulse'"
          :style="percent !== null ? { width: `${percent}%` } : undefined"
        />
      </div>
    </div>

    <div class="rounded-2xl bg-foreground/5 p-4">
      <ReleaseNotes v-if="status?.notes" :markdown="status.notes" />
      <p v-else class="text-xs text-muted-foreground">No release notes for this version.</p>
    </div>
  </div>
</template>

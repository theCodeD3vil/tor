<script setup lang="ts">
import { computed, type Component } from "vue";

const props = withDefaults(
  defineProps<{
    icon: Component;
    label: string;
    /** "9.2 GB" — the unit is rendered smaller */
    value: string;
    sub?: string;
    tone?: "download" | "upload" | "amber" | "violet";
  }>(),
  { sub: "", tone: "download" },
);

const TONES: Record<string, string> = {
  download: "bg-download/25 text-download",
  upload: "bg-chart-2/25 text-chart-2",
  amber: "bg-amber-400/25 text-amber-500",
  violet: "bg-violet-400/25 text-violet-500",
};
const badge = computed(() => TONES[props.tone] ?? TONES.download);
const parts = computed((): [string, string] => {
  const i = props.value.lastIndexOf(" ");
  return i < 0 ? [props.value, ""] : [props.value.slice(0, i), props.value.slice(i + 1)];
});
const amount = computed(() => parts.value[0]);
const unit = computed(() => parts.value[1]);
</script>

<template>
  <div class="flex flex-col gap-3 rounded-2xl bg-foreground/5 p-4">
    <div class="flex items-center justify-between gap-2">
      <span class="text-[11px] font-medium text-muted-foreground">{{ label }}</span>
      <span class="flex size-6 items-center justify-center rounded-lg" :class="badge">
        <component :is="icon" class="size-3.5" />
      </span>
    </div>
    <p class="text-xl leading-none font-semibold tracking-tight tabular-nums">
      {{ amount }}<span class="ml-1 text-xs font-medium text-muted-foreground">{{ unit }}</span>
    </p>
    <p v-if="sub" class="-mt-1 text-[11px] text-muted-foreground tabular-nums">{{ sub }}</p>
  </div>
</template>

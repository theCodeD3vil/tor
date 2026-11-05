<script setup lang="ts">
import { IconArrowDown, IconArrowUp, IconBan } from "@tabler/icons-vue";
import { LOGO_PATH, LOGO_VIEWBOX } from "../../../shared/logo";
import type { MenubarIcon } from "../../../shared/settings";

defineProps<{ icon: MenubarIcon }>();

// bar height (px) and how much of it is upload, like the real menubar bars
const BARS = [
  { h: 6, up: 0.3 },
  { h: 10, up: 0.25 },
  { h: 4, up: 0 },
  { h: 16, up: 0.4 },
  { h: 12, up: 0.15 },
];
</script>

<template>
  <span class="flex h-4 w-8 shrink-0 items-end justify-center" aria-hidden="true">
    <span v-if="icon === 'bars'" class="flex h-4 items-end gap-0.5">
      <span
        v-for="(bar, i) in BARS"
        :key="i"
        class="flex w-1 flex-col overflow-hidden rounded-full"
        :style="{ height: `${bar.h}px` }"
      >
        <span class="bg-chart-2" :style="{ flex: bar.up }" />
        <span class="bg-download" :style="{ flex: 1 - bar.up }" />
      </span>
    </span>
    <span v-else-if="icon === 'arrows'" class="flex h-4 items-center">
      <IconArrowUp class="size-4 text-chart-2" :stroke-width="2.5" />
      <IconArrowDown class="-ml-1 size-4 text-download" :stroke-width="2.5" />
    </span>
    <!-- the menubar logo is a one-color silhouette: filled with the text color -->
    <svg
      v-else-if="icon === 'logo'"
      class="size-4 self-center text-foreground"
      :viewBox="`0 0 ${LOGO_VIEWBOX} ${LOGO_VIEWBOX}`"
    >
      <path :d="LOGO_PATH" fill="currentColor" />
    </svg>
    <IconBan v-else class="size-4 self-center text-muted-foreground" />
  </span>
</template>

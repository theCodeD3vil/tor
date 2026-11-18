<script setup lang="ts">
import { computed } from "vue";
import { bundledIcon } from "@/lib/bundledIcons";

// An app's icon: the one the backend rendered, else a logo shipped with the page, else
// the first letter of its name on a plain tile. Size and corner radius come from the caller.
const props = defineProps<{ name: string; src?: string | null }>();
const url = computed(() => props.src || bundledIcon(props.name));
</script>

<template>
  <img v-if="url" :src="url" alt="" class="shrink-0" draggable="false" />
  <div
    v-else
    class="flex shrink-0 items-center justify-center bg-foreground/10 text-xs font-semibold"
  >
    {{ name.slice(0, 1) }}
  </div>
</template>

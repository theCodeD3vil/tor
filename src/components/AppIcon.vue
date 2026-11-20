<script setup lang="ts">
import { computed } from "vue";
import opencode from "@/assets/opencode.png";

const props = defineProps<{ name: string; src?: string | null }>();
const url = computed(() => props.src || (props.name === "OpenCode" ? opencode : null));
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

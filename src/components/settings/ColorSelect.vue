<script setup lang="ts">
import { computed } from "vue";
import { COLOR_PRESETS, type ColorId } from "../../../shared/settings";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

defineProps<{ label: string }>();
const model = defineModel<ColorId>({ required: true });
const selected = computed(
  () => COLOR_PRESETS.find((c) => c.id === model.value) ?? COLOR_PRESETS[0],
);
</script>

<template>
  <Select v-model="model">
    <SelectTrigger size="sm" class="w-32" :aria-label="label">
      <SelectValue>
        <span class="flex items-center gap-2">
          <span class="size-3.5 shrink-0 rounded-full" :style="{ backgroundColor: selected.hex }" />
          {{ selected.name }}
        </span>
      </SelectValue>
    </SelectTrigger>
    <SelectContent>
      <SelectItem v-for="color in COLOR_PRESETS" :key="color.id" :value="color.id">
        <span class="flex items-center gap-2">
          <span class="size-3.5 shrink-0 rounded-full" :style="{ backgroundColor: color.hex }" />
          {{ color.name }}
        </span>
      </SelectItem>
    </SelectContent>
  </Select>
</template>

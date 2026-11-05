<script setup lang="ts">
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
</script>

<template>
  <Select v-model="model">
    <SelectTrigger size="sm" class="w-32" :aria-label="label">
      <SelectValue />
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

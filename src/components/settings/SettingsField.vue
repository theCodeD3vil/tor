<script setup lang="ts">
defineProps<{ disabled?: boolean }>();
</script>

<template>
  <!-- a disabled fieldset disables every control inside it, whatever the slot holds -->
  <fieldset :disabled="disabled" class="min-w-0 disabled:opacity-50">
    <div class="flex items-center justify-between gap-4 px-4 py-3">
      <div class="grid gap-0.5">
        <span class="text-sm font-medium text-foreground/90">
          <slot name="label" />
        </span>
        <span v-if="$slots.description" class="text-xs text-muted-foreground">
          <slot name="description" />
        </span>
      </div>
      <!-- the control: tabs, select, switch… -->
      <slot />
    </div>
    <!-- full-width extra below the row -->
    <div v-if="$slots.footer" class="px-4 pb-3">
      <slot name="footer" />
    </div>
  </fieldset>
</template>

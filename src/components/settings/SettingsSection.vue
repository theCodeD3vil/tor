<template>
  <section class="grid content-start gap-y-3">
    <h3 class="text-xs font-medium text-muted-foreground">
      <slot name="section-title" />
    </h3>
    <!-- one SettingsField per setting; divide-y separates however many there are -->
    <div class="grid divide-y divide-foreground/10 rounded-2xl bg-foreground/5">
      <slot />
    </div>
  </section>
</template>

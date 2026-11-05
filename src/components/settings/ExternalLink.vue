<script setup lang="ts">
import { IconExternalLink } from "@tabler/icons-vue";
import { Button } from "@/components/ui/button";

const props = defineProps<{ name: string; url: string }>();

// opens in the default browser; the popover can't navigate away
function openLink(): void {
  void window.tiny?.app.shell.open(props.url);
}
</script>

<template>
  <Button
    variant="ghost"
    size="sm"
    class="-mr-2 text-muted-foreground"
    :aria-label="`Open ${url}`"
    :title="url"
    @click="openLink"
  >
    {{ name }}
    <IconExternalLink class="size-3.5" />
  </Button>
</template>

<script setup lang="ts">
import { IconExternalLink } from "@tabler/icons-vue";
import { Button } from "@/components/ui/button";

const props = defineProps<{ name: string; url: string }>();

// opens in the default browser; the popover can't navigate away
function openLink(): void {
  let url: URL;
  try {
    url = new URL(props.url);
  } catch {
    return;
  }
  if (url.protocol !== "https:") return;
  void window.tiny?.api.call("openExternalLink", { url: url.href });
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

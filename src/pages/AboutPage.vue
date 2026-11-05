<script setup lang="ts">
import ExternalLink from "@/components/settings/ExternalLink.vue";
import SettingsField from "@/components/settings/SettingsField.vue";
import SettingsSection from "@/components/settings/SettingsSection.vue";
import { useSettingsStore } from "@/stores/settings";

const store = useSettingsStore();
</script>

<template>
  <div class="grid content-start gap-y-8 pt-3 pb-1">
    <SettingsSection>
      <template #section-title>About</template>

      <SettingsField>
        <template #label>Version</template>
        <span class="text-sm text-muted-foreground tabular-nums">{{ store.version }}</span>
      </SettingsField>

      <SettingsField>
        <template #label>Made by</template>
        <ExternalLink name="c0d3v1l" url="https://michaelnji.codes" />
      </SettingsField>
    </SettingsSection>

    <SettingsSection>
      <template #section-title>Credits</template>

      <SettingsField>
        <template #label>Logo</template>
        <ExternalLink name="coolshap.es" url="https://coolshap.es" />
      </SettingsField>

      <SettingsField>
        <template #label>Built with</template>
        <ExternalLink name="tinyjs" url="https://tinyjs.app" />
      </SettingsField>
    </SettingsSection>
  </div>
</template>

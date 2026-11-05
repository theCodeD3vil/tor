<script setup lang="ts">
import { IconDeviceDesktop, IconMoon, IconSun } from "@tabler/icons-vue";
import { computed } from "vue";
import type {
  ColorId,
  MenubarIcon,
  MenubarValue,
  SpeedUnit,
  ThemeMode,
  TopAppsCount,
  UpdateFrequency,
} from "../../shared/settings";
import MenubarIconPreview from "@/components/settings/MenubarIconPreview.vue";
import ColorSelect from "@/components/settings/ColorSelect.vue";
import SettingsField from "@/components/settings/SettingsField.vue";
import SettingsSection from "@/components/settings/SettingsSection.vue";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { useUpdates } from "@/composables/useUpdates";
import { useSettingsStore } from "@/stores/settings";

const store = useSettingsStore();
const updates = useUpdates();

// the button doubles as the status: what the last check found
const checkLabel = computed(() => {
  if (updates.isChecking.value) return "Checking…";
  switch (updates.status.data.value?.state) {
    case "up-to-date":
      return "Up to date";
    case "error":
      return "Try again";
    case "unsupported":
      return "Unavailable";
    default:
      return "Check now";
  }
});

const autoUpdates = computed({
  get: () => store.settings.autoUpdates,
  set: (value: boolean) => store.update({ autoUpdates: value }),
});
const updateFrequency = computed({
  get: () => store.settings.updateFrequency,
  set: (value: UpdateFrequency) => store.update({ updateFrequency: value }),
});

const unit = computed({
  get: () => store.settings.unit,
  set: (value: SpeedUnit) => store.update({ unit: value }),
});
// Select values are strings, so the count goes through a string
const topApps = computed({
  get: () => String(store.settings.topApps),
  set: (value: string) => store.update({ topApps: Number(value) as TopAppsCount }),
});
const theme = computed({
  get: () => store.settings.theme,
  set: (value: ThemeMode) => store.update({ theme: value }),
});
const downloadColor = computed({
  get: () => store.settings.downloadColor,
  set: (value: ColorId) => store.update({ downloadColor: value }),
});
const uploadColor = computed({
  get: () => store.settings.uploadColor,
  set: (value: ColorId) => store.update({ uploadColor: value }),
});
const menubarIcon = computed({
  get: () => store.settings.menubarIcon,
  set: (value: MenubarIcon) => store.update({ menubarIcon: value }),
});
const menubarValue = computed({
  get: () => store.settings.menubarValue,
  set: (value: MenubarValue) => store.update({ menubarValue: value }),
});

const tabClass =
  "px-1.5 text-[11px] data-active:border-transparent data-active:bg-foreground/[0.07] dark:data-active:border-transparent dark:data-active:bg-foreground/8";

const iconOptions: { value: MenubarIcon; label: string }[] = [
  { value: "bars", label: "Bars" },
  { value: "arrows", label: "Arrows" },
  { value: "logo", label: "Tor logo" },
  { value: "none", label: "Nothing" },
];
const valueOptions: { value: MenubarValue; label: string }[] = [
  { value: "download", label: "Download speed" },
  { value: "upload", label: "Upload speed" },
  { value: "both", label: "Both speeds" },
  { value: "total-download", label: "Total downloaded" },
  { value: "total-upload", label: "Total uploaded" },
  { value: "net-total", label: "Net total" },
];
</script>

<template>
  <div class="grid content-start gap-y-8 pt-3 pb-1">
    <SettingsSection>
      <template #section-title>General</template>

      <SettingsField>
        <template #label>Unit</template>
        <Tabs v-model="unit">
          <TabsList class="h-6 px-1.5 py-0.5">
            <TabsTrigger value="MBps" :class="tabClass">MB/s</TabsTrigger>
            <TabsTrigger value="Mbps" :class="tabClass">Mbps</TabsTrigger>
          </TabsList>
        </Tabs>
      </SettingsField>

      <SettingsField>
        <template #label>Top apps</template>
        <Select v-model="topApps">
          <SelectTrigger size="sm" class="w-20">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="5">5</SelectItem>
            <SelectItem value="10">10</SelectItem>
            <SelectItem value="20">20</SelectItem>
          </SelectContent>
        </Select>
      </SettingsField>
    </SettingsSection>

    <SettingsSection>
      <template #section-title>Appearance</template>

      <SettingsField>
        <template #label>Theme</template>
        <Tabs v-model="theme">
          <TabsList class="h-6 px-1.5 py-0.5">
            <TabsTrigger value="light" aria-label="Light" title="Light" :class="tabClass">
              <IconSun class="size-3.5" />
            </TabsTrigger>
            <TabsTrigger value="dark" aria-label="Dark" title="Dark" :class="tabClass">
              <IconMoon class="size-3.5" />
            </TabsTrigger>
            <TabsTrigger value="system" aria-label="System" title="System" :class="tabClass">
              <IconDeviceDesktop class="size-3.5" />
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </SettingsField>

      <SettingsField>
        <template #label>Download color</template>
        <ColorSelect v-model="downloadColor" label="Download color" />
      </SettingsField>

      <SettingsField>
        <template #label>Upload color</template>
        <ColorSelect v-model="uploadColor" label="Upload color" />
      </SettingsField>
    </SettingsSection>

    <SettingsSection>
      <template #section-title>Menubar</template>

      <SettingsField>
        <template #label>Icon</template>
        <Select v-model="menubarIcon">
          <SelectTrigger size="sm" class="w-40">
            <SelectValue>
              <span class="flex items-center gap-2">
                <MenubarIconPreview :icon="menubarIcon" />
                {{ iconOptions.find((o) => o.value === menubarIcon)?.label }}
              </span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="o in iconOptions" :key="o.value" :value="o.value">
              <span class="flex items-center gap-2">
                <MenubarIconPreview :icon="o.value" />
                {{ o.label }}
              </span>
            </SelectItem>
          </SelectContent>
        </Select>
      </SettingsField>

      <SettingsField>
        <template #label>Value</template>
        <Select v-model="menubarValue">
          <SelectTrigger size="sm" class="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="o in valueOptions" :key="o.value" :value="o.value">
              {{ o.label }}
            </SelectItem>
          </SelectContent>
        </Select>
      </SettingsField>
    </SettingsSection>

    <SettingsSection>
      <template #section-title>Updates</template>

      <SettingsField>
        <template #label>Check for updates</template>
        <Button
          v-if="updates.available.value"
          size="sm"
          :disabled="updates.isInstalling.value"
          @click="updates.install()"
        >
          {{ updates.isInstalling.value ? "Installing…" : "Install and restart" }}
        </Button>
        <Button
          v-else
          variant="outline"
          size="sm"
          :disabled="updates.isChecking.value || updates.status.data.value?.state === 'unsupported'"
          @click="updates.check()"
        >
          {{ checkLabel }}
        </Button>
      </SettingsField>

      <SettingsField>
        <template #label>Automatic checks</template>
        <Switch v-model="autoUpdates" aria-label="Automatic update checks" />
      </SettingsField>

      <SettingsField :disabled="!autoUpdates">
        <template #label>Frequency</template>
        <Select v-model="updateFrequency" :disabled="!autoUpdates">
          <SelectTrigger size="sm" class="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="daily">Daily</SelectItem>
            <SelectItem value="weekly">Weekly</SelectItem>
            <SelectItem value="monthly">Monthly</SelectItem>
          </SelectContent>
        </Select>
      </SettingsField>
    </SettingsSection>
  </div>
</template>

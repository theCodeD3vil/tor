<script setup lang="ts">
import { iconURL } from "@/stores/traffic";
import { IconDeviceDesktop, IconMoon, IconSun, IconX } from "@tabler/icons-vue";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import type { TopApp } from "../../shared/types";
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

const emit = defineEmits<{ openUpdate: [] }>();
const store = useSettingsStore();
const updates = useUpdates();
const queryClient = useQueryClient();

// the hidden apps with their icons; refetched when the list changes
const ignored = useQuery({
  queryKey: computed(() => ["ignored-apps", store.settings.ignoredApps.join("|")]),
  queryFn: async () =>
    ((await window.tiny.api.call("getIgnoredApps")) as TopApp[]).map((a) => ({
      ...a,
      icon: a.icon ? iconURL(a.icon) : a.icon,
    })),
  staleTime: 1_000,
  // icons load in the background: ask again while any is missing
  refetchInterval: (query) => (query.state.data?.some((a) => !a.icon) ? 1_000 : false),
});

// an app shown again counts in the list and the totals at once
const showApp = async (name: string): Promise<void> => {
  await store.unignoreApp(name);
  await queryClient.invalidateQueries({ queryKey: ["top-apps"] });
  await queryClient.invalidateQueries({ queryKey: ["stats"] });
};

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
      <template #section-title>Ignored apps</template>

      <p v-if="!store.settings.ignoredApps.length" class="px-4 py-3 text-xs text-muted-foreground">
        No hidden apps
      </p>
      <!-- one row per hidden app, divided like the settings fields -->
      <div
        v-for="app in ignored.data.value ?? []"
        v-else
        :key="app.name"
        class="flex items-center gap-2.5 px-4 py-2.5"
      >
        <img
          v-if="app.icon"
          :src="app.icon"
          alt=""
          class="size-7 shrink-0 rounded-md"
          draggable="false"
        />
        <div
          v-else
          class="flex size-7 shrink-0 items-center justify-center rounded-md bg-foreground/10 text-xs font-semibold"
        >
          {{ app.name.slice(0, 1) }}
        </div>
        <span class="min-w-0 flex-1 truncate text-sm font-medium text-foreground/90">
          {{ app.name }}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          :aria-label="`Show ${app.name} again`"
          :title="`Show ${app.name} again`"
          @click="showApp(app.name)"
        >
          <IconX class="size-4" />
        </Button>
      </div>
    </SettingsSection>

    <SettingsSection>
      <template #section-title>Updates</template>

      <SettingsField>
        <template #label>Check for updates</template>
        <!-- opens the update page (release notes), where the install button lives -->
        <Button v-if="updates.available.value" size="sm" @click="emit('openUpdate')">
          Download update
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

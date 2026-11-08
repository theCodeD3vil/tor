import { defineStore } from "pinia";
import { ref } from "vue";
import { defaultSettings, type Settings } from "../../shared/settings";

// User settings, persisted by the backend (backend/settings.ts). Edits apply here at
// once and are then saved.
export const useSettingsStore = defineStore("settings", () => {
  const settings = ref<Settings>({ ...defaultSettings });
  const version = ref("");

  function update(changes: Partial<Settings>): Promise<unknown> {
    settings.value = { ...settings.value, ...changes };
    return window.tiny?.api.call("updateSettings", changes) ?? Promise.resolve();
  }

  // hide an app from Top apps and the totals (it keeps being recorded), or show it again
  function ignoreApp(name: string): Promise<unknown> {
    if (settings.value.ignoredApps.includes(name)) return Promise.resolve();
    return update({ ignoredApps: [...settings.value.ignoredApps, name] });
  }
  function unignoreApp(name: string): Promise<unknown> {
    return update({ ignoredApps: settings.value.ignoredApps.filter((n) => n !== name) });
  }

  async function load(): Promise<void> {
    if (!window.tiny) return;
    settings.value = {
      ...defaultSettings,
      ...((await window.tiny.api.call("getSettings")) as Settings),
    };
    version.value = (await window.tiny.api.call("getVersion")) as string;
  }

  // edits are applied here first, so there is nothing to listen for: just load once
  function listen(): void {
    void load();
  }

  return { settings, version, update, ignoreApp, unignoreApp, listen };
});

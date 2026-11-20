import { defineStore } from "pinia";
import { ref } from "vue";
import { defaultSettings, type Settings } from "../../shared/settings";
import { appId } from "../../shared/types";

// User settings, persisted by the backend (backend/settings.ts). Edits apply here at
// once and are then saved.
export const useSettingsStore = defineStore("settings", () => {
  const settings = ref<Settings>({ ...defaultSettings });
  const version = ref("");

  async function update(changes: Partial<Settings>): Promise<void> {
    const previous = settings.value;
    settings.value = { ...settings.value, ...changes };
    const optimistic = settings.value;
    if (!window.tiny) return;
    try {
      const saved = (await window.tiny.api.call("updateSettings", changes)) as Settings;
      if (settings.value === optimistic) settings.value = saved;
    } catch (err) {
      const committed = (await window.tiny.api
        .call("getSettings")
        .catch(() => previous)) as Settings;
      if (settings.value === optimistic) settings.value = committed;
      console.error("tor settings:", err);
    }
  }

  // hide an app from Top apps and the totals (it keeps being recorded), or show it again
  function ignoreApp(name: string, bundle = ""): Promise<unknown> {
    const app = { name, bundle };
    const ignoredApps = settings.value.ignoredApps;
    if (ignoredApps.some((other) => appId(other) === appId(app))) return Promise.resolve();
    return update({ ignoredApps: [...ignoredApps, app] });
  }
  function unignoreApp(id: string): Promise<unknown> {
    return update({ ignoredApps: settings.value.ignoredApps.filter((app) => appId(app) !== id) });
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

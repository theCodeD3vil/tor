import { usePreferredDark } from "@vueuse/core";
import { computed, watchEffect } from "vue";
import { colorHex } from "../../shared/settings";
import { useSettingsStore } from "@/stores/settings";

// Applies the theme (light / dark / system) and the download / upload colors to the page.
export function useAppearance() {
  const store = useSettingsStore();
  const systemDark = usePreferredDark();
  const isDark = computed(
    () =>
      store.settings.theme === "dark" || (store.settings.theme === "system" && systemDark.value),
  );

  watchEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", isDark.value);
    root.style.setProperty("--download", colorHex(store.settings.downloadColor));
    root.style.setProperty("--chart-2", colorHex(store.settings.uploadColor));
  });

  // The native window material follows the system, not the page. When the chosen theme
  // differs from the system's, the page paints its own solid background so the material
  // can't tint it (a translucent wash over a mismatched material just turns murky).
  const solid = computed(() => {
    if (store.settings.theme === "system" || isDark.value === systemDark.value) return "";
    return isDark.value ? "#161616" : "#f7f7f7";
  });
  watchEffect(() => {
    const root = document.documentElement;
    if (solid.value) root.style.setProperty("background-color", solid.value, "important");
    else root.style.removeProperty("background-color");
  });

  return { isDark };
}

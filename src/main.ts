import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { createPinia } from "pinia";
import { createApp } from "vue";
import "./style.css";
import App from "./App.vue";
import { disableBrowserBehaviorInProduction } from "./lib/browser-behavior";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { gcTime: 30 * 60_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

disableBrowserBehaviorInProduction();
createApp(App).use(createPinia()).use(VueQueryPlugin, { queryClient }).mount("#app");

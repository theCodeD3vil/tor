import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { defineStore } from "pinia";
import { computed, onMounted, ref } from "vue";
import type { UpdateProgress, UpdateStatus } from "../../shared/types";

const KEY = ["update-status"];

// One store for every page. Three useUpdates() calls used to each own a
// mutation and each subscribe to the same IPC events.
const useUpdateStore = defineStore("updates", () => {
  const queryClient = useQueryClient();
  const progress = ref<UpdateProgress | null>(null);
  const installError = ref(false);

  const status = useQuery({
    queryKey: KEY,
    queryFn: async () => (await window.tiny.api.call("getUpdateStatus")) as UpdateStatus,
    staleTime: 0,
  });

  const check = useMutation({
    mutationFn: async () => (await window.tiny.api.call("checkForUpdates")) as UpdateStatus,
    onSuccess: (next) => queryClient.setQueryData(KEY, next),
  });
  const install = useMutation({
    mutationFn: async () => {
      await window.tiny.api.call("installUpdate");
    },
    onError: () => {
      progress.value = null;
      installError.value = true;
    },
  });

  let listening = false;
  function listen(): void {
    if (listening || !window.tiny) return;
    listening = true;
    window.tiny.api.on("update-status", (next: UpdateStatus) =>
      queryClient.setQueryData(KEY, next),
    );
    window.tiny.api.on("update-progress", (next: UpdateProgress) => {
      progress.value = next;
    });
  }

  return {
    status,
    progress,
    installError,
    check: () => check.mutate(),
    install: () => {
      if (install.isPending.value) return;
      installError.value = false;
      progress.value = { received: 0, total: null };
      install.mutate();
    },
    isChecking: check.isPending,
    isInstalling: install.isPending,
    available: computed(() => status.data.value?.state === "available"),
    listen,
  };
});

/** shared update state; listeners are registered once */
export function useUpdates() {
  const store = useUpdateStore();
  onMounted(() => store.listen());
  return store;
}

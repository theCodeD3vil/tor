import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { UpdateProgress, UpdateStatus } from "../../shared/types";

const KEY = ["update-status"];

// shared, so the update page can show the bar while the footer button runs the install
const progress = ref<UpdateProgress | null>(null);

// Update state for the Settings page: the status the backend knows (it also checks in
// the background and pushes the result), a manual "check now" and "install".
export function useUpdates() {
  const queryClient = useQueryClient();

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
  });

  let offStatus: (() => void) | undefined;
  let offProgress: (() => void) | undefined;
  onMounted(() => {
    offStatus = window.tiny?.api.on("update-status", (next: UpdateStatus) =>
      queryClient.setQueryData(KEY, next),
    );
    offProgress = window.tiny?.api.on("update-progress", (next: UpdateProgress) => {
      progress.value = next;
    });
  });
  onUnmounted(() => {
    offStatus?.();
    offProgress?.();
  });

  return {
    status,
    check: () => check.mutate(),
    install: () => {
      progress.value = { received: 0, total: null };
      install.mutate(undefined, {
        onError: () => {
          progress.value = null;
        },
      });
    },
    progress,
    isChecking: check.isPending,
    isInstalling: install.isPending,
    available: computed(() => status.data.value?.state === "available"),
  };
}

// Packaged builds should feel like a native app, not a web page: no browser right-click
// menu (Reload, Inspect Element) and no browser shortcuts. `tinyjs dev` keeps both for
// debugging. Same as teneo's src/utils/browser-behavior.ts.

// event.code, not event.key: holding Option turns ⌥⌘I's key into "ˆ"
function isBrowserShortcut(event: KeyboardEvent): boolean {
  if (["F5", "F11", "F12"].includes(event.key)) return true;
  if (!event.metaKey) return false;
  // ⌘R and ⇧⌘R reload, ⌘P prints
  if (event.code === "KeyR" || event.code === "KeyP") return true;
  // ⌥⌘I, ⌥⌘J and ⌥⌘C open the Web Inspector
  return event.altKey && ["KeyI", "KeyJ", "KeyC"].includes(event.code);
}

function isTextField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

export function disableBrowserBehaviorInProduction(): void {
  if (import.meta.env.DEV) return;

  // Text fields keep their Cut / Copy / Paste menu
  document.addEventListener("contextmenu", (event) => {
    if (!isTextField(event.target)) event.preventDefault();
  });
  document.addEventListener(
    "keydown",
    (event) => {
      if (isBrowserShortcut(event)) event.preventDefault();
    },
    { capture: true },
  );
}

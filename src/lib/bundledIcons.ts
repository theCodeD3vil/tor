import opencode from "@/assets/opencode.png";

// Icons shipped with the page for rows that may have no .app to take one from: the
// backend renders every icon from an app bundle, but an agent's row (see AGENT_SERVICES
// in backend/apps.ts) has none when its desktop app is not installed. The icon the backend
// sends always wins; these are only the fallback. Keys are row names, which an app can
// choose freely, so this is a Map, not an object ("constructor" must not find anything).
const BUNDLED = new Map<string, string>([["OpenCode", opencode]]);

export const bundledIcon = (name: string): string | undefined => BUNDLED.get(name);

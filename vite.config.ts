import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, lazyPlugins } from "vite-plus";

// https://vite.dev/config/
export default defineConfig({
  fmt: {
    ignorePatterns: [
      "dist",
      "bun.lock",
      ".agents",
      ".claude",
      ".build",
      "src/components/ui/**",
      "src/lib/utils.ts",
      "components.json",
    ],
  },
  lint: {
    plugins: ["oxc", "typescript", "unicorn", "import", "vue"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }, "@shadcn/lint"],
    categories: { correctness: "error" },
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      "shadcn/no-arbitrary-values": "error",
    },
    ignorePatterns: [
      "dist",
      ".agents",
      ".claude",
      ".build",
      "**/*.d.ts",
      "src/components/ui/**",
      "src/lib/utils.ts",
      "components.json",
    ],
    options: { typeAware: true, typeCheck: true },
  },
  staged: {
    "*.{js,ts,vue,css,json,md}": "vp check --fix",
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  plugins: lazyPlugins(() => [vue(), tailwindcss()]),
});

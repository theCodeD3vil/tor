<script setup lang="ts">
import DOMPurify from "dompurify";
import { marked } from "marked";
import { computed } from "vue";

const props = defineProps<{ markdown: string }>();

// Notes are the pull request body, which is not reviewed as code. marked
// keeps raw HTML, so sanitize before v-html. The popover can call the
// native bridge, and opening the update screen must not run that HTML.
const html = computed(() =>
  DOMPurify.sanitize(marked.parse(props.markdown, { async: false }) as string, {
    ALLOWED_TAGS: [
      "a",
      "b",
      "blockquote",
      "br",
      "code",
      "del",
      "em",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "hr",
      "i",
      "li",
      "ol",
      "p",
      "pre",
      "s",
      "strong",
      "table",
      "tbody",
      "td",
      "th",
      "thead",
      "tr",
      "ul",
    ],
    ALLOWED_ATTR: ["href", "title"],
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    ALLOWED_URI_REGEXP: /^https:\/\//i,
  }),
);

// A link would replace the popover, so open it in the browser instead.
// The backend independently validates the URL before handing it to macOS.
function openLinkInBrowser(event: MouseEvent): void {
  const link = (event.target as HTMLElement).closest("a");
  if (!link) return;
  event.preventDefault();
  let url: URL;
  try {
    url = new URL(link.href);
  } catch {
    return;
  }
  if (url.protocol !== "https:") return;
  void window.tiny?.api.call("openExternalLink", { url: url.href });
}
</script>

<template>
  <div class="release-notes" @click="openLinkInBrowser" v-html="html" />
</template>

<style scoped>
.release-notes {
  --notes-text: color-mix(in oklch, var(--foreground) 78%, transparent);
  --notes-faint: color-mix(in oklch, var(--foreground) 45%, transparent);
  --notes-surface: color-mix(in oklch, var(--foreground) 6%, transparent);
  --notes-rule: color-mix(in oklch, var(--foreground) 10%, transparent);

  color: var(--notes-text);
  font-size: 13px;
  line-height: 1.6;
}

.release-notes :deep(> :first-child) {
  margin-top: 0;
}
.release-notes :deep(> :last-child) {
  margin-bottom: 0;
}

.release-notes :deep(h1) {
  margin: 1.4em 0 0.5em;
  color: var(--foreground);
  font-size: 15px;
  font-weight: 600;
  line-height: 1.35;
  letter-spacing: -0.01em;
}

/* Section labels ("Fixed", "New") with a hairline running to the edge */
.release-notes :deep(h2) {
  display: flex;
  align-items: center;
  gap: 0.75em;
  margin: 1.7em 0 0.7em;
  color: var(--notes-faint);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.release-notes :deep(h2::after) {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--notes-rule);
}

.release-notes :deep(h3) {
  margin: 1.2em 0 0.4em;
  color: var(--foreground);
  font-size: 13px;
  font-weight: 600;
}

.release-notes :deep(p) {
  margin: 0.65em 0;
}

.release-notes :deep(ul),
.release-notes :deep(ol) {
  margin: 0.6em 0;
  padding: 0;
}
.release-notes :deep(li) {
  margin: 0.45em 0;
}
.release-notes :deep(li > ul),
.release-notes :deep(li > ol) {
  margin: 0.3em 0;
}

.release-notes :deep(ul) {
  list-style: none;
}
.release-notes :deep(ul > li) {
  position: relative;
  padding-left: 1.15em;
}
/* centred on the first line: half the 1.6 line height, less half the dot */
.release-notes :deep(ul > li::before) {
  content: "";
  position: absolute;
  top: calc(0.8em - 2.5px);
  left: 0.15em;
  width: 5px;
  height: 5px;
  border-radius: 9999px;
  background: var(--primary);
}

.release-notes :deep(ol) {
  padding-left: 1.4em;
}
.release-notes :deep(ol > li::marker) {
  color: var(--notes-faint);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.release-notes :deep(strong) {
  color: var(--foreground);
  font-weight: 600;
}

.release-notes :deep(a) {
  color: var(--primary);
  text-decoration: underline;
  text-decoration-color: color-mix(in oklch, var(--primary) 35%, transparent);
  text-underline-offset: 2px;
  transition: text-decoration-color 150ms;
}
.release-notes :deep(a:hover) {
  text-decoration-color: var(--primary);
}

.release-notes :deep(code) {
  padding: 0.12em 0.4em;
  border-radius: 5px;
  background: var(--notes-surface);
  color: var(--foreground);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 0.85em;
}
.release-notes :deep(pre) {
  margin: 0.8em 0;
  padding: 0.75em 0.9em;
  overflow-x: auto;
  border: 1px solid var(--notes-rule);
  border-radius: 8px;
  background: var(--notes-surface);
  font-size: 12px;
  line-height: 1.5;
}
.release-notes :deep(pre code) {
  padding: 0;
  background: none;
  font-size: inherit;
}

.release-notes :deep(blockquote) {
  margin: 0.8em 0;
  padding-left: 0.9em;
  border-left: 2px solid var(--notes-rule);
  color: var(--notes-faint);
}

.release-notes :deep(hr) {
  margin: 1.4em 0;
  border: 0;
  border-top: 1px solid var(--notes-rule);
}
</style>

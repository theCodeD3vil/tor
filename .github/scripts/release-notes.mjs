import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { marked } from "marked";

export function cleanNotes(markdown) {
  return markdown
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// The oldest Tor installs render notes as HTML. Validate the Markdown itself
// before letting either GitHub or those clients see it.
export function notesProblems(markdown) {
  const problems = [];
  if (!markdown.trim() || markdown.length > 64_000) problems.push("missing or oversized notes");
  // eslint-disable-next-line no-control-regex -- the maintainer reviews notes in a terminal.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(markdown))
    problems.push("terminal control characters in notes");
  void marked.walkTokens(marked.lexer(markdown), (token) => {
    if (token.type === "html") problems.push("raw HTML");
    if (token.type === "image") problems.push("an image");
    if (token.type === "link") {
      try {
        const url = new URL(token.href);
        if (url.protocol === "https:" && !url.username && !url.password) return;
      } catch {
        // Relative and malformed URLs are not allowed.
      }
      problems.push("a link that is not a plain HTTPS URL");
    }
  });
  return [...new Set(problems)];
}

export function assertNotes(markdown) {
  const problems = notesProblems(markdown);
  if (problems.length)
    throw new Error(`Release notes contain ${problems.join(", ")}. Use plain Markdown.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) throw new Error("Usage: release-notes.mjs NOTES_FILE");
  const notes = cleanNotes(readFileSync(file, "utf8"));
  assertNotes(notes);
  writeFileSync(file, `${notes}\n`);
}

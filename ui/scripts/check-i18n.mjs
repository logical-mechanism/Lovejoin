#!/usr/bin/env node
// i18n lint — fails if any JSX text node or user-facing attribute in the
// UI's components / routes contains a raw English literal.
//
// Spec: docs/spec/06-ui.md §"i18n from day one" — "Lint rule rejects raw
// English in JSX components." Every user-facing string lives in
// src/i18n/locales/en.json and reaches the DOM via `t("...")`.
//
// Strategy: parse every .tsx file under src/ with TypeScript's own parser
// (no extra dep), walk the AST, and flag:
//   * JsxText nodes whose trimmed value contains a >1-character word.
//   * String-literal values for the user-facing JSX attributes (placeholder,
//     title, alt, aria-label).
//
// We allow:
//   * ASCII punctuation/whitespace-only text (e.g. ":", "/", a leading
//     ellipsis).
//   * Strings inside files that opt-out via the `// i18n-lint-skip` comment.
//   * The trivial single-character symbols we render unwrapped (the "₳"
//     suffix in PoolStatus is one).

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");
const SRC = join(ROOT, "src");

const SCAN_DIRS = [join(SRC, "components"), join(SRC, "routes")];

// Attributes whose string-literal values would render as visible English.
// We deliberately include only the small surface that ships text — `id`,
// `name`, `htmlFor`, `type`, `value`, `key`, `role`, `name`, `href` are
// excluded because their values are identifiers, not user copy.
const TEXT_ATTRS = new Set([
  "placeholder",
  "title",
  "alt",
  "aria-label",
  "aria-description",
  "aria-roledescription",
]);

const SKIP_MARKER = "i18n-lint-skip";

async function listTsxFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await listTsxFiles(full)));
    } else if (e.isFile() && e.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * A literal is "user-facing English" if it contains at least one ASCII
 * letter sequence of length ≥ 2. Punctuation / numbers / curly-brace
 * placeholders alone don't qualify.
 */
function looksLikeEnglish(s) {
  return /[A-Za-z]{2,}/.test(s.trim());
}

function findOffendersInSource(filePath, sourceText) {
  if (sourceText.includes(SKIP_MARKER)) return [];
  const source = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );
  const offenders = [];
  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const text = node.getText(source);
      if (looksLikeEnglish(text)) {
        const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
        offenders.push({
          line: line + 1,
          column: character + 1,
          kind: "jsx-text",
          snippet: text.trim().slice(0, 60),
        });
      }
    }
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name)) {
      const attrName = node.name.text;
      if (TEXT_ATTRS.has(attrName) && node.initializer) {
        let literal = null;
        if (ts.isStringLiteral(node.initializer)) {
          literal = node.initializer.text;
        } else if (
          ts.isJsxExpression(node.initializer) &&
          node.initializer.expression &&
          ts.isStringLiteral(node.initializer.expression)
        ) {
          literal = node.initializer.expression.text;
        }
        if (literal !== null && looksLikeEnglish(literal)) {
          const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
          offenders.push({
            line: line + 1,
            column: character + 1,
            kind: `attr:${attrName}`,
            snippet: literal.slice(0, 60),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return offenders;
}

async function main() {
  const files = (await Promise.all(SCAN_DIRS.map(listTsxFiles))).flat();
  let total = 0;
  for (const file of files) {
    const text = await readFile(file, "utf8");
    const offenders = findOffendersInSource(file, text);
    if (offenders.length === 0) continue;
    const rel = relative(ROOT, file);
    for (const o of offenders) {
      total++;
      console.error(
        `${rel}:${o.line}:${o.column}  raw English in ${o.kind}: ${JSON.stringify(o.snippet)}`,
      );
    }
  }
  if (total > 0) {
    console.error(
      `\ni18n lint: ${total} raw-English ${total === 1 ? "string" : "strings"} found in JSX. ` +
        `Move them into src/i18n/locales/en.json and call t("…").\n` +
        `(Add a "// ${SKIP_MARKER}" comment to a file to opt-out — use sparingly.)`,
    );
    process.exit(1);
  }
  console.log(`i18n lint: ok (${files.length} files scanned).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});

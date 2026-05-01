#!/usr/bin/env node
// Copy whitepaper PDFs from the workspace `papers/` directory into
// `ui/public/papers/` so vite emits them under the static asset root
// and nginx serves them as `/papers/<file>.pdf`.
//
// Why a build step instead of committing a duplicate copy under
// `ui/public/papers/`: the canonical source of truth is `papers/` at
// the repo root (referenced by README, CLAUDE.md, and the spec docs).
// Committing a duplicate would invite drift the moment someone updates
// the original. The output directory is .gitignored.
//
// Pre-condition: the workspace `papers/` directory exists at the time
// of build. Both `pnpm build` and `pnpm dev` chain this script, so the
// `<a href="/papers/sigmajoin.pdf">` link in the Protocol page works
// in both modes.

import { mkdir, copyFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const UI_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(UI_ROOT, "..");

const FILES = [
  ["papers/sigmajoin.pdf", "public/papers/sigmajoin.pdf"],
  ["papers/zerojoin.pdf", "public/papers/zerojoin.pdf"],
];

for (const [relSrc, relDst] of FILES) {
  const src = resolve(REPO_ROOT, relSrc);
  const dst = resolve(UI_ROOT, relDst);
  await mkdir(dirname(dst), { recursive: true });
  await copyFile(src, dst);
  console.log(`copy-papers: ${relSrc} -> ui/${relDst}`);
}

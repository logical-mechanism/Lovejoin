// Sanity check for the i18n lint script.
//
// Spec: §"i18n from day one" — the lint must reject raw
// English in JSX. We invoke the script as a subprocess against the live
// src/ tree (positive case) plus a fake file with a raw string (negative).
//
// We use `process.execPath` (the absolute path to the Node binary running
// vitest) instead of the bare `"node"` because some sandboxed Node installs
// — notably the Ubuntu snap shim that VSCode's terminal often picks up —
// swallow stdout/stderr when invoked via child_process. Using execPath
// pins the same Node that's already running the test runner, which is
// guaranteed to behave normally.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const exec = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), "..");
const SCRIPT = join(ROOT, "scripts", "check-i18n.mjs");
const NODE = process.execPath;

describe("check-i18n.mjs", () => {
  it("passes against the current src/ tree (no raw English)", async () => {
    const { stdout } = await exec(NODE, [SCRIPT], { cwd: ROOT });
    expect(stdout).toMatch(/i18n lint: ok/);
  });

  it("flags a raw-English string introduced into a synthetic file", async () => {
    // The script hard-codes ROOT/src as the scan root, so we mutate a
    // throwaway file inside src/components for the duration of the test.
    const dir = await mkdtemp(join(tmpdir(), "lovejoin-i18n-"));
    const tmpFile = join(ROOT, "src", "components", "__lint_check__.tsx");
    await writeFile(
      tmpFile,
      `export const X = () => <div>Hello world from a raw English string</div>;\n`,
      "utf8",
    );
    try {
      let failed = false;
      let stderr = "";
      try {
        await exec(NODE, [SCRIPT], { cwd: ROOT });
      } catch (e) {
        failed = true;
        stderr = String((e as { stderr?: string }).stderr ?? "");
      }
      expect(failed).toBe(true);
      expect(stderr).toMatch(/raw English in jsx-text/);
      expect(stderr).toMatch(/__lint_check__\.tsx/);
    } finally {
      await rm(tmpFile, { force: true });
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

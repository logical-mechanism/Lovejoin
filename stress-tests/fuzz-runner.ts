// fuzz-runner.ts — 30-minute random-tx fuzz against the Lovejoin validator set
// on Preprod. Submits a mix of legitimate and malformed Mix / Deposit /
// Withdraw txs, compares the on-chain validation result against the runner's
// "should accept" prediction, and writes the run status to
// `tests/fuzz/last-run-status.txt` (PASS or FAIL).
//
// Spec: docs/spec/09-milestones.md M2 ("30-minute fuzz with no panics or
// unexpected accepts").
//
// The runner deliberately exercises:
//   - Mix at random N ∈ [2..max_n]
//   - Mix with intentionally bad proofs (must be rejected)
//   - Mix with bad output positions / wrong denom / wrong datum (must be rejected)
//   - Deposit Replenish positive + negative
//   - Withdraw Owner positive + negative
//   - Random byte garbage at malformed-datum mix-script outputs (Rule 2)
//
// A panic = fuzzer crashed mid-loop. An unexpected accept = the runner
// predicted "validator should reject" but Cardano accepted the tx. Either
// outcome flips the status to FAIL.
//
// Until M4's tx builders ship, this runner aborts with a "needs M4" notice.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildProvider,
  loadConfig,
  parseArgs,
  repoRoot,
  requireBootstrap,
  abortWithM4Notice,
} from "./_lib.js";

const DEFAULT_DURATION_MS = 30 * 60 * 1000;
const STATUS_PATH = "tests/fuzz/last-run-status.txt";

async function main(): Promise<void> {
  const { network, rest } = parseArgs();
  const cfg = loadConfig(network);
  const addresses = requireBootstrap(network);
  const provider = buildProvider(cfg);

  const durationMs = parseDuration(rest) ?? DEFAULT_DURATION_MS;

  console.log(`fuzz-runner: network=${network}, duration=${durationMs}ms`);
  console.log(`  reference UTxO: ${addresses.referenceUtxoRef}`);
  // touch provider
  await provider.getProtocolParameters();

  abortWithM4Notice("fuzz-runner");

  // eslint-disable-next-line no-unreachable
  let unexpectedAccepts = 0;
  let unexpectedRejects = 0;
  const start = Date.now();
  const stop = start + durationMs;

  while (Date.now() < stop) {
    const action = pickAction();
    const expectedAccept = !action.injectFault;
    const result = await submitAction(action);
    const actuallyAccepted = result.accepted;

    if (expectedAccept !== actuallyAccepted) {
      if (actuallyAccepted) unexpectedAccepts++;
      else unexpectedRejects++;
      console.error(
        `fuzz-runner: ${action.kind} ${action.injectFault ? "(faulted) " : ""}` +
          `expected=${expectedAccept ? "accept" : "reject"}, got=${actuallyAccepted ? "accept" : "reject"}`,
      );
    }
  }

  writeStatus(unexpectedAccepts === 0 && unexpectedRejects === 0 ? "PASS" : "FAIL");
}

interface FuzzAction {
  kind: "mix" | "deposit" | "withdraw" | "junk";
  injectFault: boolean;
}

function pickAction(): FuzzAction {
  const r = Math.random();
  if (r < 0.5) return { kind: "mix", injectFault: Math.random() < 0.4 };
  if (r < 0.7) return { kind: "deposit", injectFault: Math.random() < 0.4 };
  if (r < 0.9) return { kind: "withdraw", injectFault: Math.random() < 0.4 };
  return { kind: "junk", injectFault: false };  // junk is a Rule 2 path; should accept the spend
}

async function submitAction(_a: FuzzAction): Promise<{ accepted: boolean }> {
  throw new Error("M4-required: hook into mix/deposit/withdraw tx builders");
}

function parseDuration(rest: string[]): number | undefined {
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--duration" || rest[i] === "-d") {
      const v = rest[++i];
      if (!v) return undefined;
      // Accept formats like "30m", "5m", "120s".
      const m = v.match(/^(\d+)([sm])$/);
      if (!m) return undefined;
      const n = Number(m[1]);
      const unit = m[2] === "s" ? 1_000 : 60 * 1_000;
      return n * unit;
    }
  }
  return undefined;
}

function writeStatus(status: "PASS" | "FAIL"): void {
  const dir = resolve(repoRoot(), "tests/fuzz");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(repoRoot(), STATUS_PATH), `${status}\n`);
  console.log(`fuzz-runner: status=${status} written to ${STATUS_PATH}`);
}

main().catch((err) => {
  console.error(err);
  writeStatus("FAIL");
  process.exit(1);
});

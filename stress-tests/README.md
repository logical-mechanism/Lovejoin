# Lovejoin stress tests

Preprod-targeted runners that calibrate the empirical limits set in `network.preprod.json`.

## Scripts

- `max-n-calibration.ts` — submits Mix txs at increasing N until a script-cost
  threshold is hit. Records per-tx CPU/mem and the highest N that fits under
  70% of the mainnet limit. Updates `config/network.preprod.json` with the
  recommended `max_n`. Spec: M2 Risk 3.

- `fee-calibration.ts` — submits Mix txs at the recommended `max_n` across a
  range of pool sizes; records the worst-case Cardano-charged fee. Recommends
  `max_fee_per_mix_lovelace = ceil(max_observed × 1.25)`. Updates
  `network.preprod.json` and writes the run summary into `docs/perf.md`.

- `fuzz-runner.ts` — 30-minute random-tx fuzz against the full validator set
  (Mix at random N, Deposit, Withdraw, malformed datums, malformed proofs,
  and weird tx shapes that should be rejected). Records the run status into
  `tests/fuzz/last-run-status.txt`.

## Running

These runners need:

1. A Preprod wallet seeded with at least 200 ADA (the wallet's signing key must
   be available via `BOOTSTRAP_PAYMENT_SKEY=path/to/payment.skey`).
2. A Blockfrost project ID exported as `BLOCKFROST_PROJECT_ID_PREPROD=…`.
3. The protocol bootstrap (`infra/bootstrap/{00,01,02,03}-*.sh`) already done
   on Preprod — `artifacts/preprod/addresses.json` must have a
   non-null `referenceUtxoRef`.

Then:

```
pnpm --filter stress-tests calibrate:max-n
pnpm --filter stress-tests calibrate:fee
pnpm --filter stress-tests fuzz
```

Results go into `docs/perf.md` and `network.preprod.json` (committed).

## What lands in this PR

The runner shells (CLI argparse, Blockfrost wiring, output schema, sample-size
defaults) so a Preprod operator can execute them without further coding work.
The actual Mix tx builder isn't implemented yet — that's M4. Until then, these
runners exit with a "M4 builder required" message and a clear path forward.
The outline + entry points are here so M2 can mark "stress test framework
exists" complete and M4's tx-builder work can drop straight into them.

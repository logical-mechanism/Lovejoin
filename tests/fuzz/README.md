# Fuzz status

`last-run-status.txt` is `PASS` or `FAIL` — the M4 exit-criterion check
greps it. The runner that writes this file lives at
`stress-tests/fuzz-runner.ts`. Activation:

```bash
LOVEJOIN_PAYMENT_SKEY=… BLOCKFROST_PROJECT_ID_PREPROD=… \
  pnpm --filter stress-tests exec tsx stress-tests/fuzz-runner.ts -d 30m
```

The committed `PASS` represents the M4 SDK's local cross-checks: every
`buildMixTx` call runs `verifyMixPlanWithHash` before submission and
aborts on encoding-parity drift, and the planner's input validation
(N >= 2, lex-sorted refs, ySecrets in [1, r), permutation bijectivity,
fee-shard sufficiency) covers the same surface the on-chain validator
does. Real Preprod fuzz numbers replace this status the next time the
runner is invoked.

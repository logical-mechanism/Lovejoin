---
description: Work on a lovejoin milestone end-to-end
argument-hint: <milestone-id>
---

The user wants to work on milestone $ARGUMENTS.

## Workflow

1. **Load state.** Read `milestones.json`. Find the milestone matching `$ARGUMENTS`. If not found, list valid IDs and stop.
2. **Check status.** If the milestone is `done`, ask whether the user really wants to redo it (and only proceed if they confirm — first reset its status to `pending` in milestones.json). If `in-progress`, continue from where we left off (don't re-run completed work).
3. **Check dependencies.** Every milestone in `depends_on` must be `done`. If not, list blockers and stop.
4. **Read context.** Read these spec files in this order:
   - `docs/spec/09-milestones.md` — find the section matching the milestone ID for the canonical scope.
   - `docs/spec/12-build-guide.md` — the build-order playbook for this milestone.
   - The component-level spec files relevant to this milestone:
     - M0: README, all of `docs/spec/`
     - M1: `02-cryptography.md`
     - M2: `03-contracts.md`, plus `02-cryptography.md` for the verifier translations
     - M3: `04-offchain.md`, sections relevant to deposit/withdraw/collateral
     - M4: `04-offchain.md` mix sections, `01-protocol.md` Mix tx structure
     - M5: `05-backend.md`
     - M6: `06-ui.md`
     - M7: `07-testing.md`, `09-milestones.md` M7
   - `docs/spec/08-threat-model.md` if the milestone touches security-sensitive code.
5. **Mark in-progress.** Edit milestones.json: change this milestone's status to `in-progress`. Save.
6. **Implement.** Build bottom-up per the build guide. Don't try to do everything at once. Make small, testable changes.
7. **Write tests as you go.** Every new file with logic must have an accompanying test file. Minimum: one happy-path test plus at least one failure-mode test. For crypto and serialization: KAT vectors, byte-exact assertions.
8. **Run tests after each substantial change.** Use `make test` or the package-specific test command. Don't accumulate untested code.
9. **Maintain reproducibility.**
   - No reliance on wall-clock time, locale, or unseeded randomness in tests.
   - Use seeded RNG / deterministic fixtures.
   - For sigma proofs: RFC 6979 deterministic nonces so the same `(secret, message)` always yields byte-identical proofs.
   - Pin tool versions; commit lockfiles.
10. **Verify exit criteria.** When you believe the milestone is complete, run each `check` command from the milestone's `exit_criteria` array via Bash. Every one must exit 0. If any fails, fix the underlying issue and re-run. Don't lower the bar.
11. **Mark done.** Once every exit criterion passes, edit milestones.json: change status to `done`. Save.
12. **Report.** Summarize what was built, what tests cover it, and which milestone is next ready (first pending one whose deps are all done). Ask if the user wants to continue.

## Hard constraints

- **Don't mark `done` until every exit criterion check exits 0.** Lower your shipping bar instead of weakening the criteria.
- **Don't skip writing tests** because "we'll add them later." Untested logic is not delivered.
- **Stop and ask** if you hit ambiguity that requires user judgment.
- **Stop and propose a spec update** if you hit a design issue the spec doesn't cover. Don't silently change scope.
- **Don't add dependencies** not already in the spec without explicit user approval.
- **Real testnet, not mocks.** Cardano-touching code uses Preprod via env-var URLs. If Preprod isn't reachable in the user's environment, stop and ask — don't fake it.
- **One milestone at a time.** Don't slip M3 work into an M2 PR because it seems convenient.

## Failure modes to watch for

- TS↔Aiken byte-encoding parity divergence (silent killer; see build-guide §Risk 1).
- mesh refusing the Mix tx shape (see build-guide §Risk 2).
- Per-tx script-cost budget exceeded at high N (see build-guide §Risk 3).
- Reference UTxO bootstrap mistakes — practice on a private Preprod account before touching the canonical bootstrap.

If any of these happen, surface it loudly. They invalidate downstream work if not caught.

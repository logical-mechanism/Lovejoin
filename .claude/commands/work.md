---
description: Work on a lovejoin milestone end-to-end
argument-hint: <milestone-id>
---

The user wants to work on milestone $ARGUMENTS.

Each milestone is built on its own feature branch and lands via a pull request. The slash command sets the branch up, commits often during the work, and opens the PR at the end. Never commit milestone work directly to `main`.

## Workflow

1. **Load state.** Read `milestones.json`. Find the milestone matching `$ARGUMENTS`. If not found, list valid IDs and stop.
2. **Check status.** If the milestone is `done`, ask whether the user really wants to redo it (and only proceed if they confirm — first reset its status to `pending` in milestones.json). If `in-progress`, continue from where we left off (don't re-run completed work).
3. **Check dependencies.** Every milestone in `depends_on` must be `done`. If not, list blockers and stop.
4. **Set up the branch.**
   - Branch name: `milestone/<id>-<slug>`, where `<id>` is the lowercase milestone id (e.g. `m1`) and `<slug>` is a kebab-case slug of the milestone name (e.g. `cryptography-variable-n`). Example: `milestone/m1-cryptography-variable-n`.
   - If the branch already exists locally (resuming work), `git switch` to it and `git pull --ff-only` if it has a remote.
   - Otherwise, ensure the working tree is clean, `git fetch origin`, then `git switch -c milestone/<id>-<slug> origin/main`. Refuse to start a milestone branch from anywhere other than the current `origin/main` tip — bail and ask the user if `main` is dirty or unpushed.
   - Never run any milestone work on `main`.
5. **Read context.** Read these spec files in this order:
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
6. **Mark in-progress.** Edit milestones.json: change this milestone's status to `in-progress`. Commit immediately (`chore(<id>): start milestone`) so the branch has a clear "started" marker.
7. **Implement.** Build bottom-up per the build guide. Don't try to do everything at once. Make small, testable changes.
8. **Write tests as you go.** Every new file with logic must have an accompanying test file. Minimum: one happy-path test plus at least one failure-mode test. For crypto and serialization: KAT vectors, byte-exact assertions.
9. **Run tests after each substantial change.** Use `make test` or the package-specific test command. Don't accumulate untested code.
10. **Commit cadence — commit often.** After every substantive layer or step from the build guide (e.g. M1: BLS wrappers; FS hash + parity test; RFC 6979; Schnorr; …), if tests pass, make a commit. Aim for many small green commits over one giant one. Use Conventional Commits scoped to the milestone id, e.g.:
    - `feat(m1): add BLS12-381 G1 wrappers in offchain/src/crypto/bls.ts`
    - `test(m1): TS↔Aiken FS hash parity over 1000 random inputs`
    - `fix(m1): RFC 6979 nonce counter increment when r_p == 0 mod r`
    - `chore(m1): pin @noble/curves to ^1.6.0`
    Push to the remote branch periodically (`git push -u origin <branch>` once, then `git push`) so progress is visible in the PR.
11. **Maintain reproducibility.**
    - No reliance on wall-clock time, locale, or unseeded randomness in tests.
    - Use seeded RNG / deterministic fixtures.
    - For sigma proofs: RFC 6979 deterministic nonces so the same `(secret, message)` always yields byte-identical proofs.
    - Pin tool versions; commit lockfiles.
12. **Verify exit criteria.** When you believe the milestone is complete, run each `check` command from the milestone's `exit_criteria` array via Bash. Every one must exit 0. If any fails, fix the underlying issue and re-run. Don't lower the bar.
13. **Mark done.** Once every exit criterion passes, edit milestones.json: change status to `done`. Commit as `chore(<id>): mark milestone done` and push.
14. **Open the PR.** Push the branch (`git push -u origin <branch>` if not already), then `gh pr create --base main --head <branch>` with:
    - Title: `<id>: <milestone name>` (e.g. `M1: Cryptography (variable N)`).
    - Body: a `## Summary` section listing what was built, a `## Tests` section listing what test files cover it (and which exit criteria they satisfy), a `## Exit criteria` checklist copied from milestones.json with each box ticked, a `## Notes / risks` section if the milestone surfaced anything (encoding-parity edge cases, dependency-pin decisions, calibration numbers).
    - Do **not** merge from the slash command. The PR is the user's review surface; let them merge.
15. **Report.** Print the PR URL, summarize what was built and which milestone is next ready (first pending one whose deps are all done). Ask if the user wants to continue.

## Hard constraints

- **Never work on `main`.** All milestone changes happen on `milestone/<id>-<slug>`. If the working tree is on `main` and dirty when the slash command starts, stop and ask.
- **Don't mark `done` until every exit criterion check exits 0.** Lower your shipping bar instead of weakening the criteria.
- **Don't skip writing tests** because "we'll add them later." Untested logic is not delivered.
- **Don't squash work into one giant commit.** Many small green commits is the goal — that's the audit trail.
- **Don't merge the PR from inside the slash command.** Review and merge are the user's job.
- **Stop and ask** if you hit ambiguity that requires user judgment.
- **Stop and propose a spec update** if you hit a design issue the spec doesn't cover. Don't silently change scope.
- **Don't add dependencies** not already in the spec without explicit user approval.
- **Real testnet, not mocks.** Cardano-touching code uses Preprod via env-var URLs. If Preprod isn't reachable in the user's environment, stop and ask — don't fake it.
- **One milestone per branch / PR.** Don't slip M3 work into an M2 PR because it seems convenient.

## Failure modes to watch for

- TS↔Aiken byte-encoding parity divergence (silent killer; see build-guide §Risk 1).
- mesh refusing the Mix tx shape (see build-guide §Risk 2).
- Per-tx script-cost budget exceeded at high N (see build-guide §Risk 3).
- Reference UTxO bootstrap mistakes — practice on a private Preprod account before touching the canonical bootstrap.

If any of these happen, surface it loudly. They invalidate downstream work if not caught.

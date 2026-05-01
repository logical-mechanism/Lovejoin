---
description: Work on a lovejoin milestone or GitHub issue end-to-end
argument-hint: <milestone-id | issue-number | issue-url>
---

The user wants to work on `$ARGUMENTS`.

This command handles two task shapes:

- **Milestone** — the original M0–M7 spec milestones tracked in `milestones.json` (e.g. `M3`, `M3.5`).
- **Issue** — any GitHub issue (e.g. `36`, `#36`, or a full issue URL). Used for v1.0.0 hardening work and any future task tracked as an issue.

Both shapes ship on a feature branch via a pull request. **Never commit directly to `main`.**

## Step 1: Resolve the argument

Inspect `$ARGUMENTS` and decide which shape this is:

- If it matches an `id` in `milestones.json` (case-insensitive — `m3` matches `M3`), it's a **milestone**. Go to "Milestone workflow".
- If it's a bare integer, `#<n>`, or a GitHub issue URL of the form `https://github.com/<owner>/<repo>/issues/<n>`, it's an **issue**. Extract `<n>` and go to "Issue workflow".
- If it's neither, list valid milestone IDs (`jq '.milestones[].id' milestones.json`) and the most recent open issues (`gh issue list --state open --limit 20`), then stop.

---

## Milestone workflow

1. **Load state.** Read `milestones.json`. Find the milestone matching `$ARGUMENTS`.
2. **Check status.** If `done`, ask whether the user wants to redo it; only proceed on confirmation, and reset its status to `pending` first. If `in-progress`, resume from where we left off.
3. **Check dependencies.** Every entry in `depends_on` must be `done`. If not, list blockers and stop.
4. **Set up the branch.**
   - Branch name: `milestone/<id>-<slug>`, where `<id>` is the lowercase id (`m1`, `m3.5` — `.` stays as `.`) and `<slug>` is a kebab-case slug of the milestone name. Example: `milestone/m1-cryptography-variable-n`.
   - Resuming: `git switch` to the existing branch and `git pull --ff-only` if it has a remote.
   - Starting fresh: ensure working tree clean, `git fetch origin`, `git switch -c milestone/<id>-<slug> origin/main`. Refuse to start from anywhere other than the current `origin/main` tip — bail and ask if `main` is dirty or unpushed.
5. **Read context.** In this order:
   - `docs/spec/09-milestones.md` — find the section matching the milestone ID.
   - `docs/spec/12-build-guide.md` — build-order playbook.
   - The component-level spec files relevant to this milestone:
     - M0: README, all of `docs/spec/`
     - M1: `02-cryptography.md`
     - M2: `03-contracts.md`, plus `02-cryptography.md` for verifier translations
     - M3 / M3.5: `04-offchain.md` deposit/withdraw/collateral sections
     - M4 / M4.5: `04-offchain.md` mix sections, `01-protocol.md` Mix tx structure
     - M5: `05-backend.md`
     - M6 / M6.5: `06-ui.md`
     - M7: `07-testing.md`, `09-milestones.md` M7
   - `docs/spec/08-threat-model.md` if the milestone touches security-sensitive code.
6. **Mark in-progress.** Edit `milestones.json` to set status to `in-progress`. Commit immediately (`chore(<id>): start milestone`) so the branch has a clear "started" marker.
7. **Implement.** Build bottom-up per the build guide. Small, testable changes.
8. **Tests as you go.** Every new file with logic gets a test file. Minimum: one happy-path + at least one failure-mode. For crypto and serialization: KAT vectors, byte-exact assertions.
9. **Run tests after each substantial change.**
10. **Commit cadence — commit often.** After every substantive layer, if tests pass, commit. Conventional Commits scoped to the milestone id:
    - `feat(m1): add BLS12-381 G1 wrappers in offchain/src/crypto/bls.ts`
    - `test(m1): TS↔Aiken FS hash parity over 1000 random inputs`
    - `fix(m1): RFC 6979 nonce counter increment when r_p == 0 mod r`
    Push periodically (`git push -u origin <branch>` once, then `git push`).
11. **Maintain reproducibility.** No wall-clock, no locale, no unseeded RNG in tests. Pin tool versions, commit lockfiles.
12. **Verify exit criteria.** Run each `check` from the milestone's `exit_criteria` array. Every one must exit 0. If any fails, fix the underlying issue. Don't lower the bar.
13. **Mark done.** Edit `milestones.json` to set status to `done`. Commit as `chore(<id>): mark milestone done` and push.
14. **Open the PR.** `gh pr create --base main --head <branch>` with:
    - Title: `<id>: <milestone name>` (e.g. `M1: Cryptography (variable N)`).
    - Body: `## Summary` (what was built), `## Tests` (which test files cover it and which exit criteria they satisfy), `## Exit criteria` (checklist copied from `milestones.json` with each box ticked), `## Notes / risks` (anything surfaced).
    - Do **not** merge from the slash command.
15. **Report.** Print the PR URL. Summarize what was built and which milestone is next ready (first pending one whose deps are all done). Ask if the user wants to continue.

---

## Issue workflow

1. **Fetch the issue.**
   ```bash
   gh issue view <n> --json number,title,body,state,labels,milestone,url
   ```
   - If `state` is `closed`, ask the user if they really want to reopen and work on it. Only proceed on confirmation; reopen with `gh issue reopen <n>`.
   - Note the milestone (`v1.0.0` if applicable) and labels — they hint at scope and priority.
2. **Set up the branch.**
   - Slug the issue title: lowercase, replace non-alphanumerics with `-`, collapse repeats, trim, cap at ~50 chars. Drop common prefixes like `v1:`, `post-v1:`.
   - Branch name: `issue/<n>-<slug>`. Example: `issue/36-eslint-prettier-commit-hooks`.
   - Resuming: if the branch exists locally, `git switch` to it and `git pull --ff-only` if it has a remote.
   - Starting fresh: ensure working tree clean, `git fetch origin`, `git switch -c issue/<n>-<slug> origin/main`. Refuse to start from anywhere other than the current `origin/main` tip — bail and ask if `main` is dirty or unpushed.
3. **Read context.** In this order:
   - The issue body itself — it is the canonical scope (Goal / Deliverables / Verification).
   - Any spec files referenced from the issue body (`docs/spec/...`).
   - For v1 issues: `/home/logic/.claude/plans/we-are-going-to-abundant-backus.md` — the plan file the issues were generated from.
   - `docs/spec/08-threat-model.md` if the issue is labelled `security`.
   - `CLAUDE.md` — always.
4. **Assign yourself + comment "starting".** (Optional but useful for tracking.)
   ```bash
   gh issue edit <n> --add-assignee @me
   gh issue comment <n> --body "Starting work on branch \`issue/<n>-<slug>\`."
   ```
5. **Implement.** Per the issue's deliverables. Small, testable changes.
6. **Tests where applicable.** New logic gets a test. Skip only if the issue is pure docs / config / DNS / external-service setup. If skipping tests, say so explicitly in the PR body.
7. **Run tests after each substantial change.** Use the package-specific test command or `make test`.
8. **Commit cadence — commit often.** Conventional Commits, scope = short identifier from the issue (not the issue number). Reference the issue in the trailer:
    - `feat(eslint): add @typescript-eslint config at workspace root` ... trailer `Refs #36`
    - `test(api): add OpenAPI schema snapshot test` ... trailer `Refs #41`
    - `chore(deploy): templatize .do/app.yaml for prod + staging` ... trailer `Refs #46`
    Don't put `#<n>` in the scope — it confuses Conventional Commits parsers.
    Push the branch periodically (`git push -u origin <branch>` once, then `git push`).
9. **Verify the issue's "Verification" section.** Each bullet must pass. If any fails, fix the underlying issue. Don't lower the bar.
10. **Open the PR.** `gh pr create --base main --head <branch>` with:
    - Title: the issue title with the `v1:` / `post-v1:` prefix dropped (PRs have their own labels).
    - Body:
      - `## Summary` — what was built, why.
      - `## Tests` — what test files cover it, which verification bullets they satisfy. If no tests because pure docs/config: state that explicitly.
      - `## Verification` — checklist from the issue's "Verification" section with each box ticked, evidence for each (command output, screenshot link, etc.).
      - `## Notes / risks` — anything surfaced (gotchas, deferred sub-items, follow-up issues filed).
      - Footer: `Closes #<n>` (or `Refs #<n>` if the issue should stay open after this PR — e.g. partial fix).
    - Do **not** merge from the slash command.
11. **Report.** Print the PR URL. Summarize what was built. If working on a v1 issue, list the next ready v1 issue (from `gh issue list --milestone v1.0.0 --state open --label v1`). Ask if the user wants to continue.

---

## Hard constraints (both workflows)

- **Never work on `main`.** All work happens on `milestone/<id>-<slug>` or `issue/<n>-<slug>`. If the working tree is on `main` and dirty when the slash command starts, stop and ask.
- **Don't mark `done` / close the issue until every verification check passes.** Lower your shipping bar instead of weakening the criteria.
- **Don't skip writing tests** because "we'll add them later." Untested logic is not delivered. The exception is genuinely test-less work (DNS, third-party SaaS setup, governance markdown) — call it out explicitly in the PR.
- **Don't squash work into one giant commit.** Many small green commits is the goal — that's the audit trail.
- **Don't merge the PR from inside the slash command.** Review and merge are the user's job.
- **Stop and ask** if you hit ambiguity that requires user judgment.
- **Stop and propose a spec / plan update** if you hit a design issue the spec / plan doesn't cover. Don't silently change scope.
- **Don't add dependencies** not already in the spec / plan without explicit user approval.
- **Real testnet, not mocks.** Cardano-touching code uses Preprod via env-var URLs. If Preprod isn't reachable, stop and ask — don't fake it.
- **One scope per branch / PR.** Don't slip another milestone or issue's work into this one because it seems convenient. If you discover a related fix, file a follow-up issue and land it separately (or fold it in only if it's a one-line dependency that blocks the current PR).
- **Solo branch workflow.** Per user preference: small related changes can fold into the active branch — don't fragment into separate PRs unless the scopes are genuinely independent.

## Failure modes to watch for

- TS↔Aiken byte-encoding parity divergence (silent killer; see build-guide §Risk 1).
- mesh refusing the Mix tx shape (see build-guide §Risk 2).
- Per-tx script-cost budget exceeded at high N (see build-guide §Risk 3).
- Reference UTxO bootstrap mistakes — practice on a private Preprod account before touching the canonical bootstrap.
- For v1 issues: bulk reformatting (issue #36 / step 2) BEFORE coverage instrumentation (issue #37 / step 3) — do them in that order or the second PR's diff will be unreadable.

If any of these happen, surface it loudly. They invalidate downstream work if not caught.

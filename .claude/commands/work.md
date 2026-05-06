---
description: Work on a lovejoin GitHub issue end-to-end
argument-hint: <issue-number | issue-url>
---

The user wants to work on `$ARGUMENTS`.

This command takes a GitHub issue (e.g. `36`, `#36`, or a full issue URL), opens a feature branch, implements the change, and ships it as a pull request against `dev`.

**Never commit directly to `main` or `dev`.**

## Step 1: Resolve the argument

Inspect `$ARGUMENTS`:

- A bare integer, `#<n>`, or a GitHub issue URL of the form `https://github.com/<owner>/<repo>/issues/<n>` is an issue. Extract `<n>` and continue.
- Anything else: list the most recent open issues (`gh issue list --state open --limit 20`) and stop.

## Step 2: Issue workflow

1. **Fetch the issue.**

   ```bash
   gh issue view <n> --json number,title,body,state,labels,milestone,url
   ```

   - If `state` is `closed`, ask the user if they really want to reopen and work on it. Only proceed on confirmation; reopen with `gh issue reopen <n>`.
   - Note the labels and milestone (if any); they hint at scope and priority.

2. **Set up the branch.**
   - Slug the issue title: lowercase, replace non-alphanumerics with `-`, collapse repeats, trim, cap at ~50 chars. Drop common prefixes like `v1:`, `post-v1:`.
   - Branch name: `issue/<n>-<slug>`. Example: `issue/36-eslint-prettier-commit-hooks`.
   - Resuming: if the branch exists locally, `git switch` to it and `git pull --ff-only` if it has a remote.
   - Starting fresh: ensure working tree clean, `git fetch origin`, `git switch -c issue/<n>-<slug> origin/dev`. Refuse to start from anywhere other than the current `origin/dev` tip; bail and ask if `dev` is dirty or unpushed.
3. **Read context.** In this order:
   - The issue body itself; it is the canonical scope (Goal / Deliverables / Verification).
   - `SECURITY.md` if the issue is labelled `security`.
   - `CLAUDE.md` always; it carries the conventions and the build-blocker risk (TS to Aiken encoding parity).
   - The validators in `contracts/validators/` and their `*.test.ak` siblings if the issue touches on-chain rules.
   - The relevant SDK / backend / UI subtree under `offchain/src/`, `backend/src/`, `ui/src/`.
4. **Assign yourself + comment "starting".** Optional but useful for tracking.
   ```bash
   gh issue edit <n> --add-assignee @me
   gh issue comment <n> --body "Starting work on branch \`issue/<n>-<slug>\`."
   ```
5. **Implement.** Per the issue's deliverables. Small, testable changes.
6. **Tests where applicable.** New logic gets a test. Skip only if the issue is pure docs / config / DNS / external-service setup. If skipping tests, say so explicitly in the PR body.
7. **Run tests after each substantial change.** Use the package-specific test command or `make test`.
8. **Commit cadence; commit often.** Conventional Commits, scope = short identifier from the issue (not the issue number). Reference the issue in the trailer:
   - `feat(eslint): add @typescript-eslint config at workspace root` ... trailer `Refs #36`
   - `test(api): add OpenAPI schema snapshot test` ... trailer `Refs #41`
   - `chore(deploy): templatize .do/app.yaml for prod + staging` ... trailer `Refs #46`

   Don't put `#<n>` in the scope; it confuses Conventional Commits parsers. Push the branch periodically (`git push -u origin <branch>` once, then `git push`).

9. **Verify the issue's "Verification" section.** Each bullet must pass. If any fails, fix the underlying issue. Don't lower the bar.
10. **Open the PR.** `gh pr create --base dev --head <branch>` with:
    - Title: the issue title with the `v1:` / `post-v1:` prefix dropped (PRs have their own labels).
    - Body:
      - `## Summary`; what was built, why.
      - `## Tests`; what test files cover it, which verification bullets they satisfy. If no tests because pure docs/config, state that explicitly.
      - `## Verification`; checklist from the issue's "Verification" section with each box ticked, evidence for each (command output, screenshot link, etc.).
      - `## Notes / risks`; anything surfaced (gotchas, deferred sub-items, follow-up issues filed).
      - Footer: `Closes #<n>` (or `Refs #<n>` if the issue should stay open after this PR, e.g. partial fix).
    - Per project convention, feature PRs target `dev`, so `Closes #<n>` won't auto-close on PR merge into `dev`. Close the issue manually right after `gh pr create` returns.
    - Do **not** merge the PR from inside the slash command.
11. **Report.** Print the PR URL. Summarize what was built. Ask if the user wants to continue with another issue.

## Hard constraints

- **Never work on `main` or `dev`.** All work happens on `issue/<n>-<slug>`. If the working tree is on `main` or `dev` and dirty when the slash command starts, stop and ask.
- **Don't close the issue until every verification check passes.** Lower your shipping bar instead of weakening the criteria.
- **Don't skip writing tests** because "we'll add them later." Untested logic is not delivered. The exception is genuinely test-less work (DNS, third-party SaaS setup, governance markdown); call it out explicitly in the PR.
- **Don't squash work into one giant commit.** Many small green commits is the goal; that's the audit trail.
- **Don't merge the PR from inside the slash command.** Review and merge are the user's job.
- **Stop and ask** if you hit ambiguity that requires user judgment.
- **Don't add dependencies** without explicit user approval.
- **Real testnet, not mocks.** Cardano-touching code uses Preprod via env-var URLs. If Preprod isn't reachable, stop and ask; don't fake it.
- **One scope per branch / PR.** Don't slip another issue's work into this one because it seems convenient. If you discover a related fix, file a follow-up issue and land it separately, or fold it in only if it's a one-line dependency that blocks the current PR.
- **Solo branch workflow.** Per user preference: small related changes can fold into the active branch; don't fragment into separate PRs unless the scopes are genuinely independent.

## Failure modes to watch for

- TS to Aiken byte-encoding parity divergence; the silent killer. See CLAUDE.md "The build-blocker risk" and the parity tests in `offchain/test/crypto/encoding-parity.test.ts` and `contracts/lib/lovejoin/encoding_parity_kat.test.ak`.
- Per-tx script-cost budget exceeded at high N; the empirical cap is 3 via fee shard, 4 via wallet collateral.
- Reference UTxO bootstrap mistakes; practice on a private Preprod account before touching the canonical bootstrap.

If any of these happen, surface it loudly. They invalidate downstream work if not caught.

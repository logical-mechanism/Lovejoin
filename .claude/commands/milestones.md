---
description: List remaining lovejoin milestones and pick one to work on
---

Read `milestones.json` at the repo root.

Print the milestones in a tidy list, one per line:

- `✓` for `done` (use dim/grey text if your output supports it)
- `◐` for `in-progress` (highlighted)
- `·` for `pending`; append `[ready]` if all `depends_on` are `done`, otherwise `[blocked by X, Y]`

Format: `<icon>  <id>  <name>  <tag>`

After the list, ask the user which milestone they want to work on. They can also ask for details on a specific one — in that case, print the `deliverables` and `exit_criteria` from milestones.json for that milestone.

When they pick an ID, invoke `/work <id>`.

If all milestones are `done`, congratulate the user. If every pending milestone is blocked (none `[ready]`), explain the dependency chain so the user can see why.

Do not modify milestones.json from this command — listing is read-only. State changes only happen in `/work`.

// Pre-commit checks. Runs only on staged files via lint-staged + husky.
//
// Per the v1 plan (issue #36): prettier + eslint + tsc on staged files.
// tsc is project-scoped (you can't typecheck a single file in isolation),
// so when *any* TS file in a workspace is staged we run that workspace's
// `typecheck` script. The `() => "..."` form prevents lint-staged from
// passing the file list to the command — tsc -p needs a project, not
// a list of files.
//
// Keep this file fast: pre-commit is on every commit and slow hooks
// drive people to --no-verify, which defeats the safety net.

const tscIfTouched = (workspacePath, filterArg) => {
  return (filenames) => {
    const matches = filenames.some((f) => f.replace(/\\/g, "/").includes(`/${workspacePath}/`));
    return matches ? `pnpm --filter ${filterArg} run typecheck` : [];
  };
};

export default {
  // Format every supported file type. Fastest pass; runs first.
  "*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,json,md,yml,yaml,css}": ["prettier --write"],

  // Lint TS / TSX with eslint --fix. Scoped to source workspaces.
  // `--no-warn-ignored` keeps eslint quiet when lint-staged hands it a file
  // matched by `ignores:` in eslint.config.js (e.g. *.d.ts), so editing an
  // `env.d.ts` doesn't fail the pre-commit hook on a max-warnings tripwire.
  "{offchain,backend,ui,integration-tests,stress-tests}/**/*.{ts,tsx,js,jsx}": [
    "eslint --fix --max-warnings=0 --no-warn-ignored",
  ],

  // Per-workspace typecheck if any TS file in that workspace was touched.
  // Each entry's first command is a no-op formatter pass already covered
  // above; the closure is what does the real work.
  "offchain/**/*.{ts,tsx}": tscIfTouched("offchain", "@lovejoin/sdk"),
  "backend/**/*.{ts,tsx}": tscIfTouched("backend", "@lovejoin/backend"),
  "ui/**/*.{ts,tsx}": tscIfTouched("ui", "@lovejoin/ui"),
  "integration-tests/**/*.{ts,tsx}": tscIfTouched("integration-tests", "integration-tests"),
};

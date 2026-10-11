// Node resolve hook, preloaded with `--import` (vitest.config.ts does this).
//
// libsodium-wrappers-sumo 0.7.16's ESM build imports "./libsodium-sumo.mjs",
// but that file ships in the sibling `libsodium-sumo` package, so under pnpm
// every import of mesh fails in Node. The UI fixes the same bug with a Vite
// alias (ui/vite.config.ts); here we redirect the one specifier to the
// package, which Node then finds next to libsodium-wrappers-sumo.
import { register } from "node:module";

const hooks = `
export async function resolve(specifier, context, next) {
  if (specifier === "./libsodium-sumo.mjs" && context.parentURL?.includes("/libsodium-wrappers-sumo/")) {
    return next("libsodium-sumo", context);
  }
  return next(specifier, context);
}`;

register(`data:text/javascript,${encodeURIComponent(hooks)}`);

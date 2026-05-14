// Public surface of the strategy layer (issue #137).
//
// Strategy modules sit ABOVE the per-tx builders in `tx/` and below the
// UI / CLI. They compose multiple Mix txs into a privacy-amplification
// flow that the user opts into with a single click. `fanout.ts` is the
// first such strategy; future modules can land here (e.g. background
// pool-keepalive, scheduled re-randomisation) without re-exporting
// through the SDK root each time.

export * from "./fanout.js";
export * from "./orchestrator.js";

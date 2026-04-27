export const SDK_VERSION = "0.0.0";

// M1: cryptography (variable-N sigma-OR + Schnorr + DH-tuple).
// See docs/spec/02-cryptography.md and docs/spec/12-build-guide.md.
export * from "./crypto/index.js";

// M2: chain-provider abstraction + Blockfrost implementation.
// See docs/spec/09-milestones.md M2 notes.
export * from "./chain/index.js";

// M3: tx-builder surface (deposit + withdraw + collateral provider). See
// docs/spec/04-offchain.md and docs/spec/09-milestones.md M3.
export * from "./tx/index.js";
export * from "./wallet/index.js";

// @lovejoin/sdk · seedelf module — stealth wallet integration.
//
// Spec: issue #135. Surfaces the Seedelf protocol (https://github.com/
// logical-mechanism/Seedelf-Wallet) as a wallet layer the Lovejoin UI
// can host inside its existing Vault. Sub-modules:
//
//   seed       — per-index BLS scalar derivation, domain-separated from
//                Lovejoin owners via "lovejoin/seedelf/v1".
//   register   — Register datum (g, u), re-randomization, ownership
//                check, Plutus-Data CBOR encode/decode.
//   token      — 5eed0e1f… NFT name generator + locator detector.
//   schnorr    — Seedelf-flavoured Schnorr prove/verify (blake2b-224,
//                vkh as Fiat-Shamir bound).
//   redeemer   — Mint + Spend redeemer encoders.
//   signer     — Ephemeral Ed25519 one-time-pad signer for spends.
//   scanner    — Walk the wallet-script address and classify owned
//                registers vs funds.
//   addresses  — Canonical per-network deployment coordinates with
//                env-override hooks.
//
// The tx builders proper (mint / send / spend) live in submodules below;
// this index curates the public surface.

export * from "./seed.js";
export * from "./register.js";
export * from "./token.js";
export * from "./schnorr.js";
export * from "./redeemer.js";
export * from "./signer.js";
export * from "./scanner.js";
export * from "./addresses.js";
export * from "./mint.js";
export * from "./send.js";
export * from "./spend.js";
export * from "./rng.js";

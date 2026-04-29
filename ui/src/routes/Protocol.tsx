// Protocol page — explains how Lovejoin works, with the math.
//
// Spec: docs/spec/02-cryptography.md + papers/sigmajoin.pdf, condensed
// for a non-academic reader. The goal isn't a full security proof — that
// lives in the paper — it's a self-contained walkthrough that someone
// who knows what an elliptic-curve point is can read in five minutes.
//
// Math is rendered in the `lj-math` block (mono, signal-bordered) so it
// reads as a primitive, not as decorative typography.
//
// i18n-lint-skip: this is a long technical document. Extracting every
// sentence to en.json wouldn't survive a meaningful translation pass
// (the cryptographic vocabulary doesn't translate cleanly), and dilutes
// the lint signal on the rest of the app.

import { useTranslation } from "react-i18next";

import { Eyebrow } from "../components/ui/Eyebrow.js";

export function Protocol() {
  const { t } = useTranslation();

  return (
    <article className="lj-prose">
      <header>
        <Eyebrow>{t("protocol.eyebrow")}</Eyebrow>
        <h1 className="mt-2 font-mono text-3xl font-medium tracking-tight text-paper">
          {t("protocol.title")}
        </h1>
        <p className="mt-3 text-muted">{t("protocol.lede")}</p>
      </header>

      <h2>{t("protocol.primitives_h")}</h2>
      <p>{t("protocol.primitives_p")}</p>
      <ul>
        <li>
          <strong>G</strong> — the generator of BLS12-381 G1, the curve
          subgroup of order <code>r</code>.
        </li>
        <li>
          <strong>x ∈ Z_r</strong> — your owner secret. Derived
          deterministically from your wallet's CIP-8 signature so it
          never needs to be backed up separately.
        </li>
        <li>
          <strong>blake2b-256</strong> — the hash function used for both
          on-chain Fiat–Shamir and this UI's vault seed.
        </li>
      </ul>

      <h2>{t("protocol.deposit_h")}</h2>
      <p>
        A deposit picks a fresh randomness <code>d</code> and locks the
        fixed denomination at the mix-box script with the inline datum
        — two 48-byte compressed G1 points, with <code>b</code> acting
        as your ownership mark:
      </p>
      <pre className="lj-math">
        <code>{`a = [d] · G
b = [x · d] · G`}</code>
      </pre>
      <p>
        Anyone watching the chain sees <code>(a, b)</code> but learns
        nothing about <code>x</code> or <code>d</code> — both are uniform
        random samples and the discrete log is hard.
      </p>

      <h2>{t("protocol.mix_h")}</h2>
      <p>
        A Mix tx picks <strong>N</strong> live boxes and re-randomises
        them with a per-input fresh scalar <code>y_i</code>. The
        <em> output</em> at position <code>i</code> is the
        <em> permuted re-randomisation</em>:
      </p>
      <pre className="lj-math">
        <code>{`for each input i ∈ 0..N:
    a'_i = [y_π(i)] · a_π(i)
    b'_i = [y_π(i)] · b_π(i)`}</code>
      </pre>
      <p>
        where <code>π</code> is a permutation of <code>0..N</code>. The
        crucial property: if <code>b_i = [x_i] · a_i</code> on input,
        then <code>{" "}b'_i = [x_π(i)] · a'_i</code> on output —
        ownership survives the re-randomisation, but the pairing
        <em> input → output</em> is hidden.
      </p>
      <p>
        To prove the tx preserves ownership without revealing
        <em>{" "}which</em> input it owns, the submitter generates an
        <strong>{" "}N-way sigma-OR</strong> proof per input — one Schnorr
        proof of "I know <code>x</code> for some output", verified
        on chain. The Fiat–Shamir challenge binds to all N output
        statements + the box's deposit datum, so the proof can't be
        re-targeted.
      </p>

      <h2>{t("protocol.privacy_h")}</h2>
      <p>
        After a single Mix at width <code>N</code>, the probability that
        an outside observer correctly links your input to your output is
        <code>{" "}1/N</code>. After <code>k</code> independent rounds:
      </p>
      <pre className="lj-math">
        <code>{`Pr[linkage] ≤ (1/N)^k`}</code>
      </pre>
      <p>
        At <strong>N = 3</strong> (Lovejoin's calibrated cap on Preprod
        today) every additional round divides the linkage probability by
        3. Twelve rounds drives it under 2⁻¹⁹ — fewer than one chance in
        half a million. Twenty rounds drives it under 2⁻³¹.
      </p>

      <h2>{t("protocol.withdraw_h")}</h2>
      <p>
        To leave the pool you spend the mix-box at the
        <code>{" "}mix_box</code> script's owner branch with a Schnorr proof
        of <code>b = [x] · a</code> bound to <code>tx.outputs</code>.
        The prover picks a uniform <code>k ∈ Z_r</code> and computes:
      </p>
      <pre className="lj-math">
        <code>{`commit:    t = [k] · a
challenge: c = blake2b(a ‖ b ‖ t ‖ outputs ‖ scriptHash)
response:  s = k + c · x   mod r
verify:    [s] · a ≟ t + [c] · b`}</code>
      </pre>
      <p>
        Output substitution invalidates the challenge, so the validator
        can spend the box only along the spend path the prover signed.
        No wallet signature on the box itself — only the destination
        outputs are tx-authorized by the submitter's wallet (which pays
        the fee).
      </p>

      <h2>{t("protocol.further_h")}</h2>
      <p>
        Full construction + security proofs are in the
        <a
          className="text-amber underline-offset-4 hover:underline"
          href="https://github.com/logical-mechanism/Lovejoin/blob/main/papers/sigmajoin.pdf"
          target="_blank"
          rel="noopener noreferrer"
        >
          {" "}Sigmajoin paper
        </a>
        . The on-chain validator implementation lives in
        <code>{" "}contracts/validators/mix_logic.ak</code>; the off-chain
        builder is <code>offchain/src/tx/mix.ts</code>; cross-language
        KAT vectors are in <code>crypto/test-vectors/</code>.
      </p>
    </article>
  );
}

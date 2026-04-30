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
// Prose is translated via i18n with the Trans component so inline `<code>`
// and `<strong>` markers survive translation. Math blocks stay untranslated
// — the formula notation is universal, and the few English keywords inside
// (e.g. "for each input") are conventional pseudocode that translators of
// cryptographic material typically leave in place.

import { Trans, useTranslation } from "react-i18next";

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
          <Trans
            i18nKey="protocol.primitive_g"
            components={{ b: <strong />, c: <code />, e: <em /> }}
          />
        </li>
        <li>
          <Trans
            i18nKey="protocol.primitive_x"
            components={{ b: <strong />, c: <code />, e: <em /> }}
          />
        </li>
        <li>
          <Trans
            i18nKey="protocol.primitive_hash"
            components={{ b: <strong />, c: <code />, e: <em /> }}
          />
        </li>
      </ul>

      <h2>{t("protocol.deposit_h")}</h2>
      <p>
        <Trans
          i18nKey="protocol.deposit_p1"
          components={{ b: <strong />, c: <code />, e: <em /> }}
        />
      </p>
      <pre className="lj-math">
        <code>{`a = [d] · g
b = [x · d] · g`}</code>
      </pre>
      <p>
        <Trans
          i18nKey="protocol.deposit_p2"
          components={{ b: <strong />, c: <code />, e: <em /> }}
        />
      </p>

      <h2>{t("protocol.mix_h")}</h2>
      <p>
        <Trans
          i18nKey="protocol.mix_p1"
          components={{ b: <strong />, c: <code />, e: <em /> }}
        />
      </p>
      <pre className="lj-math">
        <code>{`for each input i ∈ 0..N:
    a'_i = [y_π(i)] · a_π(i)
    b'_i = [y_π(i)] · b_π(i)`}</code>
      </pre>
      <p>
        <Trans
          i18nKey="protocol.mix_p2"
          components={{ b: <strong />, c: <code />, e: <em /> }}
        />
      </p>
      <p>
        <Trans
          i18nKey="protocol.mix_p3"
          components={{ b: <strong />, c: <code />, e: <em /> }}
        />
      </p>

      <h2>{t("protocol.privacy_h")}</h2>
      <p>
        <Trans
          i18nKey="protocol.privacy_p1"
          components={{ b: <strong />, c: <code />, e: <em /> }}
        />
      </p>
      <pre className="lj-math">
        <code>{`Pr[linkage] ≤ (1/N)^k`}</code>
      </pre>
      <p>
        <Trans
          i18nKey="protocol.privacy_p2"
          components={{ b: <strong />, c: <code />, e: <em /> }}
        />
      </p>

      <h2>{t("protocol.withdraw_h")}</h2>
      <p>
        <Trans
          i18nKey="protocol.withdraw_p1"
          components={{ b: <strong />, c: <code />, e: <em /> }}
        />
      </p>
      <pre className="lj-math">
        <code>{`commit:    t = [k] · a
challenge: c = blake2b(a ‖ b ‖ t ‖ outputs ‖ scriptHash)
response:  s = k + c · x   mod r
verify:    [s] · a ≟ t + [c] · b`}</code>
      </pre>
      <p>
        <Trans
          i18nKey="protocol.withdraw_p2"
          components={{ b: <strong />, c: <code />, e: <em /> }}
        />
      </p>

      <h2>{t("protocol.further_h")}</h2>
      <p>
        <Trans
          i18nKey="protocol.further_p"
          components={{
            c: <code />,
            paper: (
              <a
                className="text-amber underline-offset-4 hover:underline"
                href="https://github.com/logical-mechanism/Lovejoin/blob/main/papers/sigmajoin.pdf"
                target="_blank"
                rel="noopener noreferrer"
              />
            ),
          }}
        />
      </p>
    </article>
  );
}

// Help — non-developer landing for user-facing docs.
//
// Mirrors `Protocol.tsx`: long-form prose translated via `Trans` keys
// in `ui/src/i18n/locales/<locale>.json` under the `help.*` namespace.
// Three docs (user guide, FAQ, glossary) share a single `<article
// className="lj-prose">` shell; a tab strip switches between them and
// reflects the selection in `?doc=…` for shareable deep links.
//
// Inline formatting reuses Protocol's component map: `<b>` → bold,
// `<c>` → inline code, `<e>` → italic, `<a1>` / `<a2>` / … → anchor
// tags. Each anchor index resolves to a hand-bound href below — the
// Trans block can't carry URLs through translation, so the renderer
// supplies them via the `components` prop.

import { Trans, useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useEffect, useState } from "react";

import { Eyebrow } from "../components/ui/Eyebrow.js";

type DocId = "guide" | "faq" | "glossary";

const DOC_IDS: ReadonlyArray<DocId> = ["guide", "faq", "glossary"];

function isDocId(s: string | null): s is DocId {
  return s === "guide" || s === "faq" || s === "glossary";
}

/**
 * Inline formatting tags shared by every Trans block in this file.
 * Mirrors the `protocol.tsx` map: `<b>` for bold, `<c>` for inline
 * code, `<e>` for italic. Anchors are page-specific (the href map
 * differs per key) so we add them per call site below.
 */
const inlineTags = {
  b: <strong />,
  c: <code />,
  e: <em />,
};

/**
 * External link with the conventional safety attributes. Used inside
 * `Trans` `components` props for each `<a1>` / `<a2>` slot. We split
 * external (target=_blank + rel=noopener) from internal (SPA Link) so
 * the rendered DOM matches what users expect from the rest of the
 * app.
 */
function ext(href: string) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-amber underline-offset-4 hover:underline"
    />
  );
}

/**
 * Internal anchor that stays inside the SPA. We can't drop a
 * `<Link>` straight into the `components` map because Trans needs the
 * element itself to receive children, and `Link` accepts those just
 * like `<a>`. The `to` prop is set at the call site.
 */
function intern(to: string) {
  return <Link to={to} className="text-amber underline-offset-4 hover:underline" />;
}

export function Help() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  // The active doc lives in the URL via `?doc=…` so deep links into a
  // particular section survive a refresh and are shareable. Default
  // to the user guide for any unknown / missing value.
  const initial = searchParams.get("doc");
  const active: DocId = isDocId(initial) ? initial : "guide";

  return (
    <article className="lj-prose">
      <header>
        <Eyebrow>{t("help.eyebrow")}</Eyebrow>
        {/* Layout owns the page <h1> (sr-only, route-derived); the
         * visible page title here is h2 so the document outline is
         * h1 → h2 → h2... matching Protocol. */}
        <h2 className="mt-2 font-mono text-3xl font-medium tracking-tight text-paper">
          {t("help.title")}
        </h2>
        <p className="mt-3 text-muted">{t("help.lede")}</p>
      </header>

      <nav
        className="mt-6 flex flex-wrap gap-2"
        aria-label={t("help.tabs_aria_label")}
        role="tablist"
      >
        {DOC_IDS.map((id) => {
          const isActive = id === active;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`help-panel-${id}`}
              id={`help-tab-${id}`}
              className={isActive ? "lj-btn lj-btn--primary" : "lj-btn lj-btn--quiet"}
              onClick={() => navigate(`/help?doc=${id}`, { replace: false })}
            >
              {t(`help.tab_${id}`)}
            </button>
          );
        })}
      </nav>

      <section
        id={`help-panel-${active}`}
        role="tabpanel"
        aria-labelledby={`help-tab-${active}`}
        className="mt-6"
        // `key` on the panel resets scroll-anchored UI (the back-to-
        // top button reads scroll position) so swapping docs feels
        // like opening a fresh page rather than scrolling through
        // stitched-together sections.
        key={active}
      >
        {active === "guide" && <Guide />}
        {active === "faq" && <Faq />}
        {active === "glossary" && <Glossary />}
      </section>

      <BackToTopButton />
    </article>
  );
}

// ---------------------------------------------------------------------
// Guide
// ---------------------------------------------------------------------
//
// One <Trans> per paragraph / list item, named after the i18n key.
// The structure (h2 → p → ul/ol → p) is fixed in JSX; only the prose
// flows from i18n. Same shape as `Protocol.tsx`.
function Guide() {
  const { t } = useTranslation();
  return (
    <>
      <p>
        <Trans
          i18nKey="help.guide.intro_p1"
          components={{ ...inlineTags, a1: intern("/protocol") }}
        />
      </p>

      <h2>{t("help.guide.what_h")}</h2>
      <p>{t("help.guide.what_p1")}</p>
      <p>{t("help.guide.what_p2")}</p>

      <h2>{t("help.guide.mixing_h")}</h2>
      <p>{t("help.guide.mixing_p1")}</p>
      <ol>
        <li>
          <Trans i18nKey="help.guide.mixing_li1" components={inlineTags} />
        </li>
        <li>
          <Trans i18nKey="help.guide.mixing_li2" components={inlineTags} />
        </li>
        <li>
          <Trans i18nKey="help.guide.mixing_li3" components={inlineTags} />
        </li>
      </ol>
      <p>{t("help.guide.mixing_p2")}</p>
      {/* Diagram is universal pseudocode; same call as Protocol's
       * `<pre className="lj-math">` blocks for math expressions. */}
      <pre className="lj-math">
        <code>{`deposit  ──▶  mix  ──▶  mix  ──▶  ...  ──▶  withdraw
              │           │
              shuffles    shuffles
              N boxes     N boxes`}</code>
      </pre>

      <h2>{t("help.guide.fee_h")}</h2>
      <p>{t("help.guide.fee_p1")}</p>
      <ul>
        <li>
          <Trans i18nKey="help.guide.fee_li1" components={inlineTags} />
        </li>
        <li>
          <Trans i18nKey="help.guide.fee_li2" components={inlineTags} />
        </li>
      </ul>
      <p>
        <Trans i18nKey="help.guide.fee_p2" components={inlineTags} />
      </p>

      <h2>{t("help.guide.privacy_h")}</h2>
      <p>{t("help.guide.privacy_p1")}</p>
      <ul>
        <li>{t("help.guide.privacy_li1")}</li>
        <li>{t("help.guide.privacy_li2")}</li>
        <li>{t("help.guide.privacy_li3")}</li>
      </ul>
      <p>
        <Trans i18nKey="help.guide.privacy_p2" components={inlineTags} />
      </p>
      <ul>
        <li>
          <Trans
            i18nKey="help.guide.privacy_li4"
            components={{
              ...inlineTags,
              a1: ext("https://github.com/logical-mechanism/Seedelf-Wallet"),
            }}
          />
        </li>
        <li>{t("help.guide.privacy_li5")}</li>
        <li>{t("help.guide.privacy_li6")}</li>
      </ul>

      <h2>{t("help.guide.vault_h")}</h2>
      <p>{t("help.guide.vault_p1")}</p>
      <p>
        <Trans i18nKey="help.guide.vault_p2" components={inlineTags} />
      </p>
      <p>
        <Trans
          i18nKey="help.guide.vault_p3"
          components={{
            ...inlineTags,
            a1: ext("https://cips.cardano.org/cip/CIP-0030"),
          }}
        />
      </p>

      <h2>{t("help.guide.trouble_h")}</h2>
      <p>{t("help.guide.trouble_p1")}</p>
      <p>{t("help.guide.trouble_p2")}</p>
      <ul>
        <li>
          <Trans i18nKey="help.guide.trouble_li1" components={inlineTags} />
        </li>
        <li>
          <Trans i18nKey="help.guide.trouble_li2" components={inlineTags} />
        </li>
        <li>
          <Trans i18nKey="help.guide.trouble_li3" components={inlineTags} />
        </li>
        <li>
          <Trans
            i18nKey="help.guide.trouble_li4"
            components={{
              ...inlineTags,
              a1: ext("https://giveme.my/"),
            }}
          />
        </li>
        <li>
          <Trans i18nKey="help.guide.trouble_li5" components={inlineTags} />
        </li>
        <li>
          <Trans i18nKey="help.guide.trouble_li6" components={inlineTags} />
        </li>
      </ul>
      <p>
        <Trans
          i18nKey="help.guide.trouble_p3"
          components={{ ...inlineTags, a1: intern("/help?doc=faq") }}
        />
      </p>
    </>
  );
}

// ---------------------------------------------------------------------
// FAQ
// ---------------------------------------------------------------------
function Faq() {
  const { t } = useTranslation();
  return (
    <>
      <p>
        <Trans
          i18nKey="help.faq.intro_p1"
          components={{ ...inlineTags, a1: intern("/help?doc=guide") }}
        />
      </p>

      <h2>{t("help.faq.safe_h")}</h2>
      <p>
        <Trans i18nKey="help.faq.safe_p2" components={inlineTags} />
      </p>
      <p>
        <Trans i18nKey="help.faq.safe_p3" components={inlineTags} />
      </p>

      <h2>{t("help.faq.vault_h")}</h2>
      <p>{t("help.faq.vault_p1")}</p>
      <p>{t("help.faq.vault_p2")}</p>

      <h2>{t("help.faq.wallet_vs_vault_h")}</h2>
      <p>{t("help.faq.wallet_vs_vault_p1")}</p>
      <ul>
        <li>
          <Trans i18nKey="help.faq.wallet_vs_vault_li1" components={inlineTags} />
        </li>
        <li>
          <Trans i18nKey="help.faq.wallet_vs_vault_li2" components={inlineTags} />
        </li>
      </ul>
      <p>{t("help.faq.wallet_vs_vault_p2")}</p>

      <h2>{t("help.faq.midmix_h")}</h2>
      <p>{t("help.faq.midmix_p1")}</p>
      <p>
        <Trans i18nKey="help.faq.midmix_p2" components={inlineTags} />
      </p>
      <p>
        <Trans i18nKey="help.faq.midmix_p3" components={inlineTags} />
      </p>
      <p>{t("help.faq.midmix_p4")}</p>

      <h2>{t("help.faq.n_caps_h")}</h2>
      <p>{t("help.faq.n_caps_p1")}</p>
      <p>{t("help.faq.n_caps_p2")}</p>
      <ul>
        <li>
          <Trans i18nKey="help.faq.n_caps_li1" components={inlineTags} />
        </li>
        <li>
          <Trans i18nKey="help.faq.n_caps_li2" components={inlineTags} />
        </li>
      </ul>
      <p>{t("help.faq.n_caps_p3")}</p>

      <h2>{t("help.faq.errors_h")}</h2>
      <ul>
        <li>
          <Trans i18nKey="help.faq.errors_li1" components={inlineTags} />
        </li>
        <li>
          <Trans i18nKey="help.faq.errors_li2" components={inlineTags} />
        </li>
        <li>
          <Trans i18nKey="help.faq.errors_li3" components={inlineTags} />
        </li>
        <li>
          <Trans i18nKey="help.faq.errors_li4" components={inlineTags} />
        </li>
        <li>
          <Trans i18nKey="help.faq.errors_li5" components={inlineTags} />
        </li>
        <li>
          <Trans i18nKey="help.faq.errors_li6" components={inlineTags} />
        </li>
        <li>
          <Trans i18nKey="help.faq.errors_li7" components={inlineTags} />
        </li>
        <li>
          <Trans i18nKey="help.faq.errors_li8" components={inlineTags} />
        </li>
        <li>
          <Trans i18nKey="help.faq.errors_li9" components={inlineTags} />
        </li>
        <li>
          <Trans
            i18nKey="help.faq.errors_li10"
            components={{
              ...inlineTags,
              a1: ext("https://github.com/logical-mechanism/Lovejoin/issues"),
            }}
          />
        </li>
      </ul>
    </>
  );
}

// ---------------------------------------------------------------------
// Glossary
// ---------------------------------------------------------------------
//
// Glossary terms render as <h3>+<p> pairs; <h3> stays inside the
// `lj-prose` style block, so the heading hierarchy goes h1 → h2
// (eyebrow) → h3 (term) cleanly.
function Glossary() {
  const { t } = useTranslation();
  const terms = [
    "box",
    "deposit",
    "denomination",
    "fee_shard",
    "linkage_probability",
    "mix",
    "n_width",
    "owner_secret",
    "pool",
    "recovery_password",
    "vault",
    "wallet_anonymous",
    "withdraw",
  ] as const;
  return (
    <>
      <p>{t("help.glossary.intro_p1")}</p>
      {terms.map((term) => (
        <section key={term}>
          <h3>{t(`help.glossary.${term}_h`)}</h3>
          <p>
            <Trans i18nKey={`help.glossary.${term}_p1`} components={inlineTags} />
          </p>
        </section>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------
// Back-to-top button
// ---------------------------------------------------------------------
//
// The user guide alone is several screens of scroll, and tab swaps
// reset the panel content but not the scroll position. A floating
// "back to top" affordance keeps guide ↔ FAQ round trips fast.
//
// Visibility threshold: 240px (~two paragraphs on desktop) so the
// button doesn't clutter the first viewport. `behavior: smooth` is
// honored by browsers; users with `prefers-reduced-motion` get the
// instant jump natively.
function BackToTopButton() {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 240);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (!visible) return null;
  return (
    <button
      type="button"
      className="lj-back-to-top"
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      aria-label={t("help.back_to_top")}
      title={t("help.back_to_top")}
    >
      <span aria-hidden="true">↑</span>
      <span className="lj-back-to-top__label">{t("help.back_to_top")}</span>
    </button>
  );
}

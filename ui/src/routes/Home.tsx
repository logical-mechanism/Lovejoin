// Home — splash hero, three-pillar pitch, calm CTAs.
//
// Spec: M6.5 — "splash-style Home (hero + 3-bullet
// pitch + connect CTA, not a status-dump dashboard)". Network status
// stays in the Pool screen, not here; Home is the front door.

import { Link, useNavigate } from "react-router-dom";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useAppState } from "../lib/store.js";
import { WalletModal } from "../components/WalletModal.js";

export function Home() {
  const { t } = useTranslation();
  const { wallet, setWallet } = useAppState();
  const navigate = useNavigate();
  const [walletOpen, setWalletOpen] = useState(false);

  return (
    <>
      <section className="lj-hero">
        {/* Layout owns the page <h1> (sr-only, route-derived) so we keep the
         * heading order at h1 → h2 → h3 (pillars below). The visible hero
         * line gets h2 + the lj-hero__title styling so it still reads big. */}
        <h2 className="lj-hero__title">
          {t("home.headline_a")}
          <br />
          <em>{t("home.headline_b")}</em>
        </h2>
        <p className="lj-hero__lede">{t("home.lede")}</p>
        <div className="lj-hero__cta">
          {wallet ? (
            <button
              type="button"
              className="lj-btn lj-btn--primary lj-btn--lg"
              onClick={() => navigate("/deposit")}
            >
              {t("nav.deposit")}
            </button>
          ) : (
            <button
              type="button"
              className="lj-btn lj-btn--primary lj-btn--lg"
              onClick={() => setWalletOpen(true)}
            >
              {t("home.cta_primary")}
            </button>
          )}
          <Link to="/protocol" className="lj-btn lj-btn--lg">
            {t("home.cta_secondary")}
          </Link>
        </div>
      </section>

      <section className="lj-pillars">
        <Pillar
          numeral="I"
          title={t("home.pillar_one_title")}
          copy={t("home.pillar_one_copy")}
          to="/deposit"
        />
        <Pillar
          numeral="II"
          title={t("home.pillar_two_title")}
          copy={t("home.pillar_two_copy")}
          to="/pool"
        />
        <Pillar
          numeral="III"
          title={t("home.pillar_three_title")}
          copy={t("home.pillar_three_copy")}
          to="/vault"
        />
      </section>

      <WalletModal
        open={walletOpen}
        onClose={() => setWalletOpen(false)}
        onConnected={(args) => {
          setWallet(args);
          setWalletOpen(false);
        }}
      />
    </>
  );
}

function Pillar({
  numeral,
  title,
  copy,
  to,
}: {
  numeral: string;
  title: string;
  copy: string;
  to: string;
}) {
  return (
    <Link to={to} className="lj-pillar group block">
      <span className="lj-pillar__numeral" aria-hidden="true">
        {numeral}
      </span>
      <h3 className="lj-pillar__title">{title}</h3>
      <p className="lj-pillar__copy">{copy}</p>
    </Link>
  );
}

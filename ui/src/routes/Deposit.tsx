// Deposit route — DepositPanel + the freshly-created box's SecretCard.
//
// Spec: docs/spec/06-ui.md §"Deposit". On a successful deposit we
// auto-save the box into the encrypted vault (when unlocked) and surface
// the SecretCard so the user can copy / download / forget the secret.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { DepositPanel } from "../components/DepositPanel.js";
import { PassphraseModal } from "../components/PassphraseModal.js";
import { SecretCard } from "../components/SecretCard.js";
import { useAppState } from "../lib/store.js";
import type { StoredBox } from "../storage/secrets.js";

export function Deposit() {
  const { t } = useTranslation();
  const {
    config,
    provider,
    addresses,
    wallet,
    vault,
    addBox,
  } = useAppState();
  const [latest, setLatest] = useState<StoredBox | null>(null);
  const [savedToVault, setSavedToVault] = useState(false);
  const [persistError, setPersistError] = useState<string | null>(null);

  if (!provider || !addresses || !wallet) {
    return (
      <section className="rounded-md border border-gray-200 bg-white p-4 text-sm text-gray-700">
        {t("deposit.preconditions_missing")}
      </section>
    );
  }

  return (
    <>
      {!vault && <PassphraseModal />}
      <DepositPanel
        network={config.network}
        provider={provider}
        addresses={addresses}
        wallet={wallet}
        onDeposited={(b) => {
          const box: StoredBox = {
            txId: b.txId,
            outputIndex: b.outputIndex,
            ownerSecretHex: b.ownerSecretHex,
            aHex: b.aHex,
            bHex: b.bHex,
            label: b.label,
            rounds: b.rounds,
            createdAt: b.createdAt,
          };
          setLatest(box);
          setPersistError(null);
          if (vault) {
            addBox(box)
              .then(() => setSavedToVault(true))
              .catch((e: Error) => setPersistError(e.message));
          } else {
            setSavedToVault(false);
          }
        }}
      />

      {latest && <SecretCard box={latest} savedToVault={savedToVault} />}

      {persistError && (
        <p
          role="alert"
          className="rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900"
        >
          {t("vault.save_failed", { message: persistError })}
        </p>
      )}

      {latest && (
        <p className="text-xs text-gray-600">
          {t("deposit.see_vault")}{" "}
          <Link className="font-medium underline" to="/vault">
            {t("nav.vault")}
          </Link>
        </p>
      )}
    </>
  );
}

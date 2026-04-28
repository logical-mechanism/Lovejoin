// Withdraw — generic form for spending an owned box to any address.
//
// The dedicated per-box variant is /vault/:txid/:idx (Box route). This
// screen exists for users who imported a secret in a previous session and
// want to withdraw without going through the Vault.

import { useTranslation } from "react-i18next";

import { PassphraseModal } from "../components/PassphraseModal.js";
import { WithdrawPanel } from "../components/WithdrawPanel.js";
import { useAppState } from "../lib/store.js";

export function Withdraw() {
  const { t } = useTranslation();
  const { config, provider, addresses, wallet, vault, removeBox } = useAppState();

  if (!provider || !addresses || !wallet) {
    return (
      <section className="rounded-md border border-gray-200 bg-white p-4 text-sm text-gray-700">
        {t("withdraw.preconditions_missing")}
      </section>
    );
  }

  return (
    <>
      {!vault && <PassphraseModal />}
      <WithdrawPanel
        network={config.network}
        provider={provider}
        addresses={addresses}
        wallet={wallet}
        prefill={null}
        onWithdrawn={(spent) => {
          if (vault) void removeBox(spent.txId, spent.outputIndex);
        }}
      />
    </>
  );
}

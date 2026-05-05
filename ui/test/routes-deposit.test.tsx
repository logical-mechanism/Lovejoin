// Render-smoke for /deposit.
//
// Without an unlocked vault the deposit route renders its locked-
// card variant — same shape as the Vault locked screen, since the
// deposit form derives its owner secrets from the vault seed. The
// happy-path form is exercised by Playwright; this test only catches
// import / prop-type regressions.

import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { Deposit } from "../src/routes/Deposit.js";
import { BackendStatusProvider } from "../src/components/BackendStatus.js";
import { ToasterProvider } from "../src/components/Toaster.js";
import { AppStateProvider } from "../src/lib/store.js";
import "../src/i18n/index.js";

function renderDeposit() {
  render(
    <AppStateProvider testOverrides={{ skipAddressLoad: true }}>
      <ToasterProvider>
        <BackendStatusProvider backendUrl={null} testOverrides={{ skipPolling: true }}>
          <MemoryRouter initialEntries={["/deposit"]}>
            <Routes>
              <Route path="/deposit" element={<Deposit />} />
            </Routes>
          </MemoryRouter>
        </BackendStatusProvider>
      </ToasterProvider>
    </AppStateProvider>,
  );
}

describe("Deposit route", () => {
  it("renders the section heading without throwing", () => {
    renderDeposit();
    expect(screen.getByRole("heading", { name: "Deposit", level: 2 })).toBeInTheDocument();
  });

  it("disables the unlock button when no wallet is connected", () => {
    renderDeposit();
    const btn = screen.getByRole("button", { name: /Unlock with wallet/i });
    expect(btn).toBeDisabled();
  });
});

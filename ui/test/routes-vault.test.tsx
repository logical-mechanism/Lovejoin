// Render-smoke for /vault.
//
// Without an unlocked vault (the default in AppStateProvider), the
// route renders its locked-card variant: title, lede, and the "Unlock
// with wallet" CTA. That's enough to catch the "import crashes" /
// "stale prop type" class of regression in milliseconds, well before
// Playwright runs against Preprod.

import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { Vault } from "../src/routes/Vault.js";
import { AppStateProvider } from "../src/lib/store.js";
import "../src/i18n/index.js";

function renderVault() {
  render(
    <AppStateProvider testOverrides={{ skipAddressLoad: true }}>
      <MemoryRouter initialEntries={["/vault"]}>
        <Routes>
          <Route path="/vault" element={<Vault />} />
        </Routes>
      </MemoryRouter>
    </AppStateProvider>,
  );
}

describe("Vault route", () => {
  it("renders the locked-card title without throwing", () => {
    renderVault();
    expect(screen.getByRole("heading", { name: "Vault locked", level: 2 })).toBeInTheDocument();
  });

  it("disables the unlock button when no wallet is connected", () => {
    renderVault();
    const btn = screen.getByRole("button", { name: /Unlock with wallet/i });
    expect(btn).toBeDisabled();
  });
});

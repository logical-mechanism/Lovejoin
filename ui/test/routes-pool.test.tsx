// Render-smoke for /pool.
//
// Pool needs the toast, collateral, and backend providers because
// its hooks are called unconditionally on mount. With no provider /
// addresses (the default for `skipAddressLoad`), the visible-refresh
// hook stays disabled and no Blockfrost / backend traffic fires.

import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { Pool } from "../src/routes/Pool.js";
import { BackendStatusProvider } from "../src/components/BackendStatus.js";
import { CollateralStatusProvider } from "../src/components/CollateralProviderStatus.js";
import { ToasterProvider } from "../src/components/Toaster.js";
import { AppStateProvider } from "../src/lib/store.js";
import "../src/i18n/index.js";

function renderPool() {
  render(
    <AppStateProvider testOverrides={{ skipAddressLoad: true }}>
      <ToasterProvider>
        <CollateralStatusProvider endpoint={null} testOverrides={{ skipPolling: true }}>
          <BackendStatusProvider backendUrl={null} testOverrides={{ skipPolling: true }}>
            <MemoryRouter initialEntries={["/pool"]}>
              <Routes>
                <Route path="/pool" element={<Pool />} />
              </Routes>
            </MemoryRouter>
          </BackendStatusProvider>
        </CollateralStatusProvider>
      </ToasterProvider>
    </AppStateProvider>,
  );
}

describe("Pool route", () => {
  it("renders the section heading without throwing", () => {
    renderPool();
    expect(screen.getByRole("heading", { name: "Mix", level: 2 })).toBeInTheDocument();
  });

  it("renders the fee-payer toggle", () => {
    renderPool();
    expect(screen.getByRole("group", { name: "Fee payer" })).toBeInTheDocument();
  });
});

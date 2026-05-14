// Render-smoke for /pool.
//
// Pool needs the toast, collateral, and backend providers because its
// hooks are called unconditionally on mount. With no provider /
// addresses (the default for `skipAddressLoad`), MixPanel is gated off
// behind the `showReady` branch and the route shows the loading
// skeleton — the assertions below match that state.

import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { Pool } from "../src/routes/Pool.js";
import { BackendStatusProvider } from "../src/components/BackendStatus.js";
import { CollateralStatusProvider } from "../src/components/CollateralProviderStatus.js";
import { ToasterProvider } from "../src/components/Toaster.js";
import { AppStateProvider } from "../src/lib/store.js";
import "../src/i18n/index.js";

function renderPool(initialEntries: string[] = ["/pool"]) {
  render(
    <AppStateProvider testOverrides={{ skipAddressLoad: true }}>
      <ToasterProvider>
        <CollateralStatusProvider endpoint={null} testOverrides={{ skipPolling: true }}>
          <BackendStatusProvider backendUrl={null} testOverrides={{ skipPolling: true }}>
            <MemoryRouter initialEntries={initialEntries}>
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

  it("renders the loading skeleton when the pool isn't ready", () => {
    renderPool();
    // skipAddressLoad keeps the pool refresh disabled; the loading
    // branch wins because we never transition out of loading=true.
    expect(screen.getByRole("status")).toHaveTextContent(/scanning/i);
  });

  it("accepts ?intensity=2 in the URL without throwing", () => {
    // The intensity param is consumed by MixPanel, which doesn't render
    // when provider/addresses are unset; we just verify the route still
    // mounts cleanly with the param present so a deep-link from the
    // Vault CTA can't crash the page before the pool loads.
    renderPool(["/pool?intensity=2"]);
    expect(screen.getByRole("heading", { name: "Mix", level: 2 })).toBeInTheDocument();
  });
});

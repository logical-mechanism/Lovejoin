// Render-smoke for /vault/:txid/:idx (Box detail).
//
// Without an unlocked vault the route's effect navigates back to
// /vault, so we render under a small two-route MemoryRouter and
// assert the redirect lands. Proves the import + the redirect effect
// fire without throwing.

import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { Box } from "../src/routes/Box.js";
import { ToasterProvider } from "../src/components/Toaster.js";
import { AppStateProvider } from "../src/lib/store.js";
import "../src/i18n/index.js";

function renderBox(initialPath: string = "/vault/abcdef/0") {
  render(
    <AppStateProvider testOverrides={{ skipAddressLoad: true }}>
      <ToasterProvider>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/vault" element={<div>vault stub</div>} />
            <Route path="/vault/:txid/:idx" element={<Box />} />
          </Routes>
        </MemoryRouter>
      </ToasterProvider>
    </AppStateProvider>,
  );
}

describe("Box route", () => {
  it("redirects to /vault when the vault is locked", () => {
    renderBox();
    expect(screen.getByText("vault stub")).toBeInTheDocument();
  });
});

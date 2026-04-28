// M6 router shell.
//
// Replaces the M3.5 single-page layout with a real router + AppState
// context. Each route lives in routes/ and pulls shared state via
// `useAppState`. The collateral-provider status is hoisted to App-level so
// the polling fires once and every screen reads from the same context.

import { BrowserRouter, Route, Routes } from "react-router-dom";

import { CollateralStatusProvider } from "./components/CollateralProviderStatus.js";
import { ToasterProvider } from "./components/Toaster.js";
import { Box } from "./routes/Box.js";
import { Deposit } from "./routes/Deposit.js";
import { Home } from "./routes/Home.js";
import { Layout } from "./routes/Layout.js";
import { Pool } from "./routes/Pool.js";
import { Protocol } from "./routes/Protocol.js";
import { Vault } from "./routes/Vault.js";
import { Withdraw } from "./routes/Withdraw.js";
import { AppStateProvider, useAppState } from "./lib/store.js";

export function App() {
  return (
    <AppStateProvider>
      <ToasterProvider>
        <CollateralStatusBridge>
          <BrowserRouter>
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<Home />} />
                <Route path="deposit" element={<Deposit />} />
                <Route path="pool" element={<Pool />} />
                <Route path="vault" element={<Vault />} />
                <Route path="vault/:txid/:idx" element={<Box />} />
                <Route path="withdraw" element={<Withdraw />} />
                <Route path="protocol" element={<Protocol />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </CollateralStatusBridge>
      </ToasterProvider>
    </AppStateProvider>
  );
}

/**
 * Tiny bridge that subscribes the CollateralStatusProvider to the app's
 * configured endpoint without forcing the whole tree to re-mount when the
 * user changes it. Owned here (not inside Layout) so the polling persists
 * across route navigations.
 */
function CollateralStatusBridge({ children }: { children: React.ReactNode }) {
  const { config } = useAppState();
  return (
    <CollateralStatusProvider endpoint={config.collateralProviderEndpoint || null}>
      {children}
    </CollateralStatusProvider>
  );
}

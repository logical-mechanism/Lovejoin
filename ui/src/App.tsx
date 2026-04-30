// M6 router shell.
//
// Replaces the M3.5 single-page layout with a real router + AppState
// context. Each route lives in routes/ and pulls shared state via
// `useAppState`. The collateral-provider status is hoisted to App-level so
// the polling fires once and every screen reads from the same context.

import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { BackendStatusProvider } from "./components/BackendStatus.js";
import { CollateralStatusProvider } from "./components/CollateralProviderStatus.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { ToasterProvider } from "./components/Toaster.js";
import { Box } from "./routes/Box.js";
import { Deposit } from "./routes/Deposit.js";
import { Donate } from "./routes/Donate.js";
import { Home } from "./routes/Home.js";
import { Layout } from "./routes/Layout.js";
import { Pool } from "./routes/Pool.js";
import { Protocol } from "./routes/Protocol.js";
import { Vault } from "./routes/Vault.js";
import { AppStateProvider, useAppState } from "./lib/store.js";

export function App() {
  // ErrorBoundary wraps the entire tree below the providers so:
  //  - the boundary itself can call useTranslation (i18n is initialized
  //    statically from main.tsx, no provider needed in-tree);
  //  - if a route throws, the AppStateProvider stays mounted so the
  //    user's session state isn't blown away on the way to the error
  //    screen. The "Reset state" button in the boundary reaches in and
  //    wipes localStorage explicitly when that's actually wanted.
  return (
    <AppStateProvider>
      <ToasterProvider>
        <CollateralStatusBridge>
          <BackendStatusBridge>
            <ErrorBoundary>
              <BrowserRouter>
                <Routes>
                  <Route element={<Layout />}>
                    <Route index element={<Home />} />
                    <Route path="deposit" element={<Deposit />} />
                    <Route path="donate" element={<Donate />} />
                    <Route path="pool" element={<Pool />} />
                    <Route path="vault" element={<Vault />} />
                    <Route path="vault/:txid/:idx" element={<Box />} />
                    {/* /withdraw was a parallel multi-select flow that
                     * duplicated the Vault list. Folded into Vault; keep
                     * a redirect so external links + bookmarks still land. */}
                    <Route path="withdraw" element={<Navigate to="/vault" replace />} />
                    <Route path="protocol" element={<Protocol />} />
                  </Route>
                </Routes>
              </BrowserRouter>
            </ErrorBoundary>
          </BackendStatusBridge>
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

/**
 * Sibling bridge for the self-hosted backend (db-sync + ogmios indexer).
 * Polls `/health` every 15s so the footer badge can show whether we're
 * actually leaning on our own stack or silently falling back to Blockfrost.
 */
function BackendStatusBridge({ children }: { children: React.ReactNode }) {
  const { config } = useAppState();
  return (
    <BackendStatusProvider backendUrl={config.backendUrl || null}>
      {children}
    </BackendStatusProvider>
  );
}

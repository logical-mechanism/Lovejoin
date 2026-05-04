// M6 router shell.
//
// Replaces the M3.5 single-page layout with a real router + AppState
// context. Each route lives in routes/ and pulls shared state via
// `useAppState`. The collateral-provider status is hoisted to App-level so
// the polling fires once and every screen reads from the same context.

import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { BackendStatusProvider } from "./components/BackendStatus.js";
import { CollateralStatusProvider } from "./components/CollateralProviderStatus.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { ToasterProvider } from "./components/Toaster.js";
import { Home } from "./routes/Home.js";
import { Layout } from "./routes/Layout.js";
import { AppStateProvider, useAppState } from "./lib/store.js";

// Non-Home routes are code-split. The home/landing path is the only one
// reachable on first paint — every other screen requires either a wallet
// connection or an unlocked vault, both of which take user action. Lazy
// chunks shave hundreds of KB off the entry bundle and let the LCP-
// critical hero render without waiting on Vault/Pool/Box etc. to parse.
//
// ErrorBoundary above each <Suspense> swallows chunk-load failures so a
// flaky network on a stale tab doesn't blank the whole app — see the
// route fallback below.
const Box = lazy(() => import("./routes/Box.js").then((m) => ({ default: m.Box })));
const Deposit = lazy(() => import("./routes/Deposit.js").then((m) => ({ default: m.Deposit })));
const Donate = lazy(() => import("./routes/Donate.js").then((m) => ({ default: m.Donate })));
const Help = lazy(() => import("./routes/Help.js").then((m) => ({ default: m.Help })));
const Pool = lazy(() => import("./routes/Pool.js").then((m) => ({ default: m.Pool })));
const Protocol = lazy(() => import("./routes/Protocol.js").then((m) => ({ default: m.Protocol })));
const Vault = lazy(() => import("./routes/Vault.js").then((m) => ({ default: m.Vault })));

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
                    <Route
                      path="deposit"
                      element={
                        <Suspense fallback={<RouteFallback />}>
                          <Deposit />
                        </Suspense>
                      }
                    />
                    <Route
                      path="donate"
                      element={
                        <Suspense fallback={<RouteFallback />}>
                          <Donate />
                        </Suspense>
                      }
                    />
                    <Route
                      path="pool"
                      element={
                        <Suspense fallback={<RouteFallback />}>
                          <Pool />
                        </Suspense>
                      }
                    />
                    <Route
                      path="vault"
                      element={
                        <Suspense fallback={<RouteFallback />}>
                          <Vault />
                        </Suspense>
                      }
                    />
                    <Route
                      path="vault/:txid/:idx"
                      element={
                        <Suspense fallback={<RouteFallback />}>
                          <Box />
                        </Suspense>
                      }
                    />
                    {/* /withdraw was a parallel multi-select flow that
                     * duplicated the Vault list. Folded into Vault; keep
                     * a redirect so external links + bookmarks still land. */}
                    <Route path="withdraw" element={<Navigate to="/vault" replace />} />
                    <Route
                      path="protocol"
                      element={
                        <Suspense fallback={<RouteFallback />}>
                          <Protocol />
                        </Suspense>
                      }
                    />
                    <Route
                      path="help"
                      element={
                        <Suspense fallback={<RouteFallback />}>
                          <Help />
                        </Suspense>
                      }
                    />
                    {/* Catch-all: unknown URLs (typos, stale external
                     * links, anyone hitting the backend's /docs on the
                     * UI origin by mistake) redirect to Home rather than
                     * rendering a blank screen + a React Router warning.
                     * `replace` keeps the bad URL out of history. */}
                    <Route path="*" element={<Navigate to="/" replace />} />
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
 * Minimal placeholder shown while a lazy route chunk is in flight.
 * Intentionally non-translated and class-only — the route bundle owns
 * its own copy + i18n keys. Keeping this tiny so it doesn't add to the
 * entry chunk weight we're trying to reduce.
 */
function RouteFallback() {
  return <div className="lj-route-fallback" aria-hidden="true" />;
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
    <BackendStatusProvider backendUrl={config.backendUrl || null}>{children}</BackendStatusProvider>
  );
}

// Tiny hook that returns `false` until the browser has had a chance to
// paint the initial frame, then flips to `true`. Used to gate side-
// channel work (collateral probe, backend /health, addresses.json fetch)
// out of the LCP-critical window so those requests don't contend for
// connections during page load.
//
// Mechanics: on mount we schedule a microtask via `requestIdleCallback`
// when the browser supports it (most do), falling back to a 200ms
// `setTimeout` otherwise. Either way we're past first paint and the
// JS bundle has finished its synchronous bootstrap before the gated
// fetch fires.
//
// Caller passes `skip = true` when they don't want any deferral
// (e.g. tests that inject `testOverrides.skipPolling`).

import { useEffect, useState } from "react";

interface IdleWindow {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
}

export function useAfterFirstPaint(skip = false): boolean {
  const [ready, setReady] = useState(skip);

  useEffect(() => {
    if (skip) {
      setReady(true);
      return;
    }
    if (typeof window === "undefined") return;
    const w = window as Window & IdleWindow;
    if (typeof w.requestIdleCallback === "function") {
      // 1.5s timeout caps the wait on a busy main thread so the probe
      // doesn't get postponed indefinitely if the user keeps interacting.
      const id = w.requestIdleCallback(() => setReady(true), { timeout: 1500 });
      return () => {
        if (typeof w.cancelIdleCallback === "function") w.cancelIdleCallback(id);
      };
    }
    // Safari + older browsers: small fixed delay past LCP. 200ms is
    // long enough for the entry chunk parse + first render to wrap up
    // on a slow phone, short enough that the badge feels live.
    const id = window.setTimeout(() => setReady(true), 200);
    return () => window.clearTimeout(id);
  }, [skip]);

  return ready;
}

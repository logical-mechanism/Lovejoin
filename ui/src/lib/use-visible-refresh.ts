// Tab-aware refresh hook.
//
// Four triggers fire the caller's refresh function:
//
//   1. **mount** — once when the consumer subscribes. Used by callers
//      that want to populate their initial state on first render.
//   2. **visibility** — when `document.visibilityState` flips back to
//      "visible" after being hidden for at least `staleThresholdMs`.
//      Real users tab away for minutes; coming back to a 30-min-old
//      pool view feels broken. The threshold prevents firing on a tiny
//      tab-switch flicker.
//   3. **interval** — periodic, only while the document is visible.
//      Hidden tabs throttle setInterval down to 1/min in modern
//      browsers anyway, but explicitly stopping the timer also stops
//      the chain-provider HTTP load when the user isn't watching.
//   4. **manual** — caller invokes `refresh()` from the returned
//      handle. Useful when an upstream signal flips (e.g. backend
//      health goes synced) and you want an immediate re-fetch without
//      remounting the consumer.
//
// The callback is captured through a ref so the consumer can
// reference component state inside it without re-binding the
// listeners on every render.
//
// Returned: a `refresh()` trigger that consumers can wire into their
// own effects. Consumers wire their own loading flag inside the
// callback if they want a different visual treatment for `mount`
// (skeleton) vs `visibility` / `interval` / `manual` (silent re-fetch).

import { useEffect, useRef } from "react";

export type RefreshTrigger = "mount" | "visibility" | "interval" | "manual";

export interface UseVisibleRefreshHandle {
  /** Imperatively trigger a refresh (e.g. from an upstream effect). */
  refresh: () => void;
}

export interface UseVisibleRefreshOptions {
  /** Periodic refresh while visible. Default 30 s. Set 0 to disable. */
  intervalMs?: number;
  /**
   * Minimum hidden duration before a re-show triggers a refresh.
   * Default 5 s — short enough that "alt-tab and back to check" feels
   * fresh, long enough that an OS-level focus blip doesn't fire.
   */
  staleThresholdMs?: number;
  /**
   * Disable the entire effect. Useful when the caller's preconditions
   * aren't met yet (e.g. provider/addresses not loaded) and they want
   * the hook to no-op rather than fire an empty refresh.
   */
  enabled?: boolean;
}

export function useVisibleRefresh(
  callback: (trigger: RefreshTrigger) => void | Promise<void>,
  opts: UseVisibleRefreshOptions = {},
): UseVisibleRefreshHandle {
  const { intervalMs = 30_000, staleThresholdMs = 5_000, enabled = true } = opts;

  // Latest-callback ref so listeners read the current closure without
  // re-attaching on every render.
  const cbRef = useRef(callback);
  cbRef.current = callback;

  // Latest-fire ref the consumer-facing `refresh()` thunk reads from.
  // The thunk identity stays stable across renders even though the
  // underlying behaviour rebinds when `enabled` flips.
  const fireRef = useRef<((trigger: RefreshTrigger) => void) | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") {
      fireRef.current = null;
      return;
    }
    if (!enabled) {
      fireRef.current = null;
      return;
    }

    let intervalId: number | null = null;
    let lastHiddenAt = 0;

    const fire = (trigger: RefreshTrigger) => {
      // Swallow async errors — the consumer has its own error
      // handling. We don't want a transient network blip on a
      // background refresh to throw an unhandled rejection.
      try {
        const r = cbRef.current(trigger);
        if (r instanceof Promise) r.catch(() => {});
      } catch {
        /* swallow synchronous throw */
      }
    };
    fireRef.current = fire;

    const startInterval = () => {
      if (intervalId !== null) return;
      if (intervalMs <= 0) return;
      intervalId = window.setInterval(() => fire("interval"), intervalMs);
    };
    const stopInterval = () => {
      if (intervalId === null) return;
      window.clearInterval(intervalId);
      intervalId = null;
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        // Only fire on visibility-back if we've actually been hidden
        // long enough; lastHiddenAt = 0 covers the initial mount case
        // (no hide happened yet).
        if (lastHiddenAt > 0 && Date.now() - lastHiddenAt >= staleThresholdMs) {
          fire("visibility");
        }
        startInterval();
      } else {
        lastHiddenAt = Date.now();
        stopInterval();
      }
    };

    fire("mount");
    if (document.visibilityState === "visible") startInterval();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stopInterval();
      document.removeEventListener("visibilitychange", onVisibility);
      fireRef.current = null;
    };
  }, [enabled, intervalMs, staleThresholdMs]);

  // Stable identity across renders — the closure dispatches through
  // fireRef which is rebound on each effect run. No-op when the hook
  // is disabled or the consumer is mid-mount.
  const refreshRef = useRef<() => void>(() => fireRef.current?.("manual"));

  return { refresh: refreshRef.current };
}

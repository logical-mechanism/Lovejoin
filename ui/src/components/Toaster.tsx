// Toaster — top-right slide-in notifications.
//
// Spec: M6.5 dogfood feedback (no toasts for tx success/failure; users
// can't see what happened after they click submit). The toast system
// surfaces async outcomes — successful tx submission, errors — with an
// optional cardanoscan link rendered next to the message.
//
// Implementation is intentionally tiny: one Context, one push helper,
// one portal-rendered list, auto-dismiss on a timer per toast. No queue
// management, no animation library. The CSS handles slide-in via
// keyframes; React handles state.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import type { Network } from "../lib/sdk.js";

export type ToastTone = "success" | "error" | "info";

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  detail?: string;
  /** Tx hash; when set, the toast renders a "View on cardanoscan" link. */
  txHash?: string;
  /** Network for the cardanoscan URL. Falls back to preprod. */
  network?: Network;
  /** Auto-dismiss timeout in ms. 0 = sticky. Default 7000. */
  ttl?: number;
}

interface ToasterApi {
  push(t: Omit<Toast, "id">): number;
  dismiss(id: number): void;
}

const Ctx = createContext<ToasterApi | null>(null);
const DEFAULT_TTL = 7000;
// Errors hang around longer than success toasts (more text, typically
// more important to read), but they no longer stick. Sticky errors
// were piling up — a fresh "tx failed" would land behind two stale
// errors the user had already seen. 12s is enough to read 1–2 lines
// without forcing a manual dismiss.
const ERROR_TTL = 12_000;
// Hard cap on simultaneously-visible toasts. Beyond this, the oldest
// toast is evicted when a new one pushes — same rationale as above:
// new info shouldn't get hidden behind stale alerts.
const MAX_VISIBLE = 4;

export function ToasterProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (t: Omit<Toast, "id">) => {
      idRef.current += 1;
      const id = idRef.current;
      const effectiveTtl = t.ttl ?? (t.tone === "error" ? ERROR_TTL : DEFAULT_TTL);
      const queued: Toast = { ...t, id, ttl: effectiveTtl };
      setToasts((cur) => {
        const next = [...cur, queued];
        // Evict the oldest entries past the cap so a flurry of
        // failures (e.g. multiple retry collisions) doesn't bury the
        // newest message under a wall of stale ones.
        return next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next;
      });
      if (effectiveTtl > 0) {
        window.setTimeout(() => dismiss(id), effectiveTtl);
      }
      return id;
    },
    [dismiss],
  );

  const api = useMemo<ToasterApi>(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <Ctx.Provider value={api}>
      {children}
      {typeof document !== "undefined" &&
        createPortal(<ToastStack toasts={toasts} onDismiss={dismiss} />, document.body)}
    </Ctx.Provider>
  );
}

export function useToast(): ToasterApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useToast: ToasterProvider missing");
  return v;
}

function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  const { t } = useTranslation();
  return (
    // `<ol>` already has an implicit list role; tagging it `role="region"`
    // overrode that and made Lighthouse flag the element under "Uses ARIA
    // roles only on compatible elements". `aria-live="polite"` (for the
    // toast announcement) and `aria-label` (for the accessible name) work
    // without a role override; we lose the landmark, but a toast stack
    // is not really a landmark anyway.
    <ol className="lj-toaster" aria-live="polite" aria-label={t("toast.region_label")}>
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={() => onDismiss(toast.id)} />
      ))}
    </ol>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const { t } = useTranslation();
  const [closing, setClosing] = useState(false);

  // Lift the close one frame so the slide-out CSS has a chance to play
  // before React unmounts the node. The parent timeout still ultimately
  // removes the toast from state.
  useEffect(() => {
    if (toast.ttl === 0) return;
    const ttl = toast.ttl ?? DEFAULT_TTL;
    const id = window.setTimeout(() => setClosing(true), Math.max(0, ttl - 250));
    return () => window.clearTimeout(id);
  }, [toast.ttl]);

  const cls = ["lj-toast", `lj-toast--${toast.tone}`, closing ? "lj-toast--closing" : ""]
    .filter(Boolean)
    .join(" ");

  // Errors fire `role="alert"` so AT announces them assertively even
  // when the parent region's `aria-live="polite"` would defer. Success
  // / info toasts stay polite — they're informational, not urgent.
  const itemRole = toast.tone === "error" ? "alert" : "status";

  return (
    <li className={cls} role={itemRole}>
      <div className="lj-toast__body">
        <span className="lj-toast__title">{toast.title}</span>
        {toast.detail && <span className="lj-toast__detail">{toast.detail}</span>}
        {toast.txHash && (
          <a
            className="lj-toast__link"
            href={cardanoscanUrl(toast.txHash, toast.network ?? "preprod")}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("toast.view_on_scan")}
          </a>
        )}
      </div>
      <button
        type="button"
        className="lj-toast__close"
        onClick={onDismiss}
        aria-label={t("toast.dismiss")}
      >
        ×
      </button>
    </li>
  );
}

/**
 * Build the canonical cardanoscan URL for the configured network. Falls
 * back to preprod since that's where the bootstrap actually lives — a
 * mainnet hash on Preprod cardanoscan would 404, but the user gets a
 * clear "not found" page rather than a silent miss.
 */
export function cardanoscanUrl(txHash: string, network: Network): string {
  const clean = txHash.replace(/^0x/i, "").toLowerCase();
  if (network === "mainnet") return `https://cardanoscan.io/transaction/${clean}`;
  if (network === "preview") return `https://preview.cardanoscan.io/transaction/${clean}`;
  return `https://preprod.cardanoscan.io/transaction/${clean}`;
}

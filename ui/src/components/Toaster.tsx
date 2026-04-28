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
      setToasts((cur) => [...cur, { ...t, id }]);
      const ttl = t.ttl ?? DEFAULT_TTL;
      if (ttl > 0) {
        window.setTimeout(() => dismiss(id), ttl);
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

function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  return (
    <ol className="lj-toaster">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
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

  const cls = [
    "lj-toast",
    `lj-toast--${toast.tone}`,
    closing ? "lj-toast--closing" : "",
  ].filter(Boolean).join(" ");

  return (
    <li className={cls} role="status">
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

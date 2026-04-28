// Minimal accessible modal — backdrop click + Esc close, focus-trap-light.
//
// We deliberately don't pull in a UI library: the app only needs two
// modals (wallet picker + tier-2 BIP-39 setup), so the cost of a real
// dialog package isn't justified. The implementation closes on Esc,
// closes on backdrop click, and renders into a portal so it escapes
// any overflow:hidden ancestors.

import { useEffect } from "react";
import { createPortal } from "react-dom";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name read by AT — required. */
  title: string;
  /** Optional CSS modifier; pass "lj-modal--wide" for the BIP-39 flow. */
  className?: string;
  children: React.ReactNode;
}

export function Modal({ open, onClose, title, className, children }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="lj-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`lj-modal ${className ?? ""}`.trim()}>{children}</div>
    </div>,
    document.body,
  );
}

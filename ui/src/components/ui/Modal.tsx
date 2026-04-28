// Minimal accessible modal — backdrop click + Esc close, focus trap +
// focus restoration on close.
//
// We deliberately don't pull in a UI library: the app only needs two
// modals (wallet picker + tier-2 BIP-39 setup), so the cost of a real
// dialog package isn't justified. The implementation closes on Esc,
// closes on backdrop click, renders into a portal (escapes any
// overflow:hidden ancestors), and traps focus inside the dialog while
// open — Tab cycles forward through descendants, Shift+Tab backwards,
// and the previously-focused element gets focus back on close.

import { useEffect, useRef } from "react";
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

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function Modal({ open, onClose, title, className, children }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    // Capture the element that opened the modal so focus can return to
    // it on close. document.activeElement is HTMLElement when present.
    restoreRef.current =
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);

    // Move initial focus inside the dialog. Defer one frame so
    // descendants have mounted.
    const focusFirst = () => {
      const root = dialogRef.current;
      if (!root) return;
      const focusables = root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      const target = focusables[0] ?? root;
      target.focus();
    };
    const raf = window.requestAnimationFrame(focusFirst);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => !el.hasAttribute("inert"));
      if (focusables.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !root.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || !root.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      // Hand focus back to whatever opened us. Guard the .focus() call;
      // the original element may have been removed from the DOM during
      // the modal's lifetime.
      const restore = restoreRef.current;
      if (restore && document.body.contains(restore)) {
        restore.focus();
      }
    };
  }, [open, onClose]);

  if (!open) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="lj-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`lj-modal ${className ?? ""}`.trim()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

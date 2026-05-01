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
//
// A11y posture: role="dialog" + aria-modal="true" + aria-labelledby
// pointing at a visually-hidden title node (so AT speaks a stable
// title even when the visible header markup is custom per modal). The
// surrounding #root tree is marked inert while the modal is open so
// AT and Tab both treat the rest of the document as unreachable.

import { useEffect, useId, useRef } from "react";
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
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    // Capture the element that opened the modal so focus can return to
    // it on close. document.activeElement is HTMLElement when present.
    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

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
      const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => !el.hasAttribute("inert"),
      );
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

    // Inert the rest of the document so AT + sequential focus skip
    // everything outside the dialog. The modal is portalled into
    // document.body, so we mark every direct child of <body> as inert
    // *except* the backdrop wrapper (which holds this dialog). On
    // close we revert. Browsers without inert support gracefully
    // ignore the attribute; the focus trap above still keeps Tab inside.
    const dialogEl = dialogRef.current;
    const backdropEl = dialogEl?.parentElement ?? null;
    const inertedSiblings: HTMLElement[] = [];
    if (backdropEl) {
      for (const child of Array.from(document.body.children)) {
        if (!(child instanceof HTMLElement)) continue;
        if (child === backdropEl) continue;
        if (!child.hasAttribute("inert")) {
          child.setAttribute("inert", "");
          inertedSiblings.push(child);
        }
      }
    }

    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      for (const el of inertedSiblings) {
        el.removeAttribute("inert");
      }
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
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`lj-modal ${className ?? ""}`.trim()}
      >
        {/* Visually-hidden title node referenced by aria-labelledby. We
         * still let consumers render a custom visible header inside; the
         * sr-only copy keeps the accessible name stable regardless. */}
        <span id={titleId} className="sr-only">
          {title}
        </span>
        {children}
      </div>
    </div>,
    document.body,
  );
}

import { useEffect, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessible modal plumbing shared by every dialog/drawer:
 *  - Esc closes (calls `onClose`).
 *  - Tab / Shift+Tab is trapped inside `ref`, cycling at the edges.
 *  - The element focused before the modal opened is restored on close.
 *  - Focus moves into the modal on open (the first focusable, or the box itself).
 *
 * `ref` is the modal container; it should be focusable as a fallback (tabIndex=-1).
 */
export function useModalFocusTrap(ref: RefObject<HTMLElement | null>, onClose: () => void): void {
  useEffect(() => {
    const node = ref.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    function focusables(): HTMLElement[] {
      if (!node) return [];
      return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
    }

    // Move focus inside, unless something in the modal already has it.
    if (node && !node.contains(document.activeElement)) {
      const first = focusables()[0];
      (first ?? node).focus();
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !node) return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        node.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !node.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !node.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      // Restore focus to the opener if it's still in the document.
      if (previouslyFocused && previouslyFocused.isConnected) previouslyFocused.focus();
    };
  }, [ref, onClose]);
}

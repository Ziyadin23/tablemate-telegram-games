import { useEffect, useRef } from 'react';
const dialogs: HTMLElement[] = [];
export function useModal(open: boolean, selector: string, cancel: () => void) {
  const cancelRef = useRef(cancel); cancelRef.current = cancel;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>(selector);
    if (!dialog) return;
    dialogs.push(dialog);
    const isTop = () => dialogs.at(-1) === dialog;
    const buttons = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') || []);
    const focusFirst = () => (buttons()[0] || dialog)?.focus(); focusFirst();
    const key = (event: KeyboardEvent) => {
      if (!isTop()) return;
      if (event.key === 'Escape') { event.preventDefault(); cancelRef.current(); }
      if (event.key === 'Tab') {
        const targets = buttons(), first = targets[0], last = targets.at(-1);
        if (!targets.length) { event.preventDefault(); dialog?.focus(); }
        else if (!dialog?.contains(document.activeElement)) { event.preventDefault(); first?.focus(); }
        else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    const focus = (event: FocusEvent) => { if (isTop() && event.target instanceof Node && !dialog.contains(event.target)) focusFirst(); };
    document.addEventListener('keydown', key); document.addEventListener('focusin', focus);
    return () => {
      const wasTop = isTop(); dialogs.splice(dialogs.indexOf(dialog), 1);
      document.removeEventListener('keydown', key); document.removeEventListener('focusin', focus);
      if (wasTop && previous?.isConnected) previous.focus();
    };
  }, [open, selector]);
}

import { useEffect, useRef, type ReactNode } from 'react';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function trapTab(e: React.KeyboardEvent, root: HTMLElement | null): void {
  if (e.key !== 'Tab' || !root) return;
  const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
  if (items.length === 0) return;
  const first = items[0]!;
  const last = items[items.length - 1]!;
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * Modal dialog: focus moves in (to `initialFocus` or the first control), Tab is trapped,
 * Escape calls `onClose`, and focus returns to where it was when the dialog closes.
 */
export function Modal(props: {
  labelledBy: string;
  describedBy?: string;
  onClose: () => void;
  initialFocus?: string;
  className?: string;
  role?: 'dialog' | 'alertdialog';
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { initialFocus } = props;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = ref.current;
    const target = initialFocus
      ? root?.querySelector<HTMLElement>(initialFocus)
      : root?.querySelector<HTMLElement>(FOCUSABLE);
    (target ?? root)?.focus();
    return () => previous?.focus?.();
  }, [initialFocus]);
  return (
    <div className="backdrop">
      <div
        ref={ref}
        role={props.role ?? 'dialog'}
        aria-modal="true"
        aria-labelledby={props.labelledBy}
        aria-describedby={props.describedBy}
        tabIndex={-1}
        className={`modal ${props.className ?? ''}`}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            props.onClose();
          } else trapTab(e, ref.current);
        }}
      >
        {props.children}
      </div>
    </div>
  );
}

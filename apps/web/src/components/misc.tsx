import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { initials } from '../lib/format';
import { useDismiss, useLatest } from '../lib/hooks';
import { useRoom } from '../state/room';
import { IconButton } from './Button';
import s from './misc.module.css';

export function Avatar({ name, color, size = 28 }: { name: string; color: string; size?: number }) {
  return (
    <span className={s.avatar} style={{ width: size, height: size, background: color, fontSize: Math.round(size * 0.4) }} aria-hidden>
      {initials(name)}
    </span>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <span className={s.spinner} style={{ width: size, height: size }} role="status" aria-label="Loading" />;
}

const TOAST_ICON = { info: Info, success: CheckCircle2, warning: AlertTriangle, error: XCircle } as const;

export function Toasts() {
  const toasts = useRoom((st) => st.toasts);
  return (
    <div className={s.toasts} aria-live="polite">
      {toasts.map((t) => {
        const Icon = TOAST_ICON[t.level];
        return (
          <div key={t.id} className={`${s.toast} ${s[t.level]}`}>
            <Icon size={16} />
            <span>{t.text}</span>
          </div>
        );
      })}
    </div>
  );
}

export function Modal({ title, onClose, children, width }: { title: string; onClose(): void; children: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useLatest(onClose);
  // Mount only: parents re-render often (status updates), which must not move focus while someone types.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close.current();
      }
    };
    window.addEventListener('keydown', onKey, true);
    const prev = document.activeElement as HTMLElement | null;
    // Focus the first form field if any, otherwise the dialog itself (no stray focus ring on the close button).
    (ref.current?.querySelector<HTMLElement>('input, textarea') ?? ref.current)?.focus();
    return () => {
      window.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, [close]);
  return (
    <div className={s.backdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} className={s.dialog} role="dialog" aria-modal="true" aria-label={title} style={width ? { width: `min(${width}px, 100%)` } : undefined}>
        <div className={s.dialogHead}>
          <h2 className={s.dialogTitle}>{title}</h2>
          <IconButton label="Close" size="sm" onClick={onClose}><X size={16} /></IconButton>
        </div>
        <div className={s.dialogBody}>{children}</div>
      </div>
    </div>
  );
}

export interface MenuOption {
  id: string;
  label: string;
  hint?: string;
  checked?: boolean;
  disabled?: boolean;
}

const sheetQuery = () => window.matchMedia('(pointer: coarse) and (max-width: 640px)').matches;

/** Popover menu anchored to its (position: relative) parent. Closes on outside click / Escape. */
export function Menu({
  title, options, onSelect, onClose, note, align = 'right', placement = 'top', extra, keepOpen, sheet: forceSheet,
}: {
  title?: string; options: MenuOption[]; onSelect(id: string): void; onClose(): void; note?: string;
  align?: 'left' | 'right'; placement?: 'top' | 'bottom'; extra?: ReactNode; keepOpen?: boolean; sheet?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // On phones (or a narrow player), menus become bottom sheets: easier to reach, never clipped.
  const sheet = forceSheet || sheetQuery();
  useDismiss(ref, onClose, { container: sheet ? 'self' : 'parent' });
  // Arrow keys move between items; initial focus goes to the checked item once, on open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      items[next]?.focus();
    };
    window.addEventListener('keydown', onKey, true);
    (ref.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? ref.current?.querySelector('button'))?.focus({ preventScroll: true });
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  const pos = sheet ? undefined : ({ [align]: 0, [placement === 'top' ? 'bottom' : 'top']: 'calc(100% + 8px)' } as CSSProperties);
  const menu = (
    <div ref={ref} className={`${s.menu} ${sheet ? s.sheet : ''}`} style={pos} role="menu">
      {sheet && <div className={s.sheetHandle} />}
      {title && <div className={s.menuTitle}>{title}</div>}
      {options.map((o) => (
        <button key={o.id} className={s.menuItem} role="menuitemradio" aria-checked={Boolean(o.checked)} disabled={o.disabled}
          onClick={() => { onSelect(o.id); if (!keepOpen) onClose(); }}>
          <span className={s.menuCheck}>{o.checked && <Check size={15} />}</span>
          <span className={s.menuLabel}>{o.label}</span>
          {o.hint && <span className={s.menuHint}>{o.hint}</span>}
        </button>
      ))}
      {extra}
      {note && <div className={s.menuNote}>{note}</div>}
    </div>
  );
  if (!sheet) return menu;
  // Rendered at the top level (or inside the full-screen element) so a hidden or clipped anchor can't hide it.
  const target = (document.fullscreenElement as HTMLElement | null) ?? document.body;
  return createPortal(<div className={s.sheetBackdrop}>{menu}</div>, target);
}

import { useEffect, useRef } from 'react';

/** Always-current reference to a callback, so effects can use it without re-running when it changes. */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/**
 * Close a popover on outside pointer-down or Escape. Listeners are installed once (on mount), so parent
 * re-renders never reset focus or listeners while the popover is open.
 */
export function useDismiss(
  ref: React.RefObject<HTMLElement | null>,
  onClose: () => void,
  opts: { ignore?: (target: HTMLElement) => boolean; container?: 'self' | 'parent' } = {},
): void {
  const close = useLatest(onClose);
  const ignore = useLatest(opts.ignore);
  const container = opts.container ?? 'self';
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const root = container === 'parent' ? ref.current?.parentElement : ref.current;
      const target = e.target as HTMLElement;
      if (root && !root.contains(target) && !ignore.current?.(target)) close.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close.current();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [ref, container, close, ignore]);
}

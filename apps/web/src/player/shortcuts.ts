import { useEffect, useRef } from 'react';

export interface ShortcutActions {
  togglePlay(): void;
  seekBy(delta: number): void;
  seekToFraction(f: number): void;
  volumeBy(delta: number): void;
  toggleMute(): void;
  fullscreen(): void;
  toggleChat(): void;
  rateBy(delta: number): void;
  poke(): void;
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

export function usePlayerShortcuts(actions: ShortcutActions): void {
  const ref = useRef(actions);
  ref.current = actions;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (document.querySelector('[role="dialog"]')) return;
      const a = ref.current;
      let handled = true;
      switch (e.key) {
        case ' ': case 'k': case 'K':
          if ((e.target as HTMLElement)?.tagName === 'BUTTON' && e.key === ' ') { handled = false; break; }
          a.togglePlay(); break;
        case 'ArrowLeft': a.seekBy(-5); break;
        case 'ArrowRight': a.seekBy(5); break;
        case 'j': case 'J': a.seekBy(-10); break;
        case 'l': case 'L': a.seekBy(10); break;
        case 'ArrowUp': a.volumeBy(0.05); break;
        case 'ArrowDown': a.volumeBy(-0.05); break;
        case 'm': case 'M': a.toggleMute(); break;
        case 'f': case 'F': a.fullscreen(); break;
        case 'c': case 'C': a.toggleChat(); break;
        case '<': case ',': if (e.key === '<' || e.shiftKey) a.rateBy(-1); else handled = false; break;
        case '>': case '.': if (e.key === '>' || e.shiftKey) a.rateBy(1); else handled = false; break;
        default:
          if (/^[0-9]$/.test(e.key)) a.seekToFraction(Number(e.key) / 10);
          else handled = false;
      }
      if (handled) {
        e.preventDefault();
        a.poke();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

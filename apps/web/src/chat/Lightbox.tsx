import { useEffect } from 'react';
import { X } from 'lucide-react';
import { useLatest } from '../lib/hooks';
import s from './Pickers.module.css';

export function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose(): void }) {
  const close = useLatest(onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close.current(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [close]);
  return (
    <div className={s.lightbox} role="dialog" aria-label="Picture" onClick={onClose}>
      <img src={src} alt={alt} />
      <button className={s.lightboxClose} aria-label="Close" onClick={onClose}><X size={20} /></button>
    </div>
  );
}

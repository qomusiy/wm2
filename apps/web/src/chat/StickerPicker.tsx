import { useRef } from 'react';
import { useDismiss } from '../lib/hooks';
import { STICKERS } from '@watchroom/protocol';
import s from './Pickers.module.css';

export const stickerUrl = (id: string) => `/stickers/${id}.webp`;
const label = (id: string) => id.replace(/-/g, ' ');

export function StickerPicker({ onPick, onClose }: { onPick(id: string): void; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose, { ignore: (t) => Boolean(t.closest('[data-picker-toggle]')) });
  return (
    <div ref={ref} className={`${s.pop} ${s.stickerPop}`} role="dialog" aria-label="Stickers">
      <div className={s.stickerHead}>Stickers</div>
      <div className={s.stickers}>
        {STICKERS.map((id) => (
          <button key={id} className={s.sticker} title={label(id)} aria-label={`Send ${label(id)} sticker`} onClick={() => onPick(id)}>
            <img src={stickerUrl(id)} alt="" loading="lazy" draggable={false} />
          </button>
        ))}
      </div>
    </div>
  );
}

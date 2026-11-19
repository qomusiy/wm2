import { forwardRef, useState } from 'react';
import { parseYouTubeUrl, youtubeThumbnail } from '@watchroom/protocol';
import { Button } from '../components/Button';
import { Spinner } from '../components/misc';
import { YouTubeIcon } from '../components/YouTubeIcon';
import type { OpenResult } from '../lib/connection';
import s from './YouTubeLinkForm.module.css';

interface Props {
  onOpen(url: string): Promise<OpenResult>;
  onDone?(): void;
  autoFocus?: boolean;
  value?: string;
  onValueChange?(v: string): void;
}

/** "Paste a YouTube link" → the room watches it. Checks the link as it is typed and shows the video's picture. */
export const YouTubeLinkForm = forwardRef<HTMLInputElement, Props>(function YouTubeLinkForm({ onOpen, onDone, autoFocus, value: controlled, onValueChange }, ref) {
  const [own, setOwn] = useState('');
  const value = controlled ?? own;
  const setValue = onValueChange ?? setOwn;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const link = parseYouTubeUrl(value);

  const submit = async () => {
    const text = value.trim();
    if (!text) return;
    if (!parseYouTubeUrl(text)) {
      setError('That isn\'t a link to a YouTube video. Copy the video\'s address (youtube.com/watch?v=… or youtu.be/…).');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await onOpen(text);
    setBusy(false);
    if (res.ok) {
      setValue('');
      onDone?.();
    } else setError(res.error ?? 'Couldn\'t open this video.');
  };

  return (
    <form className={s.form} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className={`${s.field} ${error ? s.fieldError : ''} ${link ? s.fieldOk : ''}`}>
        <span className={s.lead}>
          {link ? <img className={s.thumb} src={youtubeThumbnail(link.videoId)} alt="" draggable={false} /> : <YouTubeIcon size={20} />}
        </span>
        <input
          ref={ref}
          className={s.input}
          value={value}
          onChange={(e) => { setValue(e.target.value); setError(null); }}
          placeholder="Paste a YouTube link"
          aria-label="YouTube link"
          aria-invalid={error ? true : undefined}
          autoFocus={autoFocus}
          inputMode="url"
          spellCheck={false}
          autoComplete="off"
          disabled={busy}
        />
        <Button type="submit" variant="primary" size="sm" disabled={busy || !value.trim()}>
          {busy ? <><Spinner size={13} /> Opening</> : 'Watch'}
        </Button>
      </div>
      {error && <div className={s.error} role="alert">{error}</div>}
    </form>
  );
});

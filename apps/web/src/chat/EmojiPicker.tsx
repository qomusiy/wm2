import { useEffect, useMemo, useRef, useState } from 'react';
import { isTouch } from '../lib/device';
import { useDismiss } from '../lib/hooks';
import { local } from '../lib/storage';
import s from './Pickers.module.css';

type Entry = [string, string, ...string[]]; // emoji, words, 5 skin-tone variants (optional)
interface Group { key: string; label: string; emojis: Entry[] }

const ICONS: Record<string, string> = {
  recent: '🕘', smileys: '😀', people: '👋', nature: '🐻', food: '🍔', activities: '⚽', travel: '✈️', objects: '💡', symbols: '❤️', flags: '🏳️',
};
const TONES = ['✋', '✋🏻', '✋🏼', '✋🏽', '✋🏾', '✋🏿'];

let cache: Group[] | null = null;
async function loadEmoji(): Promise<Group[]> {
  if (!cache) cache = ((await import('./emoji-data.json')).default as unknown) as Group[];
  return cache;
}

export function recordRecentEmoji(emoji: string): void {
  const recent = local.get<string[]>('wr:emoji-recent', []).filter((e) => e !== emoji);
  local.set('wr:emoji-recent', [emoji, ...recent].slice(0, 24));
}

export function EmojiPicker({ onPick, onClose }: { onPick(emoji: string): void; onClose(): void }) {
  const [groups, setGroups] = useState<Group[] | null>(cache);
  const [query, setQuery] = useState('');
  const [tone, setTone] = useState(() => local.get('wr:emoji-tone', 0));
  const [hover, setHover] = useState<string | null>(null);
  const [active, setActive] = useState('smileys');
  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const recent = useMemo(() => local.get<string[]>('wr:emoji-recent', []), []);

  // Mount only: focusing again on every parent render would steal focus from the message box.
  useEffect(() => {
    void loadEmoji().then(setGroups);
    if (!isTouch()) searchRef.current?.focus();
  }, []);
  useDismiss(rootRef, onClose, { ignore: (t) => Boolean(t.closest('[data-picker-toggle]')) });

  const variant = (e: Entry) => (tone > 0 && e.length === 7 ? e[1 + tone]! : e[0]);
  const filtered = useMemo(() => {
    if (!groups) return null;
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const terms = q.split(/\s+/);
    return groups.flatMap((g) => g.emojis).filter((e) => terms.every((t) => e[1].includes(t))).slice(0, 160);
  }, [groups, query]);

  const pick = (emoji: string) => {
    recordRecentEmoji(emoji);
    onPick(emoji);
  };
  const button = (emoji: string, label: string) => (
    <button key={emoji} className={s.emoji} title={label} aria-label={label} onClick={() => pick(emoji)}
      onPointerEnter={() => setHover(`${emoji}  ${label}`)}>
      {emoji}
    </button>
  );

  return (
    <div ref={rootRef} className={`${s.pop} ${s.emojiPop}`} role="dialog" aria-label="Emoji">
      <input ref={searchRef} className={s.search} placeholder="Search emoji" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search emoji" />
      {!query && groups && (
        <div className={s.cats}>
          {[...(recent.length ? ['recent'] : []), ...groups.map((g) => g.key)].map((key) => (
            <button key={key} className={`${s.cat} ${active === key ? s.catActive : ''}`} aria-label={key}
              onClick={() => {
                setActive(key);
                gridRef.current?.querySelector(`[data-group="${key}"]`)?.scrollIntoView({ block: 'start' });
              }}>
              {ICONS[key]}
            </button>
          ))}
        </div>
      )}
      <div ref={gridRef} className={s.grid}
        onScroll={(e) => {
          const top = e.currentTarget.getBoundingClientRect().top;
          const heads = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-group]')];
          const current = heads.filter((h) => h.getBoundingClientRect().top - top < 40).pop();
          if (current?.dataset.group && current.dataset.group !== active) setActive(current.dataset.group);
        }}>
        {!groups && <div className={s.empty}>Loading…</div>}
        {filtered && (filtered.length ? <div className={s.emojis}>{filtered.map((e) => button(variant(e), e[1].split(' ').slice(0, 4).join(' ')))}</div>
          : <div className={s.empty}>No emoji found</div>)}
        {!filtered && groups && (
          <>
            {recent.length > 0 && (
              <>
                <div className={s.section} data-group="recent">Recently used</div>
                <div className={s.emojis}>{recent.map((e) => button(e, 'recent'))}</div>
              </>
            )}
            {groups.map((g) => (
              <div key={g.key}>
                <div className={s.section} data-group={g.key}>{g.label}</div>
                <div className={s.emojis}>{g.emojis.map((e) => button(variant(e), e[1].split(' ').slice(0, 4).join(' ')))}</div>
              </div>
            ))}
          </>
        )}
      </div>
      <div className={s.foot}>
        <span className={s.preview}>{hover ?? 'Pick an emoji'}</span>
        <div className={s.tones} role="radiogroup" aria-label="Skin tone">
          {TONES.map((t, i) => (
            <button key={t} className={`${s.tone} ${tone === i ? s.toneActive : ''}`} role="radio" aria-checked={tone === i} aria-label={`Skin tone ${i}`}
              onClick={() => { setTone(i); local.set('wr:emoji-tone', i); }}>
              {t}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

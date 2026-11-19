// Builds the compact emoji table used by the chat picker from emojibase-data.
// Keeps emoji up to Unicode/Emoji 14 so they render on phones a few years old.
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const data = require('emojibase-data/en/data.json');
const GROUPS = [
  [0, 'smileys', 'Smileys & emotion'], [1, 'people', 'People'], [3, 'nature', 'Animals & nature'], [4, 'food', 'Food & drink'],
  [6, 'activities', 'Activities'], [5, 'travel', 'Travel & places'], [7, 'objects', 'Objects'], [8, 'symbols', 'Symbols'], [9, 'flags', 'Flags'],
];
const MAX_VERSION = 14;
const out = GROUPS.map(([id, key, label]) => ({
  key,
  label,
  // [emoji, searchable words, ...skin tone variants]
  emojis: data
    .filter((e) => e.group === id && e.version <= MAX_VERSION && !e.label.startsWith('regional indicator'))
    .sort((a, b) => a.order - b.order)
    .map((e) => {
      const words = [e.label, ...(e.tags ?? [])].join(' ').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      const skins = (e.skins ?? []).filter((s) => typeof s.tone === 'number' && s.version <= MAX_VERSION).sort((a, b) => a.tone - b.tone).map((s) => s.emoji);
      return skins.length === 5 ? [e.emoji, words, ...skins] : [e.emoji, words];
    }),
}));
const target = new URL('../apps/web/src/chat/emoji-data.json', import.meta.url);
writeFileSync(target, JSON.stringify(out));
console.log(`emoji: ${out.reduce((a, g) => a + g.emojis.length, 0)} in ${out.length} groups -> ${target.pathname}`);

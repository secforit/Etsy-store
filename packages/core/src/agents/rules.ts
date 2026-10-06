/**
 * Code-side hard rules shared by agents: text normalisation, blocklist matching and trademark matching.
 * These run AFTER the model and decide on their own; the model can add blocks, never remove them.
 *
 * Matching covers: case, punctuation/spacing ("Coca-Cola" = "coca cola" = "CocaCola"), accents and
 * full-width letters (NFKD), common Cyrillic/Greek look-alike letters, simple digit/symbol substitutions
 * inside words ("D1sney", "$tarbucks"), possessives and English plural/singular forms of the last word.
 * Matches always start and end on word boundaries, so "ugg" does not hit "snuggle".
 */

const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  і: 'i', ї: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ԛ: 'q', ԝ: 'w', һ: 'h', ӏ: 'l',
  // Greek
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w',
  // Latin look-alikes
  ı: 'i', ɡ: 'g', ł: 'l', ø: 'o', đ: 'd', ß: 'ss', æ: 'ae', œ: 'oe',
};

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't' };

/** Lowercase ASCII words separated by single spaces. */
export function normalizeText(input: string): string {
  let s = input.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
  s = Array.from(s, (ch) => CONFUSABLES[ch] ?? ch).join('');
  s = s.replace(/[​-‍⁠﻿­]/g, ''); // zero-width and soft hyphen join the word
  s = s.replace(/['’ʼ`´]/g, ''); // possessives: "disney's" -> "disneys"
  s = s.replace(/&/g, ' and ');
  s = s.replace(/(?<=[a-z0-9])[$@]|[$@](?=[a-z0-9])/g, (m) => (m === '$' ? 's' : 'a'));
  s = s.replace(/[^a-z0-9]+/g, ' ').trim();
  return s
    .split(' ')
    .filter(Boolean)
    .map((w) => (/[a-z]/.test(w) && /[0-9]/.test(w) ? w.replace(/[013457]/g, (d) => LEET[d] ?? d) : w))
    .join(' ');
}

export function tokenize(input: string): string[] {
  const n = normalizeText(input);
  return n ? n.split(' ') : [];
}

/** Plural/singular forms of one word (including itself). */
export function wordForms(word: string): string[] {
  const forms = new Set([word]);
  if (word.length < 3) {
    forms.add(`${word}s`);
    return [...forms];
  }
  forms.add(`${word}s`);
  forms.add(`${word}es`);
  if (/[^aeiou]y$/.test(word)) forms.add(`${word.slice(0, -1)}ies`);
  if (word.endsWith('ies') && word.length > 4) forms.add(`${word.slice(0, -3)}y`);
  if (word.endsWith('es') && word.length > 3) forms.add(word.slice(0, -2));
  if (word.endsWith('s') && !word.endsWith('ss')) forms.add(word.slice(0, -1));
  return [...forms];
}

/** All compact (space-free) spellings of a term: plural/singular variants of its last word. */
export function compactVariants(term: string): string[] {
  const toks = tokenize(term);
  if (toks.length === 0) return [];
  const head = toks.slice(0, -1).join('');
  const last = toks[toks.length - 1] as string;
  return [...new Set(wordForms(last).map((f) => head + f))];
}

/**
 * True when `term` appears in `text` as a run of whole words (in any spacing/punctuation/plural form).
 */
export function containsTerm(text: string, term: string): boolean {
  return findInTokens(tokenize(text), new Set(compactVariants(term)));
}

function findInTokens(textTokens: string[], variants: Set<string>): boolean {
  if (variants.size === 0 || textTokens.length === 0) return false;
  const maxLen = Math.max(...[...variants].map((v) => v.length));
  for (let i = 0; i < textTokens.length; i++) {
    let joined = '';
    for (let j = i; j < textTokens.length; j++) {
      joined += textTokens[j];
      if (joined.length > maxLen) break;
      if (variants.has(joined)) return true;
    }
  }
  return false;
}

/** True when two terms are the same after normalisation (exact, plural, punctuation, spacing). */
export function sameTerm(a: string, b: string): boolean {
  const va = compactVariants(a);
  if (va.length === 0) return false;
  const vb = new Set(compactVariants(b));
  return va.some((v) => vb.has(v));
}

export interface TermHit {
  term: string;
  field: string;
}

/** Every (term, field) pair where a blocklist term occurs in a field's text. */
export function findBlocklistHits(fields: Record<string, string | string[] | null | undefined>, terms: string[]): TermHit[] {
  const prepared = terms
    .map((term) => ({ term, variants: new Set(compactVariants(term)) }))
    .filter((t) => t.variants.size > 0);
  const hits: TermHit[] = [];
  for (const [field, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    const texts = Array.isArray(value) ? value : [value];
    const tokenLists = texts.map(tokenize);
    for (const t of prepared) {
      if (tokenLists.some((toks) => findInTokens(toks, t.variants))) hits.push({ term: t.term, field });
    }
  }
  return hits;
}

/**
 * Built-in terms always blocked in addition to Razvan's blocklist (settings). Only names of very
 * actively enforced IP owners that are not ordinary English words.
 */
export const BASELINE_BLOCKLIST: readonly string[] = [
  'disney', 'pixar', 'marvel', 'star wars', 'harry potter', 'hogwarts', 'pokemon', 'pikachu', 'nintendo',
  'super mario', 'zelda', 'hello kitty', 'sanrio', 'barbie', 'peppa pig', 'paw patrol', 'bluey', 'sesame street',
  'looney tunes', 'scooby doo', 'spongebob', 'minecraft', 'fortnite', 'nike', 'adidas', 'coca cola', 'starbucks',
  'louis vuitton', 'gucci', 'chanel', 'harley davidson', 'nfl', 'nba', 'mlb', 'nhl', 'fifa', 'super bowl',
  'olympics', 'taylor swift', 'lord of the rings', 'game of thrones', 'stranger things', 'grinch', 'snoopy',
];

/** Settings blocklist + baseline, deduplicated by normalised form. */
export function effectiveBlocklist(settingsBlocklist: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of [...settingsBlocklist, ...BASELINE_BLOCKLIST]) {
    const key = normalizeText(term);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(term.trim());
  }
  return out;
}

/** Removes every sentence/line of `text` that contains one of `terms`. */
export function removeSentencesWithTerms(text: string, terms: string[]): string {
  if (terms.length === 0) return text;
  return text
    .split('\n')
    .map((line) =>
      line
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => !terms.some((t) => containsTerm(sentence, t)))
        .join(' '),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function uniqueBy<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = key(i);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function collapseSpaces(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

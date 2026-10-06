import { describe, expect, it } from 'vitest';
import { BASELINE_BLOCKLIST, containsTerm, effectiveBlocklist, findBlocklistHits, normalizeText, removeSentencesWithTerms, sameTerm } from './rules.ts';

describe('normalizeText', () => {
  it('folds case, accents, punctuation, full-width and look-alike letters', () => {
    expect(normalizeText('Café-Racer!!')).toBe('cafe racer');
    expect(normalizeText('ＮＩＫＥ')).toBe('nike');
    expect(normalizeText('Dіsnеy')).toBe('disney'); // Cyrillic і and е
    expect(normalizeText("Disney's")).toBe('disneys');
    expect(normalizeText('Di​sney')).toBe('disney');
    expect(normalizeText('D1sney $tarbucks')).toBe('disney starbucks');
    expect(normalizeText('2024 tour')).toBe('2024 tour'); // pure numbers untouched
  });
});

describe('containsTerm', () => {
  it.each([
    ['Mickey goes to DISNEY world', 'disney'],
    ['disney-themed shirt', 'Disney'],
    ['Disneys finest', 'disney'],
    ["Disney's finest", 'disney'],
    ['Coca-Cola retro', 'coca cola'],
    ['cocacola retro', 'Coca-Cola'],
    ['Coca Cola retro', 'cocacola'],
    ['two hello kitties', 'hello kitty'],
    ['one hello kitty', 'Hello Kitties'],
    ['Star.Wars fan', 'star wars'],
    ['The Grinch!', 'grinch'],
  ])('finds %j in %j', (text, term) => {
    expect(containsTerm(text, term)).toBe(true);
  });

  it.each([
    ['snuggle season', 'ugg'],
    ['catwalk ready', 'cat'],
    ['nikeless', 'nike'],
    ['pokemonish', 'pokemon'],
  ])('does not find partial words (%j / %j)', (text, term) => {
    expect(containsTerm(text, term)).toBe(false);
  });
});

describe('sameTerm', () => {
  it('matches exact, plural, case and punctuation variants', () => {
    expect(sameTerm('Mama Bear', 'MAMA BEAR')).toBe(true);
    expect(sameTerm('mama bears', 'MAMA BEAR')).toBe(true);
    expect(sameTerm('mama-bear', 'Mama Bear!')).toBe(true);
    expect(sameTerm('mama bear club', 'MAMA BEAR')).toBe(false);
  });
});

describe('blocklist helpers', () => {
  it('reports every term and field hit', () => {
    const hits = findBlocklistHits({ title: 'Funny Taco Shirt', tags: ['taco tuesday', 'mexican food'] }, ['Taco Tuesday', 'burrito']);
    expect(hits).toEqual([{ term: 'Taco Tuesday', field: 'tags' }]);
  });

  it('merges settings with the baseline without duplicates', () => {
    const list = effectiveBlocklist(['Disney', 'my brand']);
    expect(list).toContain('my brand');
    expect(list.filter((t) => normalizeText(t) === 'disney')).toHaveLength(1);
    expect(list.length).toBe(BASELINE_BLOCKLIST.length + 1);
  });

  it('removes only sentences with blocked terms', () => {
    expect(removeSentencesWithTerms('Great gift. Like Disney magic! Soft and bold.', ['disney'])).toBe('Great gift. Soft and bold.');
  });
});

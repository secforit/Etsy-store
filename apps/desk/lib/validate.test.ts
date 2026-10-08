import { describe, expect, it } from 'vitest';
import {
  cleanFilename,
  DONE_NOTICES,
  doneNotice,
  hasPngSignature,
  isAssetKind,
  isChecked,
  isUuid,
  parseRejectReason,
  parseSettingsForm,
  parseStatesParam,
  safeNextPath,
} from './validate.ts';

function form(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

describe('validate', () => {
  it('only allows same-site relative redirect targets', () => {
    expect(safeNextPath('/queue?state=drafted')).toBe('/queue?state=drafted');
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', 'queue', '', '/login', '/x\u0000', null, 42]) {
      expect(safeNextPath(bad)).toBe('/');
    }
  });

  it('maps ?done= only to fixed notices', () => {
    expect(doneNotice('uploaded')).toBe(DONE_NOTICES.uploaded);
    expect(doneNotice(['approved', 'x'])).toBe(DONE_NOTICES.approved);
    for (const bad of [undefined, '', 'toString', '__proto__', '<script>', ['nope'], 1]) {
      expect(doneNotice(bad)).toBeNull();
    }
  });

  it('parses state filters and drops unknown states', () => {
    expect(parseStatesParam('designed,drafted')).toEqual(['designed', 'drafted']);
    expect(parseStatesParam(['live', 'nope', 'live'])).toEqual(['live']);
    expect(parseStatesParam(undefined)).toEqual([]);
  });

  it('validates ids and asset kinds', () => {
    expect(isUuid('00000000-0000-4000-8000-000000000001')).toBe(true);
    expect(isUuid('../../etc/passwd')).toBe(false);
    expect(isAssetKind('print')).toBe(true);
    expect(isAssetKind('mockup')).toBe(false);
  });

  it('requires a reject reason of 1-500 characters', () => {
    expect(parseRejectReason('  too similar to existing shirts ')).toEqual({ ok: true, value: 'too similar to existing shirts' });
    expect(parseRejectReason('   ').ok).toBe(false);
    expect(parseRejectReason('x'.repeat(501)).ok).toBe(false);
    expect(parseRejectReason(null).ok).toBe(false);
  });

  it('reads a checkbox as checked only for the browser default value', () => {
    expect(isChecked(form({ ipMiss: 'on' }).get('ipMiss'))).toBe(true);
    expect(isChecked(form({}).get('ipMiss'))).toBe(false);
    for (const other of ['true', '1', 'yes', '', 'ON', null, true]) expect(isChecked(other)).toBe(false);
  });

  it('parses the settings form strictly', () => {
    const ok = parseSettingsForm(form({ dailyDraftCap: '5', dailySpendCapUsd: '10.50', blocklist: 'Disney\n disney \n\nNike  Air\n' }));
    expect(ok).toEqual({ ok: true, value: { dailyDraftCap: 5, dailySpendCapUsd: 10.5, blocklist: ['Disney', 'Nike Air'] } });
    expect(parseSettingsForm(form({ paused: 'true' }))).toEqual({ ok: true, value: { paused: true } });
    const bads: Record<string, string>[] = [
      { dailyDraftCap: '-1' },
      { dailyDraftCap: '101' },
      { dailyDraftCap: '2.5' },
      { dailySpendCapUsd: '1e3' },
      { dailySpendCapUsd: '10.123' },
      { dailySpendCapUsd: '1001' },
      { blocklist: 'x'.repeat(81) },
      { paused: 'yes' },
    ];
    for (const bad of bads) {
      expect(parseSettingsForm(form(bad)).ok).toBe(false);
    }
  });

  it('detects the PNG signature and sanitises display filenames', () => {
    expect(hasPngSignature(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe(true);
    expect(hasPngSignature(new TextEncoder().encode('GIF89a......'))).toBe(false);
    expect(hasPngSignature(new Uint8Array([0x89, 0x50]))).toBe(false);
    expect(cleanFilename('../../evil<script>.png')).toBe('evil_script_.png');
    expect(cleanFilename(undefined)).toBe('upload.png');
  });
});

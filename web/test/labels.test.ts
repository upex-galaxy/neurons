import { afterEach, describe, expect, it } from 'vitest';
import { setLang } from '../src/i18n.ts';
import { isDenied, plainDetail, shownDetail } from '../src/labels.ts';
import { feedItem } from '../src/store.ts';

afterEach(() => setLang('en'));

describe('denied calls', () => {
  it('are worded in the UI language, keeping what the call was about', () => {
    const e = { phase: 'fail' as const, denied: true, detail: 'rm -rf src' };
    setLang('en');
    expect(shownDetail(e)).toBe('denied · rm -rf src');
    expect(shownDetail({ phase: 'fail', denied: true })).toBe('denied');
    setLang('es');
    expect(shownDetail(e)).toBe('denegado · rm -rf src');
    expect(shownDetail({ phase: 'fail', denied: true })).toBe('denegado');
  });

  it('still read logs written before 0.3, where detail was the fixed word "denied"', () => {
    const old = { phase: 'fail' as const, detail: 'denied' };
    expect(isDenied(old)).toBe(true);
    expect(plainDetail(old)).toBeUndefined();
    setLang('es');
    expect(shownDetail(old)).toBe('denegado');
    // The same word on a successful call is just a detail.
    expect(isDenied({ phase: 'post', detail: 'denied' })).toBe(false);
    expect(shownDetail({ phase: 'post', detail: 'denied' })).toBe('denied');
  });

  it('feed items carry the flag', () => {
    const item = feedItem({ id: 'd1', ts: 1, sessionId: 's', phase: 'fail', action: 'read', paths: ['a.ts'], source: 'hook', denied: true });
    expect(item.denied).toBe(true);
    expect(shownDetail(item)).toBe('denied');
  });
});

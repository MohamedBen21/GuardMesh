import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { LANGS, MESSAGES, fmtDuration, fmtTime, t } from '../src/i18n.js';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('server messages: every language has every key, with the same placeholders', () => {
  const en = Object.keys(MESSAGES.en);
  for (const lang of LANGS) {
    assert.deepEqual(Object.keys(MESSAGES[lang]).sort(), [...en].sort(), `${lang} keys differ`);
    for (const k of en) {
      assert.deepEqual(placeholders(MESSAGES[lang][k]), placeholders(MESSAGES.en[k]), `${lang}.${k} placeholders differ`);
    }
  }
});

test('web translations: every language has every key, with the same placeholders', () => {
  const src = fs.readFileSync(new URL('../web/translations.js', import.meta.url), 'utf8');
  const T = vm.runInNewContext(src + ';T') as Record<string, Record<string, string>>;
  const en = Object.keys(T.en);
  for (const lang of ['fr', 'ar']) {
    assert.deepEqual(Object.keys(T[lang]).sort(), [...en].sort(), `${lang} keys differ`);
    for (const k of en) assert.deepEqual(placeholders(T[lang][k]), placeholders(T.en[k]), `${lang}.${k} placeholders differ`);
  }
});

test('every translation key used by the page exists', () => {
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const src = fs.readFileSync(new URL('../web/translations.js', import.meta.url), 'utf8');
  const T = vm.runInNewContext(src + ';T') as Record<string, Record<string, string>>;
  const used = new Set([...html.matchAll(/\bt\('([a-z0-9_]+)'/g)].map((m) => m[1]));
  used.delete('w1_d'); // prefix of keys built dynamically
  used.delete('pc_os_');
  used.delete('pc_how_');
  for (const o of ['windows', 'macos', 'linux', 'ios', 'android']) { used.add('pc_os_' + o); used.add('pc_how_' + o); }
  for (const d of [60, 360, 1440, 4320]) used.add('w1_d' + d);
  for (const k of used) assert.ok(k in T.en, `missing key ${k}`);
});

test('t() fills placeholders and falls back to English, then the key', () => {
  assert.equal(t('en', 'new_device', { device: 'X' }), 'New device on the network: X. It is filtered by default.');
  assert.equal(t('en', 'nope'), 'nope');
});

test('durations and times are human readable', () => {
  assert.equal(fmtDuration('en', 1440), '1 day');
  assert.equal(fmtDuration('en', 2880), '2 days');
  assert.equal(fmtDuration('en', 360), '6 hours');
  assert.equal(fmtDuration('en', 30), '30 minutes');
  assert.equal(fmtDuration('fr', 60), '1 heure');
  assert.equal(fmtDuration('ar', 1440), '1 يوم');
  // 2026-10-28T15:13:00Z in Algeria (UTC+1) is 16:13
  const ms = Date.UTC(2026, 9, 28, 15, 13);
  assert.match(fmtTime(ms, 'en', 'Africa/Algiers'), /16:13/);
  assert.match(fmtTime(ms, 'en', 'UTC'), /15:13/);
  assert.match(fmtTime(ms, 'fr', 'Not/AZone'), /15:13/, 'invalid timezone falls back to UTC');
});

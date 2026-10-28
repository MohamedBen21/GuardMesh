import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashSecret, generatePartnerKey, verifySecret, Lockout } from '../src/auth.js';
import { MIN, setup } from './helpers.js';

const texts = (s: { text: string }[]) => s.map((m) => m.text);

test('pausing protection waits for the delay, then auto-restores after its duration', async () => {
  const { g, api, advance } = setup();
  await g.requestChange({ kind: 'disable_all', durationMinutes: 30 });
  await g.tick();
  assert.equal(api.protection, true, 'still protected during the waiting period');
  advance(59 * MIN);
  await g.tick();
  assert.equal(api.protection, true);
  advance(2 * MIN);
  await g.tick();
  assert.equal(api.protection, false, 'paused after the delay');
  advance(31 * MIN);
  await g.tick();
  assert.equal(api.protection, true, 'restored after the window');
});

test('cancelling a pending request means it never applies', async () => {
  const { g, api, advance } = setup();
  const r = await g.requestChange({ kind: 'disable_all' });
  assert.equal(await g.cancel(r.id), true);
  advance(120 * MIN);
  await g.tick();
  assert.equal(api.protection, true);
});

test('partner key approves early; a wrong key does not', async () => {
  const { g, api, key } = setup();
  const r = await g.requestChange({ kind: 'disable_all', durationMinutes: 10 });
  assert.equal(await g.approveEarly(r.id, 'WRONG-KEY'), false);
  assert.equal(api.protection, true);
  assert.equal(await g.approveEarly(r.id, key.toLowerCase()), true);
  assert.equal(api.protection, false);
});

test('tamper: protection switched off outside a window is re-enabled and reported', async () => {
  const { g, api, sent } = setup();
  api.protection = false;
  await g.tick();
  assert.equal(api.protection, true);
  assert.ok(texts(sent).some((m) => m.includes('TAMPER')));
});

test('tamper: unauthorised exemptions are removed', async () => {
  const { g, api } = setup();
  api.exempt.add('aa:bb:cc:dd:ee:ff');
  await g.tick();
  assert.equal(api.exempt.size, 0);
});

test('exempting a device is delayed; permanent trusted devices persist', async () => {
  const { g, api, store, advance } = setup();
  store.state.devices['11:22:33:44:55:66'] = { mac: '11:22:33:44:55:66', name: 'Dad laptop', policy: 'exempt', firstSeen: '' };
  await g.tick();
  assert.ok(api.exempt.has('11:22:33:44:55:66'), 'trusted device exempted');

  await g.requestChange({ kind: 'exempt_device', mac: 'AA-BB-CC-DD-EE-01', durationMinutes: 20 });
  await g.tick();
  assert.ok(!api.exempt.has('aa:bb:cc:dd:ee:01'));
  advance(61 * MIN);
  await g.tick();
  assert.ok(api.exempt.has('aa:bb:cc:dd:ee:01'));
  advance(21 * MIN);
  await g.tick();
  assert.ok(!api.exempt.has('aa:bb:cc:dd:ee:01'), 'temporary exemption expired');
  assert.ok(api.exempt.has('11:22:33:44:55:66'), 'trusted device untouched');
});

test('new devices are discovered as strict and the partner is told', async () => {
  const { g, api, store, sent } = setup();
  api.leases = [{ mac: 'de:ad:be:ef:00:01', ip: '192.168.1.120', hostname: 'galaxy-s24' }];
  await g.tick();
  assert.equal(store.state.devices['de:ad:be:ef:00:01'].policy, 'strict');
  assert.ok(texts(sent).some((m) => m.includes('New device') && m.includes('galaxy-s24')));
});

test('restoreNow ends every active change immediately', async () => {
  const { g, api, advance } = setup();
  await g.requestChange({ kind: 'disable_all' });
  advance(61 * MIN);
  await g.tick();
  assert.equal(api.protection, false);
  await g.restoreNow();
  assert.equal(api.protection, true);
});

test('alerts are readable (no internal names), carry a cancel button, and show the delay', async () => {
  const { g, sent } = setup();
  const r = await g.requestChange({ kind: 'disable_all', durationMinutes: 30 });
  const m = sent[0];
  assert.ok(!m.text.includes('disable_all') && !m.text.includes('Z'), m.text);
  assert.match(m.text, /pause ALL protection/);
  assert.match(m.text, /in 1 hour/);
  assert.match(m.text, /30 minutes/);
  assert.deepEqual(m.opts?.button, { id: r.id, labelKey: 'btn_cancel' });
});

test('an applied pause offers a "restore" button', async () => {
  const { g, sent, advance } = setup();
  const r = await g.requestChange({ kind: 'disable_all' });
  advance(61 * MIN);
  await g.tick();
  const applied = sent.find((m) => m.text.includes('PAUSED'));
  assert.ok(applied);
  assert.deepEqual(applied!.opts?.button, { id: r.id, labelKey: 'btn_restore' });
});

test('alerts follow the configured language', async () => {
  const { g, sent } = setup({ lang: 'fr' });
  await g.requestChange({ kind: 'disable_all' });
  assert.match(sent[0].text, /suspendre TOUTE la protection/);
  assert.match(sent[0].text, /1 heure/);
});

test('auth: hashing, verification and lockout', () => {
  const k = generatePartnerKey();
  const h = hashSecret(k);
  assert.ok(verifySecret(k, h));
  assert.ok(verifySecret(' ' + k.toLowerCase().replace(/-/g, ' ') + ' ', h), 'tolerant of case/spacing');
  assert.ok(!verifySecret('nope', h));
  const l = new Lockout(3, 1000);
  l.fail(0); l.fail(1); l.fail(2);
  assert.ok(l.isLocked(3));
  assert.ok(!l.isLocked(2000));
});

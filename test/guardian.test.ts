import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Guardian } from '../src/guardian.js';
import { Store, defaultState } from '../src/store.js';
import { hashSecret, generatePartnerKey, verifySecret, Lockout } from '../src/auth.js';
import type { AdGuardApi, Lease } from '../src/adguard.js';

class FakeApi implements AdGuardApi {
  protection = true;
  exempt = new Set<string>();
  leases: Lease[] = [];
  async isInstalled() { return true; }
  async install() {}
  async applyBaselinePolicy() {}
  async getProtection() { return this.protection; }
  async setProtection(e: boolean) { this.protection = e; }
  async listLeases() { return this.leases; }
  async enableDhcp() {}
  async setExempt(mac: string, _n: string, on: boolean) { on ? this.exempt.add(mac) : this.exempt.delete(mac); }
  async listExemptMacs() { return [...this.exempt]; }
}

const MIN = 60_000;

function setup() {
  const store = new Store('/tmp/fg-test-state.json');
  store.save = async () => {}; // no disk in tests
  store.state = { ...defaultState(), setupDone: true, delayMinutes: 60 };
  const key = generatePartnerKey();
  store.state.partnerKeyHash = hashSecret(key);
  const api = new FakeApi();
  const sent: string[] = [];
  let t = 1_000_000;
  const clock = { now: () => t };
  const g = new Guardian(store, api, { send: async (m) => void sent.push(m) }, clock);
  return { store, api, sent, g, key, advance: (ms: number) => (t += ms) };
}

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
  assert.ok(sent.some((m) => m.includes('TAMPER')));
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
  assert.ok(sent.some((m) => m.includes('New device')));
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

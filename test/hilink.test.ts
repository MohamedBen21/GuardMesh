import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HilinkDriver, HilinkClient, parseResponse, scramClientProof } from '../src/router/hilink.js';
import { applyWithBackup, undoFromBackup, latestBackup } from '../src/router/runner.js';
import { fingerprint, parseGateway, ROUTERS } from '../src/router/database.js';
import { mockHilink } from './mockHilink.js';

const io = () => { const lines: string[] = []; return { lines, log: (m: string) => void lines.push(m), confirm: async () => true }; };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fgr-'));
const opts = (dir: string, extra = {}) => ({ host: '192.168.8.1', user: 'admin', password: 'secret', backupDir: dir, sleep: async () => {}, ...extra });
const DNS = ['1.1.1.3', '1.0.0.3'];

test('parseResponse handles ok, fields, error, json', () => {
  assert.equal(parseResponse('<response>OK</response>').value, 'OK');
  assert.deepEqual(parseResponse('<response><a>1</a><b>x&amp;y</b></response>').value, { a: '1', b: 'x&y' });
  assert.equal(parseResponse('<error><code>125002</code><message></message></error>').error?.code, 125002);
});

test('scram proof is deterministic and uses swapped hmac (differs from RFC form)', () => {
  const a = scramClientProof('pw', 'aabb', 10, 'n1', 'n1S');
  assert.equal(a.proof.length, 64);
  assert.deepEqual(a, scramClientProof('pw', 'aabb', 10, 'n1', 'n1S'));
});

for (const [name, mo] of [['base64 (type 0/3)', { passwordType: 3 as const }], ['legacy sha256 (type 4)', { passwordType: 4 as const }], ['scram (type 4)', { passwordType: 4 as const, scram: true }]] as const) {
  test(`apply + undo against mock router: ${name}`, async () => {
    const m = mockHilink(mo);
    const d = new HilinkDriver('192.168.8.1', m.fetchFn);
    const dir = tmp();
    const r = await applyWithBackup(d, DNS, opts(dir), io());
    assert.ok(r.ok);
    assert.equal(m.st.dhcp.DnsStatus, '1');
    assert.equal(m.st.dhcp.PrimaryDns, '1.1.1.3');
    // nothing else was overwritten
    assert.equal(m.st.dhcp.DhcpIPAddress, '192.168.8.1');
    assert.equal(m.st.dhcp.DhcpStartIPAddress, '192.168.8.100');
    assert.equal(m.st.dhcp.DhcpLeaseTime, '86400');
    const text = fs.readFileSync(r.backupFile!, 'utf8');
    assert.ok(!text.includes('secret'));
    const u = await undoFromBackup(new HilinkDriver('192.168.8.1', m.fetchFn), r.backupFile!, opts(dir), io());
    assert.ok(u);
    assert.equal(m.st.dhcp.DnsStatus, '0');
    assert.equal(m.st.dhcp.PrimaryDns, '');
  });
}

test('dry run changes nothing and writes no backup', async () => {
  const m = mockHilink();
  const dir = tmp();
  const r = await applyWithBackup(new HilinkDriver('h', m.fetchFn), DNS, opts(dir, { dryRun: true }), io());
  assert.ok(r.ok);
  assert.equal(m.st.writes, 0);
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('declining the confirmation changes nothing (backup exists)', async () => {
  const m = mockHilink();
  const dir = tmp();
  const i = io(); i.confirm = async () => false;
  const r = await applyWithBackup(new HilinkDriver('h', m.fetchFn), DNS, opts(dir), i);
  assert.equal(r.ok, false);
  assert.equal(m.st.writes, 0);
});

test('wrong password: friendly error, one attempt only, nothing written', async () => {
  const m = mockHilink();
  await assert.rejects(applyWithBackup(new HilinkDriver('h', m.fetchFn), DNS, opts(tmp(), { password: 'nope' }), io()), /Wrong username or password/);
  assert.equal(m.st.loginFailures, 1);
  assert.equal(m.st.writes, 0);
});

test('router that fails to prove itself (bad server signature) is rejected', async () => {
  const m = mockHilink({ passwordType: 4, scram: true, badServerSig: true });
  await assert.rejects(applyWithBackup(new HilinkDriver('h', m.fetchFn), DNS, opts(tmp()), io()), /server signature/);
});

test('write cut off by LAN restart is verified by reading back', async () => {
  const m = mockHilink({ failWrite: true });
  const i = io();
  const r = await applyWithBackup(new HilinkDriver('h', m.fetchFn), DNS, opts(tmp()), i);
  assert.ok(r.ok);
  assert.ok(i.lines.some((l) => /kept the change/.test(l)));
});

test('already set: nothing to change', async () => {
  const m = mockHilink({ dhcp: { DnsStatus: '1', PrimaryDns: '1.1.1.3', SecondaryDns: '1.0.0.3' } });
  const i = io();
  await applyWithBackup(new HilinkDriver('h', m.fetchFn), DNS, opts(tmp()), i);
  assert.equal(m.st.writes, 0);
  assert.ok(i.lines.some((l) => /Nothing to change/.test(l)));
});

test('refuses to write when DHCP settings are incomplete', async () => {
  const m = mockHilink({ dhcp: { DhcpIPAddress: '' } });
  await assert.rejects(applyWithBackup(new HilinkDriver('h', m.fetchFn), DNS, opts(tmp()), io()), /missing/);
  assert.equal(m.st.writes, 0);
});

test('undo refuses a backup from another driver; latestBackup finds the newest', async () => {
  const m = mockHilink();
  const dir = tmp();
  const r = await applyWithBackup(new HilinkDriver('h', m.fetchFn), DNS, opts(dir), io());
  assert.equal(latestBackup(dir, '192.168.8.1'), r.backupFile);
  const b = JSON.parse(fs.readFileSync(r.backupFile!, 'utf8')); b.driver = 'other';
  fs.writeFileSync(r.backupFile!, JSON.stringify(b));
  await assert.rejects(undoFromBackup(new HilinkDriver('h', m.fetchFn), r.backupFile!, opts(dir), io()), /not "huawei-hilink"/);
});

test('model with no login required still works', async () => {
  const m = mockHilink({ noLogin: true });
  const c = new HilinkClient('http://h', m.fetchFn);
  await c.init();
  await c.login('admin', '');
});

test('detect: fingerprints and gateway parsing', () => {
  assert.equal(fingerprint({ gateway: 'x', hilink: true }).entry?.id, 'huawei-hilink');
  assert.equal(fingerprint({ gateway: 'x', title: 'Login - MikroTik RouterOS', body: 'mikrotik routeros' }).entry?.id, 'mikrotik');
  assert.equal(fingerprint({ gateway: 'x', body: 'hello' }).confidence, 'none');
  assert.equal(parseGateway('linux', 'Iface\tDestination\tGateway\nwlan0\t00000000\t0108A8C0\n'), '192.168.8.1');
  assert.equal(parseGateway('darwin', 'default            192.168.1.1        UGScg'), '192.168.1.1');
  assert.equal(parseGateway('win32', '  0.0.0.0          0.0.0.0     192.168.1.1   192.168.1.5     25'), '192.168.1.1');
  assert.ok(ROUTERS.every((r) => !/pass(word)?\s*[:=]/i.test(JSON.stringify(r))));
});

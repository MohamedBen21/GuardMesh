import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { PROVIDERS, getProvider } from '../src/router/providers.js';
import { judge, verifyFiltering, type VerifyDeps } from '../src/router/verify.js';
import { IOS_STEPS, androidSteps, deviceScript, iosProfile } from '../src/router/deviceScripts.js';
import { mikrotikApply, mikrotikUndo, openwrtApply, openwrtUndo, runMikrotik, sshArgs } from '../src/router/drivers.js';
import { manualGuide } from '../src/router/guide.js';

const cf = getProvider('cloudflare-families');

test('providers are well formed', () => {
  for (const p of PROVIDERS) {
    assert.ok(p.v4.length >= 1, p.id);
    for (const a of p.v4) assert.match(a, /^\d{1,3}(\.\d{1,3}){3}$/);
    for (const a of p.v6) assert.match(a, /^[0-9a-f:]+$/i);
  }
  assert.deepEqual(cf.v4, ['1.1.1.3', '1.0.0.3']);
  assert.throws(() => getProvider('nope'), /Unknown provider/);
});

test('judge: the three-answer comparison', () => {
  const pub = ['152.233.100.1', '152.233.100.2'];
  assert.equal(judge(['0.0.0.0'], ['0.0.0.0'], pub), 'active', 'router returns the sinkhole like the provider');
  assert.equal(judge([], [], pub), 'active', 'both say no answer');
  assert.equal(judge(['152.233.100.2'], ['0.0.0.0'], pub), 'inactive', 'router returns the real address');
  assert.equal(judge(['10.9.9.9'], ['10.9.9.9'], pub), 'active', 'a block-page address returned by both');
  assert.equal(judge(['152.233.100.1'], ['152.233.100.2'], pub), 'inconclusive', 'provider does not block this domain');
  assert.equal(judge(['0.0.0.0'], ['0.0.0.0'], []), 'inconclusive', 'domain does not exist publicly');
  assert.equal(judge(['7.7.7.7'], ['0.0.0.0'], pub), 'inconclusive', 'unrelated answer');
});

test('verifyFiltering: overall verdict and error handling', async () => {
  const pub = ['152.233.100.1'];
  const mk = (system: string[]): VerifyDeps => ({
    systemLookup: async () => system,
    resolveVia: async (server) => (server === '9.9.9.9' ? pub : ['0.0.0.0']),
  });
  assert.equal((await verifyFiltering(cf, ['a.com'], mk(['0.0.0.0']))).overall, 'active');
  assert.equal((await verifyFiltering(cf, ['a.com'], mk(pub))).overall, 'inactive');
  const broken: VerifyDeps = { systemLookup: async () => { throw new Error('timeout'); }, resolveVia: async () => [] };
  const r = await verifyFiltering(cf, ['a.com', 'b.com'], broken);
  assert.equal(r.overall, 'error');
  assert.equal(r.results[0].error, 'timeout');
  const offline: VerifyDeps = { systemLookup: async () => [], resolveVia: async () => [] };
  assert.equal((await verifyFiltering(cf, ['a.com'], offline)).overall, 'error', 'no internet is reported as an error, not "inconclusive"');
});

test('device scripts: apply and undo for each OS', () => {
  const win = deviceScript('windows', cf, 'apply').content;
  assert.match(win, /'1\.1\.1\.3','1\.0\.0\.3'/);
  assert.match(win, /Set-DnsClientServerAddress/);
  assert.match(win, /\$idx = \$_\.ifIndex/);
  assert.match(deviceScript('windows', cf, 'undo').content, /-ResetServerAddresses/);

  const mac = deviceScript('macos', cf, 'apply');
  assert.equal(mac.filename, 'guardmesh-dns-macos-apply.sh');
  assert.match(mac.content, /networksetup -setdnsservers "\$svc" 1\.1\.1\.3 1\.0\.0\.3 2606:4700:4700::1113/);
  assert.match(deviceScript('macos', cf, 'undo').content, /setdnsservers "\$svc" empty/);

  const lin = deviceScript('linux', cf, 'apply').content;
  assert.match(lin, /ipv4\.dns "1\.1\.1\.3 1\.0\.0\.3" ipv4\.ignore-auto-dns yes/);
  assert.match(deviceScript('linux', cf, 'undo').content, /ipv4\.ignore-auto-dns no/);
  for (const os of ['macos', 'linux'] as const) assert.ok(deviceScript(os, cf, 'apply').content.startsWith('#!'));
});

test('phones: Android private DNS hostname and iOS profile', () => {
  assert.match(androidSteps(cf), /family\.cloudflare-dns\.com/);
  const prof = iosProfile(cf);
  assert.match(prof.content, /<string>https:\/\/family\.cloudflare-dns\.com\/dns-query<\/string>/);
  assert.match(prof.content, /com\.apple\.dnsSettings\.managed/);
  assert.match(prof.content, /<key>PayloadUUID<\/key><string>[0-9A-F-]{36}<\/string>/);
  assert.ok(prof.filename.endsWith('.mobileconfig'));
  assert.throws(() => iosProfile(getProvider('opendns-familyshield')), /no DNS-over-HTTPS/);
  assert.match(IOS_STEPS, /Install/);
});

test('OpenWrt commands', () => {
  const cmds = openwrtApply(cf);
  assert.ok(cmds.includes(`uci add_list dhcp.@dnsmasq[0].server='1.1.1.3'`));
  assert.ok(cmds.includes(`uci set dhcp.@dnsmasq[0].noresolv='1'`));
  assert.equal(cmds.at(-1), '/etc/init.d/dnsmasq restart');
  assert.ok(openwrtUndo().includes(`uci set dhcp.@dnsmasq[0].noresolv='0'`));
  const args = sshArgs('192.168.1.1', 'root', ['a', 'b']);
  assert.deepEqual(args, ['root@192.168.1.1', 'a && b']);
});

test('MikroTik REST calls', async () => {
  assert.deepEqual(mikrotikApply(cf)[0], { method: 'POST', path: '/rest/ip/dns/set', body: { servers: '1.1.1.3,1.0.0.3', 'allow-remote-requests': 'yes' } });
  assert.deepEqual(mikrotikUndo()[0].body, { servers: '' });

  const seen: { url: string; init: any }[] = [];
  const ok = (async (url: string, init: any) => (seen.push({ url, init }), new Response('{}', { status: 200 }))) as unknown as typeof fetch;
  await runMikrotik('http://192.168.88.1', 'admin', 'pw', mikrotikApply(cf), ok);
  assert.equal(seen[0].url, 'http://192.168.88.1/rest/ip/dns/set');
  assert.equal(seen[0].init.headers.authorization, 'Basic ' + Buffer.from('admin:pw').toString('base64'));

  const denied = (async () => new Response('no', { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(runMikrotik('http://x', 'a', 'b', mikrotikApply(cf), denied), /HTTP 401/);
});

test('manual guide contains the DNS values and the partner-password step', () => {
  const g = manualGuide(cf);
  assert.match(g, /Primary DNS\s*:\s*1\.1\.1\.3/);
  assert.match(g, /Secondary DNS:\s*1\.0\.0\.3/);
  assert.match(g, /PARTNER/);
  assert.match(g, /2606:4700:4700::1113/);
  assert.match(manualGuide(getProvider('opendns-familyshield')), /no IPv6 addresses/);
});

import { BRAND_GUIDES, brandGuideText, lockedGuideText } from '../src/router/brandGuides.js';
import { ROUTERS } from '../src/router/database.js';
test('brand guides: every manual-only router in the database has notes, no passwords, marked unverified', () => {
  for (const r of ROUTERS.filter((x) => !x.recipe)) assert.ok(BRAND_GUIDES.some((b) => b.id === r.id), `missing guide for ${r.id}`);
  for (const b of BRAND_GUIDES) {
    const t = brandGuideText(b);
    assert.match(t, b.verifiedOn ? /VERIFIED on/ : /UNVERIFIED/);
    assert.doesNotMatch(t, /password\s*[:=]\s*\S+/i);
  }
  assert.match(lockedGuideText(), /behind the ISP box/);
});

import { deviceDownload, deviceScript } from '../src/router/deviceScripts.js';
import { buildDownloads } from '../src/router/buildDownloads.js';
import { getProvider as gp } from '../src/router/providers.js';

test('Windows launcher: elevates itself and embeds exactly the PowerShell script', () => {
  const cf = gp('cloudflare-families');
  for (const action of ['apply', 'undo'] as const) {
    const f = deviceDownload('windows', cf, action);
    assert.match(f.filename, /\.cmd$/);
    assert.match(f.content, /-Verb RunAs/);
    const b64 = /-EncodedCommand (\S+)/.exec(f.content)![1];
    assert.equal(Buffer.from(b64, 'base64').toString('utf16le'), deviceScript('windows', cf, action).content);
    assert.ok(f.content.split('\r\n').every((l) => l.length < 7000), 'cmd line limit');
  }
  assert.match(Buffer.from(/-EncodedCommand (\S+)/.exec(deviceDownload('windows', cf, 'apply').content)![1], 'base64').toString('utf16le'), /1\.1\.1\.3/);
  assert.throws(() => deviceDownload('ios', cf, 'undo'), /Settings/);
});

test('README download files in downloads/ are up to date with the generator', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fgd-'));
  const names = buildDownloads(tmp);
  assert.ok(names.length >= 7);
  for (const n of names) {
    const committed = fs.readFileSync(new URL(`../downloads/${n}`, import.meta.url), 'utf8');
    assert.equal(committed, fs.readFileSync(path.join(tmp, n), 'utf8'), `${n} is stale: run npm run build:downloads`);
  }
});

test('iPhone profile is reproducible (stable UUIDs)', () => {
  const cf = gp('cloudflare-families');
  assert.equal(deviceDownload('ios', cf, 'apply').content, deviceDownload('ios', cf, 'apply').content);
});

test('README download links point to files that exist in downloads/', () => {
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const names = [...readme.matchAll(/releases\/latest\/download\/([\w.-]+)/g)].map((m) => m[1]);
  assert.ok(names.length >= 7);
  for (const n of names) assert.ok(fs.existsSync(new URL(`../downloads/${n}`, import.meta.url)), `README links to missing file ${n}`);
});

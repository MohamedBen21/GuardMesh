import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app.js';
import { Guardian } from '../src/guardian.js';
import { FakeApi, makeStore } from './helpers.js';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

function boot() {
  const store = makeStore();
  const api = new FakeApi();
  const sentToPartner: string[] = [];
  const guardian = new Guardian(store, api, { send: async () => undefined });
  const app = buildApp({
    store,
    api,
    guardian,
    webDir: new URL('../web', import.meta.url).pathname,
    // like the real sender: delivered only if some contact is configured
    send: async (p, text) => (sentToPartner.push(text), Boolean(p.telegramBotToken || p.webhookUrl)),
  });
  const server = app.listen(0);
  after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, body?: unknown) => {
    const res = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { store, api, call, sentToPartner, base };
}

test('wizard flow: setup (language, key delivered), skip DHCP, finish, dashboard status', async () => {
  const { call, sentToPartner, store } = boot();
  assert.equal((await call('/api/status')).json.setupDone, false);

  const setup = await call('/api/setup', { mode: 'parental', delayMinutes: 60, lang: 'fr', partner: { telegramBotToken: TOKEN, telegramChatId: '5108771793' } });
  assert.equal(setup.status, 200);
  assert.equal(setup.json.keyDeliveredToPartner, true);
  assert.equal(setup.json.partnerKey, undefined, 'the key is not shown on screen when it was sent to the partner');
  assert.match(sentToPartner[0], /Votre clé partenaire : [A-Z0-9]{4}(-[A-Z0-9]{4}){3}/);

  const done = await call('/api/setup/finish', { trusted: ['aa:bb:cc:dd:ee:ff'] });
  assert.equal(done.json.ok, true);
  const st = (await call('/api/status')).json;
  assert.equal(st.setupDone, true);
  assert.equal(st.lang, 'fr');
  assert.equal(st.dhcp, false, 'DNS-only mode when the DHCP step was skipped');
  assert.equal(st.partner.telegram, true);
  assert.equal(JSON.stringify(st).includes(TOKEN), false, 'the bot token is never sent back to the browser');
  assert.equal(store.state.devices['aa:bb:cc:dd:ee:ff'].policy, 'exempt');
  assert.equal((await call('/api/setup', {})).status, 409, 'setup cannot be re-run');
});

test('without Telegram the key is returned once for the screen', async () => {
  const { call } = boot();
  const r = await call('/api/setup', { mode: 'self', partner: {} });
  assert.match(r.json.partnerKey, /^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
});

test('contact details are validated', async () => {
  const { call } = boot();
  assert.equal((await call('/api/setup', { partner: { telegramBotToken: 'abc', telegramChatId: '1' } })).status, 400);
  assert.equal((await call('/api/setup', { partner: { telegramBotToken: TOKEN, telegramChatId: 'abc' } })).status, 400);
  assert.equal((await call('/api/setup', { partner: { telegramBotToken: TOKEN } })).status, 400);
  assert.equal((await call('/api/setup', { partner: { webhookUrl: 'ftp://x' } })).status, 400);
});

test('settings need the partner key, validate input, and apply', async () => {
  const { call } = boot();
  const key = (await call('/api/setup', { mode: 'self', lang: 'en', partner: {} })).json.partnerKey;
  await call('/api/setup/finish', { trusted: [] });

  assert.equal((await call('/api/settings', { partnerKey: 'WRONG', delayMinutes: 5 })).status, 403);
  assert.equal((await call('/api/settings', { partnerKey: key, partner: { telegramBotToken: 'bad', telegramChatId: '1' } })).status, 400);

  const ok = await call('/api/settings', { partnerKey: key, delayMinutes: 5, lang: 'ar', partner: { telegramBotToken: TOKEN, telegramChatId: '42' } });
  assert.equal(ok.status, 200);
  const st = (await call('/api/status')).json;
  assert.equal(st.delayMinutes, 15, 'minimum waiting period is enforced');
  assert.equal(st.lang, 'ar');
  assert.equal(st.partner.chatId, '42');

  // a later save with an empty token keeps the stored one
  await call('/api/settings', { partnerKey: key, partner: { telegramBotToken: '', telegramChatId: '43' } });
  assert.equal((await call('/api/status')).json.partner.telegram, true);
});

test('test alert needs the key and reports delivery', async () => {
  const { call, sentToPartner } = boot();
  const key = (await call('/api/setup', { mode: 'self', partner: {} })).json.partnerKey;
  await call('/api/setup/finish', { trusted: [] });
  assert.equal((await call('/api/test-alert', { partnerKey: 'nope' })).status, 403);
  assert.equal((await call('/api/test-alert', { partnerKey: key })).json.delivered, false, 'no contact configured yet');
  await call('/api/settings', { partnerKey: key, partner: { webhookUrl: 'https://example.com/hook' } });
  assert.equal((await call('/api/test-alert', { partnerKey: key })).json.delivered, true);
  assert.match(sentToPartner.at(-1)!, /Test alert/);
});

test('five wrong keys lock the partner endpoints', async () => {
  const { call } = boot();
  const key = (await call('/api/setup', { mode: 'self', partner: {} })).json.partnerKey;
  await call('/api/setup/finish', { trusted: [] });
  for (let i = 0; i < 5; i++) assert.equal((await call('/api/settings', { partnerKey: 'WRONG' })).status, 403);
  assert.equal((await call('/api/settings', { partnerKey: key })).status, 429);
});

test('pause request and instant cancel through the API', async () => {
  const { call } = boot();
  await call('/api/setup', { mode: 'self', partner: {} });
  await call('/api/setup/finish', { trusted: [] });
  const r = await call('/api/changes', { kind: 'disable_all', durationMinutes: 30 });
  assert.equal(r.json.status, 'pending');
  assert.equal((await call('/api/status')).json.changes.length, 1);
  assert.equal((await call(`/api/changes/${r.json.id}/cancel`, {})).json.ok, true);
  assert.equal((await call('/api/status')).json.changes.length, 0);
});

test('the page and its translations are served', async () => {
  const { base } = boot();
  assert.match(await (await fetch(base + '/')).text(), /FocusGuard Network/);
  assert.match(await (await fetch(base + '/translations.js')).text(), /const T = /);
});

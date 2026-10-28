import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdGuardHttp } from './adguard.js';
import { Guardian } from './guardian.js';
import { StoreNotifier, sendToPartner } from './notify.js';
import { Lockout, generatePartnerKey, generatePassword, hashSecret, verifySecret } from './auth.js';
import { Store, type Mode } from './store.js';
import { normMac } from './util.js';

const DATA_DIR = process.env.DATA_DIR ?? './data';
const PORT = Number(process.env.PORT ?? 8080);
const ADGUARD_URL = process.env.ADGUARD_URL ?? 'http://127.0.0.1:3000';
const HEARTBEAT_URL = process.env.HEARTBEAT_URL; // e.g. a healthchecks.io ping URL; partner gets alerted if pings stop
const MIN_DELAY_MINUTES = 15;

const store = new Store(path.join(DATA_DIR, 'state.json'));
await store.load();
const s = () => store.state;

const api = new AdGuardHttp(ADGUARD_URL, () => s().adguard);
const guardian = new Guardian(store, api, new StoreNotifier(store));
const lockout = new Lockout();

const app = express();
app.use(express.json());
const here = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(here, '..', 'web')));

const wrap =
  (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response) =>
    fn(req, res).catch((e: Error) => {
      console.error(e);
      res.status(500).json({ error: e.message });
    });

/** Verifies the partner key with lockout. Returns true if OK, otherwise sends the error response. */
function requirePartner(req: express.Request, res: express.Response): boolean {
  if (lockout.isLocked()) {
    res.status(429).json({ error: 'Too many wrong keys. Try again in 15 minutes.' });
    return false;
  }
  if (!verifySecret(String(req.body?.partnerKey ?? ''), s().partnerKeyHash)) {
    lockout.fail();
    res.status(403).json({ error: 'Wrong partner key.' });
    return false;
  }
  lockout.reset();
  return true;
}

app.get('/api/status', wrap(async (_req, res) => {
  let protection: boolean | null = null;
  try {
    protection = s().setupDone ? await api.getProtection() : null;
  } catch {
    /* adguard unreachable */
  }
  res.json({
    setupDone: s().setupDone,
    mode: s().mode,
    delayMinutes: s().delayMinutes,
    protection,
    partnerConfigured: Boolean(s().partnerKeyHash),
    devices: Object.values(s().devices),
    changes: s().changes.filter((c) => c.status === 'pending' || c.status === 'active'),
    log: s().log.slice(-20),
  });
}));

// ---- Setup wizard (only while setupDone is false) ----
function requireSetupOpen(res: express.Response): boolean {
  if (s().setupDone) {
    res.status(409).json({ error: 'Setup already completed. Use partner settings to change things.' });
    return false;
  }
  return true;
}

app.post('/api/setup', wrap(async (req, res) => {
  if (!requireSetupOpen(res)) return;
  const mode: Mode = req.body.mode === 'parental' ? 'parental' : 'self';
  const delayMinutes = Math.max(MIN_DELAY_MINUTES, Number(req.body.delayMinutes) || 24 * 60);
  const partner = {
    telegramBotToken: req.body.partner?.telegramBotToken || undefined,
    telegramChatId: req.body.partner?.telegramChatId || undefined,
    webhookUrl: req.body.partner?.webhookUrl || undefined,
  };

  // AdGuard admin credentials are random and live only inside the box: nobody is told them.
  if (!s().adguard) s().adguard = { user: 'guardian', password: generatePassword() };
  if (!(await api.isInstalled())) await api.install(s().adguard!.user, s().adguard!.password);
  await api.applyBaselinePolicy();

  const key = generatePartnerKey();
  s().mode = mode;
  s().delayMinutes = delayMinutes;
  s().partner = partner;
  s().partnerKeyHash = hashSecret(key);
  await store.save();

  // Prefer delivering the key straight to the partner so the user never sees it.
  const delivered = await sendToPartner(
    partner,
    `FocusGuard Network partner key: ${key}\nKeep it safe and do NOT share it with the person being protected. You need it to approve early changes or change settings.`,
  );
  res.json({ keyDeliveredToPartner: delivered, partnerKey: delivered ? undefined : key });
}));

app.post('/api/setup/dhcp', wrap(async (_req, res) => {
  if (!requireSetupOpen(res)) return;
  await api.enableDhcp();
  res.json({ ok: true });
}));

app.post('/api/setup/finish', wrap(async (req, res) => {
  if (!requireSetupOpen(res)) return;
  const trusted: string[] = Array.isArray(req.body.trusted) ? req.body.trusted : [];
  for (const raw of trusted) {
    const mac = normMac(String(raw));
    if (!mac) continue;
    const d = s().devices[mac] ?? { mac, name: mac, policy: 'strict' as const, firstSeen: new Date().toISOString() };
    d.policy = 'exempt';
    s().devices[mac] = d;
  }
  s().setupDone = true;
  await store.save();
  await guardian.tick();
  await new StoreNotifier(store).send('Setup finished. Protection is active.');
  res.json({ ok: true });
}));

app.get('/api/devices', wrap(async (_req, res) => {
  const now = new Date().toISOString();
  for (const l of await api.listLeases()) {
    s().devices[l.mac] ??= { mac: l.mac, name: l.hostname || l.mac, policy: 'strict', firstSeen: now };
  }
  await store.save();
  res.json(Object.values(s().devices));
}));

// ---- Weakening actions: delayed ----
app.post('/api/changes', wrap(async (req, res) => {
  if (!s().setupDone) return void res.status(409).json({ error: 'Finish setup first.' });
  const kind = req.body.kind;
  if (kind !== 'disable_all' && kind !== 'exempt_device') return void res.status(400).json({ error: 'Bad kind' });
  const dur = req.body.durationMinutes ? Math.min(Number(req.body.durationMinutes), 24 * 60) : null;
  res.json(await guardian.requestChange({ kind, mac: req.body.mac, durationMinutes: dur }));
}));

// ---- Strengthening actions: instant, no key ----
app.post('/api/changes/:id/cancel', wrap(async (req, res) => {
  res.json({ ok: await guardian.cancel(req.params.id) });
}));
app.post('/api/restore', wrap(async (_req, res) => {
  await guardian.restoreNow();
  res.json({ ok: true });
}));
app.post('/api/devices/:mac/strict', wrap(async (req, res) => {
  const mac = normMac(req.params.mac);
  if (!mac || !s().devices[mac]) return void res.status(404).json({ error: 'Unknown device' });
  s().devices[mac].policy = 'strict';
  await store.save();
  await guardian.tick();
  res.json({ ok: true });
}));

// ---- Partner-only ----
app.post('/api/changes/:id/approve', wrap(async (req, res) => {
  if (!requirePartner(req, res)) return;
  res.json({ ok: await guardian.approveEarly(req.params.id, String(req.body.partnerKey)) });
}));
app.post('/api/settings', wrap(async (req, res) => {
  if (!requirePartner(req, res)) return;
  if (req.body.delayMinutes != null) s().delayMinutes = Math.max(MIN_DELAY_MINUTES, Number(req.body.delayMinutes));
  if (req.body.partner) s().partner = { ...s().partner, ...req.body.partner };
  if (req.body.devicePolicy?.mac) {
    const mac = normMac(req.body.devicePolicy.mac);
    if (mac && s().devices[mac]) s().devices[mac].policy = req.body.devicePolicy.policy === 'exempt' ? 'exempt' : 'strict';
  }
  await store.save();
  await guardian.tick();
  res.json({ ok: true });
}));

// ---- Background loop ----
async function loop() {
  try {
    await guardian.tick();
    if (HEARTBEAT_URL) await fetch(HEARTBEAT_URL).catch(() => undefined);
  } catch (e) {
    console.error('tick failed', (e as Error).message);
  }
}
setInterval(loop, 30_000);

app.listen(PORT, () => {
  console.log(`FocusGuard Network wizard on http://0.0.0.0:${PORT}`);
  if (s().setupDone) {
    // A reboot or unplug is visible to the partner.
    new StoreNotifier(store).send('The box just (re)started.').catch(() => undefined);
    void loop();
  }
});

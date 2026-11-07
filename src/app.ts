import express from 'express';
import type { AdGuardApi } from './adguard.js';
import type { Guardian } from './guardian.js';
import { sendToPartner } from './notify.js';
import { Lockout, generatePartnerKey, generatePassword, hashSecret, verifySecret } from './auth.js';
import type { Mode, PartnerContact, Store } from './store.js';
import { normMac } from './util.js';
import { isLang, t, type Lang } from './i18n.js';
import { DEFAULT_PROVIDER, getProvider } from './router/providers.js';
import { DOWNLOAD_OS, deviceDownload, type DownloadOs } from './router/deviceScripts.js';

export const MIN_DELAY_MINUTES = 15;

export interface AppDeps {
  store: Store;
  api: AdGuardApi;
  guardian: Guardian;
  webDir: string;
  /** injectable for tests */
  send?: typeof sendToPartner;
}

/** Validates partner contact details. Empty fields keep the existing value. */
export function cleanPartner(raw: any, existing: PartnerContact = {}): { partner?: PartnerContact; error?: string } {
  const pick = (k: string): string | undefined => (typeof raw?.[k] === 'string' && raw[k].trim() ? raw[k].trim() : undefined);
  const token = pick('telegramBotToken') ?? existing.telegramBotToken;
  const chat = pick('telegramChatId') ?? existing.telegramChatId;
  const hook = pick('webhookUrl') ?? existing.webhookUrl;
  if (token && !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
    return { error: 'That does not look like a Telegram bot token (it looks like 123456789:ABC...).' };
  }
  if (chat && !/^-?\d+$/.test(chat)) return { error: 'The Telegram chat ID must be a number.' };
  if ((token && !chat) || (chat && !token)) return { error: 'Telegram needs both the bot token and the chat ID.' };
  if (hook && !/^https?:\/\//i.test(hook)) return { error: 'The webhook must start with http:// or https://' };
  return { partner: { telegramBotToken: token, telegramChatId: chat, webhookUrl: hook } };
}

export function buildApp(d: AppDeps) {
  const { store, api, guardian } = d;
  const send = d.send ?? sendToPartner;
  const s = () => store.state;
  const lockout = new Lockout();

  const app = express();
  app.use(express.json());
  app.use(express.static(d.webDir));

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

  function requireSetupOpen(res: express.Response): boolean {
    if (s().setupDone) {
      res.status(409).json({ error: 'Setup already completed. Use partner settings to change things.' });
      return false;
    }
    return true;
  }

  // "Protect this computer" / "Remove protection": a script for the visitor's own computer. Nothing secret is in it,
  // and the browser can only download it: the person must open it themselves.
  app.get('/api/device-script', wrap(async (req, res) => {
    const os = String(req.query.os ?? '') as DownloadOs;
    const action = req.query.action === 'undo' ? 'undo' : 'apply';
    if (!DOWNLOAD_OS.includes(os)) {
      res.status(400).json({ error: 'Unknown system. Use windows, macos, linux or ios.' });
      return;
    }
    try {
      const f = deviceDownload(os, getProvider(DEFAULT_PROVIDER), action);
      res.setHeader('Content-Type', f.mime);
      res.setHeader('Content-Disposition', `attachment; filename="${f.filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(f.content);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  }));

  app.get('/api/status', wrap(async (_req, res) => {
    const st = s().setupDone ? await guardian.status() : { protection: null, changes: [] };
    const p = s().partner;
    res.json({
      setupDone: s().setupDone,
      mode: s().mode,
      lang: s().lang,
      delayMinutes: s().delayMinutes,
      dhcp: s().dhcpEnabled,
      protection: st.protection,
      partnerConfigured: Boolean(s().partnerKeyHash),
      partner: { telegram: Boolean(p.telegramBotToken && p.telegramChatId), chatId: p.telegramChatId ?? '', webhook: Boolean(p.webhookUrl) },
      devices: Object.values(s().devices),
      changes: st.changes,
      log: s().log.slice(-20),
    });
  }));

  // ---- Setup wizard (only while setupDone is false) ----
  app.post('/api/setup', wrap(async (req, res) => {
    if (!requireSetupOpen(res)) return;
    const mode: Mode = req.body.mode === 'parental' ? 'parental' : 'self';
    const lang: Lang = isLang(req.body.lang) ? req.body.lang : 'en';
    const delayMinutes = Math.max(MIN_DELAY_MINUTES, Number(req.body.delayMinutes) || 24 * 60);
    const parsed = cleanPartner(req.body.partner);
    if (parsed.error) return void res.status(400).json({ error: parsed.error });

    // AdGuard admin credentials are random and live only inside the box: nobody is told them.
    if (!s().adguard) s().adguard = { user: 'guardian', password: generatePassword() };
    if (!(await api.isInstalled())) await api.install(s().adguard!.user, s().adguard!.password);
    await api.applyBaselinePolicy();

    const key = generatePartnerKey();
    s().mode = mode;
    s().lang = lang;
    s().delayMinutes = delayMinutes;
    s().partner = parsed.partner!;
    s().partnerKeyHash = hashSecret(key);
    await store.save();

    // Prefer delivering the key straight to the partner so the user never sees it.
    const delivered = await send(parsed.partner!, `GuardMesh: ${t(lang, 'key_msg', { key })}`);
    res.json({ keyDeliveredToPartner: delivered, partnerKey: delivered ? undefined : key });
  }));

  app.post('/api/setup/dhcp', wrap(async (_req, res) => {
    if (!requireSetupOpen(res)) return;
    await api.enableDhcp();
    s().dhcpEnabled = true;
    await store.save();
    res.json({ ok: true });
  }));

  app.post('/api/setup/finish', wrap(async (req, res) => {
    if (!requireSetupOpen(res)) return;
    const trusted: string[] = Array.isArray(req.body.trusted) ? req.body.trusted : [];
    for (const raw of trusted) {
      const mac = normMac(String(raw));
      if (!mac) continue;
      const dev = s().devices[mac] ?? { mac, name: mac, policy: 'strict' as const, firstSeen: new Date().toISOString() };
      dev.policy = 'exempt';
      s().devices[mac] = dev;
    }
    s().setupDone = true;
    await store.save();
    await guardian.tick();
    await send(s().partner, `GuardMesh: ${t(s().lang, 'setup_done')}`);
    res.json({ ok: true });
  }));

  app.get('/api/devices', wrap(async (_req, res) => {
    try {
      const now = new Date().toISOString();
      for (const l of await api.listLeases()) {
        s().devices[l.mac] ??= { mac: l.mac, name: l.hostname || l.mac, policy: 'strict', firstSeen: now };
      }
      await store.save();
    } catch {
      /* DNS-only mode: no DHCP leases to list */
    }
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

  // ---- Partner-only (needs the partner key) ----
  app.post('/api/changes/:id/approve', wrap(async (req, res) => {
    if (!requirePartner(req, res)) return;
    res.json({ ok: await guardian.approveEarly(req.params.id, String(req.body.partnerKey)) });
  }));

  app.post('/api/settings', wrap(async (req, res) => {
    if (!requirePartner(req, res)) return;
    if (req.body.partner) {
      const parsed = cleanPartner(req.body.partner, s().partner);
      if (parsed.error) return void res.status(400).json({ error: parsed.error });
      s().partner = parsed.partner!;
    }
    if (req.body.delayMinutes != null) {
      const n = Number(req.body.delayMinutes);
      if (Number.isFinite(n)) s().delayMinutes = Math.max(MIN_DELAY_MINUTES, Math.round(n));
    }
    if (isLang(req.body.lang)) s().lang = req.body.lang;
    if (req.body.devicePolicy?.mac) {
      const mac = normMac(req.body.devicePolicy.mac);
      if (mac && s().devices[mac]) s().devices[mac].policy = req.body.devicePolicy.policy === 'exempt' ? 'exempt' : 'strict';
    }
    await store.save();
    await guardian.tick();
    res.json({ ok: true });
  }));

  app.post('/api/test-alert', wrap(async (req, res) => {
    if (!requirePartner(req, res)) return;
    const delivered = await send(s().partner, `GuardMesh: ${t(s().lang, 'test_alert')}`);
    res.json({ delivered });
  }));

  return app;
}

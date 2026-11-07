import type { Store, PartnerContact } from './store.js';
import { t } from './i18n.js';

/** Optional inline button attached to a Telegram alert (cancel a request / restore protection). */
export interface AlertOpts {
  button?: { id: string; labelKey: 'btn_cancel' | 'btn_restore' };
}

export interface Notifier {
  send(text: string, opts?: AlertOpts): Promise<void>;
}

export class ConsoleNotifier implements Notifier {
  async send(text: string): Promise<void> {
    console.log(`[notify] ${text}`);
  }
}

async function postJson(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  // never put the URL in the error: for Telegram it contains the bot token
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/** Sends to the partner through whatever is configured (Telegram bot and/or a generic webhook). Never throws. */
export async function sendToPartner(
  partner: PartnerContact,
  text: string,
  opts: { button?: { id: string; label: string } } = {},
): Promise<boolean> {
  let delivered = false;
  if (partner.telegramBotToken && partner.telegramChatId) {
    try {
      await postJson(`https://api.telegram.org/bot${partner.telegramBotToken}/sendMessage`, {
        chat_id: partner.telegramChatId,
        text,
        reply_markup: opts.button
          ? { inline_keyboard: [[{ text: opts.button.label, callback_data: `cancel:${opts.button.id}` }]] }
          : undefined,
      });
      delivered = true;
    } catch (e) {
      console.error('telegram notify failed:', (e as Error).message);
    }
  }
  if (partner.webhookUrl) {
    try {
      await postJson(partner.webhookUrl, { text, content: text });
      delivered = true;
    } catch (e) {
      console.error('webhook notify failed:', (e as Error).message);
    }
  }
  return delivered;
}

/** Reads the partner contact from the store at send time, so settings changes apply immediately. */
export class StoreNotifier implements Notifier {
  constructor(private store: Store) {}
  async send(text: string, opts?: AlertOpts): Promise<void> {
    const lang = this.store.state.lang;
    const button = opts?.button ? { id: opts.button.id, label: t(lang, opts.button.labelKey) } : undefined;
    const delivered = await sendToPartner(this.store.state.partner, `GuardMesh: ${text}`, { button });
    if (!delivered) console.log(`[notify:undelivered] ${text}`);
  }
}

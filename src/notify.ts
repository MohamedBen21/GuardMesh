import type { Store, PartnerContact } from './store.js';

export interface Notifier {
  send(text: string): Promise<void>;
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
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
}

/** Sends to the partner through whatever is configured (Telegram bot and/or a generic webhook). Never throws. */
export async function sendToPartner(partner: PartnerContact, text: string): Promise<boolean> {
  let delivered = false;
  if (partner.telegramBotToken && partner.telegramChatId) {
    try {
      await postJson(`https://api.telegram.org/bot${partner.telegramBotToken}/sendMessage`, {
        chat_id: partner.telegramChatId,
        text,
      });
      delivered = true;
    } catch (e) {
      console.error('telegram notify failed', (e as Error).message);
    }
  }
  if (partner.webhookUrl) {
    try {
      await postJson(partner.webhookUrl, { text, content: text });
      delivered = true;
    } catch (e) {
      console.error('webhook notify failed', (e as Error).message);
    }
  }
  return delivered;
}

/** Reads the partner contact from the store at send time, so settings changes apply immediately. */
export class StoreNotifier implements Notifier {
  constructor(private store: Store) {}
  async send(text: string): Promise<void> {
    const delivered = await sendToPartner(this.store.state.partner, `FocusGuard Network: ${text}`);
    if (!delivered) console.log(`[notify:undelivered] ${text}`);
  }
}

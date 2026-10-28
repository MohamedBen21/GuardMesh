import type { Guardian } from './guardian.js';
import type { Store } from './store.js';
import { fmtTime, t } from './i18n.js';

export type FetchFn = typeof fetch;
type Button = { id: string; labelKey: 'btn_cancel' | 'btn_restore' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Lets the partner act from their phone. The box polls Telegram (outbound only: no port forwarding needed) and handles:
 *  - taps on the "Cancel request" / "Restore protection" buttons attached to alerts
 *  - /status (shows protection state and pending changes, each with a button) and /restore
 * Only messages from the configured partner chat are obeyed. Every action is a STRENGTHENING one
 * (cancel / restore), so a hijacked chat can never weaken protection through the bot.
 */
export class TelegramBot {
  private offset = 0;
  private running = false;

  constructor(
    private store: Store,
    private guardian: Guardian,
    private fetchFn: FetchFn = fetch,
  ) {}

  private get partner() {
    return this.store.state.partner;
  }

  private async api(method: string, body: unknown, timeoutMs = 15_000): Promise<any> {
    const token = this.partner.telegramBotToken;
    if (!token) throw new Error('no bot token configured');
    const res = await this.fetchFn(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data: any = await res.json().catch(() => ({}));
    // never include the URL in errors: it contains the token
    if (!res.ok || data.ok === false) throw new Error(`telegram ${method}: HTTP ${res.status} ${data.description ?? ''}`.trim());
    return data.result;
  }

  private async say(text: string, button?: Button) {
    const lang = this.store.state.lang;
    await this.api('sendMessage', {
      chat_id: this.partner.telegramChatId,
      text,
      reply_markup: button
        ? { inline_keyboard: [[{ text: t(lang, button.labelKey), callback_data: `cancel:${button.id}` }]] }
        : undefined,
    });
  }

  private async sendStatus() {
    const lang = this.store.state.lang;
    const st = await this.guardian.status();
    const state = st.protection === false ? t(lang, 'state_paused') : t(lang, 'state_on');
    await this.say(t(lang, 'bot_status', { state }) + (st.changes.length ? '' : '\n' + t(lang, 'no_changes')));
    for (const c of st.changes) {
      const what = this.guardian.whatOf(c);
      const line =
        c.status === 'pending'
          ? t(lang, 'ch_pending', { what, time: fmtTime(c.unlockAt, lang) })
          : t(lang, 'ch_active', { what });
      await this.say(line, { id: c.id, labelKey: c.status === 'pending' ? 'btn_cancel' : 'btn_restore' });
    }
  }

  async handleUpdate(u: any): Promise<void> {
    const lang = this.store.state.lang;
    const partnerChat = String(this.partner.telegramChatId ?? '');

    const cq = u.callback_query;
    if (cq) {
      const from = String(cq.message?.chat?.id ?? '');
      if (!partnerChat || from !== partnerChat) {
        await this.api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Not allowed', show_alert: true }).catch(() => undefined);
        return;
      }
      const data = String(cq.data ?? '');
      if (data.startsWith('cancel:')) {
        const ok = await this.guardian.cancel(data.slice('cancel:'.length));
        await this.api('answerCallbackQuery', {
          callback_query_id: cq.id,
          text: t(lang, ok ? 'bot_cancelled' : 'bot_not_found'),
        }).catch(() => undefined);
        if (cq.message) {
          await this.api('editMessageReplyMarkup', {
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            reply_markup: { inline_keyboard: [] },
          }).catch(() => undefined);
        }
      }
      return;
    }

    const m = u.message;
    if (m?.text) {
      if (String(m.chat?.id) !== partnerChat) return; // strangers are ignored silently
      const cmd = String(m.text).trim().split(/[\s@]/)[0].toLowerCase();
      if (cmd === '/status' || cmd === '/start') await this.sendStatus();
      else if (cmd === '/restore') await this.guardian.restoreNow(); // sends its own "restored" alert
      else if (cmd === '/help') await this.say(t(lang, 'bot_help'));
    }
  }

  /** One long-poll round trip. Returns the number of updates handled. */
  async pollOnce(timeoutSec = 25): Promise<number> {
    const updates: any[] =
      (await this.api(
        'getUpdates',
        { offset: this.offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] },
        (timeoutSec + 10) * 1000,
      )) ?? [];
    for (const u of updates) {
      this.offset = u.update_id + 1;
      try {
        await this.handleUpdate(u);
      } catch (e) {
        console.error('telegram update failed:', (e as Error).message);
      }
    }
    return updates.length;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  private async loop() {
    while (this.running) {
      if (!this.partner.telegramBotToken || !this.partner.telegramChatId) {
        await sleep(5_000);
        continue;
      }
      try {
        await this.pollOnce(25);
      } catch (e) {
        console.error('telegram poll failed:', (e as Error).message);
        await sleep(10_000);
      }
    }
  }
}

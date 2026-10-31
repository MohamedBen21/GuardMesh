import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramBot } from '../src/telegram.js';
import { MIN, setup } from './helpers.js';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const PARTNER_CHAT = '1234567890';

/** A fake Telegram API that records calls and serves queued getUpdates results. */
function fakeTelegram() {
  const calls: { method: string; body: any }[] = [];
  const queue: any[][] = [];
  const fetchFn = (async (url: string, init: any) => {
    const method = String(url).split('/').pop()!;
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    const result = method === 'getUpdates' ? (queue.shift() ?? []) : true;
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, queue, fetchFn, of: (m: string) => calls.filter((c) => c.method === m) };
}

function boxWithTelegram() {
  const ctx = setup({ partner: { telegramBotToken: TOKEN, telegramChatId: PARTNER_CHAT } });
  const tg = fakeTelegram();
  const bot = new TelegramBot(ctx.store, ctx.g, tg.fetchFn);
  return { ...ctx, tg, bot };
}

test('partner taps "Cancel request": the pending change is cancelled and the button removed', async () => {
  const { g, bot, tg, advance, api } = boxWithTelegram();
  const r = await g.requestChange({ kind: 'disable_all' });
  tg.queue.push([{ update_id: 7, callback_query: { id: 'cb1', data: `cancel:${r.id}`, message: { message_id: 42, chat: { id: Number(PARTNER_CHAT) } } } }]);
  assert.equal(await bot.pollOnce(0), 1);
  assert.equal(tg.of('answerCallbackQuery')[0].body.text, 'Cancelled.');
  assert.equal(tg.of('editMessageReplyMarkup')[0].body.message_id, 42);
  advance(120 * MIN);
  await g.tick();
  assert.equal(api.protection, true, 'the cancelled pause never applied');
});

test('taps from any other chat are refused and change nothing', async () => {
  const { g, bot, tg, advance, api } = boxWithTelegram();
  const r = await g.requestChange({ kind: 'disable_all' });
  tg.queue.push([{ update_id: 1, callback_query: { id: 'cb2', data: `cancel:${r.id}`, message: { message_id: 1, chat: { id: 999 } } } }]);
  await bot.pollOnce(0);
  assert.equal(tg.of('answerCallbackQuery')[0].body.text, 'Not allowed');
  advance(61 * MIN);
  await g.tick();
  assert.equal(api.protection, false, 'the pause still applied because nobody legitimate cancelled it');
});

test('/status from the partner lists state and pending changes with buttons; strangers are ignored', async () => {
  const { g, bot, tg } = boxWithTelegram();
  await g.requestChange({ kind: 'disable_all' });
  tg.queue.push([
    { update_id: 1, message: { chat: { id: 555 }, text: '/status' } },
    { update_id: 2, message: { chat: { id: Number(PARTNER_CHAT) }, text: '/status' } },
  ]);
  await bot.pollOnce(0);
  const sends = tg.of('sendMessage');
  assert.equal(sends.length, 2, 'one status line + one pending change, nothing for the stranger');
  assert.match(sends[0].body.text, /Protection is ON/);
  assert.match(sends[1].body.text, /pause all protection — starts at/);
  assert.equal(sends[1].body.reply_markup.inline_keyboard[0][0].callback_data.startsWith('cancel:'), true);
  assert.ok(sends.every((s) => String(s.body.chat_id) === PARTNER_CHAT));
});

test('/restore ends an active pause', async () => {
  const { g, bot, tg, advance, api } = boxWithTelegram();
  await g.requestChange({ kind: 'disable_all' });
  advance(61 * MIN);
  await g.tick();
  assert.equal(api.protection, false);
  tg.queue.push([{ update_id: 3, message: { chat: { id: Number(PARTNER_CHAT) }, text: '/restore' } }]);
  await bot.pollOnce(0);
  assert.equal(api.protection, true);
});

test('the offset moves past handled updates', async () => {
  const { bot, tg } = boxWithTelegram();
  tg.queue.push([{ update_id: 10, message: { chat: { id: 1 }, text: 'hello' } }]);
  await bot.pollOnce(0);
  await bot.pollOnce(0);
  const polls = tg.of('getUpdates');
  assert.equal(polls[0].body.offset, 0);
  assert.equal(polls[1].body.offset, 11);
});

test('errors never contain the bot token', async () => {
  const ctx = setup({ partner: { telegramBotToken: TOKEN, telegramChatId: PARTNER_CHAT } });
  const failing = (async () => new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), { status: 401 })) as unknown as typeof fetch;
  const bot = new TelegramBot(ctx.store, ctx.g, failing);
  await assert.rejects(bot.pollOnce(0), (e: Error) => !e.message.includes(TOKEN) && /401/.test(e.message));
});

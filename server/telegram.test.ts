import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Update } from 'grammy/types';
import { openDatabase } from './db.js';
import { GameService } from './service.js';
import { createTelegramBot } from './telegram.js';
import type { Config } from './config.js';

const config: Config = { mode: 'telegram', port: 3001, host: '127.0.0.1', dbPath: ':memory:', publicUrl: 'https://games.example.com', botToken: '123:fake', botUsername: 'tablemate_bot', sessionSecret: 'secret', production: false };
const user = { id: 7, is_bot: false as const, first_name: 'Ada' };
let service: GameService, telegram: ReturnType<typeof createTelegramBot>;
let calls: { method: string; payload: any }[];
beforeEach(async () => {
  service = new GameService(openDatabase(':memory:')); telegram = createTelegramBot(config, service); calls = [];
  telegram.bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    if (method === 'getMe') return { ok: true, result: { id: 123, is_bot: true, first_name: 'Tablemate', username: 'tablemate_bot' } };
    if (method === 'sendMessage') return { ok: true, result: { message_id: 99, date: 0, chat: { id: -100, type: 'group', title: 'Friends' }, text: 'game' } };
    return { ok: true, result: true };
  });
  await telegram.bot.init();
});
afterEach(async () => { await telegram.close(); service.db.close(); });

describe('Telegram update integration without network messages', () => {
  it('returns three personal, uncached games and records chosen feedback', async () => {
    await telegram.bot.handleUpdate({ update_id: 1, inline_query: { id: 'query1', from: user, query: '', offset: '' } });
    const answer = calls.find(c => c.method === 'answerInlineQuery')!.payload;
    expect(answer.cache_time).toBe(0); expect(answer.is_personal).toBe(true); expect(answer.results).toHaveLength(3);
    expect(answer.results[0].reply_markup.inline_keyboard[0][0].url).toMatch(/^https:\/\/t.me\/tablemate_bot\?startapp=/);
    expect(answer.results[0].reply_markup.inline_keyboard[0][0].text).toBe('Play Chess');
    expect(answer.results[0].input_message_content.message_text).toBe('Chess\nAda · Waiting for player');
    expect(service.list('7')).toHaveLength(0);
    await telegram.bot.handleUpdate({ update_id: 2, chosen_inline_result: { result_id: answer.results[0].id, from: user, query: '', inline_message_id: 'inline-message' } });
    expect(service.list('7')).toHaveLength(1); expect(service.pendingMessages()[0].inline_message_id).toBe('inline-message');
  });
  it('handles /play chess in a group and keeps the game in the same topic', async () => {
    const update: Update = { update_id: 3, message: { message_id: 1, date: 0, from: user, chat: { id: -100, type: 'supergroup', title: 'Friends' }, message_thread_id: 42, text: '/play chess', entities: [{ type: 'bot_command', offset: 0, length: 5 }] } };
    await telegram.bot.handleUpdate(update);
    const sent = calls.find(c => c.method === 'sendMessage')!.payload;
    expect(sent.message_thread_id).toBe(42); expect(sent.text).toBe('Chess\nAda · Waiting for player');
    expect(service.list('7')[0].game).toBe('chess'); expect(service.pendingMessages()[0].chat_id).toBe('-100');
  });
  it('replaces the game selector with the board button without an extra message', async () => {
    await telegram.bot.handleUpdate({ update_id: 4, callback_query: { id: 'cb', from: user, chat_instance: 'chat', data: 'new:checkers', message: { message_id: 1, date: 0, chat: { id: -100, type: 'group', title: 'Friends' }, text: 'Choose' } } });
    expect(calls.some(c => c.method === 'answerCallbackQuery')).toBe(true); expect(service.list('7')[0].game).toBe('checkers');
    expect(calls.some(c => c.method === 'sendMessage')).toBe(false);
    const edited = calls.find(c => c.method === 'editMessageText')!.payload;
    expect(edited.message_id).toBe(1); expect(edited.text).toBe('Checkers\nAda · Waiting for player');
    expect(service.pendingMessages()[0].message_id).toBe(1);
  });
  it('ignores queued clicks after a selector has already become a game', async () => {
    for (const [i, game] of ['chess', 'checkers'].entries()) {
      await telegram.bot.handleUpdate({ update_id: 10 + i, callback_query: { id: `cb-${i}`, from: user, chat_instance: 'chat', data: `new:${game}`, message: { message_id: 1, date: 0, chat: { id: -100, type: 'group', title: 'Friends' }, text: 'Choose' } } });
    }
    expect(service.list('7')).toHaveLength(1); expect(service.list('7')[0].game).toBe('chess');
    expect(calls.filter(c => c.method === 'editMessageText')).toHaveLength(1);
  });
});

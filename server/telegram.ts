import { Bot, InlineKeyboard, GrammyError, type Context } from 'grammy';
import type { InlineQueryResultArticle } from 'grammy/types';
import { gameNames, type GameSummary, type GameType } from '../shared/types.js';
import type { Config } from './config.js';
import { GameService } from './service.js';

export const gameMessage = (match: GameSummary) => {
  const title = gameNames[match.game];
  if (match.status === 'waiting') return `${title}\n${match.creator.name} · Waiting for player`;
  if (match.status === 'cancelled') return `${title}\nCancelled`;
  if (match.status === 'finished') {
    const winner = match.result?.winner === 'first' ? match.creator.name : match.opponent?.name;
    return `${title}\n${match.result?.winner ? `${winner} won` : 'Draw'} · ${match.result?.reason}`;
  }
  return `${title}\n${match.creator.name} vs ${match.opponent?.name}`;
};
export const gameLink = (botUsername: string, id: string) => `https://t.me/${botUsername}?startapp=${id}`;
export const resultArticle = (match: GameSummary, botUsername: string): InlineQueryResultArticle => ({
  type: 'article', id: match.id, title: gameNames[match.game], description: '2 players',
  input_message_content: { message_text: gameMessage(match) },
  reply_markup: new InlineKeyboard().url(`Play ${gameNames[match.game]}`, gameLink(botUsername, match.id)),
});

export function createTelegramBot(config: Config, service: GameService) {
  const bot = new Bot(config.botToken);
  const keyboard = () => new InlineKeyboard().text('♟ Chess', 'new:chess').text('● Checkers', 'new:checkers').row().text('✕ Tic-tac-toe', 'new:tictactoe');
  const games: GameType[] = ['chess', 'checkers', 'tictactoe'];
  const addPlayer = (user: { id: number; first_name: string; last_name?: string; username?: string }) => {
    const player = { id: String(user.id), name: [user.first_name, user.last_name].filter(Boolean).join(' '), ...(user.username ? { username: user.username } : {}) };
    service.upsertPlayer(player); return player;
  };
  const sendGame = async (ctx: Context, game: GameType) => {
    if (!ctx.from) return;
    if (ctx.callbackQuery?.message && ctx.chat && service.hasMessageRef(String(ctx.chat.id), ctx.callbackQuery.message.message_id)) return;
    const player = addPlayer(ctx.from), match = service.create(game, player.id, false);
    const reply_markup = new InlineKeyboard().url(`Play ${gameNames[game]}`, gameLink(config.botUsername, match.id));
    if (ctx.callbackQuery?.message && ctx.chat) {
      await ctx.editMessageText(gameMessage(match), { reply_markup });
      service.addMessageRef(match.id, { chatId: String(ctx.chat.id), messageId: ctx.callbackQuery.message.message_id });
      return;
    }
    const message = await ctx.reply(gameMessage(match), { reply_markup, ...(ctx.msg?.message_thread_id ? { message_thread_id: ctx.msg.message_thread_id } : {}) });
    service.addMessageRef(match.id, { chatId: String(message.chat.id), messageId: message.message_id });
  };
  bot.command('start', async ctx => {
    if (!ctx.from) return;
    addPlayer(ctx.from);
    await ctx.reply('Choose a game.', { reply_markup: keyboard() });
  });
  bot.command('help', ctx => ctx.reply(`/play chess\n/play checkers\n/play tictactoe\n\nTap Play to open the board. The second player to open it joins automatically.\n\nIn any chat: @${config.botUsername} chess`));
  bot.command('play', async ctx => {
    const game = ctx.match.trim().toLowerCase();
    if (games.includes(game as GameType)) return sendGame(ctx, game as GameType);
    await ctx.reply('Choose a game.', { reply_markup: keyboard(), ...(ctx.msg.message_thread_id ? { message_thread_id: ctx.msg.message_thread_id } : {}) });
  });
  bot.callbackQuery(/^new:(chess|checkers|tictactoe)$/, async ctx => {
    await ctx.answerCallbackQuery();
    await sendGame(ctx, ctx.match[1] as GameType);
  });
  bot.on('inline_query', async ctx => {
    const player = addPlayer(ctx.from), query = ctx.inlineQuery.query.trim().toLowerCase();
    const selected = games.filter(g => !query || g.includes(query) || gameNames[g].toLowerCase().includes(query));
    const results = selected.map(g => resultArticle(service.create(g, player.id, false), config.botUsername));
    await ctx.answerInlineQuery(results, { cache_time: 0, is_personal: true });
  });
  bot.on('chosen_inline_result', ctx => {
    const result = ctx.chosenInlineResult;
    try {
      const match = service.get(result.result_id);
      if (match.creator.id !== String(ctx.from.id)) return;
      if (result.inline_message_id) service.addMessageRef(match.id, { inlineMessageId: result.inline_message_id });
      else service.publish(match.id);
    } catch { /* Expired, unused draft. Never create a match with another creator. */ }
  });
  bot.catch(error => { console.error('Telegram update failed:', error.error instanceof GrammyError ? error.error.description : 'Unexpected bot error'); });

  let stopped = false, inFlight: Promise<void> | null = null;
  async function runFlush() {
    if (Date.now() < service.telegramCooldown()) return;
    for (const ref of service.pendingMessages()) {
      if (stopped) break;
      try {
        const match = service.summary(ref.match_id), text = gameMessage(match);
        const markup = new InlineKeyboard().url(`Play ${gameNames[match.game]}`, gameLink(config.botUsername, match.id));
        const controller = new AbortController();
        const deadline = setTimeout(() => controller.abort(), 15_000);
        // grammY types its signal with a polyfill; Node's native signal implements
        // the runtime interface consumed by its HTTP client.
        const signal = controller.signal as unknown as Parameters<typeof bot.api.editMessageText>[4];
        try {
          if (ref.inline_message_id) await bot.api.editMessageTextInline(ref.inline_message_id, text, { reply_markup: markup }, signal);
          else if (ref.chat_id && ref.message_id) await bot.api.editMessageText(ref.chat_id, ref.message_id, text, { reply_markup: markup }, signal);
          if (service.summary(match.id).version === match.version) service.messageUpdated(ref.ref);
        } catch (error) {
          if (error instanceof GrammyError) {
            const terminal = error.error_code === 403 || error.description.includes('message to edit not found') || error.description.includes("message can't be edited");
            if (terminal || error.description.includes('message is not modified') && service.summary(match.id).version === match.version) { service.messageUpdated(ref.ref); continue; }
            if (error.error_code === 429) {
              const seconds = Math.max(1, error.parameters.retry_after ?? 30);
              const until = Date.now() + seconds * 1000;
              service.deferTelegram(until); service.messageDeferred(ref.ref, ref.attempts + 1, until);
              break;
            }
          }
          // Failed refs become ineligible, allowing newer messages to make progress.
          service.messageDeferred(ref.ref, ref.attempts + 1, Date.now() + Math.min(300_000, 8000 * 2 ** Math.min(ref.attempts, 6)));
        } finally { clearTimeout(deadline); }
      } catch (error) {
        // Includes storage/render failures; never leave an unhandled interval rejection.
        console.error('Telegram edit worker failed:', error instanceof Error ? error.message : 'Unexpected error');
        break;
      }
    }
  }
  function flushMessages(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = runFlush().catch(() => { console.error('Telegram edit worker failed'); }).finally(() => { inFlight = null; });
    return inFlight;
  }
  const timer = setInterval(() => { void flushMessages(); }, 4000); timer.unref();
  return { bot, flush: flushMessages, close: async () => { stopped = true; clearInterval(timer); await inFlight; } };
}

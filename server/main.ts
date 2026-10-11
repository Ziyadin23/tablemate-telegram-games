import { readConfig } from './config.js';
import { openDatabase } from './db.js';
import { GameService } from './service.js';
import { buildApp } from './app.js';
import { createTelegramBot } from './telegram.js';

const config = readConfig();
const db = openDatabase(config.dbPath), service = new GameService(db);
const app = await buildApp(config, service);
const telegram = config.mode === 'telegram' ? createTelegramBot(config, service) : null;
if (telegram) {
  await telegram.bot.init();
  if (telegram.bot.botInfo.username?.toLowerCase() !== config.botUsername.toLowerCase()) throw new Error('BOT_USERNAME does not match BOT_TOKEN');
  await telegram.bot.api.setMyCommands([{ command: 'play', description: 'Play a game' }, { command: 'help', description: 'Commands' }]);
  await telegram.bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'My games', web_app: { url: config.publicUrl } } });
}
await app.listen({ port: config.port, host: config.host });
let polling: Promise<void> | undefined;
if (telegram) {
  polling = telegram.bot.start({ allowed_updates: ['message', 'callback_query', 'inline_query', 'chosen_inline_result'], onStart: () => app.log.info('Telegram bot polling started') });
  void polling.catch(() => { app.log.error('Bot polling failed. Check bot credentials, webhook configuration, and other running instances.'); process.exitCode = 1; void shutdown(); });
}

let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true;
  const editsClosed = telegram?.close();
  if (telegram?.bot.isRunning()) await telegram.bot.stop();
  await polling?.catch(() => {}); // bot.stop() alone does not drain update middleware.
  await editsClosed;
  await app.close(); db.close();
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });

import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z, ZodError } from 'zod';
import type { WebSocket } from 'ws';
import { AppError, issueSession, validateTelegramData, verifySession } from './auth.js';
import { GameService, type Action } from './service.js';
import type { Config } from './config.js';
import { DEMO_PLAYERS, type GameSnapshot } from '../shared/types.js';

const gameSchema = z.enum(['chess', 'checkers', 'tictactoe', 'mafia']);
const matchIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16}$/);
const moveSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chess'), from: z.string().regex(/^[a-h][1-8]$/), to: z.string().regex(/^[a-h][1-8]$/), promotion: z.enum(['q', 'r', 'b', 'n']).optional() }).strict(),
  z.object({ kind: z.literal('checkers'), path: z.array(z.number().int().min(0).max(63)).min(2).max(13) }).strict(),
  z.object({ kind: z.literal('tictactoe'), cell: z.number().int().min(0).max(8) }).strict(),
  z.object({ kind: z.literal('mafia'), phase: z.enum(['night', 'day']), round: z.number().int().min(1), target: z.string().min(1).max(100).nullable() }).strict(),
]);
const actionSchema = z.object({ actionId: z.string().min(8).max(100), version: z.number().int().nonnegative(), kind: z.enum(['join', 'start', 'leave', 'move', 'resign', 'cancel', 'offer-draw', 'accept-draw', 'decline-draw']), move: moveSchema.optional() }).strict().refine(a => a.kind === 'move' ? Boolean(a.move) : !a.move, 'Invalid move payload');

export async function buildApp(config: Config, service: GameService, logging = true) {
  const app = Fastify({ logger: logging ? { redact: ['req.headers.authorization', 'req.body.initData', 'req.body.token'] } : false, bodyLimit: 16_384, trustProxy: ['127.0.0.0/8', '::1/128', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'] });
  const sockets = new Map<WebSocket, { playerId: string; matchId: string | null; token: string }>();
  const rate = new Map<string, { count: number; until: number }>();
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
    if (req.url.startsWith('/api')) {
      reply.header('Cache-Control', 'no-store');
      const path = req.url.split('?')[0];
      if (path === '/api/health') return;
      let key: string, limit: number;
      if (path.startsWith('/api/matches') || path.startsWith('/api/creations') || path === '/api/session') {
        // A verified identity, never an untrusted token/header, defines gameplay quota.
        const id = currentPlayer(req.headers.authorization);
        key = `player:${id}`; limit = 300;
      } else { key = `${path.startsWith('/api/auth/') ? 'auth' : 'public'}:${req.ip}`; limit = path.startsWith('/api/auth/') ? 60 : 300; }
      const now = Date.now(), entry = rate.get(key);
      if (entry && entry.until > now) { entry.count++; if (entry.count > limit) throw new AppError(429, 'Too many requests. Try again shortly.'); }
      else rate.set(key, { count: 1, until: now + 60_000 });
    }
    // All mutations are same-origin. Telegram's signed initData establishes identity.
    if (req.method === 'POST' && req.headers.origin) {
      let origin: URL; try { origin = new URL(req.headers.origin); } catch { throw new AppError(403, 'Invalid origin'); }
      const allowed = origin.origin === new URL(config.publicUrl).origin || !config.production && ['localhost', '127.0.0.1'].includes(origin.hostname);
      if (!allowed) throw new AppError(403, 'Invalid origin');
    }
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: 'Invalid request', details: error.issues.map(i => i.message) });
    if (error instanceof AppError) return reply.code(error.statusCode).send({ error: error.message });
    if (typeof error === 'object' && error && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500) return reply.code(error.statusCode).send({ error: 'Invalid request' });
    req.log.error(error, 'Request failed'); return reply.code(500).send({ error: 'Something went wrong. Please try again.' });
  });
  const currentPlayer = (header: string | undefined) => {
    if (!header?.startsWith('Bearer ')) throw new AppError(401, 'Open the app from Telegram to sign in');
    const id = verifySession(header.slice(7), config.sessionSecret); service.player(id); return id;
  };

  app.get('/api/config', async () => ({ mode: config.mode, botUsername: config.botUsername }));
  app.get('/api/health', async () => { service.db.prepare('SELECT 1').get(); return { status: 'ok' }; });
  app.post('/api/auth/telegram', async req => {
    if (config.mode !== 'telegram') throw new AppError(404, 'Telegram authentication is not enabled');
    const { initData } = z.object({ initData: z.string().min(1).max(12_000) }).parse(req.body);
    const player = validateTelegramData(initData, config.botToken); service.upsertPlayer(player);
    return { token: issueSession(player.id, config.sessionSecret), player };
  });
  app.post('/api/auth/demo', async req => {
    if (config.mode !== 'demo' || config.production) throw new AppError(404, 'Demo authentication is disabled');
    const { player: name } = z.object({ player: z.enum(DEMO_PLAYERS) }).parse(req.body);
    const player = { id: `demo-${name.toLowerCase()}`, name }; service.upsertPlayer(player);
    return { token: issueSession(player.id, config.sessionSecret), player };
  });
  app.get('/api/session', async req => ({ player: service.player(currentPlayer(req.headers.authorization)) }));
  app.get('/api/creations/:requestId', async req => {
    const playerId = currentPlayer(req.headers.authorization), { requestId } = z.object({ requestId: z.string().uuid() }).parse(req.params);
    return { match: service.creation(playerId, requestId) };
  });
  app.get('/api/matches', async req => ({ matches: service.list(currentPlayer(req.headers.authorization)) }));
  app.post('/api/matches', async req => {
    const id = currentPlayer(req.headers.authorization);
    const { game, requestId } = z.object({ game: gameSchema, requestId: z.string().uuid().optional() }).strict().parse(req.body);
    return { match: service.create(game, id, true, requestId) };
  });
  app.get('/api/matches/:id', async req => {
    const playerId = currentPlayer(req.headers.authorization), { id } = z.object({ id: matchIdSchema }).parse(req.params);
    return { match: service.get(id, playerId) };
  });
  app.post('/api/matches/:id/open', async req => {
    const playerId = currentPlayer(req.headers.authorization), { id } = z.object({ id: matchIdSchema }).parse(req.params);
    return { match: service.open(id, playerId) };
  });
  app.post('/api/matches/:id/actions', async req => {
    const playerId = currentPlayer(req.headers.authorization), { id } = z.object({ id: matchIdSchema }).parse(req.params);
    const action = actionSchema.parse(req.body) as Action;
    return { match: service.act(id, playerId, action) };
  });

  await app.register(websocket, { options: { maxPayload: 4096 } });
  app.get('/ws', { websocket: true }, (socket, req) => {
    const origin = req.headers.origin;
    if (origin && origin !== new URL(config.publicUrl).origin && !(config.mode === 'demo' && ['http://localhost:5173', 'http://127.0.0.1:5173'].includes(origin))) { socket.close(1008, 'Invalid origin'); return; }
    const authTimeout = setTimeout(() => socket.close(1008, 'Authentication required'), 5000);
    let messages = 0, resetAt = Date.now();
    socket.on('message', raw => {
      try {
        if (Date.now() > resetAt + 60_000) { messages = 0; resetAt = Date.now(); }
        if (++messages > 120) { socket.close(1008, 'Too many messages'); return; }
        const input = JSON.parse(raw.toString());
        if (input.type === 'auth') {
          const { token } = z.object({ token: z.string().max(2048) }).parse(input);
          const playerId = verifySession(token, config.sessionSecret); service.player(playerId);
          sockets.set(socket, { playerId, matchId: null, token }); clearTimeout(authTimeout);
          socket.send(JSON.stringify({ type: 'ready' }));
        } else {
          const entry = sockets.get(socket); if (!entry) throw new AppError(401, 'Authentication required');
          verifySession(entry.token, config.sessionSecret);
          if (input.type === 'subscribe') {
            const id = matchIdSchema.nullable().parse(input.matchId);
            entry.matchId = id;
            if (id) socket.send(JSON.stringify({ type: 'match', match: service.get(id, entry.playerId) }));
          } else if (input.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
          else throw new AppError(400, 'Unknown message');
        }
      } catch (error) {
        socket.send(JSON.stringify({ type: 'error', error: error instanceof AppError ? error.message : 'Invalid message' }));
        if (error instanceof AppError && error.statusCode === 401) socket.close(1008, 'Session expired');
      }
    });
    socket.on('close', () => { clearTimeout(authTimeout); sockets.delete(socket); });
    socket.on('error', () => { clearTimeout(authTimeout); sockets.delete(socket); });
  });
  const unsubscribe = service.onChange((match: GameSnapshot) => {
    for (const [socket, entry] of sockets) {
      if (socket.readyState !== 1) continue;
      try { verifySession(entry.token, config.sessionSecret); }
      catch { socket.close(1008, 'Session expired'); continue; }
      if (entry.matchId === match.id) socket.send(JSON.stringify({ type: 'match', match: match.game === 'mafia' ? service.get(match.id, entry.playerId) : match }));
      if (entry.playerId === match.creator.id || entry.playerId === match.opponent?.id || match.participants?.some(player => player.id === entry.playerId)) socket.send(JSON.stringify({ type: 'list-changed' }));
    }
  });
  service.expireWaitingGames();
  service.advanceMafiaGames();
  const waitingExpiry = setInterval(() => {
    try { service.expireWaitingGames(); service.advanceMafiaGames(); }
    catch (error) { app.log.error(error, 'Waiting game expiry failed'); }
  }, 1000); waitingExpiry.unref();
  const maintenance = setInterval(() => {
    const now = Date.now(); for (const [key, value] of rate) if (value.until < now) rate.delete(key);
    for (const [socket] of sockets) if (socket.readyState === 1) socket.ping();
    service.clearOldDrafts();
  }, 60_000); maintenance.unref();
  app.addHook('onClose', async () => { unsubscribe(); clearInterval(waitingExpiry); clearInterval(maintenance); for (const [socket] of sockets) socket.close(1001, 'Server closing'); });
  const root = resolve('dist/public');
  if (existsSync(root)) {
    await app.register(staticFiles, { root });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url === '/ws' || req.method !== 'GET' || req.url.split('?')[0].includes('.')) return reply.code(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}

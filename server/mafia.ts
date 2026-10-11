import { randomInt } from 'node:crypto';
import { AppError } from './auth.js';
import { MAFIA_MIN_PLAYERS, MAFIA_MAX_PLAYERS, type MafiaMove, type MafiaPhase, type MafiaRole, type MafiaTeam, type MafiaView, type Player, type GameResult } from '../shared/types.js';

// This state stays on the server. Only mafiaView may cross the API/socket boundary.
export type MafiaState = {
  kind: 'mafia'; phase: MafiaPhase; round: number; phaseExpiresAt: string | null;
  players: { id: string; alive: boolean; role: MafiaRole | null }[];
  nightActions: Record<string, string | null>; votes: Record<string, string | null>;
  investigations: Record<string, { round: number; playerId: string; team: MafiaTeam }[]>;
  events: { round: number; kind: 'night' | 'vote' | 'peaceful-night' | 'no-vote' | 'leave'; playerId: string | null }[];
  winner: MafiaTeam | null;
};
export const createMafia = (creatorId: string): MafiaState => ({ kind: 'mafia', phase: 'lobby', round: 0, phaseExpiresAt: null, players: [{ id: creatorId, alive: true, role: null }], nightActions: {}, votes: {}, investigations: {}, events: [], winner: null });
const copy = (state: MafiaState): MafiaState => structuredClone(state);
const has = (choices: Record<string, string | null>, id: string) => Object.hasOwn(choices, id);
const living = (state: MafiaState) => state.players.filter(player => player.alive);

export function joinMafia(state: MafiaState, playerId: string): MafiaState {
  if (state.players.some(player => player.id === playerId)) return state;
  if (state.phase !== 'lobby') throw new AppError(409, 'Mafia has already started. You can watch this game.');
  if (state.players.length >= MAFIA_MAX_PLAYERS) throw new AppError(409, 'The Mafia lobby is full. You can watch this game.');
  return { ...state, players: [...state.players, { id: playerId, alive: true, role: null }] };
}
export function startMafia(state: MafiaState, now = Date.now()): MafiaState {
  if (state.phase !== 'lobby') throw new AppError(409, 'Mafia has already started');
  if (state.players.length < MAFIA_MIN_PLAYERS) throw new AppError(409, `Mafia needs at least ${MAFIA_MIN_PLAYERS} players`);
  const next = copy(state), mafiaCount = next.players.length >= 7 ? 2 : 1;
  const roles: MafiaRole[] = Array.from({ length: next.players.length }, (_, i) => i < mafiaCount ? 'mafia' : i === mafiaCount ? 'doctor' : i === mafiaCount + 1 ? 'detective' : 'villager');
  for (let i = roles.length - 1; i > 0; i--) { const j = randomInt(i + 1); [roles[i], roles[j]] = [roles[j], roles[i]]; }
  next.players.forEach((player, i) => { player.role = roles[i]; });
  next.round = 1; beginPhase(next, 'night', now);
  return next;
}
function beginPhase(state: MafiaState, phase: 'night' | 'day', now: number) {
  state.phase = phase;
  state.phaseExpiresAt = new Date(now + (phase === 'night' ? 60_000 : 120_000)).toISOString();
  state.nightActions = {}; state.votes = {};
}
function finishIfWon(state: MafiaState): boolean {
  const players = living(state), mafia = players.filter(player => player.role === 'mafia').length, town = players.length - mafia;
  if (!mafia) state.winner = 'town';
  else if (mafia >= town) state.winner = 'mafia';
  if (!state.winner) return false;
  state.phase = 'finished'; state.phaseExpiresAt = null; state.nightActions = {}; state.votes = {};
  return true;
}
function selectedTarget(choices: (string | null)[]): string | null {
  const counts = new Map<string | null, number>();
  for (const target of choices) counts.set(target, (counts.get(target) ?? 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  return !ranked.length || ranked[0][1] === ranked[1]?.[1] ? null : ranked[0][0];
}
function nightActors(state: MafiaState) { return living(state).filter(player => player.role !== 'villager'); }
function resolveNight(state: MafiaState, now: number) {
  const players = living(state), attackers = players.filter(player => player.role === 'mafia');
  const targetId = selectedTarget(attackers.map(player => state.nightActions[player.id] ?? null));
  const doctor = players.find(player => player.role === 'doctor');
  const protectedId = doctor ? state.nightActions[doctor.id] : null;
  const detective = players.find(player => player.role === 'detective');
  const investigatedId = detective ? state.nightActions[detective.id] : null;
  const investigated = players.find(player => player.id === investigatedId);
  if (detective && investigated) (state.investigations[detective.id] ??= []).push({ round: state.round, playerId: investigated.id, team: investigated.role === 'mafia' ? 'mafia' : 'town' });
  const victim = players.find(player => player.id === targetId && player.id !== protectedId);
  if (victim) victim.alive = false;
  state.events.push({ round: state.round, kind: victim ? 'night' : 'peaceful-night', playerId: victim?.id ?? null });
  if (!finishIfWon(state)) beginPhase(state, 'day', now);
}
function resolveDay(state: MafiaState, now: number) {
  const players = living(state), targetId = selectedTarget(players.map(player => state.votes[player.id] ?? null));
  const victim = players.find(player => player.id === targetId);
  if (victim) victim.alive = false;
  state.events.push({ round: state.round, kind: victim ? 'vote' : 'no-vote', playerId: victim?.id ?? null });
  if (!finishIfWon(state)) { state.round++; beginPhase(state, 'night', now); }
}
export function mafiaTargets(state: MafiaState, playerId: string): (string | null)[] {
  const actor = state.players.find(player => player.id === playerId);
  if (!actor?.alive || state.phase === 'lobby' || state.phase === 'finished') return [];
  const choices = state.phase === 'day' ? state.votes : state.nightActions;
  if (has(choices, playerId) || state.phase === 'night' && actor.role === 'villager') return [];
  return [...living(state).filter(player => state.phase === 'day' ? player.id !== playerId : actor.role === 'mafia' ? player.role !== 'mafia' : actor.role === 'detective' ? player.id !== playerId : true).map(player => player.id), null];
}
export function playMafia(state: MafiaState, playerId: string, move: MafiaMove, now = Date.now()): MafiaState {
  if (move.phase !== state.phase || move.round !== state.round) throw new AppError(409, 'The Mafia phase changed. Choose again.');
  if (!mafiaTargets(state, playerId).includes(move.target)) throw new AppError(409, 'You cannot make that choice, or your choice is already saved.');
  const next = copy(state), choices = next.phase === 'day' ? next.votes : next.nightActions;
  choices[playerId] = move.target;
  if (next.phase === 'day' && living(next).every(player => has(choices, player.id))) resolveDay(next, now);
  else if (next.phase === 'night' && nightActors(next).every(player => has(choices, player.id))) resolveNight(next, now);
  return next;
}
export function advanceMafia(state: MafiaState, now = Date.now()): MafiaState {
  if (!state.phaseExpiresAt || Date.parse(state.phaseExpiresAt) > now) return state;
  const next = copy(state);
  if (next.phase === 'night') resolveNight(next, now);
  else if (next.phase === 'day') resolveDay(next, now);
  return next;
}
export function leaveMafia(state: MafiaState, playerId: string, creatorId: string, now = Date.now()): MafiaState {
  const player = state.players.find(player => player.id === playerId);
  if (!player) throw new AppError(403, 'Only the players can leave this game');
  if (state.phase === 'finished') throw new AppError(409, 'This game has ended');
  if (state.phase === 'lobby') {
    if (playerId === creatorId) throw new AppError(409, 'The host can cancel the lobby instead');
    return { ...state, players: state.players.filter(player => player.id !== playerId) };
  }
  if (!player.alive) throw new AppError(409, 'You have already been eliminated');
  const next = copy(state); next.players.find(player => player.id === playerId)!.alive = false;
  for (const choices of [next.votes, next.nightActions]) {
    delete choices[playerId];
    for (const id of Object.keys(choices)) if (choices[id] === playerId) choices[id] = null;
  }
  next.events.push({ round: next.round, kind: 'leave', playerId });
  if (!finishIfWon(next)) {
    if (next.phase === 'day' && living(next).every(player => has(next.votes, player.id))) resolveDay(next, now);
    else if (next.phase === 'night' && nightActors(next).every(player => has(next.nightActions, player.id))) resolveNight(next, now);
  }
  return next;
}
export const mafiaResult = (state: MafiaState): GameResult | null => state.winner ? { winner: null, team: state.winner, reason: state.winner === 'town' ? 'All Mafia members were eliminated.' : 'Mafia outnumber or equal the remaining town.' } : null;
export function mafiaView(state: MafiaState, player: (id: string) => Player, viewerId?: string): MafiaView {
  const viewer = state.players.find(member => member.id === viewerId), choices = state.phase === 'day' ? state.votes : state.nightActions;
  return {
    kind: 'mafia', phase: state.phase, round: state.round, phaseExpiresAt: state.phaseExpiresAt,
    players: state.players.map(member => ({ player: player(member.id), alive: member.alive, revealedRole: !member.alive || state.phase === 'finished' ? member.role : null })),
    yourRole: viewer?.role ?? null,
    teammates: viewer?.role === 'mafia' ? state.players.filter(member => member.role === 'mafia' && member.id !== viewerId).map(member => member.id) : [],
    investigations: viewerId ? state.investigations[viewerId] ?? [] : [],
    canAct: viewerId ? mafiaTargets(state, viewerId).length > 0 : false,
    hasActed: viewerId ? has(choices, viewerId) : false, yourChoice: viewerId ? choices[viewerId] ?? null : null,
    votes: state.phase === 'day' ? { ...state.votes } : {},
    events: state.events.map(event => ({ round: event.round, text: event.playerId ? `${player(event.playerId).name} ${event.kind === 'night' ? 'was eliminated at night.' : event.kind === 'vote' ? 'was voted out.' : 'left the game.'}` : event.kind === 'peaceful-night' ? 'Nobody was eliminated at night.' : 'The vote ended without an elimination.' })),
  };
}

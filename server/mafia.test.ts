import { describe, expect, it } from 'vitest';
import { createMafia, joinMafia, startMafia, mafiaView, mafiaTargets, playMafia, advanceMafia, leaveMafia, mafiaResult, type MafiaState } from './mafia.js';
import type { MafiaRole } from '../shared/types.js';

const now = Date.parse('2026-10-11T12:00:00.000Z');
const player = (id: string) => ({ id, name: id });
function fixture(roles: MafiaRole[] = ['mafia', 'doctor', 'detective', 'villager', 'villager']): MafiaState {
  return { ...createMafia('p0'), phase: 'night', round: 1, phaseExpiresAt: new Date(now + 60_000).toISOString(), players: roles.map((role, i) => ({ id: `p${i}`, alive: true, role })) };
}
function choose(state: MafiaState, id: string, target: string | null) {
  if (state.phase !== 'night' && state.phase !== 'day') throw new Error('Not a playable phase');
  return playMafia(state, id, { kind: 'mafia', phase: state.phase, round: state.round, target }, now);
}
describe('Mafia rules and private views', () => {
  it.each([5, 6, 7, 10])('assigns the correct secret roles to %i distinct players', count => {
    let state = createMafia('p0'); for (let i = 1; i < count; i++) state = joinMafia(state, `p${i}`);
    const active = startMafia(state, now), roles = active.players.map(player => player.role);
    expect(active.phase).toBe('night'); expect(active.round).toBe(1);
    expect(roles.filter(role => role === 'mafia')).toHaveLength(count >= 7 ? 2 : 1);
    expect(roles.filter(role => role === 'doctor')).toHaveLength(1); expect(roles.filter(role => role === 'detective')).toHaveLength(1);
    expect(state.players.every(player => player.role === null)).toBe(true);
  });
  it('enforces lobby minimum, capacity, and distinct membership', () => {
    let state = createMafia('p0'); expect(joinMafia(state, 'p0')).toBe(state);
    expect(() => startMafia(state, now)).toThrow('at least 5');
    for (let i = 1; i < 10; i++) state = joinMafia(state, `p${i}`);
    expect(() => joinMafia(state, 'outsider')).toThrow('full');
    expect(() => joinMafia(startMafia(state, now), 'outsider')).toThrow('already started');
  });
  it('resolves protection and investigation together and keeps the result private', () => {
    let state = fixture(); state = choose(state, 'p0', 'p3'); state = choose(state, 'p1', 'p3');
    expect(state.phase).toBe('night'); state = choose(state, 'p2', 'p0');
    expect(state.phase).toBe('day'); expect(state.players.every(player => player.alive)).toBe(true);
    expect(mafiaView(state, player, 'p2').investigations).toEqual([{ round: 1, playerId: 'p0', team: 'mafia' }]);
    for (const id of ['p0', 'p1', 'p3', 'spectator']) {
      const view = mafiaView(state, player, id);
      expect(view.investigations).toEqual([]); expect(view.players.every(player => player.revealedRole === null)).toBe(true);
      expect(view).not.toHaveProperty('nightActions'); expect(view).not.toHaveProperty('winner');
    }
    expect(mafiaView(state, player).yourRole).toBeNull(); expect(mafiaView(state, player).teammates).toEqual([]);
  });
  it('permits Doctor self-protection and hides other night choices', () => {
    let state = fixture(); expect(mafiaTargets(state, 'p1')).toContain('p1');
    expect(mafiaTargets(state, 'p2')).not.toContain('p2'); expect(mafiaTargets(state, 'p3')).toEqual([]);
    state = choose(state, 'p0', 'p3');
    expect(mafiaView(state, player, 'p0')).toMatchObject({ hasActed: true, yourChoice: 'p3', votes: {} });
    expect(mafiaView(state, player, 'p1')).toMatchObject({ hasActed: false, yourChoice: null, votes: {} });
    expect(() => choose(state, 'p0', 'p4')).toThrow('already saved');
    expect(() => choose(state, 'p3', 'p0')).toThrow('cannot make');
  });
  it('allows Mafia to see only their teammates and requires an agreed attack', () => {
    let state = fixture(['mafia', 'mafia', 'doctor', 'detective', 'villager', 'villager', 'villager']);
    expect(mafiaView(state, player, 'p0').teammates).toEqual(['p1']);
    expect(mafiaView(state, player, 'p2').teammates).toEqual([]); expect(mafiaTargets(state, 'p0')).not.toContain('p1');
    state = choose(state, 'p0', 'p4'); state = choose(state, 'p1', 'p5'); state = choose(state, 'p2', null); state = choose(state, 'p3', null);
    expect(state.phase).toBe('day'); expect(state.players.every(player => player.alive)).toBe(true);
  });
  it('reveals eliminated roles and ends with a town victory when Mafia is voted out', () => {
    let state = fixture(); state = choose(state, 'p0', 'p3'); state = choose(state, 'p1', null); state = choose(state, 'p2', null);
    expect(state.players[3].alive).toBe(false); expect(mafiaView(state, player, 'p4').players[3].revealedRole).toBe('villager');
    expect(mafiaTargets(state, 'p3')).toEqual([]);
    for (const [id, target] of [['p0', 'p4'], ['p1', 'p0'], ['p2', 'p0'], ['p4', 'p0']]) state = choose(state, id, target);
    expect(mafiaResult(state)?.team).toBe('town'); expect(state.phase).toBe('finished');
    expect(mafiaView(state, player).players.every(player => player.revealedRole !== null)).toBe(true);
  });
  it('treats tied votes and missing choices as skips and rejects stale phase choices', () => {
    const night = fixture(); expect(advanceMafia(night, now + 59_999)).toBe(night);
    let state = advanceMafia(night, now + 60_000); expect(state.phase).toBe('day');
    for (const [id, target] of [['p0', 'p3'], ['p1', 'p0'], ['p2', 'p0'], ['p3', 'p4'], ['p4', 'p3']]) state = choose(state, id, target);
    expect(state.phase).toBe('night'); expect(state.round).toBe(2); expect(state.players.every(player => player.alive)).toBe(true);
    expect(() => playMafia(state, 'p0', { kind: 'mafia', phase: 'night', round: 1, target: 'p3' }, now)).toThrow('phase changed');
    expect(() => playMafia(state, 'spectator', { kind: 'mafia', phase: 'night', round: 2, target: null }, now)).toThrow('cannot make');
  });
  it('finishes when Mafia reach parity, and leaving counts as elimination', () => {
    const state = fixture(['mafia', 'doctor', 'villager']);
    const next = leaveMafia(state, 'p1', 'p0', now);
    expect(mafiaResult(next)?.team).toBe('mafia'); expect(state.players[1].alive).toBe(true);
    expect(mafiaResult(leaveMafia(state, 'p0', 'p0', now))?.team).toBe('town');
    expect(() => leaveMafia(createMafia('p0'), 'p0', 'p0', now)).toThrow('host can cancel');
  });
});

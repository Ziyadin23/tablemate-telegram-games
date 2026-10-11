import { useEffect, useState } from 'react';
import { MAFIA_MIN_PLAYERS, MAFIA_MAX_PLAYERS, gameResultLabel, type GameSnapshot, type MafiaMove, type MafiaRole, type Player } from '../shared/types';
import { useCountdown, countdownText } from './useCountdown';

const roleNames: Record<MafiaRole, string> = { mafia: 'Mafia', doctor: 'Doctor', detective: 'Detective', villager: 'Villager' };
const roleDetails: Record<MafiaRole, string> = {
  mafia: 'Choose a town player to eliminate at night. Your team wins when Mafia equal or outnumber the town.',
  doctor: 'Protect one living player each night, including yourself. Help the town find every Mafia member.',
  detective: 'Investigate one other player each night. Only you see whether they belong to Mafia or town.',
  villager: 'Discuss suspicions in your Telegram chat and vote during the day. Find every Mafia member to win.',
};
type Props = {
  match: GameSnapshot; player: Player; enabled: boolean; inviteUrl: string;
  act(kind: 'start' | 'leave'): void; play(move: MafiaMove): void;
  cancel(): void; quit(): void; newGame(): void;
};
export function MafiaGame({ match, player, enabled, inviteUrl, act, play, cancel, quit, newGame }: Props) {
  const [selected, setSelected] = useState<string | null | undefined>(undefined), [inviteStatus, setInviteStatus] = useState('');
  const state = match.state.kind === 'mafia' ? match.state : null;
  const seconds = useCountdown(match.status === 'waiting' ? match.waitingExpiresAt : state?.phaseExpiresAt ?? null);
  useEffect(() => { setSelected(undefined); }, [match.id, state?.phase, state?.round, state?.hasActed, player.id]);
  if (!state) return null;
  const me = state.players.find(member => member.player.id === player.id), host = player.id === match.creator.id;
  const moves = match.legalMoves.filter((move): move is MafiaMove => move.kind === 'mafia');
  const canChoose = enabled && state.canAct;
  const title = match.status === 'cancelled' ? match.result ? 'Game disbanded' : 'Game cancelled' : match.status === 'finished' ? gameResultLabel(match) : state.phase === 'lobby' ? 'Gather your players' : `${state.phase === 'night' ? 'Night' : 'Day'} ${state.round}`;
  const choiceName = state.yourChoice ? state.players.find(member => member.player.id === state.yourChoice)?.player.name : 'Skip';
  async function copyInvite() {
    try { if (!navigator.clipboard) throw new Error('Clipboard unavailable'); await navigator.clipboard.writeText(inviteUrl); setInviteStatus('Link copied'); }
    catch { setInviteStatus('Copy the link below'); }
  }
  return <div className={`mafia-layout ${state.phase === 'night' ? 'mafia-night' : ''}`}>
    <section className="mafia-main" aria-label="Mafia game">
      <div className="mafia-heading"><span className="mafia-emblem" aria-hidden="true">🎭</span><div><h2>{title}</h2><p>{state.phase === 'lobby' ? `${state.players.length}/${MAFIA_MAX_PLAYERS} players · ${MAFIA_MIN_PLAYERS} needed to start` : `${state.players.filter(member => member.alive).length} alive · ${state.players.length} players`}</p></div>{!me && <span className="spectator-label">Watching</span>}</div>
      {state.yourRole && <section className={`mafia-role-card role-${state.yourRole}`} aria-label="Your secret role"><p>{match.status === 'finished' ? 'Your role' : 'Your secret role'}</p><h2>{roleNames[state.yourRole]}</h2><p>{roleDetails[state.yourRole]}</p>{state.teammates.length > 0 && <p><strong>Your Mafia teammates:</strong> {state.teammates.map(id => state.players.find(member => member.player.id === id)?.player.name).join(', ')}</p>}</section>}
      {state.investigations.length > 0 && <section className="mafia-investigations" aria-label="Your investigations"><h2>Your investigations</h2>{state.investigations.map((result, i) => <p key={i}>{state.players.find(member => member.player.id === result.playerId)?.player.name}: <strong>{result.team === 'mafia' ? 'Mafia' : 'Town'}</strong> <small>· Night {result.round}</small></p>)}</section>}
      {match.result && <p className="mafia-result" role="status">{match.result.reason}</p>}
      {(match.status === 'waiting' || match.status === 'active') && <div className="mafia-phase-copy">
        <p>{state.phase === 'lobby' ? 'Invite friends using the same game link. The host can start once five players join.' : state.phase === 'day' ? 'Discuss in your Telegram chat, then vote for a player to eliminate. Your confirmed vote is final.' : 'Night actions are private. Mafia choose a target, the Doctor protects, and the Detective investigates.'}</p>
        <p className="mafia-timer" aria-live="off">{seconds > 0 ? <>{state.phase === 'lobby' ? state.players.length >= MAFIA_MIN_PLAYERS ? 'Auto-starts in' : 'Lobby closes in' : 'Phase ends in'} <strong>{countdownText(seconds)}</strong></> : 'Updating game…'}</p>
      </div>}
      <div className="mafia-roster" role="group" aria-label="Mafia players">{state.players.map(member => {
        const target = moves.find(move => move.target === member.player.id), selectable = Boolean(target && canChoose);
        const voteCount = Object.values(state.votes).filter(id => id === member.player.id).length;
        return <button key={member.player.id} type="button" className={`mafia-player ${selected === member.player.id ? 'chosen' : ''} ${!member.alive ? 'eliminated' : ''}`} disabled={!selectable} aria-label={`${member.player.name}${selectable ? ' select target' : ''}${!member.alive ? ' eliminated' : ''}`} aria-pressed={selected === member.player.id} onClick={() => setSelected(member.player.id)}>
          <span className="player-avatar">{member.player.name.slice(0, 1)}</span><span className="mafia-player-copy"><strong>{member.player.name}{member.player.id === player.id && <small>You</small>}</strong><span>{member.revealedRole ? `${roleNames[member.revealedRole]}${member.alive ? '' : ' · Eliminated'}` : state.phase === 'lobby' ? member.player.id === match.creator.id ? 'Host' : 'Joined' : member.alive ? 'Alive' : 'Eliminated'}</span></span>{voteCount > 0 && <span className="mafia-vote-count">{voteCount} vote{voteCount > 1 ? 's' : ''}</span>}
        </button>;
      })}</div>
      {state.canAct && match.status === 'active' && <div className="mafia-choice">
        <p>{state.phase === 'day' ? 'Choose who to vote out' : state.yourRole === 'doctor' ? 'Choose who to protect' : state.yourRole === 'detective' ? 'Choose who to investigate' : 'Choose the Mafia target'}</p>
        <div><button className={`secondary ${selected === null ? 'chosen' : ''}`} aria-pressed={selected === null} disabled={!canChoose} onClick={() => setSelected(null)}>Skip</button><button className="primary" disabled={!canChoose || selected === undefined || !moves.some(move => move.target === selected)} onClick={() => { const move = moves.find(move => move.target === selected); if (move) play(move); }}>{state.phase === 'day' ? 'Confirm vote' : 'Confirm night action'}</button></div>
      </div>}
      {match.status === 'active' && <p className="mafia-action-status" role="status">{!me ? 'You are watching. Roles stay private until revealed.' : !me.alive ? 'You were eliminated. You can keep watching.' : state.hasActed ? `Choice saved: ${choiceName}. Waiting for the other players.` : !state.canAct && state.phase === 'night' ? 'You sleep tonight. Wait for the day to begin.' : 'Select a player above or skip, then confirm your choice.'}</p>}
      {state.events.length > 0 && <div className="mafia-events"><h2>Game events</h2><ol>{state.events.map((event, i) => <li key={i}><span>Round {event.round}</span>{event.text}</li>)}</ol></div>}
    </section>
    <aside className="mafia-sidebar">
      {match.status === 'waiting' && <div className="mafia-lobby-actions"><button className="secondary" onClick={() => void copyInvite()}>Copy invite link</button>{inviteStatus && <><p role="status">{inviteStatus}</p><input aria-label="Game invite link" readOnly value={inviteUrl} onFocus={event => event.target.select()} /></>}{host && <button className="primary" disabled={!enabled || state.players.length < MAFIA_MIN_PLAYERS} onClick={() => act('start')}>Start Mafia</button>}{host ? <button className="secondary cancel-game" disabled={!enabled} onClick={cancel}>Cancel game</button> : me && <button className="secondary" disabled={!enabled} onClick={() => act('leave')}>Leave lobby</button>}</div>}
      {match.status === 'active' && me?.alive && <button className="secondary mafia-leave" disabled={!enabled} onClick={quit}>Leave game</button>}
      {(match.status === 'finished' || match.status === 'cancelled') && <button className="primary" onClick={newGame}>New game</button>}
      <details className="mafia-rules"><summary>How to play</summary><p>5–6 players get one Mafia member; 7–10 get two. Every game has one Doctor, one Detective, and the remaining players are Villagers.</p><p>Night lasts up to 1 minute; day lasts up to 2 minutes. A phase ends early when everyone required has confirmed. Missing choices count as skips.</p><p>Mafia must agree on a target; a tied attack eliminates nobody. The Doctor can protect themselves. Day votes use the most votes, with ties or a winning skip eliminating nobody. Eliminated roles are revealed.</p><p>Town win when all Mafia are eliminated. Mafia win when they equal or outnumber the town. Leaving an active game counts as elimination.</p><p>The lobby lasts 3 minutes. It starts automatically if at least five players have joined, otherwise it disbands.</p></details>
    </aside>
  </div>;
}

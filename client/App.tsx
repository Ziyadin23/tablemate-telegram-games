import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, isTransient, retryOperation } from './api';
import { forgetSession, launchScope, loadTelegramSDK, readStored, restoreSession, saveSession, writeStored, type Session } from './session';
import { useModal } from './useModal';
import { Board } from './Boards';
import { MafiaGame } from './MafiaGame';
import { useCountdown, countdownText } from './useCountdown';
import { gameNames, gameResultLabel, DEMO_PLAYERS, type GameSnapshot, type GameSummary, type GameType, type Move, type Player, type Seat } from '../shared/types';

type AppConfig = { mode: 'demo' | 'telegram'; botUsername: string };
const games: GameType[] = ['chess', 'checkers', 'tictactoe', 'mafia'];
const icons: Record<GameType, string> = { chess: '♞', checkers: '●', tictactoe: '×', mafia: '🎭' };
const seatFor = (match: GameSummary, player: Player): Seat | null => match.game === 'mafia' ? null : match.creator.id === player.id ? 'first' : match.opponent?.id === player.id ? 'second' : null;
const isPlayer = (match: GameSummary, player: Player) => match.game === 'mafia' ? Boolean(match.participants?.some(member => member.id === player.id)) : Boolean(seatFor(match, player));
const getInitialMatch = () => new URLSearchParams(location.search).get('match') || window.Telegram?.WebApp.initDataUnsafe?.start_param || new URLSearchParams(location.search).get('tgWebAppStartParam');

function GameCards({ choose, busy }: { choose(game: GameType): void; busy: boolean }) {
  return <div className="game-grid">{games.map(game => <button key={game} className={`game-card ${game}`} onClick={() => choose(game)} disabled={busy} aria-label={`Play ${gameNames[game]}`}><span className="game-icon" aria-hidden="true">{icons[game]}</span><span>{gameNames[game]}{game === 'mafia' && <small className="card-meta">5–10 players</small>}</span><span className="card-arrow" aria-hidden="true">→</span></button>)}</div>;
}
function playerColor(game: GameType, seat: Seat) {
  return game === 'chess' ? seat === 'first' ? 'White' : 'Black' : game === 'checkers' ? seat === 'first' ? 'Red' : 'White' : seat === 'first' ? 'X' : 'O';
}
function WaitingCountdown({ expiresAt }: { expiresAt: string }) {
  const seconds = useCountdown(expiresAt);
  return <p className="waiting-countdown" aria-live="off">{seconds > 0 ? <>Disbands in <span>{countdownText(seconds)}</span> if nobody joins.</> : 'Disbanding…'}</p>;
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null), [session, setSession] = useState<Session | null>(null);
  const [matchId, setMatchId] = useState<string | null>(getInitialMatch), [match, setMatch] = useState<GameSnapshot | null>(null), [matches, setMatches] = useState<GameSummary[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [fatal, setFatal] = useState(''), [online, setOnline] = useState(false);
  const [bootAttempt, setBootAttempt] = useState(0), [reopen, setReopen] = useState(false);
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading'), [listError, setListError] = useState('');
  const [picker, setPicker] = useState(false), [filter, setFilter] = useState('active');
  const [confirmation, setConfirmation] = useState<'resign' | 'cancel' | null>(null);
  const sessionRef = useRef(session); sessionRef.current = session;
  const matchIdRef = useRef(matchId); matchIdRef.current = matchId;
  const requestBusy = useRef(false), operation = useRef<AbortController | null>(null);
  const listTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), listSequence = useRef(0);
  const listControllers = useRef(new Set<AbortController>());
  const socketRef = useRef<WebSocket | null>(null), readyRef = useRef(false);
  const recoverOpen = useRef<() => void>(() => {});
  const scopeRef = useRef('');
  const [pendingAction, setPendingAction] = useState<{ id: string; token: string; action: { kind: string; version: number; actionId: string; move?: Move } } | null>(null);

  const refreshList = useCallback((token: string) => {
    const sequence = ++listSequence.current;
    clearTimeout(listTimer.current);
    listTimer.current = setTimeout(() => {
      const controller = new AbortController(); listControllers.current.add(controller);
      void api<{ matches: GameSummary[] }>('/matches', token, undefined, { signal: controller.signal }).then(data => {
        if (sessionRef.current?.token !== token || sequence !== listSequence.current) return;
        setMatches(prev => data.matches.map(row => { const known = prev.find(m => m.id === row.id); return known && known.version > row.version ? known : row; }));
        setListState('ready'); setListError('');
      }).catch(e => {
        if (controller.signal.aborted || sessionRef.current?.token !== token || sequence !== listSequence.current) return;
        setListState('error'); setListError(e instanceof Error ? e.message : 'Could not load saved games');
      }).finally(() => listControllers.current.delete(controller));
    }, 60);
  }, []);
  const acceptMatch = useCallback((next: GameSnapshot) => {
    const current = sessionRef.current;
    if (current && isPlayer(next, current.player)) setMatches(prev => prev.map(row => row.id === next.id && next.version >= row.version ? {
      id: next.id, game: next.game, status: next.status, creator: next.creator, opponent: next.opponent,
      turn: next.turn, result: next.result, version: next.version, createdAt: next.createdAt, updatedAt: next.updatedAt, waitingExpiresAt: next.waitingExpiresAt,
      participants: next.participants, mafiaPhase: next.mafiaPhase,
    } : row));
    if (next.id !== matchIdRef.current) return;
    setMatch(prev => !prev || prev.id !== next.id || next.version >= prev.version ? next : prev);
  }, []);
  useEffect(() => {
    const controller = new AbortController(); let tg: NonNullable<Window['Telegram']>['WebApp'] | undefined;
    const theme = () => {
      const root = document.documentElement;
      root.dataset.theme = tg?.initData ? tg.colorScheme : 'dark';
      if (tg?.initData) {
        const colors: Record<string, string | undefined> = { '--bg': tg.themeParams.bg_color, '--surface': tg.themeParams.secondary_bg_color, '--text': tg.themeParams.text_color, '--muted': tg.themeParams.hint_color, '--accent': tg.themeParams.button_color, '--accent-ink': tg.themeParams.button_text_color };
        for (const [key, value] of Object.entries(colors)) if (value) root.style.setProperty(key, value);
      }
    };
    async function boot() {
      try {
        setFatal(''); setReopen(false);
        const cfg = await api<AppConfig>('/config', undefined, undefined, { signal: controller.signal });
        if (controller.signal.aborted) return; setConfig(cfg);
        let scope: string, auth: Session;
        if (cfg.mode === 'demo') {
          let chosen = new URLSearchParams(location.search).get('player');
          if (!chosen) { try { chosen = sessionStorage.getItem('demo-player'); } catch { /* Storage may be disabled. */ } }
          const player = DEMO_PLAYERS.find(name => name === chosen) ?? 'Alice'; scope = `demo:${player}`;
          auth = await restoreSession(scope, controller.signal) || await api<Session>('/auth/demo', undefined, { player }, { signal: controller.signal });
        } else {
          tg = await loadTelegramSDK(controller.signal); theme(); tg.ready(); tg.expand(); tg.onEvent('themeChanged', theme);
          if (!tg.initData) { setReopen(true); throw new Error('Open this app through its Telegram bot to sign in and play.'); }
          scope = launchScope(tg.initData);
          auth = await restoreSession(scope, controller.signal) || await api<Session>('/auth/telegram', undefined, { initData: tg.initData }, { signal: controller.signal });
          const initial = getInitialMatch(); if (initial && !matchIdRef.current) { matchIdRef.current = initial; setMatchId(initial); }
        }
        if (controller.signal.aborted) return;
        scopeRef.current = scope; saveSession(scope, auth); setSession(auth); sessionRef.current = auth; refreshList(auth.token);
        const pending = readStored<{ game: GameType; requestId: string }>(`tablemate-create-${auth.player.id}`);
        if (pending && !matchIdRef.current) {
          try {
            const data = await api<{ match: GameSnapshot }>(`/creations/${pending.requestId}`, auth.token, undefined, { signal: controller.signal });
            if (!controller.signal.aborted && !matchIdRef.current) { writeStored(`tablemate-create-${auth.player.id}`, null); navigate(data.match.id); acceptMatch(data.match); }
          } catch { /* The same creation ID remains available to a manual retry. */ }
        }
      } catch (e) {
        if (!controller.signal.aborted) { setFatal(e instanceof Error ? e.message : 'Could not connect. Please retry.'); if (e instanceof ApiError && e.status === 401) setReopen(true); }
      }
    }
    theme(); void boot();
    return () => { controller.abort(); tg?.offEvent('themeChanged', theme); };
  }, [refreshList, acceptMatch, bootAttempt]);

  useEffect(() => {
    setMatches([]); setListState('loading'); setListError(''); setPendingAction(null);
    return () => {
      operation.current?.abort(); requestBusy.current = false; setBusy(false);
      clearTimeout(listTimer.current); ++listSequence.current;
      for (const controller of listControllers.current) controller.abort();
    };
  }, [session?.token]);
  useEffect(() => {
    if (!session) return;
    let gone = false, ws: WebSocket | undefined, retry: ReturnType<typeof setTimeout> | undefined, heartbeat: ReturnType<typeof setInterval> | undefined, watchdog: ReturnType<typeof setTimeout> | undefined, attempts = 0;
    function connect() {
      if (gone || !navigator.onLine || ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
      ws = socket; socketRef.current = socket; readyRef.current = false;
      setOnline(false);
      let lastPong = Date.now();
      watchdog = setTimeout(() => { if (socket === ws && !readyRef.current) socket.close(4000, 'Connection timed out'); }, 8000);
      socket.onopen = () => { if (!gone && socket === ws) socket.send(JSON.stringify({ type: 'auth', token: session!.token })); };
      socket.onmessage = event => {
        if (gone || socket !== ws) return;
        let data; try { data = JSON.parse(event.data); } catch { socket.close(4000, 'Invalid response'); return; }
        if (data.type === 'ready') {
          clearTimeout(watchdog); clearInterval(heartbeat); readyRef.current = true;
          attempts = 0; setOnline(true); refreshList(session!.token); recoverOpen.current();
          if (matchIdRef.current) socket.send(JSON.stringify({ type: 'subscribe', matchId: matchIdRef.current }));
          lastPong = Date.now();
          heartbeat = setInterval(() => {
            if (socket.readyState !== WebSocket.OPEN) return;
            if (Date.now() - lastPong > 45_000) socket.close();
            else socket.send(JSON.stringify({ type: 'ping' }));
          }, 25_000);
        } else if (data.type === 'pong') lastPong = Date.now();
        else if (data.type === 'match') acceptMatch(data.match);
        else if (data.type === 'list-changed') refreshList(session!.token);
        else if (data.type === 'error') setError(data.error);
      };
      socket.onclose = event => {
        if (gone || socket !== ws) return;
        clearTimeout(watchdog); clearInterval(heartbeat); readyRef.current = false; setOnline(false);
        if (event.code === 1008 && /session|expired/i.test(event.reason)) { forgetSession(); setReopen(true); setFatal('Your session expired. Reopen the app to continue.'); return; }
        if (navigator.onLine) retry = setTimeout(connect, Math.min(500 * 2 ** Math.min(attempts++, 5), 10_000));
      };
    }
    const offline = () => { setOnline(false); clearTimeout(retry); clearTimeout(watchdog); clearInterval(heartbeat); ws?.close(); };
    const online = () => { clearTimeout(retry); connect(); recoverOpen.current(); };
    const visible = () => {
      if (document.visibilityState !== 'visible') return;
      recoverOpen.current();
      if (ws?.readyState === WebSocket.OPEN && readyRef.current) { if (matchIdRef.current) ws.send(JSON.stringify({ type: 'subscribe', matchId: matchIdRef.current })); refreshList(session.token); }
      else connect();
    };
    window.addEventListener('offline', offline); window.addEventListener('online', online); document.addEventListener('visibilitychange', visible);
    connect();
    return () => { gone = true; clearTimeout(retry); clearTimeout(watchdog); clearInterval(heartbeat); ws?.close(); socketRef.current = null; readyRef.current = false; window.removeEventListener('offline', offline); window.removeEventListener('online', online); document.removeEventListener('visibilitychange', visible); };
  }, [session, refreshList, acceptMatch]);

  useEffect(() => {
    if (!session || !matchId) {
      setMatch(null); recoverOpen.current = () => {};
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN && readyRef.current) socket.send(JSON.stringify({ type: 'subscribe', matchId: null }));
      return;
    }
    const controller = new AbortController(); let complete = false, running = false, retry: ReturnType<typeof setTimeout> | undefined;
    setMatch(prev => prev?.id === matchId ? prev : null); setError('');
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN && readyRef.current) socket.send(JSON.stringify({ type: 'subscribe', matchId }));
    async function open(attempt = 0) {
      if (complete || running || controller.signal.aborted) return;
      running = true; clearTimeout(retry);
      try {
        const data = await api<{ match: GameSnapshot }>(`/matches/${encodeURIComponent(matchId!)}/open`, session!.token, {}, { signal: controller.signal });
        if (!controller.signal.aborted) { complete = true; acceptMatch(data.match); setError(''); }
      } catch (e) {
        if (!controller.signal.aborted) {
          if (isTransient(e) && attempt < 1) {
            if (e instanceof ApiError) retry = setTimeout(() => void open(attempt + 1), 500);
            else { running = false; await open(attempt + 1); }
          } else {
            setError(e instanceof Error ? e.message : 'Could not open game');
            if (!isTransient(e)) complete = true;
          }
        }
      } finally { running = false; }
    }
    recoverOpen.current = () => { if (!complete) void open(); }; void open();
    return () => { controller.abort(); clearTimeout(retry); recoverOpen.current = () => {}; };
  }, [session, matchId, acceptMatch]);
  useModal(picker || Boolean(confirmation), picker ? '.picker-dialog' : '.confirm-dialog', () => { setPicker(false); setConfirmation(null); });
  useEffect(() => {
    if (match && confirmation && match.status !== (confirmation === 'cancel' ? 'waiting' : 'active')) setConfirmation(null);
  }, [match?.status, confirmation]);
  useEffect(() => { const pop = () => { setMatchId(new URLSearchParams(location.search).get('match')); setError(''); }; window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop); }, []);
  useEffect(() => {
    const back = () => navigate(null), button = window.Telegram?.WebApp.BackButton;
    if (matchId) button?.show(); else button?.hide();
    button?.onClick(back); return () => button?.offClick(back);
  }, [matchId]);
  function navigate(id: string | null) {
    const url = new URL(location.href); url.searchParams.delete('tgWebAppStartParam');
    if (id) url.searchParams.set('match', id); else url.searchParams.delete('match');
    history.pushState({}, '', url); matchIdRef.current = id; setMatchId(id); setMatch(null); setError(''); setConfirmation(null);
  }
  async function choose(game: GameType) {
    if (!session || requestBusy.current) return;
    const key = `tablemate-create-${session.player.id}`;
    const pending = readStored<{ game: GameType; requestId: string }>(key);
    if (pending && pending.game !== game) { setError(`Retry ${gameNames[pending.game]} to resolve the previous creation before starting another game.`); return; }
    const intent = pending || { game, requestId: crypto.randomUUID() };
    writeStored(key, intent);
    const controller = new AbortController(); operation.current = controller;
    requestBusy.current = true; setBusy(true); setError('');
    try {
      let data: { match: GameSnapshot };
      try { data = await retryOperation('/matches', session.token, intent, controller.signal); }
      catch (e) {
        if (!isTransient(e) || controller.signal.aborted) { if (!controller.signal.aborted) writeStored(key, null); throw e; }
        // Even if every POST response was lost, the durable ledger resolves the commit.
        try { data = await api(`/creations/${intent.requestId}`, session.token, undefined, { signal: controller.signal }); }
        catch { refreshList(session.token); throw e; }
      }
      if (controller.signal.aborted) return;
      writeStored(key, null); setPicker(false); navigate(data.match.id); acceptMatch(data.match); refreshList(session.token);
      window.Telegram?.WebApp.HapticFeedback?.impactOccurred('light');
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Could not start the game'); }
    finally { if (operation.current === controller) { requestBusy.current = false; setBusy(false); operation.current = null; } }
  }
  async function sendAction(intent: NonNullable<typeof pendingAction>) {
    if (requestBusy.current || sessionRef.current?.token !== intent.token) return;
    const controller = new AbortController(); operation.current = controller;
    requestBusy.current = true; setBusy(true); setError('');
    try {
      const data = await retryOperation<{ match: GameSnapshot }>(`/matches/${intent.id}/actions`, intent.token, intent.action, controller.signal);
      if (!controller.signal.aborted) { acceptMatch(data.match); setPendingAction(null); setConfirmation(null); if (!readyRef.current || intent.action.kind === 'leave') refreshList(intent.token); if (intent.action.kind === 'leave') navigate(null); window.Telegram?.WebApp.HapticFeedback?.impactOccurred('light'); }
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(e instanceof Error ? e.message : 'Could not save the move');
        if (!isTransient(e)) setPendingAction(null);
        try { const data = await api<{ match: GameSnapshot }>(`/matches/${intent.id}`, intent.token, undefined, { signal: controller.signal }); acceptMatch(data.match); } catch { /* Offer retry with the original action ID. */ }
      }
    } finally { if (operation.current === controller) { requestBusy.current = false; setBusy(false); operation.current = null; } }
  }
  async function act(kind: 'join' | 'start' | 'leave' | 'move' | 'resign' | 'cancel' | 'offer-draw' | 'accept-draw' | 'decline-draw', move?: Move) {
    if (!session || !match || requestBusy.current || pendingAction) return;
    const intent = { id: match.id, token: session.token, action: { kind, version: match.version, actionId: crypto.randomUUID(), ...(move ? { move } : {}) } };
    setPendingAction(intent); await sendAction(intent);
  }
  async function switchPlayer(chosen?: string) {
    if (!session || busy) return;
    setBusy(true);
    try {
      const player = chosen ?? (session.player.name === 'Alice' ? 'Bob' : 'Alice');
      const auth = await api<Session>('/auth/demo', undefined, { player }); try { sessionStorage.setItem('demo-player', player); } catch { /* Keep the current in-memory identity. */ }
      const url = new URL(location.href); url.searchParams.delete('player'); history.replaceState({}, '', url);
      setMatch(null); setMatches([]); setPendingAction(null); setConfirmation(null);
      scopeRef.current = `demo:${player}`; saveSession(scopeRef.current, auth); setSession(auth); sessionRef.current = auth; setError(''); refreshList(auth.token);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not switch player'); }
    finally { setBusy(false); }
  }
  if (fatal) return <div className="boot-screen"><h1>Unable to open game</h1><p>{fatal}</p><button className="primary" onClick={() => { if (reopen && config?.mode === 'telegram') location.href = `https://t.me/${config.botUsername}?startapp${matchId ? `=${encodeURIComponent(matchId)}` : ''}`; else { setFatal(''); setBootAttempt(v => v + 1); } }}>{reopen && config?.mode === 'telegram' ? 'Reopen from Telegram' : 'Try again'}</button></div>;
  if (!session || !config) return <div className="boot-screen"><span className="loading-ring" /><p>Loading…</p></div>;

  const seat = match ? seatFor(match, session.player) : null;
  const yourTurn = Boolean(match && match.status === 'active' && seat === match.turn);
  const turnPlayer = match?.turn === 'first' ? match.creator : match?.opponent;
  const filtered = matches.filter(m => filter === 'active' ? m.status === 'active' || m.status === 'waiting' : m.status === 'finished' || m.status === 'cancelled');
  const bottomSeat: Seat = seat === 'second' ? 'second' : 'first';
  const topSeat: Seat = bottomSeat === 'first' ? 'second' : 'first';
  const bottomPlayer = match ? bottomSeat === 'first' ? match.creator : match.opponent : null;
  const topPlayer = match ? topSeat === 'first' ? match.creator : match.opponent : null;
  const status = !match ? '' : match.status === 'waiting' ? 'Waiting for player' : match.status === 'cancelled' ? match.result ? 'Game disbanded' : 'Game cancelled' : match.status === 'finished' ? gameResultLabel(match) : yourTurn ? 'Your turn' : `${turnPlayer?.name}’s turn`;
  return <div className="app-shell">
    <header className="header"><div className="header-title">{matchId ? <><button className="back-button" onClick={() => navigate(null)} aria-label="Back to games">←</button><h1>{match ? gameNames[match.game] : 'Game'}</h1></> : <span className="brand">Tablemate</span>}</div><span className={`connection ${online ? 'connected' : ''}`} aria-label={online ? 'Connected' : 'Reconnecting'}><i />{!online && 'Reconnecting'}</span></header>
    {config.mode === 'demo' && <div className="demo-bar"><span>{session.player.name} · Demo</span>{match?.game === 'mafia' ? <select aria-label="Demo player" value={session.player.name} disabled={busy} onChange={event => void switchPlayer(event.target.value)}>{DEMO_PLAYERS.map(name => <option key={name}>{name}</option>)}</select> : <button onClick={() => void switchPlayer()} disabled={busy}>Switch to {session.player.name === 'Alice' ? 'Bob' : 'Alice'}</button>}</div>}
    <main>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
      {pendingAction && !busy && <div className="error-banner" role="alert"><span>Confirm the last action before playing again.</span><button className="secondary" onClick={() => void sendAction(pendingAction)}>Retry saved action</button></div>}
      {!matchId ? <>
        <section className="games-section"><h1>Play</h1><GameCards choose={g => void choose(g)} busy={busy} /></section>
        <section className="saved-games"><div className="section-heading"><h2>Your games</h2><div className="filters" role="tablist" aria-label="Filter games">{[['active', 'Playing'], ['finished', 'Finished']].map(([id, label]) => <button role="tab" aria-selected={filter === id} className={filter === id ? 'selected-tab' : ''} key={id} onClick={() => setFilter(id)}>{label}</button>)}</div></div>
          {listState === 'loading' && <p role="status">Loading saved games…</p>}
          {listState === 'error' && <div className="error-banner" role="alert"><span>Could not load saved games. {listError} {matches.length > 0 && 'Showing previously loaded games.'}</span><button className="secondary" onClick={() => refreshList(session.token)}>Retry saved games</button></div>}
          {(listState === 'ready' || matches.length > 0) && (filtered.length ? <div className="match-list">{filtered.map(m => <button key={m.id} className="match-row" onClick={() => navigate(m.id)}><span className={`match-icon ${m.game}`} aria-hidden="true">{icons[m.game]}</span><span className="match-row-copy"><strong>{gameNames[m.game]}</strong><span>{m.game === 'mafia' ? `${m.participants?.length ?? 0} players · Hosted by ${m.creator.name}` : m.opponent ? `${m.creator.name} vs ${m.opponent.name}` : m.creator.name}</span></span><span className={`status-pill status-${m.status}`}>{m.status === 'waiting' ? m.game === 'mafia' ? 'Lobby' : 'Waiting' : m.status === 'active' ? m.game === 'mafia' ? m.mafiaPhase === 'night' ? 'Night' : 'Day' : m.turn === seatFor(m, session.player) ? 'Your turn' : 'Their turn' : m.status === 'cancelled' ? m.result ? 'Disbanded' : 'Cancelled' : gameResultLabel(m)}</span></button>)}</div> : <p className="empty-list">No {filter === 'active' ? 'active' : 'finished'} games.</p>)}
        </section>
      </> : !match ? <div className="match-loading">{!error && <p>Loading board…</p>}</div> : match.game === 'mafia' ? <MafiaGame match={match} player={session.player} enabled={online && !busy && !pendingAction} inviteUrl={config.mode === 'telegram' ? `https://t.me/${config.botUsername}?startapp=${match.id}` : `${location.origin}/?match=${match.id}`} act={kind => void act(kind)} play={move => void act('move', move)} cancel={() => setConfirmation('cancel')} quit={() => setConfirmation('resign')} newGame={() => setPicker(true)} /> : <div className="play-layout">
        <div className={`turn-status ${yourTurn ? 'your-turn' : ''}`} role="status"><span className="status-dot" /><h2>{status}</h2>{!seat && match.status !== 'waiting' && <span className="spectator-label">Watching</span>}{match.status === 'waiting' && match.waitingExpiresAt && <WaitingCountdown expiresAt={match.waitingExpiresAt} />}{match.result && <p>{match.result.reason}</p>}</div>
        <section className="board-panel" aria-label="Game"><div className={`board-player ${match.status === 'active' && match.turn === topSeat ? 'current-player' : ''}`}><div className="player-identity"><span className={`player-avatar ${topSeat}`}>{topPlayer?.name.slice(0, 1) || '·'}</span><strong>{topPlayer?.name || 'Waiting…'}</strong></div><span className="player-color">{playerColor(match.game, topSeat)}</span></div>
          <Board match={match} seat={seat} enabled={yourTurn && online && !busy && !pendingAction} play={move => void act('move', move)} />
          <div className={`board-player bottom-player ${match.status === 'active' && match.turn === bottomSeat ? 'current-player' : ''}`}><div className="player-identity"><span className={`player-avatar ${bottomSeat}`}>{bottomPlayer?.name.slice(0, 1)}</span><strong>{bottomPlayer?.name}</strong>{seat && <span className="you-label">You</span>}</div><span className="player-color">{playerColor(match.game, bottomSeat)}</span></div>
        </section>
        <aside className="game-sidebar">
          {match.status === 'active' && match.drawOffer && <div className="draw-offer">{match.drawOffer === seat ? <p>Draw offered</p> : seat ? <><p>Opponent offered a draw</p><div><button className="primary" disabled={busy || Boolean(pendingAction) || !online} onClick={() => void act('accept-draw')}>Accept</button><button className="secondary" disabled={busy || Boolean(pendingAction) || !online} onClick={() => void act('decline-draw')}>Decline</button></div></> : <p>Draw offered</p>}</div>}
          <div className="game-actions">
            {match.status === 'active' && seat && <>{match.game !== 'tictactoe' && <button className="secondary" disabled={busy || Boolean(pendingAction) || !online || Boolean(match.drawOffer)} onClick={() => void act('offer-draw')}>Offer draw</button>}<button className="text-button danger" disabled={busy || Boolean(pendingAction) || !online} onClick={() => setConfirmation('resign')}>Resign</button></>}
            {match.status === 'waiting' && seat === 'first' && <button className="secondary cancel-game" disabled={busy || Boolean(pendingAction) || !online} onClick={() => setConfirmation('cancel')}>Cancel game</button>}
            {(match.status === 'finished' || match.status === 'cancelled') && <button className="primary" onClick={() => setPicker(true)}>New game</button>}
          </div>
          {match.history.length > 0 && <details className="move-history"><summary>Moves <span>{match.history.length}</span></summary><ol>{match.history.map(h => <li key={h.number}><span>{h.number}</span><b>{h.label}</b><small>{h.seat === 'first' ? match.creator.name : match.opponent?.name}</small></li>)}</ol></details>}
        </aside>
      </div>}
    </main>
    {picker && <div className="modal-backdrop" onClick={() => setPicker(false)}><section className="picker-dialog" role="dialog" aria-modal="true" aria-label="Choose a game" onClick={e => e.stopPropagation()}><button className="modal-close" aria-label="Close game chooser" onClick={() => setPicker(false)}>×</button><h2>New game</h2><GameCards choose={g => void choose(g)} busy={busy} /></section></div>}
    {confirmation && <div className="modal-backdrop"><section className="confirm-dialog" role="dialog" aria-modal="true" aria-label={confirmation === 'resign' ? 'Confirm resignation' : 'Confirm cancellation'}><h2>{confirmation === 'resign' ? match?.game === 'mafia' ? 'Leave game?' : 'Resign?' : 'Cancel game?'}</h2>{confirmation === 'resign' && <p>{match?.game === 'mafia' ? 'Your role is revealed and the remaining players continue.' : 'Your opponent wins.'}</p>}<div><button className="secondary" onClick={() => setConfirmation(null)}>Keep playing</button><button className="primary" disabled={busy || Boolean(pendingAction) || !online} onClick={() => void act(confirmation)}>{confirmation === 'resign' ? match?.game === 'mafia' ? 'Leave game' : 'Resign' : 'Cancel game'}</button></div></section></div>}
  </div>;
}

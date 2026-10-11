# Tablemate · Telegram games

Play **chess, English/American checkers, and tic-tac-toe** with a friend from a Telegram chat. Run a command in chat and open the board inside Telegram. The second player joins automatically. Every accepted move is saved; games are untimed and survive closing the app or restarting the server.

## Try it locally

Requires Node.js **22.12+** and npm. No bot token is needed for the local demo.

```bash
npm ci
cp .env.example .env
npm run dev
```

Open **http://localhost:5173**. The demo signs you in as Alice.

1. Choose a game. Its board opens immediately.
2. Copy the browser address into another tab and click **Switch to Bob** there. Bob joins automatically.
3. Play Alice’s moves in the first tab and Bob’s in the second.
4. Close and reopen a tab, or visit **Your games**, to resume. The board link always opens the same match.

Demo identities are limited to Alice and Bob and are available only in demo mode. Production refuses to start in demo mode. The demo listens only on the loopback interface. Sessions are independent per tab; switching players does not affect your other tab.

## Connect a Telegram bot

1. In Telegram, open [@BotFather](https://t.me/BotFather), use `/newbot`, and retain the token privately. Record the bot username without `@`.
2. Use `/setinline` and choose your bot. Set its placeholder to `Choose chess, checkers, or tic-tac-toe`.
3. Use `/setinlinefeedback` and choose **100%**. This lets Tablemate update sent game messages when a game starts or ends. Games still work if feedback arrives late.
4. Under `/mybots` → your bot → **Bot Settings** → **Configure Mini App**, configure the **Main Mini App** with your public HTTPS URL. The exact labels can vary by Telegram client. This is required for `https://t.me/<botusername>?startapp=<match-id>` board links.
5. Allow the bot to join groups. Group privacy mode can remain enabled: `/play@your_bot_username` works without access to ordinary chat messages. The bot needs permission to send messages, rather than administrator rights.
6. Configure the environment and run the app as described below. At startup it registers `/play` and `/help` and sets the bot’s **My games** menu button.

People can now:

- Type `@your_bot_username` in **any private chat or group**, choose a game, and send its Play button. The bot does not need to be a group member for this flow.
- Add the bot to a group and use `/play`, `/play chess`, `/play checkers`, or `/play tictactoe`.
- Use `/play` in their private conversation with the bot, then forward its game message to a friend.
- Open the board to play. The first distinct person to open it joins the second seat automatically. The creator plays White in chess, Red in checkers, and X in tic-tac-toe. Other visitors spectate.

Board links are access links: anyone opening one takes the empty opponent seat or watches if both players are already seated. They are not restricted to a particular chat. Direct-link Mini Apps cannot read ordinary chat messages.

Telegram references: [inline mode](https://core.telegram.org/bots/inline), [Main Mini Apps](https://core.telegram.org/bots/webapps#launching-the-main-mini-app), [direct links](https://core.telegram.org/bots/webapps#direct-link-mini-apps), and [signed launch-data validation](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).

## Host it with HTTPS

The included Docker Compose configuration runs one Node service with a persistent SQLite volume and Caddy for HTTPS. Use a Linux server with Docker Compose installed and a domain whose DNS points to that server. Open TCP ports 80 and 443; do not expose port 3001 publicly.

Set these values in `.env` on the server (replace all placeholders):

```dotenv
APP_DOMAIN=games.example.com
BOT_USERNAME=your_bot_username
BOT_TOKEN=your_private_bot_token
SESSION_SECRET=a_random_secret_at_least_32_characters_long
```

Generate a session secret with:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Deploy:

```bash
docker compose up -d --build
docker compose logs -f app
```

Set the Main Mini App URL in BotFather to `https://games.example.com`. Caddy automatically obtains and renews the TLS certificate, and proxies HTTP and WebSocket traffic to the app. Configure only **one** running bot instance per token: polling and SQLite are designed for one service instance.

For development against a real Telegram bot, expose the Vite frontend through your preferred HTTPS tunnel and set `APP_MODE=telegram`, `PUBLIC_URL` to that HTTPS URL, and the bot credentials. The frontend proxies `/api` and `/ws` to the backend. Configure the same URL in BotFather. Use only one active polling instance and disable any previously configured webhook before starting polling.

To run without Docker behind an existing HTTPS reverse proxy:

```bash
npm run build
APP_MODE=telegram NODE_ENV=production npm start
```

Supply `BOT_TOKEN`, `BOT_USERNAME`, `PUBLIC_URL`, `SESSION_SECRET`, and a persistent `DB_PATH` through the environment or `.env`. The backend serves the compiled frontend and `/api` and `/ws` on port 3001. Proxy all three from the same public origin; permit WebSocket upgrades. A process manager should restart the service on failure.

### Render Free deployment

The included `render.yaml` creates a free Docker web service with HTTPS and the
`/api/health` health check. Create a Blueprint from this repository in Render and
enter `BOT_TOKEN` and `BOT_USERNAME` when prompted. Render generates the session
secret. The app uses Render's `RENDER_EXTERNAL_URL` automatically when `PUBLIC_URL`
is unset; set `PUBLIC_URL` only if using a custom domain.

This is temporary preview hosting: Render Free sleeps after 15 minutes without
incoming traffic, and its local SQLite database is lost on restarts, redeploys,
and sleep. Saved games and old board links can stop working. Telegram polling
does not wake a sleeping service, so open the app URL to wake it before using bot
commands. See [Render's free-service limits](https://render.com/docs/free).

Before starting the Render service, stop any other running instance using the
same bot token. Keep automatic deploys disabled: overlapping instances during a
deploy conflict with Telegram polling. Stop the old polling instance before
starting a replacement during updates.
Set the Main Mini App URL in BotFather to the service's `https://…onrender.com`
address. No Caddy service or purchased domain is needed on Render.

### Storage and operation

- `/api/health` checks database availability. Docker uses it for its health check.
- SQLite stores player names/IDs, game states, full move history, action IDs, and game-message references. The bot token stays on the server.
- Keep the `games` volume across deployments. `docker compose down` preserves it; `docker compose down -v` deletes saved games.
- For a consistent offline backup, stop the app, copy the database together with any `-wal`/`-shm` files from the volume, then start the app. Restore only while the app is stopped.
- Numbered, additive database migrations run at startup. The current schema is version 3. Version-1 databases upgrade without changing saved game states. Migration 2 adds creation/retry ledgers; migration 3 indexes the creation ledger's match reference for draft cleanup.
- Unsent inline-query drafts expire after 24 hours. Published games and active games do not expire. **Your games** shows the most recent 100 matches.
- Telegram message edits use persistent due times and exponential backoff independently of gameplay. Flood-control cooldowns survive restart; shutdown drains outstanding edits before closing SQLite. Deleted or inaccessible game messages do not delete matches.
- Launch-data signatures expire after ten minutes for new authentication; signed app sessions last 24 hours. The client restores a server-validated session within the same browser tab and exact Telegram launch (or demo identity), using sessionStorage. New launches authenticate afresh. Reopen the Mini App from Telegram if authentication or the app session expires.
- HTTP requests have an eight-second deadline; game creation and actions retry once within twelve seconds with the same operation ID. Ambiguous actions offer an explicit retry. Pending creation IDs persist in the tab across reload and reconcile through the creation ledger. The SDK loads only in Telegram mode, with an eight-second deadline and recovery; demo startup is independent of it.
- Health checks bypass request quotas. Gameplay/session/creation lookup requests share a 300/minute player bucket. Anonymous authentication uses a separate 60/minute IP bucket; public config uses 300/minute per IP. Only configured private/loopback proxy addresses can supply forwarded client IPs. Validate the deployed proxy path separately.

## Game rules

- **Chess:** standard legal moves, castling, en passant, selectable promotion, checkmate, stalemate, insufficient material, repetition, and the fifty-move rule, using [chess.js](https://jhlywa.github.io/chess.js/). Full move history is retained and reconstructed when applying a move or evaluating repetition/fifty-move outcomes; lobby summaries and board legal-move reads do not replay it. For casual play, eligible repetition and fifty-move draws end automatically rather than requiring a tournament claim.
- **Checkers:** 8×8 English/American rules. Men move and capture forward. Kings move one square and capture in either direction. Captures and complete multi-jumps are mandatory, but the player may choose any capture chain. Crowning ends the turn. No legal moves means a loss. Threefold repetition or 40 moves by **each** player with no capture or movement of an uncrowned piece ends automatically in a draw. Based on [WCDF rules](https://wcdf.net/rules/rules_of_checkers_english.pdf).
- **Tic-tac-toe:** 3×3, X starts, three in a row wins, and a full board without a winner is a draw.
- Players can resign. Chess/checkers also allow agreed draws. A waiting game can be cancelled by its creator. Closing the app does not resign or cancel a match.

## Development and checks

```bash
npm run typecheck
npm test
npm run build
npm run test:browser
```

Install Playwright’s browser with `npx playwright install chromium` before running browser tests. Alternatively, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to an existing Chromium/Chrome binary (for example `/usr/bin/google-chrome`). Browser tests run an isolated demo on ports **3101/5174** using `data/e2e.sqlite`. Ports 3001/5173 are for ordinary development. Browser screenshots and failure traces are saved under `test-results/`.

Structure:

- `shared/`: typed snapshots, moves, and engine contracts.
- `server/`: rules, SQLite persistence, authenticated HTTP/WebSocket API, and Telegram bot.
- `client/`: compact game picker, saved games, and interactive boards.
- `e2e/`: two-browser multiplayer, reconnect, and layout checks.

### API contract

All match endpoints require `Authorization: Bearer <session-token>`.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/config` | Public app mode and bot username |
| `GET /api/health` | Service/database health |
| `POST /api/auth/telegram` | Exchange signed `{ initData }` for `{ token, player }` |
| `POST /api/auth/demo` | Local-only `{ player: "Alice" \| "Bob" }` authentication |
| `GET /api/session` | Validate a token and return its current player |
| `GET /api/matches` | Your recent lightweight `GameSummary` rows (no board, history, or legal moves) |
| `POST /api/matches` | Create `{ game, requestId }`; UUID request IDs deduplicate creation per player |
| `GET /api/creations/:requestId` | Recover the committed snapshot for your creation request |
| `GET /api/matches/:id` | Fetch a saved snapshot |
| `POST /api/matches/:id/open` | Publish a game, automatically take an empty opponent seat, and return its snapshot |
| `POST /api/matches/:id/actions` | Join, move, resign, cancel, or offer/accept/decline a draw |

The current client always sends a creation `requestId` and reuses it after ambiguous failures. Omitting it remains supported for older clients, which cannot recover lost creation responses idempotently. Changing the game with an existing request ID returns **409**.

Actions contain `{ actionId, version, kind, move? }`. `actionId` is unique per attempted action and must be reused for retries. `version` is the version of the snapshot the action was based on. A stale action returns **409**; the client reloads the latest snapshot. Repeating an already committed action returns the latest match without committing it again.

Move formats are `{ kind: "chess", from, to, promotion? }`, `{ kind: "checkers", path: [squareIndex, ...] }` (a complete capture sequence), and `{ kind: "tictactoe", cell }`. Checkers indices run 0–63 from the top-left of the canonical board; tic-tac-toe cells run 0–8 in row-major order.

WebSocket `/ws` requires `{ type: "auth", token }` as its first message. After `ready`, send `{ type: "subscribe", matchId }`; use `matchId: null` to unsubscribe in the lobby. Board navigation reuses the authenticated socket. The server sends `{ type: "match", match }` for the initial/current state and accepted changes, and `list-changed` when one of your games changes. Reconnect and subscribe again to get the saved position. Tokens are never placed in WebSocket URLs.

## Live Telegram smoke test

After connecting a bot and HTTPS hosting:

1. Send an inline game in a human-to-human private chat. Open it from two Telegram accounts and play a turn each; the second account joins automatically.
2. Repeat in a group without adding the bot, then add it and test `/play@your_bot_username` and a game selector button.
3. Test all three games, promotion, a mandatory checkers capture, resignation, and a draw offer.
4. Close/reopen both clients, interrupt one client’s connection, and restart the backend. Confirm the saved position returns.
5. Check Android/iOS and desktop layouts, Telegram light/dark themes, and a third account’s read-only spectator view.
6. Confirm game messages change when the match starts/ends and that removed bot permissions do not interrupt an existing board.

Public deployment and a real-account smoke test require your bot credentials and HTTPS host. Those credentials are not included in this project. This release has no computer opponents, clocks, ranking, payments, or matchmaking.

The UI opens directly to the board from chat. It has no invitation screen, sharing form, or Join button. Game controls sit below the board on phones; move history is collapsed until requested. Selecting a game from the bot’s keyboard replaces that selector with the Play button.

Chess pieces slide to their destination after the server confirms a move. Captures fade out; castling moves the king and rook together; a promoted pawn changes into the chosen piece when it lands. The source and destination squares stay highlighted. Opening a saved board or catching up on multiple moves shows the current position immediately. System reduced-motion settings disable travel and capture animations.

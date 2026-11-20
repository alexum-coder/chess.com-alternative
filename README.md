# Zugzwang — free online chess

A responsive real-time chess site built with Node.js, Express, Socket.IO, chess.js and optional Supabase accounts. The refreshed interface uses a clean green-and-cream board, dark navigation, player cards, clocks and a compact side panel, while keeping Zugzwang branding.

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000 in two browser windows, choose the same time control and play. Guest matchmaking works without Supabase.

## Enable accounts and social features

1. Create a Supabase project.
2. In **SQL Editor**, run the complete `schema.sql` file. Re-run it when upgrading an existing installation; it adds the `game_state` checkpoint column and the atomic `finalize_chess_game` database function used by crash recovery.
3. Copy `.env.example` to `.env` and fill in the project URL, anon key and service-role key from **Project Settings → API**.
4. Set `ADMIN_USER_IDS` to a comma-separated list of Supabase Auth user UUIDs that should have moderator access. Leave it blank to disable moderator UI/API access.
5. Restart the Node server. Keep `SUPABASE_SERVICE_KEY` server-side and out of source control.

Email confirmation can be disabled temporarily in Supabase **Authentication → Providers → Email** while testing. Re-enable it before opening registrations publicly.

## Stockfish engine review

Engine-based integrity review runs after an authenticated game finishes. Install a native Stockfish executable from the [official Stockfish download page](https://stockfishchess.org/download/), then set `STOCKFISH_PATH` in `.env` to the executable (or leave it as `stockfish` when it is on `PATH`). Stockfish is not bundled in this source archive.

The server speaks UCI to Stockfish, samples up to the first 60 plies by default, and records the engine's best move and centipawn-loss evidence. Defaults are depth 11, minimum 12 analyzed moves per player, at least 90% best-move agreement and average centipawn loss at or below 18. Tune those values with the `STOCKFISH_*` settings in `.env`.

A match meeting the configured thresholds creates a `stockfish_concordance` item in the moderator integrity queue, with per-move samples. **This is a review signal, not proof of cheating.** It does not auto-ban, auto-forfeit or publicly label a player. Moderators must review the game context; legitimate opening preparation, forced positions and short games can affect engine agreement.

## Tournament recovery

Active tournament matches persist their move list, FEN, players, time controls, remaining clocks, draw state and timing signals to `tournament_matches.game_state`. Checkpoints are written after each move, every five seconds for clocks, and when a result is finalized. The game result and both profile rating updates are committed in one idempotent database transaction keyed by the game ID. This prevents a server restart between result saving and bracket advancement from applying the same rating change twice.

After a restart, active tournament positions and bracket rounds are rebuilt from Supabase. New-round pairings are inserted together, so bootstrap can recover a round even if the process stops while launching its games. The game clock pauses during downtime; a recovered match resumes only when both players reconnect. Drawn matches and not-yet-started pairings remain pending until both assigned players reconnect. If a very old in-progress match has no saved `game_state` checkpoint, it cannot be reconstructed and the tournament is left paused for manual intervention. Run the current `schema.sql` before starting new tournaments.

## Rating placement

New authenticated accounts receive a provisional Glicko-2 rating internally, but the numeric rating and rating deviation are hidden from the profile API, player cards, friends list and leaderboard until five completed matches. The server updates Glicko-2 after each game; after match five the established rating becomes visible. Guest players do not receive a public rating.

## Shared navigation and chessboard

All pages use the same responsive navigation injected by `nav.js`. Online matches, computer games and puzzles share the same `ZugzwangBoard` renderer in `board.js` and the same board skin in `board.css`, including the same SVG pieces, square palette, coordinates, selection, legal-move dots, last-move and check highlights. The online match page keeps its game-specific clocks, premoves, promotion picker and result overlay around that shared board.

## Included features

- Server-validated chess rules and clocks, matchmaking, reconnects, resignation, draw offers, premoves, promotions, move sounds and PGN history.
- Glicko-2 rating, rating deviation and volatility.
- Live in-game chat, friend requests and single-elimination tournaments.
- Tournament brackets, byes, drawn-match replays and server-restart recovery.
- Reports, moderator review, warnings, mutes, bans and Stockfish-based review flags.

## Tests

```bash
npm test
npm run check
```

The tests include Glicko-2 reference cases, the five-game rating placement rule, Stockfish UCI protocol handling (using a lightweight mock engine), engine review thresholds and tournament checkpoint restoration. The mock tests do not replace installing and testing a real Stockfish executable on the deployment host.

The piece set in `pieces/` is CC0 (see `pieces/LICENSE.txt`).

## Browser Stockfish: play vs computer and analysis

The `/computer.html` page runs Stockfish.js 19 in a same-origin Web Worker using the single-threaded lite WASM build. The engine files are hosted in a **public Supabase Storage bucket** so Render does not need to serve the WASM file. The bucket contains only public client-side engine assets; never upload `.env`, the native anti-cheat executable, or any Supabase secret key to it.

1. Install dependencies locally with `npm install`.
2. Put `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in your local `.env`. The existing backend also uses the service key server-side; never place it in browser code or commit it to Git.
3. Set `STOCKFISH_STORAGE_BUCKET=stockfish` in `.env` or keep the default.
4. Run `npm run upload:stockfish`. The script creates the public bucket if it does not exist, uses the package's documented `findEngine('lite-single')` resolver to locate the actual JS file (the npm package may store it below its root), then uploads that JS file and its matching WASM file with the correct content types and long-lived cache headers. If the bucket already exists but is private, the script attempts to make it public.
5. Set `STOCKFISH_STORAGE_BUCKET=stockfish` in your Render environment variables and redeploy. `SUPABASE_URL` must already be set on Render.

The web page creates `/stockfish-worker.js` on the Zugzwang origin. That bootstrap imports the JS loader from the public Storage URL and uses Emscripten's `locateFile` hook to fetch the matching WASM object directly from Storage. This avoids trying to construct a Worker directly from a cross-origin URL. The Storage object responses must be publicly readable and permit cross-origin requests from your website. If you use a restrictive Content-Security-Policy, allow `https://YOUR-PROJECT.supabase.co` in `script-src`/`connect-src` as applicable.

No browser engine computation is sent to the server. Server-side anti-cheat analysis uses a separate native Stockfish executable. You can keep it at `STOCKFISH_PATH`, or upload a **Linux ELF** executable to a private bucket: run `npm run upload:stockfish-native -- ./path/to/linux/stockfish`. The script gzip-compresses it and splits the gzip byte stream into Storage objects no larger than `STOCKFISH_NATIVE_PART_SIZE_MB` (45 MiB by default, below Supabase Free's 50 MB per-file cap). It uploads objects such as `stockfish-linux-x64.gz.part-001` and `.part-002`. After the script prints `STOCKFISH_NATIVE_OBJECTS`, set that comma-separated value and `STOCKFISH_NATIVE_BUCKET=stockfish-native` in Render only (leave these unset in local Windows `.env` files). At startup the server downloads each private object in order, reconstructs the original gzip stream, decompresses the executable into its temporary directory, sets executable permissions, and validates its UCI handshake. The prior single-object `STOCKFISH_NATIVE_OBJECT` variable remains supported for backwards compatibility. Never use the Windows `.exe` on Render, which runs Linux, and never make the native-engine bucket public.

Supabase Free projects currently have a 50 MB maximum per uploaded file. The native uploader uses 45 MiB parts by default to leave room below that per-object cap. Pro and higher plans can configure larger limits if desired. (See [Supabase upload limits](https://supabase.com/docs/guides/storage/uploads/file-limits).) Stockfish.js is GPL-3.0; retain its license and source notices with distributions that include it. The page provides local play, position analysis and move-by-move review with !! Brilliant, ! Great, ★ Excellent, ?! Inaccuracy, ? Mistake and ?? Blunder labels. The labels are heuristic centipawn-loss bands, not official Chess.com classifications.

## Puzzles (Lichess CC0)

Run the `puzzles` table section in `schema.sql`, then download `lichess_db_puzzle.csv.zst` from [Lichess Open Database](https://database.lichess.org/) and import it:

```bash
# Install the zstd command-line utility first
npm install
npm run import:puzzles -- /path/to/lichess_db_puzzle.csv.zst
```

The importer streams the compressed CSV and upserts batches into Supabase; it does not need to decompress the multi-million-row dataset into memory. The `/puzzles.html` trainer picks puzzles by rating band and validates the complete UCI solution line. Lichess publishes the puzzle database under CC0; retain attribution in product documentation as a courtesy and do not imply Lichess endorsement. The puzzle service requires the Supabase service key on the server and the public-read RLS policy from `schema.sql`.

### Engine assets / deployment check

After uploading, open `/api/health` on the deployed site. The response should show `browserStockfish.source: "supabase-storage"` and both `browserStockfish.js` and `browserStockfish.wasm` as `true`. If either is false, check the bucket name, public access, exact object filenames and service-side environment variable. The computer page queues moves made during startup and displays import/WASM errors rather than silently dropping engine requests.

## Fixing Supabase 500s after deploying

If `/api/friends`, `/api/mod/reports`, `/api/mod/integrity`, `/api/puzzles/random`, or tournament creation returns HTTP 500 with a database permission error, run `fix-existing-supabase-permissions.sql` in the Supabase SQL Editor. Supabase checks Postgres grants separately from RLS policies; having an RLS policy alone does not grant table access. The migration grants DML access to `service_role` for existing public-schema application tables and sequences, while keeping social, tournament and moderation routes server-only. It grants public read access only to `games` and `puzzles`, matching their public-read RLS policies.

After the migration succeeds, redeploy/restart the Render service so the server starts with the expected `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`. The key must be the backend service-role/secret key, never the anon/publishable key. Do not expose it in browser config or commit it. The migration query at the bottom prints a per-table permissions check.

Open `/api/health` on the deployed site to verify that both browser Stockfish files are reachable from Supabase Storage. The response should show `browserStockfish.source: "supabase-storage"` and `browserStockfish.js: true`, `browserStockfish.wasm: true`.

The computer page queues a move made while Stockfish is still downloading/initializing, instead of silently dropping the engine request. It also displays worker/Storage/WASM startup errors on the page. The uploaded pair must be `stockfish-19-lite-single.js` and its matching `stockfish-19-lite-single.wasm` from the same `stockfish@19.0.1` package version.
#   c h e s s . c o m - a l t e r n a t i v e  
 #   c h e s s . c o m - a l t e r n a t i v e  
 #   c h e s s . c o m - a l t e r n a t i v e  
 #   c h e s s . c o m - a l t e r n a t i v e  
 #   c h e s s . c o m - a l t e r n a t i v e  
 #   c h e s s . c o m - a l t e r n a t i v e  
 
# AFCON Fan backend

TypeScript REST API for the Flutter client. It uses Fastify and PostgreSQL. The API contract and database cover match centre data, teams and players, competition standings, venues, news, media, host-city events, Ask AFCON, and English-to-Luganda translation sessions.

## Start locally

Requirements: Node.js 22.18+ and Docker Desktop (or PostgreSQL 14+ with `psql`).

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
docker compose up -d db
npm install
npm run dev
```

Compose starts a local PostgreSQL database and applies the initial migration on first startup. The local database uses development-only credentials from the example `.env`; do not reuse them in a deployed environment.

The development command uses Node's built-in TypeScript type stripping and watch mode; it does not need a TypeScript runtime loader. `npm run build` still runs the TypeScript compiler for type checking and production output.

The API listens on `http://localhost:8080` by default. Check `/health` and `/api/v1` to confirm it is running. Public content rows are hidden until `published = TRUE`; populate them from a licensed football data provider or the admin dashboard.

The fan account, follow, notification preference, community, and media endpoints require database migration `002_fan_accounts_community.sql`. Docker applies it automatically when creating a fresh database volume. To update an existing database, run from `backend`:

```powershell
Get-Content .\db\migrations\002_fan_accounts_community.sql | docker compose exec -T db psql -U postgres -d afcon_fan
```

Venue images are optional. The dashboard accepts JPEG, PNG, or WebP uploads up to 8 MiB and stores them under `VENUE_IMAGE_DIR` (default `backend/venue-images`). Keep that directory on persistent storage in deployments. The admin-authenticated `POST /api/v1/admin/venue-images` endpoint accepts `{ "mimeType", "data" }`, where `data` is base64; the API serves uploads at public `/api/v1/venue-images/:filename` URLs which are stored with venue records. Set `PUBLIC_API_BASE_URL` to the canonical externally reachable API origin behind a reverse proxy so uploaded image URLs work in the app.

Player images are optional too. The dashboard accepts JPEG, PNG, or WebP uploads up to 8 MiB, stores them under `PLAYER_IMAGE_DIR` (default `backend/player-images`), and saves the public image URL in the existing `players.photo_url` column. The protected upload route is `POST /api/v1/admin/player-images`; images are served at `/api/v1/player-images/:filename`. Keep the player image directory on persistent storage and configure `PUBLIC_API_BASE_URL` for externally reachable deployments.

Player statistics are entered by selecting named metrics in the dashboard and entering their numeric values. The selected values are stored in the existing `players.stats` JSONB column. Available metrics include appearances, minutes played, goals, assists, cards, shots, dribbles, chances, distance covered, sprints, clean sheets, and saves.

Line-ups are entered as a complete team squad for a match. Create the match, teams, and their player records first, then select the match and participating team in the dashboard, choose a formation, add starters and substitutes, and set each player's position and shirt number. The dashboard previews the formation graphic; the app displays the published starters on a pitch and substitutes below it. The protected `POST /api/v1/admin/lineups/batch` endpoint accepts `{ "matchId", "teamId", "formation", "published", "players": [{ "playerId", "position", "shirtNumber", "isStarting" }] }`. It validates that the team participates in the match and every selected player belongs to that team, permits up to 30 unique squad members and at most 11 starters, and replaces that team's match line-up in one transaction. Public `GET /api/v1/lineups?matchId=...` includes player names and optional photo URLs. No schema migration is required.

The venue image database field requires migration `003_venue_images.sql` on existing databases:

```powershell
Get-Content .\db\migrations\003_venue_images.sql | docker compose exec -T db psql -U postgres -d afcon_fan
```

Team country codes accept either a three-letter ISO code such as `UGA` or an international calling code such as `+256`. Existing databases need migration `004_team_calling_codes.sql` to store calling codes:

```powershell
Get-Content .\db\migrations\004_team_calling_codes.sql | docker compose exec -T db psql -U postgres -d afcon_fan
```

Set `AUTH_TOKEN_SECRET` to a private random value of at least 32 characters, distinct from `ADMIN_API_TOKEN`. For example, generate a value with `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"` and place it in `backend/.env`; never commit it. Fan bearer tokens are HMAC-signed and expire after seven days. Passwords are stored as scrypt hashes. The shared dashboard token remains separate and unchanged.

Community uploads accept bounded base64 JSON: images up to 8 MiB and MP4/WebM/QuickTime videos up to 15 MiB. Files and upload metadata are persisted under `COMMUNITY_MEDIA_DIR` (default `backend/community-media`); use persistent storage in production. Set `PUBLIC_API_BASE_URL` to the canonical externally reachable API origin (for example `https://api.example.com`) behind a reverse proxy so returned absolute media URLs remain valid. `GET /api/v1/community/media/:id` serves these URLs publicly. The client upload route also supports its existing `POST /api/v1/community/uploads` contract.

## Admin dashboard

The React/TypeScript dashboard is in `../dashboard`; the dashboard identified in the Flutter project is `../Afcon_app/dashboard`. Both use the same shared admin token. Set `ADMIN_API_TOKEN` in this backend's `.env` to a private random value of at least 32 characters, and add the dashboard's actual browser origin to `APP_ORIGINS` (the default Vite origin is `http://localhost:5173`). The dashboard uses the hostname in its browser URL for API requests, so when opening it on a phone, use the computer's LAN address for the dashboard and allow that origin (for example, `http://192.168.1.20:5173`) in `APP_ORIGINS`. Start the API, then in another terminal:

```powershell
cd ..\dashboard
Copy-Item .env.example .env
npm install
npm run dev
```

Open the dashboard and enter the value of `ADMIN_API_TOKEN` from `backend/.env`. The browser keeps it in session storage for the active tab. Protected endpoints under `/api/v1/admin` provide overview counts and create/update/delete/list operations for competitions, matches, teams, players, standings, match events and statistics, line-ups, venues, news, fan events and media. Line-ups are saved as a validated match/team batch so squad replacement is transactional. Community posts and comments can be reviewed and moved between pending, published, hidden, and removed states; fan reports can be resolved or dismissed. Both dashboards use this same admin API; the fan app's account tokens are separate. This uses a shared admin token; use individual accounts and role-based permissions before public production deployment.

## Connect Flutter

The Flutter client uses `lib/services/afcon_api.dart`. Android emulator builds default to the host API at `10.0.2.2:8080`; use a Dart define for a physical device or deployed API:

```powershell
flutter run --dart-define=AFCON_API_URL=http://10.0.2.2:8080/api/v1
```

`10.0.2.2` reaches the host machine from the Android emulator. Use the host's LAN address for a physical phone. Keep provider API keys in this backend's `.env`; never bundle them into the Flutter app.

## Ask AFCON setup

Ask AFCON uses DeepSeek's OpenAI-compatible chat completions API. Set `AI_PROVIDER_API_KEY` in `backend/.env`; the defaults are `AI_PROVIDER_BASE_URL=https://api.deepseek.com/v1` and `AI_PROVIDER_MODEL=deepseek-chat`. Restart the backend after changing environment variables. The API only supplies published match, standings, team, player, venue, news, and event records as answer context; it returns source labels with answers and asks the model to say when that content does not support an answer. Questions without a language setting are answered in the language used by the fan.

The assistant requires both a configured database and AI key. It reports an explicit setup/content error when either is unavailable, and a provider error if DeepSeek cannot complete the request. Provider credentials remain server-side. Add rate limiting and usage monitoring before exposing the endpoint publicly.

## API resources

- `GET /api/v1/competitions`, `matches`, `teams`, `players`, `standings`, `venues`
- `GET /api/v1/match-events?matchId=…`, `lineups?matchId=…`, `match-statistics?matchId=…`
- `GET /api/v1/news`, `events`, `media`
- `POST /api/v1/assistant/ask` accepts `{ "question": "…", "language": "en" }`
- `POST /api/v1/translation/sessions` accepts source/target language and audio format; English to Luganda uses `en` → `lg`
- `POST /api/v1/auth/register` accepts `{ "name", "email", "password" }`; `POST /api/v1/auth/login` accepts `{ "email", "password" }`. Both return `{ "data": { "token", "user": { "id", "email", "displayName" } } }`. Use `Authorization: Bearer <token>` for `GET/PATCH /api/v1/auth/me`; PATCH accepts `{ "displayName" }`.
- `GET /api/v1/community/posts` returns published posts and the authenticated caller's pending posts. `POST /api/v1/community/posts` accepts `{ "content", "media": [{ "url", "type" }] }`; new posts are published immediately, and blank text is accepted only when a valid uploaded media item is attached. Feed rows use camelCase `id`, `userId`, `displayName`, `content`, `createdAt`, `status`, `likesCount`, `commentsCount`, `likedByMe`, `media`. `PATCH/DELETE /api/v1/community/posts/:id` are owner-only; edits to pending or published posts publish immediately, and `PUT/DELETE /api/v1/community/posts/:id/like` persist likes.
- `POST /api/v1/community/uploads` accepts `{ "filename", "mimeType", "data" }` (`data` is base64) and returns `{ "data": { "id", "url", "type" } }`. The returned URL can be included in the post's `media` array. `GET /api/v1/community/posts/:id/comments` exposes published comments and the caller's own pending comments on visible posts; authenticated `POST` accepts `{ "content" }` and creates a pending comment. `DELETE /api/v1/community/posts/:id/comments/:commentId` is owner-only. Authenticated `POST /api/v1/community/posts/:id/reports` accepts `{ "reason" }`.
- Authenticated `GET /api/v1/account/follows`, `PUT/DELETE /api/v1/account/follows/:teamId` manage team follows. `GET/PUT /api/v1/account/notification-preferences` uses `matchReminders`, `kickoffChanges`, `teamNews`, `tournamentNews`, `quietHoursStart`, and `quietHoursEnd` (24-hour `HH:MM` or `null`).

Collection responses use `{ "data": [], "meta": { "count": 0, "limit": 50 } }`. Filters are query parameters such as `date`, `status`, `competitionId`, `teamId`, `group`, `city`, and `region`.

## Features and current integration status

- Fixture, live score, result, event, line-up, statistics, group and venue tables are represented in the schema and exposed as read endpoints.
- The app client includes typed methods for those resources plus teams, player rankings, competitions, news, media and events.
- Ask AFCON grounds answers in published tournament data, calls DeepSeek, and shows returned source labels. Configure `AI_PROVIDER_API_KEY` and keep published content current for useful answers.
- The language control requests a translation session. It reports provider status; it does not claim audio is translating until a speech pipeline is connected.
- The translation endpoint deliberately returns `503` until speech recognition, Luganda translation and Luganda text-to-speech adapters are implemented and configured. Production live voice requires an audio streaming transport, permission handling, playback, interruption controls, and a provider with acceptable Luganda quality/latency.
- Fan registration/login, profile-name updates, team follows, notification preferences, immediately published community posts, comments/likes/reports, and bounded image/video uploads are available. Notifications are preferences only; delivery remains an administrative workflow.

## Production requirements

The admin API is protected by the shared token, but production still needs named admin accounts and role permissions. Validate provider licensing and source timestamps, use migrations in a deployment pipeline, configure TLS and restrictive CORS origins, add rate limiting and monitoring, and verify provider failure/offline behavior before release. The initial migration is for a new database; back it up before applying schema changes later.

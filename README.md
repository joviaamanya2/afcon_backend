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

Set `AUTH_TOKEN_SECRET` to a private random value of at least 32 characters, distinct from `ADMIN_API_TOKEN`. For example, generate a value with `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"` and place it in `backend/.env`; never commit it. Fan bearer tokens are HMAC-signed and expire after seven days. Passwords are stored as scrypt hashes. The shared dashboard token remains separate and unchanged.

Community uploads accept bounded base64 JSON: images up to 8 MiB and MP4/WebM/QuickTime videos up to 15 MiB. Files and upload metadata are persisted under `COMMUNITY_MEDIA_DIR` (default `backend/community-media`); use persistent storage in production. Set `PUBLIC_API_BASE_URL` to the canonical externally reachable API origin (for example `https://api.example.com`) behind a reverse proxy so returned absolute media URLs remain valid. `GET /api/v1/community/media/:id` serves these URLs publicly. The client upload route also supports its existing `POST /api/v1/community/uploads` contract.

## Admin dashboard

The React/TypeScript dashboard is in `../dashboard`; the dashboard identified in the Flutter project is `../Afcon_app/dashboard`. Both use the same shared admin token. Set `ADMIN_API_TOKEN` in this backend's `.env` to a private random value of at least 32 characters, and add the dashboard's actual browser origin to `APP_ORIGINS` (the default Vite origin is `http://localhost:5173`). Start the API, then in another terminal:

```powershell
cd ..\dashboard
Copy-Item .env.example .env
npm install
npm run dev
```

Open the dashboard and enter the value of `ADMIN_API_TOKEN` from `backend/.env`. The browser keeps it in session storage for the active tab. Protected endpoints under `/api/v1/admin` provide overview counts and create/update/delete/list operations for competitions, matches, teams, players, standings, match events and statistics, line-ups, venues, news, fan events and media. Community posts and comments can be reviewed and moved between pending, published, hidden, and removed states; fan reports can be resolved or dismissed. Both dashboards use this same admin API; the fan app's account tokens are separate. This uses a shared admin token; use individual accounts and role-based permissions before public production deployment.

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
- `GET /api/v1/community/posts` returns published posts and the authenticated caller's pending posts. `POST /api/v1/community/posts` accepts `{ "content", "media": [{ "url", "type" }] }`; new posts are pending, and blank text is accepted only when a valid uploaded media item is attached. Feed rows use camelCase `id`, `userId`, `displayName`, `content`, `createdAt`, `status`, `likesCount`, `commentsCount`, `likedByMe`, `media`. `PATCH/DELETE /api/v1/community/posts/:id` are owner-only; `PUT/DELETE /api/v1/community/posts/:id/like` persist likes.
- `POST /api/v1/community/uploads` accepts `{ "filename", "mimeType", "data" }` (`data` is base64) and returns `{ "data": { "id", "url", "type" } }`. The returned URL can be included in the post's `media` array. `GET /api/v1/community/posts/:id/comments` exposes published comments and the caller's own pending comments on visible posts; authenticated `POST` accepts `{ "content" }` and creates a pending comment. `DELETE /api/v1/community/posts/:id/comments/:commentId` is owner-only. Authenticated `POST /api/v1/community/posts/:id/reports` accepts `{ "reason" }`.
- Authenticated `GET /api/v1/account/follows`, `PUT/DELETE /api/v1/account/follows/:teamId` manage team follows. `GET/PUT /api/v1/account/notification-preferences` uses `matchReminders`, `kickoffChanges`, `teamNews`, `tournamentNews`, `quietHoursStart`, and `quietHoursEnd` (24-hour `HH:MM` or `null`).

Collection responses use `{ "data": [], "meta": { "count": 0, "limit": 50 } }`. Filters are query parameters such as `date`, `status`, `competitionId`, `teamId`, `group`, `city`, and `region`.

## Features and current integration status

- Fixture, live score, result, event, line-up, statistics, group and venue tables are represented in the schema and exposed as read endpoints.
- The app client includes typed methods for those resources plus teams, player rankings, competitions, news, media and events.
- Ask AFCON grounds answers in published tournament data, calls DeepSeek, and shows returned source labels. Configure `AI_PROVIDER_API_KEY` and keep published content current for useful answers.
- The language control requests a translation session. It reports provider status; it does not claim audio is translating until a speech pipeline is connected.
- The translation endpoint deliberately returns `503` until speech recognition, Luganda translation and Luganda text-to-speech adapters are implemented and configured. Production live voice requires an audio streaming transport, permission handling, playback, interruption controls, and a provider with acceptable Luganda quality/latency.
- Fan registration/login, profile-name updates, team follows, notification preferences, persistent community posts/comments/likes/reports, and bounded image/video uploads are available. Notifications are preferences only; delivery and community moderation remain administrative workflows.

## Production requirements

The admin API is protected by the shared token, but production still needs named admin accounts and role permissions. Validate provider licensing and source timestamps, use migrations in a deployment pipeline, configure TLS and restrictive CORS origins, add rate limiting and monitoring, and verify provider failure/offline behavior before release. The initial migration is for a new database; back it up before applying schema changes later.

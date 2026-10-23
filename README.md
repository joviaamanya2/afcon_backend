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

## Admin dashboard

The standalone React/TypeScript dashboard is in `../dashboard`. Set `ADMIN_API_TOKEN` in this backend's `.env` to a private random value of at least 32 characters, and add `http://localhost:5173` to `APP_ORIGINS`. Start the API, then in another terminal:

```powershell
cd ..\dashboard
Copy-Item .env.example .env
npm install
npm run dev
```

Open `http://localhost:5173` and enter the value of `ADMIN_API_TOKEN` from `backend/.env`. The browser holds it in memory for that tab only. Protected endpoints under `/api/v1/admin` provide overview counts and create/update/delete/list operations for competitions, matches, teams, players, standings, match events and statistics, line-ups, venues, news, fan events and media. Linked items such as teams and competitions are selectable in the dashboard. This initial dashboard uses a single shared admin token; use individual accounts and role-based permissions before a public production deployment.

## Connect Flutter

The Flutter client uses `lib/services/afcon_api.dart`. Android emulator builds default to the host API at `10.0.2.2:8080`; use a Dart define for a physical device or deployed API:

```powershell
flutter run --dart-define=AFCON_API_URL=http://10.0.2.2:8080/api/v1
```

`10.0.2.2` reaches the host machine from the Android emulator. Use the host's LAN address for a physical phone. Keep provider API keys in this backend's `.env`; never bundle them into the Flutter app.

## API resources

- `GET /api/v1/competitions`, `matches`, `teams`, `players`, `standings`, `venues`
- `GET /api/v1/match-events?matchId=…`, `lineups?matchId=…`, `match-statistics?matchId=…`
- `GET /api/v1/news`, `events`, `media`
- `POST /api/v1/assistant/ask` accepts `{ "question": "…", "language": "en" }`
- `POST /api/v1/translation/sessions` accepts source/target language and audio format; English to Luganda uses `en` → `lg`

Collection responses use `{ "data": [], "meta": { "count": 0, "limit": 50 } }`. Filters are query parameters such as `date`, `status`, `competitionId`, `teamId`, `group`, `city`, and `region`.

## Features and current integration status

- Fixture, live score, result, event, line-up, statistics, group and venue tables are represented in the schema and exposed as read endpoints.
- The app client includes typed methods for those resources plus teams, player rankings, competitions, news, media and events.
- Ask AFCON now sends questions to the backend and renders the service's answer or setup error. The endpoint deliberately returns `503` until an AI provider adapter is implemented, configured, and grounded in verified tournament data.
- The language control requests a translation session. It reports provider status; it does not claim audio is translating until a speech pipeline is connected.
- The translation endpoint deliberately returns `503` until speech recognition, Luganda translation and Luganda text-to-speech adapters are implemented and configured. Production live voice requires an audio streaming transport, permission handling, playback, interruption controls, and a provider with acceptable Luganda quality/latency.
- User identity, sign-in, follow persistence, notification delivery and community write APIs/moderation are not enabled yet. Their tables are included where appropriate.

## Production requirements

The admin API is protected by the shared token, but production still needs named admin accounts and role permissions. Validate provider licensing and source timestamps, use migrations in a deployment pipeline, configure TLS and restrictive CORS origins, add rate limiting and monitoring, and verify provider failure/offline behavior before release. The initial migration is for a new database; back it up before applying schema changes later.

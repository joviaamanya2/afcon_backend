import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { Pool } from 'pg';
import { z } from 'zod';
import { registerAdminRoutes } from './admin.ts';
import { DeepSeekAssistantProvider } from './providers/deepseek.ts';
import { registerFanAuthRoutes } from './fan-auth.ts';
import { registerFanRoutes } from './fan-routes.ts';

const env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().url().optional(),
  DATABASE_SSL: z.string().default('false'),
  APP_ORIGINS: z.string().default('http://localhost:3000,http://localhost:5000,http://localhost:5173'),
  ADMIN_API_TOKEN: z.string().min(32).optional(),
  AUTH_TOKEN_SECRET: z.string().min(32).optional(),
  COMMUNITY_MEDIA_DIR: z.string().default('community-media'),
  VENUE_IMAGE_DIR: z.string().default('venue-images'),
  PLAYER_IMAGE_DIR: z.string().default('player-images'),
  PUBLIC_API_BASE_URL: z.string().url().optional(),
  AI_PROVIDER_API_KEY: z.string().optional(),
  AI_PROVIDER_BASE_URL: z.string().url().default('https://api.deepseek.com/v1'),
  AI_PROVIDER_MODEL: z.string().min(1).default('deepseek-chat'),
}).parse(process.env);

const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });
const pool = env.DATABASE_URL
  ? new Pool({
      connectionString: env.DATABASE_URL,
      ssl: env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    })
  : undefined;

await app.register(helmet, {
  crossOriginResourcePolicy: { policy: 'cross-origin' },
});

const configuredOrigins = env.APP_ORIGINS.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

await app.register(cors, {
  origin: (origin, cb) => {
    if (!origin) {
      cb(null, true);
      return;
    }
    if (configuredOrigins.includes(origin) || configuredOrigins.includes('*')) {
      cb(null, true);
      return;
    }
    // Allow any localhost, 127.0.0.1, or local LAN IP on any port, or if in development
    const isLocalhostOrLan =
      /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+)(:\d+)?$/.test(
        origin,
      );
    if (isLocalhostOrLan || env.NODE_ENV === 'development') {
      cb(null, true);
      return;
    }
    cb(new Error('Not allowed by CORS'), false);
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'Accept', 'Origin', 'X-Requested-With'],
});

app.get('/health', async (_request, reply) => {
  if (!pool) return reply.code(503).send({ status: 'degraded', service: 'afcon-fan-api', databaseConfigured: false, databaseReady: false });
  try {
    await pool.query('SELECT 1');
    return { status: 'ok', service: 'afcon-fan-api', databaseConfigured: true, databaseReady: true };
  } catch {
    return reply.code(503).send({ status: 'degraded', service: 'afcon-fan-api', databaseConfigured: true, databaseReady: false });
  }
});

app.get('/api/v1', async () => ({
  name: 'AFCON Fan API',
  version: 'v1',
  resources: [
    'competitions', 'matches', 'match-events', 'lineups', 'match-statistics',
    'teams', 'players', 'standings', 'venues', 'news', 'events', 'media',
    'assistant', 'translation', 'auth', 'account', 'community',
  ],
}));

type ResourceName = 'competitions' | 'matches' | 'teams' | 'players' | 'standings' | 'venues' | 'news' | 'events' | 'media' | 'match-events' | 'lineups' | 'match-statistics';
const resources: Record<ResourceName, { table: string; order: string; filters: Record<string, string> }> = {
  competitions: { table: 'competitions', order: 'name', filters: { season: 'season' } },
  matches: { table: 'matches', order: 'kickoff_at', filters: { competitionId: 'competition_id', date: 'kickoff_date', status: 'status', teamId: 'team_id' } },
  teams: { table: 'teams', order: 'name', filters: { competitionId: 'competition_id', region: 'region' } },
  players: { table: 'players', order: 'name', filters: { teamId: 'team_id', competitionId: 'competition_id' } },
  standings: { table: 'standings', order: 'group_code, position', filters: { competitionId: 'competition_id', group: 'group_code' } },
  venues: { table: 'venues', order: 'name', filters: { city: 'city' } },
  news: { table: 'articles', order: 'published_at DESC', filters: { category: 'category', region: 'region' } },
  events: { table: 'fan_events', order: 'starts_at', filters: { city: 'city', region: 'region' } },
  media: { table: 'media_assets', order: 'published_at DESC', filters: { type: 'media_type', teamId: 'team_id' } },
  'match-events': { table: 'match_events', order: 'minute, added_time', filters: { matchId: 'match_id' } },
  lineups: { table: 'match_lineups', order: 'is_starting DESC, shirt_number', filters: { matchId: 'match_id', teamId: 'team_id' } },
  'match-statistics': { table: 'match_statistics', order: 'statistic', filters: { matchId: 'match_id' } },
};

for (const [resource, definition] of Object.entries(resources) as [ResourceName, (typeof resources)[ResourceName]][]) {
  app.get(`/api/v1/${resource}`, async (request, reply) => {
    if (!pool) return reply.code(503).send({ error: 'database_not_configured', message: 'Configure DATABASE_URL to serve football data.' });
    const query = request.query as Record<string, string | undefined>;
    const isMatchList = resource === 'matches';
    const isStandingsList = resource === 'standings';
    const isLineupList = resource === 'lineups';
    const isEventList = resource === 'match-events';
    const clauses: string[] = [
      isMatchList ? 'm.published = TRUE'
        : isStandingsList ? 's.published = TRUE'
          : isLineupList ? 'l.published = TRUE'
            : isEventList ? 'e.published = TRUE' : 'published = TRUE',
    ];
    const values: unknown[] = [];
    for (const [queryKey, column] of Object.entries(definition.filters)) {
      const value = query[queryKey];
      if (value) {
        values.push(value);
        if (column === 'team_id' && isMatchList) {
          clauses.push(`(m.home_team_id = $${values.length} OR m.away_team_id = $${values.length})`);
        } else if (column === 'kickoff_date') {
          clauses.push(`${isMatchList ? 'm.' : ''}kickoff_at::date = $${values.length}::date`);
        } else {
          const prefix = isMatchList ? 'm.' : isStandingsList ? 's.' : isLineupList ? 'l.' : isEventList ? 'e.' : '';
          clauses.push(`${prefix}${column} = $${values.length}`);
        }
      }
    }
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 100);
    values.push(limit);
    try {
      const sql = isMatchList
        ? `SELECT m.*, home.name AS home_team, home.crest_url AS home_crest_url,
                  away.name AS away_team, away.crest_url AS away_crest_url,
                  v.name AS venue_name, c.name AS competition_name
           FROM matches m
           JOIN teams home ON home.id = m.home_team_id
           JOIN teams away ON away.id = m.away_team_id
           LEFT JOIN venues v ON v.id = m.venue_id
           JOIN competitions c ON c.id = m.competition_id
           WHERE ${clauses.join(' AND ')} ORDER BY m.kickoff_at LIMIT $${values.length}`
        : isStandingsList
          ? `SELECT s.*, t.name AS team_name, t.country_code
             FROM standings s JOIN teams t ON t.id = s.team_id
             WHERE ${clauses.join(' AND ')} ORDER BY s.group_code, s.position LIMIT $${values.length}`
          : isLineupList
            ? `SELECT l.*, p.name AS player_name, p.photo_url, t.name AS team_name, t.crest_url AS team_crest_url
               FROM match_lineups l JOIN players p ON p.id = l.player_id JOIN teams t ON t.id = l.team_id
               WHERE ${clauses.join(' AND ')} ORDER BY l.is_starting DESC, l.shirt_number LIMIT $${values.length}`
            : isEventList
              ? `SELECT e.*, p.name AS player_name, t.name AS team_name
                 FROM match_events e LEFT JOIN players p ON p.id = e.player_id LEFT JOIN teams t ON t.id = e.team_id
                 WHERE ${clauses.join(' AND ')} ORDER BY e.minute, e.added_time LIMIT $${values.length}`
        : `SELECT * FROM ${definition.table} WHERE ${clauses.join(' AND ')} ORDER BY ${definition.order} LIMIT $${values.length}`;
      const result = await pool.query(sql, values);
      return { data: result.rows, meta: { count: result.rowCount, limit, source: 'database' } };
    } catch (error) {
      request.log.error({ err: error, resource }, 'resource query failed');
      return reply.code(503).send({ error: 'data_unavailable', message: 'Football data is not available yet.' });
    }
  });
}

registerAdminRoutes(
  app,
  pool,
  env.ADMIN_API_TOKEN,
  env.VENUE_IMAGE_DIR,
  env.PLAYER_IMAGE_DIR,
  env.PUBLIC_API_BASE_URL,
);
registerFanAuthRoutes(app, pool, env.AUTH_TOKEN_SECRET);
registerFanRoutes(app, pool, env.AUTH_TOKEN_SECRET, env.COMMUNITY_MEDIA_DIR, env.PUBLIC_API_BASE_URL);

type AssistantFact = { text: string; source: string; updatedAt: string };
type AssistantRow = Record<string, unknown>;

async function loadAssistantFacts(database: Pool, question: string): Promise<AssistantFact[]> {
  const query = question.toLowerCase();
  const wantsMatches = /\b(match|fixture|kick.?off|score|result|playing|play|next|when)\b/.test(query);
  const wantsStandings = /\b(standings?|table|group|points|qualified|qualify)\b/.test(query);
  const wantsTeams = /\b(team|country|coach|squad|morocco|senegal|nigeria|egypt|uganda)\b/.test(query);
  const wantsPlayers = /\b(player|scorer|goal.?scorer|goals|squad|captain)\b/.test(query);
  const wantsVenues = /\b(venue|stadium|where|address|capacity|transport)\b/.test(query);
  const wantsNews = /\b(news|article|latest|story)\b/.test(query);
  const wantsEvents = /\b(event|fan.?zone|festival)\b/.test(query);
  const useDefaultFacts = !(
    wantsMatches || wantsStandings || wantsTeams || wantsPlayers ||
    wantsVenues || wantsNews || wantsEvents
  );
  const includeMatches = wantsMatches || wantsVenues || useDefaultFacts;
  const includeStandings = wantsStandings || useDefaultFacts;
  const includeTeams = wantsTeams || wantsPlayers || useDefaultFacts;

  const factGroups = await Promise.all([
    ...(includeMatches ? [database.query<AssistantRow>(
      `SELECT c.name AS competition, home.name AS home_team, away.name AS away_team,
              m.kickoff_at, m.status, m.home_score, m.away_score, v.name AS venue,
              m.source_name, m.source_updated_at
       FROM matches m
       JOIN competitions c ON c.id = m.competition_id
       JOIN teams home ON home.id = m.home_team_id
       JOIN teams away ON away.id = m.away_team_id
       LEFT JOIN venues v ON v.id = m.venue_id
       WHERE m.published = TRUE
         AND m.kickoff_at >= NOW() - INTERVAL '30 days'
       ORDER BY CASE WHEN m.kickoff_at >= NOW() THEN 0 ELSE 1 END,
                ABS(EXTRACT(EPOCH FROM (m.kickoff_at - NOW())))
       LIMIT 12`,
    ).then(({ rows }) => rows.map((row): AssistantFact => ({
      text: `${row.competition}: ${row.home_team} vs ${row.away_team}; kickoff ${new Date(String(row.kickoff_at)).toISOString()}; status ${row.status}; score ${row.home_score ?? 'not available'}-${row.away_score ?? 'not available'}${row.venue ? `; venue ${row.venue}` : ''}.`,
      source: `Match schedule: ${row.home_team} vs ${row.away_team}${row.source_name ? ` (${row.source_name})` : ''}`,
      updatedAt: row.source_updated_at ? new Date(String(row.source_updated_at)).toISOString() : 'not provided',
    }))) ] : []),
    ...(includeStandings ? [database.query<AssistantRow>(
      `SELECT c.name AS competition, s.group_code, s.position, t.name AS team,
              s.played, s.won, s.drawn, s.lost, s.goals_for, s.goals_against,
              s.goal_difference, s.points, s.source_updated_at
       FROM standings s
       JOIN competitions c ON c.id = s.competition_id
       JOIN teams t ON t.id = s.team_id
       WHERE s.published = TRUE
       ORDER BY c.name, s.group_code, s.position
       LIMIT 32`,
    ).then(({ rows }) => rows.map((row): AssistantFact => ({
      text: `${row.competition}, Group ${row.group_code}: ${row.team} is #${row.position}; ${row.played} played, ${row.won} wins, ${row.drawn} draws, ${row.lost} losses, goals ${row.goals_for}-${row.goals_against}, goal difference ${row.goal_difference}, ${row.points} points.`,
      source: `Standings: ${row.competition}, Group ${row.group_code}`,
      updatedAt: row.source_updated_at ? new Date(String(row.source_updated_at)).toISOString() : 'not provided',
    }))) ] : []),
    ...(includeTeams ? [database.query<AssistantRow>(
      `SELECT t.name, t.short_name, t.country_code, t.region, t.coach, c.name AS competition,
              t.source_name, t.source_updated_at
       FROM teams t
       LEFT JOIN competitions c ON c.id = t.competition_id
       WHERE t.published = TRUE
       ORDER BY t.name
       LIMIT 24`,
    ).then(({ rows }) => rows.map((row): AssistantFact => ({
      text: `${row.name}${row.short_name ? ` (${row.short_name})` : ''}${row.country_code ? `, country code ${row.country_code}` : ''}${row.region ? `, region ${row.region}` : ''}${row.coach ? `, coach ${row.coach}` : ''}${row.competition ? `, competition ${row.competition}` : ''}.`,
      source: `Team profile: ${row.name}${row.source_name ? ` (${row.source_name})` : ''}`,
      updatedAt: row.source_updated_at ? new Date(String(row.source_updated_at)).toISOString() : 'not provided',
    }))) ] : []),
    ...(wantsPlayers ? [database.query<AssistantRow>(
      `SELECT p.name, p.position, p.shirt_number, p.club, t.name AS team,
              c.name AS competition, p.stats, p.source_name, p.source_updated_at
       FROM players p
       LEFT JOIN teams t ON t.id = p.team_id
       LEFT JOIN competitions c ON c.id = p.competition_id
       WHERE p.published = TRUE
       ORDER BY p.name
       LIMIT 16`,
    ).then(({ rows }) => rows.map((row): AssistantFact => ({
      text: `${row.name}${row.position ? `, position ${row.position}` : ''}${row.shirt_number ? `, shirt ${row.shirt_number}` : ''}${row.team ? `, team ${row.team}` : ''}${row.club ? `, club ${row.club}` : ''}${row.competition ? `, competition ${row.competition}` : ''}${row.stats && Object.keys(row.stats as object).length ? `, statistics ${JSON.stringify(row.stats)}` : ''}.`,
      source: `Player profile: ${row.name}${row.source_name ? ` (${row.source_name})` : ''}`,
      updatedAt: row.source_updated_at ? new Date(String(row.source_updated_at)).toISOString() : 'not provided',
    }))) ] : []),
    ...(wantsVenues ? [database.query<AssistantRow>(
      `SELECT name, city, country, address, capacity, accessibility_info,
              transport_info, timezone, source_name, source_updated_at
       FROM venues
       WHERE published = TRUE
       ORDER BY name
       LIMIT 12`,
    ).then(({ rows }) => rows.map((row): AssistantFact => ({
      text: `${row.name}, ${row.city}${row.country ? `, ${row.country}` : ''}${row.address ? `; address ${row.address}` : ''}${row.capacity ? `; capacity ${row.capacity}` : ''}${row.timezone ? `; timezone ${row.timezone}` : ''}${row.accessibility_info ? `; accessibility ${row.accessibility_info}` : ''}${row.transport_info ? `; transport ${row.transport_info}` : ''}.`,
      source: `Venue: ${row.name}${row.source_name ? ` (${row.source_name})` : ''}`,
      updatedAt: row.source_updated_at ? new Date(String(row.source_updated_at)).toISOString() : 'not provided',
    }))) ] : []),
    ...(wantsNews ? [database.query<AssistantRow>(
      `SELECT title, summary, category, region, source_name, published_at
       FROM articles
       WHERE published = TRUE
       ORDER BY published_at DESC NULLS LAST
       LIMIT 8`,
    ).then(({ rows }) => rows.map((row): AssistantFact => ({
      text: `${row.title}${row.summary ? `: ${row.summary}` : ''}${row.category ? `; category ${row.category}` : ''}${row.region ? `; region ${row.region}` : ''}.`,
      source: `News: ${row.title}${row.source_name ? ` (${row.source_name})` : ''}`,
      updatedAt: row.published_at ? new Date(String(row.published_at)).toISOString() : 'not provided',
    }))) ] : []),
    ...(wantsEvents ? [database.query<AssistantRow>(
      `SELECT e.title, e.description, e.city, e.region, e.starts_at, e.ends_at,
              v.name AS venue, e.organizer
       FROM fan_events e
       LEFT JOIN venues v ON v.id = e.venue_id
       WHERE e.published = TRUE
       ORDER BY e.starts_at
       LIMIT 8`,
    ).then(({ rows }) => rows.map((row): AssistantFact => ({
      text: `${row.title}${row.description ? `: ${row.description}` : ''}; ${row.city}${row.region ? `, ${row.region}` : ''}; starts ${new Date(String(row.starts_at)).toISOString()}${row.ends_at ? `, ends ${new Date(String(row.ends_at)).toISOString()}` : ''}${row.venue ? `; venue ${row.venue}` : ''}${row.organizer ? `; organizer ${row.organizer}` : ''}.`,
      source: `Fan event: ${row.title}`,
      updatedAt: 'not provided',
    }))) ] : []),
  ]);
  return factGroups.flat().slice(0, 48);
}

const assistant = env.AI_PROVIDER_API_KEY
  ? new DeepSeekAssistantProvider(
      env.AI_PROVIDER_API_KEY,
      env.AI_PROVIDER_BASE_URL,
      env.AI_PROVIDER_MODEL,
    )
  : undefined;
const askSchema = z.object({
  question: z.string().trim().min(1).max(2000),
  language: z.string().trim().min(1).max(32).default('auto'),
});
app.post('/api/v1/assistant/ask', async (request, reply) => {
  const parsed = askSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
  if (!assistant) {
    return reply.code(503).send({
      error: 'assistant_provider_not_configured',
      message: 'Configure AI_PROVIDER_API_KEY in the backend environment to enable Ask AFCON.',
    });
  }
  if (!pool) {
    return reply.code(503).send({
      error: 'database_not_configured',
      message: 'Configure DATABASE_URL to answer from verified AFCON information.',
    });
  }

  try {
    const facts = await loadAssistantFacts(pool, parsed.data.question);
    if (facts.length === 0) {
      return reply.code(503).send({
        error: 'assistant_content_unavailable',
        message: 'There is no published AFCON information available to answer this question yet.',
      });
    }
    return await assistant.answer({ ...parsed.data, facts });
  } catch (error) {
    request.log.error({ err: error }, 'Ask AFCON request failed');
    return reply.code(502).send({
      error: 'assistant_unavailable',
      message: 'Ask AFCON could not complete the request. Please try again.',
    });
  }
});

const translationSchema = z.object({
  sourceLanguage: z.string().default('en'),
  targetLanguage: z.string().default('lg'),
  audioFormat: z.enum(['webm', 'wav', 'mp3', 'm4a']).default('webm'),
});
app.post('/api/v1/translation/sessions', async (request, reply) => {
  const parsed = translationSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
  if (parsed.data.sourceLanguage !== 'en' || parsed.data.targetLanguage !== 'lg') {
    return reply.code(422).send({ error: 'unsupported_language_pair', supported: [{ source: 'en', target: 'lg' }] });
  }
  return reply.code(503).send({
    error: 'speech_translation_provider_not_configured',
    message: 'Configure speech recognition, Luganda translation and Luganda text-to-speech providers.',
  });
});

app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not_found' }));
app.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  return reply.code(500).send({ error: 'internal_error', message: 'The request could not be completed.' });
});

app.addHook('onClose', async () => { await pool?.end(); });

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

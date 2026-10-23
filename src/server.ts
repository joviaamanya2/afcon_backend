import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { Pool } from 'pg';
import { z } from 'zod';
import { registerAdminRoutes } from './admin.ts';

const env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().url().optional(),
  DATABASE_SSL: z.string().default('false'),
  APP_ORIGINS: z.string().default('http://localhost:3000,http://localhost:5000,http://localhost:5173'),
  ADMIN_API_TOKEN: z.string().min(32).optional(),
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

await app.register(helmet);
await app.register(cors, {
  origin: env.APP_ORIGINS.split(',').map((origin) => origin.trim()),
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
    'assistant', 'translation',
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
        ? `SELECT m.*, home.name AS home_team, away.name AS away_team, v.name AS venue_name, c.name AS competition_name
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
            ? `SELECT l.*, p.name AS player_name, t.name AS team_name
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

registerAdminRoutes(app, pool, env.ADMIN_API_TOKEN);

const askSchema = z.object({ question: z.string().trim().min(1).max(2000), language: z.string().default('en') });
app.post('/api/v1/assistant/ask', async (request, reply) => {
  const parsed = askSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
  return reply.code(503).send({
    error: 'assistant_provider_not_configured',
    message: 'Connect an AI provider and verified AFCON content before enabling answers.',
  });
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

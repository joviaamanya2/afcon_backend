import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';

const uuid = z.string().uuid();
const dateTime = z.string().datetime({ offset: true }).nullable().optional();
const publish = z.boolean().optional();

const collections = {
  competitions: {
    table: 'competitions',
    order: 'created_at DESC',
    fields: {
      name: 'name', slug: 'slug', season: 'season', country: 'country',
      startsAt: 'starts_at', endsAt: 'ends_at', published: 'published',
    },
    create: z.object({ name: z.string().trim().min(2).max(120), slug: z.string().trim().min(2).max(120), season: z.string().trim().min(4).max(20), country: z.string().trim().max(100).optional(), startsAt: dateTime, endsAt: dateTime, published: publish }),
  },
  teams: {
    table: 'teams',
    order: 'name',
    fields: {
      name: 'name', shortName: 'short_name', countryCode: 'country_code',
      region: 'region', crestUrl: 'crest_url', coach: 'coach',
      competitionId: 'competition_id', published: 'published',
    },
    create: z.object({ name: z.string().trim().min(2).max(120), shortName: z.string().trim().max(30).optional(), countryCode: z.string().trim().length(3).optional(), region: z.string().trim().max(80).optional(), crestUrl: z.string().url().optional(), coach: z.string().trim().max(120).optional(), competitionId: uuid.optional(), published: publish }),
  },
  players: {
    table: 'players',
    order: 'name',
    fields: { teamId: 'team_id', competitionId: 'competition_id', name: 'name', position: 'position', shirtNumber: 'shirt_number', dateOfBirth: 'date_of_birth', club: 'club', photoUrl: 'photo_url', stats: 'stats', published: 'published' },
    create: z.object({ teamId: uuid.optional(), competitionId: uuid.optional(), name: z.string().trim().min(2).max(120), position: z.string().trim().max(40).optional(), shirtNumber: z.number().int().min(1).max(99).nullable().optional(), dateOfBirth: z.string().date().nullable().optional(), club: z.string().trim().max(120).optional(), photoUrl: z.string().url().optional(), stats: z.record(z.string(), z.number()).optional(), published: publish }),
  },
  matches: {
    table: 'matches',
    order: 'kickoff_at DESC',
    fields: {
      competitionId: 'competition_id', stage: 'stage', groupCode: 'group_code',
      homeTeamId: 'home_team_id', awayTeamId: 'away_team_id', venueId: 'venue_id',
      kickoffAt: 'kickoff_at', status: 'status', homeScore: 'home_score',
      awayScore: 'away_score', broadcast: 'broadcast', published: 'published',
    },
    create: z.object({ competitionId: uuid, stage: z.string().trim().max(80).optional(), groupCode: z.string().trim().max(8).optional(), homeTeamId: uuid, awayTeamId: uuid, venueId: uuid.nullable().optional(), kickoffAt: z.string().datetime({ offset: true }), status: z.enum(['scheduled', 'live', 'half_time', 'finished', 'postponed', 'cancelled']).optional(), homeScore: z.number().int().min(0).max(99).nullable().optional(), awayScore: z.number().int().min(0).max(99).nullable().optional(), broadcast: z.string().trim().max(200).optional(), published: publish }),
  },
  standings: {
    table: 'standings',
    order: 'group_code, position',
    fields: { competitionId: 'competition_id', groupCode: 'group_code', teamId: 'team_id', position: 'position', played: 'played', won: 'won', drawn: 'drawn', lost: 'lost', goalsFor: 'goals_for', goalsAgainst: 'goals_against', goalDifference: 'goal_difference', points: 'points', published: 'published' },
    create: z.object({ competitionId: uuid, groupCode: z.string().trim().min(1).max(8), teamId: uuid, position: z.number().int().min(1).max(100), played: z.number().int().min(0).optional(), won: z.number().int().min(0).optional(), drawn: z.number().int().min(0).optional(), lost: z.number().int().min(0).optional(), goalsFor: z.number().int().min(0).optional(), goalsAgainst: z.number().int().min(0).optional(), goalDifference: z.number().int().optional(), points: z.number().int().min(0).optional(), published: publish }),
  },
  venues: {
    table: 'venues',
    order: 'name',
    fields: {
      name: 'name', city: 'city', country: 'country', address: 'address',
      latitude: 'latitude', longitude: 'longitude', capacity: 'capacity',
      accessibilityInfo: 'accessibility_info', transportInfo: 'transport_info',
      timezone: 'timezone', published: 'published',
    },
    create: z.object({ name: z.string().trim().min(2).max(160), city: z.string().trim().min(2).max(100), country: z.string().trim().max(100).optional(), address: z.string().trim().max(240).optional(), latitude: z.number().min(-90).max(90).nullable().optional(), longitude: z.number().min(-180).max(180).nullable().optional(), capacity: z.number().int().positive().nullable().optional(), accessibilityInfo: z.string().max(2000).optional(), transportInfo: z.string().max(2000).optional(), timezone: z.string().max(80).optional(), published: publish }),
  },
  news: {
    table: 'articles',
    order: 'created_at DESC',
    fields: {
      title: 'title', slug: 'slug', summary: 'summary', body: 'body', author: 'author',
      category: 'category', region: 'region', imageUrl: 'image_url',
      imageRights: 'image_rights', publishedAt: 'published_at', published: 'published',
    },
    create: z.object({ title: z.string().trim().min(5).max(220), slug: z.string().trim().min(2).max(240), summary: z.string().max(500).optional(), body: z.string().max(30000).optional(), author: z.string().trim().max(120).optional(), category: z.string().trim().max(80).optional(), region: z.string().trim().max(80).optional(), imageUrl: z.string().url().optional(), imageRights: z.string().max(500).optional(), publishedAt: dateTime, published: publish }),
  },
  events: {
    table: 'fan_events',
    order: 'starts_at DESC',
    fields: {
      title: 'title', description: 'description', city: 'city', region: 'region',
      venueId: 'venue_id', startsAt: 'starts_at', endsAt: 'ends_at',
      bookingUrl: 'booking_url', organizer: 'organizer', published: 'published',
    },
    create: z.object({ title: z.string().trim().min(3).max(180), description: z.string().max(3000).optional(), city: z.string().trim().min(2).max(100), region: z.string().trim().max(80).optional(), venueId: uuid.nullable().optional(), startsAt: z.string().datetime({ offset: true }), endsAt: dateTime, bookingUrl: z.string().url().optional(), organizer: z.string().trim().max(160).optional(), published: publish }),
  },
  media: {
    table: 'media_assets',
    order: 'published_at DESC',
    fields: { title: 'title', description: 'description', mediaType: 'media_type', url: 'url', thumbnailUrl: 'thumbnail_url', captions: 'captions', territory: 'territory', rightsStart: 'rights_start', rightsEnd: 'rights_end', teamId: 'team_id', publishedAt: 'published_at', published: 'published' },
    create: z.object({ title: z.string().trim().min(2).max(200), description: z.string().max(3000).optional(), mediaType: z.enum(['image', 'video', 'audio']), url: z.string().url(), thumbnailUrl: z.string().url().optional(), captions: z.record(z.string(), z.string()).optional(), territory: z.string().max(120).optional(), rightsStart: dateTime, rightsEnd: dateTime, teamId: uuid.nullable().optional(), publishedAt: dateTime, published: publish }),
  },
  'match-events': {
    table: 'match_events',
    order: 'minute, added_time',
    fields: { matchId: 'match_id', teamId: 'team_id', playerId: 'player_id', relatedPlayerId: 'related_player_id', eventType: 'event_type', minute: 'minute', addedTime: 'added_time', detail: 'detail', published: 'published' },
    create: z.object({ matchId: uuid, teamId: uuid.nullable().optional(), playerId: uuid.nullable().optional(), relatedPlayerId: uuid.nullable().optional(), eventType: z.enum(['goal', 'own_goal', 'penalty', 'yellow_card', 'red_card', 'substitution', 'var', 'kickoff', 'half_time', 'full_time']), minute: z.number().int().min(0).max(150), addedTime: z.number().int().min(0).nullable().optional(), detail: z.string().max(500).optional(), published: publish }),
  },
  'match-statistics': {
    table: 'match_statistics',
    order: 'statistic',
    fields: { matchId: 'match_id', statistic: 'statistic', homeValue: 'home_value', awayValue: 'away_value', published: 'published' },
    create: z.object({ matchId: uuid, statistic: z.string().trim().min(1).max(80), homeValue: z.number().nullable().optional(), awayValue: z.number().nullable().optional(), published: publish }),
  },
  lineups: {
    table: 'match_lineups',
    order: 'is_starting DESC, shirt_number',
    fields: { matchId: 'match_id', teamId: 'team_id', playerId: 'player_id', isStarting: 'is_starting', shirtNumber: 'shirt_number', position: 'position', formation: 'formation', published: 'published' },
    create: z.object({ matchId: uuid, teamId: uuid, playerId: uuid, isStarting: z.boolean(), shirtNumber: z.number().int().min(1).max(99).nullable().optional(), position: z.string().max(40).optional(), formation: z.string().max(20).optional(), published: publish }),
  },
} as const;

type CollectionName = keyof typeof collections;

function isCollection(value: string): value is CollectionName {
  return Object.hasOwn(collections, value);
}

export function registerAdminRoutes(app: FastifyInstance, pool: Pool | undefined, adminToken: string | undefined): void {
  const authorize: preHandlerHookHandler = async (request, reply) => {
    if (!pool) return reply.code(503).send({ error: 'database_not_configured' });
    if (!adminToken) return reply.code(503).send({ error: 'admin_token_not_configured' });
    const authorization = request.headers.authorization ?? '';
    const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const expectedBytes = Buffer.from(adminToken);
    const suppliedBytes = Buffer.from(supplied);
    if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  };

  const moderationStatus = z.enum(['pending', 'published', 'hidden', 'removed']);
  const moderationUpdate = z.object({ status: moderationStatus }).strict();
  for (const resource of ['community-posts', 'community-comments'] as const) {
    const table = resource === 'community-posts' ? 'community_posts' : 'community_comments';
    const query = resource === 'community-posts'
      ? `SELECT p.id, p.user_id, u.display_name, p.body AS content, p.status, p.created_at,
                (SELECT COUNT(*)::int FROM community_post_likes l WHERE l.post_id = p.id) AS likes_count,
                (SELECT COUNT(*)::int FROM community_comments c WHERE c.post_id = p.id) AS comments_count
         FROM community_posts p JOIN app_users u ON u.id = p.user_id
         ORDER BY p.created_at DESC LIMIT 250`
      : `SELECT c.id, c.post_id, c.user_id, u.display_name, c.body AS content, c.status, c.created_at
         FROM community_comments c JOIN app_users u ON u.id = c.user_id
         ORDER BY c.created_at DESC LIMIT 250`;

    app.get(`/api/v1/admin/${resource}`, { preHandler: authorize }, async (request, reply) => {
      if (!pool) return reply.code(503).send({ error: 'database_not_configured' });
      try {
        const result = await pool.query(query);
        return { data: result.rows, meta: { count: result.rowCount, limit: 250 } };
      } catch (error) {
        request.log.error({ err: error, resource }, 'community moderation list failed');
        return reply.code(503).send({ error: 'data_unavailable' });
      }
    });

    app.patch<{ Params: { id: string } }>(`/api/v1/admin/${resource}/:id`, { preHandler: authorize }, async (request, reply) => {
      if (!pool) return reply.code(503).send({ error: 'database_not_configured' });
      if (!uuid.safeParse(request.params.id).success) return reply.code(400).send({ error: 'invalid_id' });
      const parsed = moderationUpdate.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
      try {
        const result = await pool.query(
          `UPDATE ${table} SET status = $1 WHERE id = $2 RETURNING id, status`,
          [parsed.data.status, request.params.id],
        );
        if (!result.rowCount) return reply.code(404).send({ error: 'record_not_found' });
        return { data: result.rows[0] };
      } catch (error) {
        request.log.error({ err: error, resource }, 'community moderation update failed');
        return reply.code(409).send({ error: 'record_not_updated' });
      }
    });
  }

  const reportStatus = z.enum(['open', 'resolved', 'dismissed']);
  app.get('/api/v1/admin/community-reports', { preHandler: authorize }, async (request, reply) => {
    if (!pool) return reply.code(503).send({ error: 'database_not_configured' });
    try {
      const result = await pool.query(`
        SELECT r.id, r.post_id, r.comment_id, r.reporter_id,
               u.display_name AS reporter_name, r.reason, r.status, r.created_at,
               CASE WHEN r.post_id IS NOT NULL THEN 'post' ELSE 'comment' END AS target_type,
               COALESCE(p.body, c.body) AS reported_content
        FROM content_reports r
        JOIN app_users u ON u.id = r.reporter_id
        LEFT JOIN community_posts p ON p.id = r.post_id
        LEFT JOIN community_comments c ON c.id = r.comment_id
        ORDER BY r.created_at DESC LIMIT 250
      `);
      return { data: result.rows, meta: { count: result.rowCount, limit: 250 } };
    } catch (error) {
      request.log.error({ err: error }, 'community reports list failed');
      return reply.code(503).send({ error: 'data_unavailable' });
    }
  });
  app.patch<{ Params: { id: string } }>('/api/v1/admin/community-reports/:id', { preHandler: authorize }, async (request, reply) => {
    if (!pool) return reply.code(503).send({ error: 'database_not_configured' });
    if (!uuid.safeParse(request.params.id).success) return reply.code(400).send({ error: 'invalid_id' });
    const parsed = z.object({ status: reportStatus }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
    try {
      const result = await pool.query(
        'UPDATE content_reports SET status = $1 WHERE id = $2 RETURNING id, status',
        [parsed.data.status, request.params.id],
      );
      if (!result.rowCount) return reply.code(404).send({ error: 'record_not_found' });
      return { data: result.rows[0] };
    } catch (error) {
      request.log.error({ err: error }, 'community report update failed');
      return reply.code(409).send({ error: 'record_not_updated' });
    }
  });

  app.get('/api/v1/admin/overview', { preHandler: authorize }, async (request, reply) => {
    if (!pool) return reply.code(503).send({ error: 'database_not_configured' });
    try {
      const result = await pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM matches) AS matches,
          (SELECT COUNT(*)::int FROM teams) AS teams,
          (SELECT COUNT(*)::int FROM players) AS players,
          (SELECT COUNT(*)::int FROM articles) AS articles,
          (SELECT COUNT(*)::int FROM fan_events) AS events,
          (SELECT COUNT(*)::int FROM venues) AS venues,
          (SELECT COUNT(*)::int FROM matches WHERE published = TRUE) AS published_matches,
          (SELECT COUNT(*)::int FROM articles WHERE published = TRUE) AS published_articles
      `);
      return { data: result.rows[0] };
    } catch (error) {
      request.log.error({ err: error }, 'admin dashboard overview failed');
      return reply.code(503).send({ error: 'data_unavailable' });
    }
  });

  app.get<{ Params: { resource: string } }>('/api/v1/admin/:resource', { preHandler: authorize }, async (request, reply) => {
    if (!pool) return reply.code(503).send({ error: 'database_not_configured' });
    if (!isCollection(request.params.resource)) return reply.code(404).send({ error: 'unknown_resource' });
    const collection = collections[request.params.resource];
    try {
      const limit = Math.min(Math.max(Number((request.query as { limit?: string }).limit ?? 100) || 100, 1), 250);
      const sql = request.params.resource === 'matches'
        ? `SELECT m.*, home.name AS home_team, away.name AS away_team, c.name AS competition_name
           FROM matches m JOIN teams home ON home.id = m.home_team_id
           JOIN teams away ON away.id = m.away_team_id
           JOIN competitions c ON c.id = m.competition_id
           ORDER BY m.kickoff_at DESC LIMIT $1`
        : `SELECT * FROM ${collection.table} ORDER BY ${collection.order} LIMIT $1`;
      const result = await pool.query(sql, [limit]);
      return { data: result.rows, meta: { count: result.rowCount, limit } };
    } catch (error) {
      request.log.error({ err: error, resource: request.params.resource }, 'admin list failed');
      return reply.code(503).send({ error: 'data_unavailable' });
    }
  });

  app.post<{ Params: { resource: string } }>('/api/v1/admin/:resource', { preHandler: authorize }, async (request, reply) => {
    if (!pool) return reply.code(503).send({ error: 'database_not_configured' });
    if (!isCollection(request.params.resource)) return reply.code(404).send({ error: 'unknown_resource' });
    const collection = collections[request.params.resource];
    const parsed = collection.create.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
    const values = Object.entries(parsed.data).filter(([, value]) => value !== undefined);
    const columns = values.map(([key]) => collection.fields[key as keyof typeof collection.fields]);
    try {
      const placeholders = values.map((_, index) => `$${index + 1}`);
      const result = await pool.query(
        `INSERT INTO ${collection.table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
        values.map(([, value]) => value),
      );
      return reply.code(201).send({ data: result.rows[0] });
    } catch (error) {
      request.log.error({ err: error, resource: request.params.resource }, 'admin create failed');
      return reply.code(409).send({ error: 'record_not_created', message: 'Check unique values and linked IDs.' });
    }
  });

  app.patch<{ Params: { resource: string; id: string } }>('/api/v1/admin/:resource/:id', { preHandler: authorize }, async (request, reply) => {
    if (!pool) return reply.code(503).send({ error: 'database_not_configured' });
    if (!isCollection(request.params.resource)) return reply.code(404).send({ error: 'unknown_resource' });
    if (request.params.resource === 'match-statistics') {
      const separator = request.params.id.lastIndexOf(':');
      const matchId = request.params.id.slice(0, separator);
      const statistic = decodeURIComponent(request.params.id.slice(separator + 1));
      if (separator < 0 || !uuid.safeParse(matchId).success) return reply.code(400).send({ error: 'invalid_id' });
      const parsed = collections['match-statistics'].create.partial().safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
      const values = Object.entries(parsed.data).filter(([key, value]) => value !== undefined && !['matchId', 'statistic'].includes(key));
      if (!values.length) return reply.code(400).send({ error: 'empty_update' });
      const assignments = values.map(([key], index) => `${collections['match-statistics'].fields[key as keyof typeof collections['match-statistics']['fields']]} = $${index + 1}`);
      try {
        const result = await pool.query(
          `UPDATE match_statistics SET ${assignments.join(', ')} WHERE match_id = $${values.length + 1} AND statistic = $${values.length + 2} RETURNING *`,
          [...values.map(([, value]) => value), matchId, statistic],
        );
        if (!result.rowCount) return reply.code(404).send({ error: 'record_not_found' });
        return { data: result.rows[0] };
      } catch (error) {
        request.log.error({ err: error, resource: request.params.resource }, 'admin statistics update failed');
        return reply.code(409).send({ error: 'record_not_updated' });
      }
    }
    if (!uuid.safeParse(request.params.id).success) return reply.code(400).send({ error: 'invalid_id' });
    const collection = collections[request.params.resource];
    const parsed = collection.create.partial().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
    const values = Object.entries(parsed.data).filter(([, value]) => value !== undefined);
    if (!values.length) return reply.code(400).send({ error: 'empty_update' });
    const assignments = values.map(([key], index) => `${collection.fields[key as keyof typeof collection.fields]} = $${index + 1}`);
    try {
      const result = await pool.query(
        `UPDATE ${collection.table} SET ${assignments.join(', ')} WHERE id = $${values.length + 1} RETURNING *`,
        [...values.map(([, value]) => value), request.params.id],
      );
      if (!result.rowCount) return reply.code(404).send({ error: 'record_not_found' });
      return { data: result.rows[0] };
    } catch (error) {
      request.log.error({ err: error, resource: request.params.resource }, 'admin update failed');
      return reply.code(409).send({ error: 'record_not_updated', message: 'Check values and linked IDs.' });
    }
  });

  app.delete<{ Params: { resource: string; id: string } }>('/api/v1/admin/:resource/:id', { preHandler: authorize }, async (request, reply) => {
    if (!pool) return reply.code(503).send({ error: 'database_not_configured' });
    if (!isCollection(request.params.resource)) return reply.code(404).send({ error: 'unknown_resource' });
    if (request.params.resource === 'match-statistics') {
      const separator = request.params.id.lastIndexOf(':');
      const matchId = request.params.id.slice(0, separator);
      const statistic = decodeURIComponent(request.params.id.slice(separator + 1));
      if (separator < 0 || !uuid.safeParse(matchId).success) return reply.code(400).send({ error: 'invalid_id' });
      try {
        const result = await pool.query('DELETE FROM match_statistics WHERE match_id = $1 AND statistic = $2 RETURNING statistic', [matchId, statistic]);
        if (!result.rowCount) return reply.code(404).send({ error: 'record_not_found' });
        return reply.code(204).send();
      } catch (error) {
        request.log.error({ err: error, resource: request.params.resource }, 'admin statistics delete failed');
        return reply.code(409).send({ error: 'record_not_deleted' });
      }
    }
    if (!uuid.safeParse(request.params.id).success) return reply.code(400).send({ error: 'invalid_id' });
    const collection = collections[request.params.resource];
    try {
      const result = await pool.query(`DELETE FROM ${collection.table} WHERE id = $1 RETURNING id`, [request.params.id]);
      if (!result.rowCount) return reply.code(404).send({ error: 'record_not_found' });
      return reply.code(204).send();
    } catch (error) {
      request.log.error({ err: error, resource: request.params.resource }, 'admin delete failed');
      return reply.code(409).send({ error: 'record_not_deleted', message: 'This record is still linked to other tournament data.' });
    }
  });
}

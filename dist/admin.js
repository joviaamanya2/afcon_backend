import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
const uuid = z.string().uuid();
const dateTime = z.string().datetime({ offset: true }).nullable().optional();
const publish = z.boolean().optional();
const maxVenueImageBytes = 8 * 1024 * 1024;
const venueImageTypes = {
    'image/jpeg': {
        extension: 'jpg',
        matches: (image) => image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff,
    },
    'image/png': {
        extension: 'png',
        matches: (image) => image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    },
    'image/webp': {
        extension: 'webp',
        matches: (image) => image.toString('ascii', 0, 4) === 'RIFF' && image.toString('ascii', 8, 12) === 'WEBP',
    },
};
function competitionSlug(name, season) {
    const slugPart = (value) => value
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
    const nameSlug = slugPart(name).slice(0, 90).replace(/-+$/g, '') || 'competition';
    const seasonSlug = slugPart(season).slice(0, 20).replace(/-+$/g, '');
    return `${nameSlug}-${seasonSlug}`.slice(0, 120).replace(/-+$/g, '');
}
const collections = {
    competitions: {
        table: 'competitions',
        order: 'created_at DESC',
        fields: {
            name: 'name', slug: 'slug', season: 'season', country: 'country',
            startsAt: 'starts_at', endsAt: 'ends_at', published: 'published',
        },
        create: z.object({ name: z.string().trim().min(2).max(120), slug: z.string().trim().min(2).max(120).optional(), season: z.string().trim().min(4).max(20), country: z.string().trim().max(100).optional(), startsAt: dateTime, endsAt: dateTime, published: publish }),
    },
    teams: {
        table: 'teams',
        order: 'name',
        fields: {
            name: 'name', shortName: 'short_name', countryCode: 'country_code',
            region: 'region', crestUrl: 'crest_url', coach: 'coach',
            competitionId: 'competition_id', published: 'published',
        },
        create: z.object({ name: z.string().trim().min(2).max(120), shortName: z.string().trim().max(30).optional(), countryCode: z.string().trim().transform((value) => value.startsWith('+') ? value : value.toUpperCase()).refine((value) => /^[A-Z]{3}$/.test(value) || /^\+[1-9]\d{0,2}$/.test(value), 'Enter a three-letter code such as UGA or a calling code such as +256.').optional(), region: z.string().trim().max(80).optional(), crestUrl: z.string().url().optional(), coach: z.string().trim().max(120).optional(), competitionId: uuid.optional(), published: publish }),
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
            imageUrl: 'image_url', capacity: 'capacity',
            accessibilityInfo: 'accessibility_info', transportInfo: 'transport_info',
            timezone: 'timezone', published: 'published',
        },
        create: z.object({ name: z.string().trim().min(2).max(160), city: z.string().trim().min(2).max(100), country: z.string().trim().max(100).optional(), address: z.string().trim().max(240).optional(), imageUrl: z.string().url().nullable().optional(), capacity: z.number().int().positive().nullable().optional(), accessibilityInfo: z.string().max(2000).optional(), transportInfo: z.string().max(2000).optional(), timezone: z.string().max(80).optional(), published: publish }),
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
        order: 'match_id, team_id, is_starting DESC, shirt_number',
        fields: { matchId: 'match_id', teamId: 'team_id', playerId: 'player_id', isStarting: 'is_starting', shirtNumber: 'shirt_number', position: 'position', formation: 'formation', published: 'published' },
        create: z.object({ matchId: uuid, teamId: uuid, playerId: uuid, isStarting: z.boolean(), shirtNumber: z.number().int().min(1).max(99).nullable().optional(), position: z.string().max(40).optional(), formation: z.string().max(20).optional(), published: publish }),
    },
};
function isCollection(value) {
    return Object.hasOwn(collections, value);
}
function registerImageRoutes(app, authorize, uploadPath, publicPath, imageDirectory, publicApiBaseUrl, imageLabel) {
    app.post(uploadPath, {
        preHandler: authorize,
        bodyLimit: 12 * 1024 * 1024,
    }, async (request, reply) => {
        const parsed = z.object({
            mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
            data: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
        }).strict().safeParse(request.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'invalid_image' });
        const image = Buffer.from(parsed.data.data, 'base64');
        const imageType = venueImageTypes[parsed.data.mimeType];
        if (!image.length || image.length > maxVenueImageBytes) {
            return reply.code(413).send({ error: 'image_size_exceeded', maxBytes: maxVenueImageBytes });
        }
        if (!imageType.matches(image))
            return reply.code(415).send({ error: 'image_content_mismatch' });
        const filename = `${randomUUID()}.${imageType.extension}`;
        const filePath = path.join(imageDirectory, filename);
        try {
            await mkdir(imageDirectory, { recursive: true });
            await writeFile(filePath, image, { flag: 'wx' });
            const baseUrl = publicApiBaseUrl?.replace(/\/+$/, '') ?? `${request.protocol}://${request.headers.host}`;
            return reply.code(201).send({ data: { url: `${baseUrl}${publicPath}/${filename}` } });
        }
        catch (error) {
            await rm(filePath, { force: true }).catch(() => undefined);
            request.log.error({ err: error }, `${imageLabel} image upload failed`);
            return reply.code(503).send({ error: `${imageLabel}_image_upload_unavailable` });
        }
    });
    app.get(`${publicPath}/:filename`, async (request, reply) => {
        const match = request.params.filename.match(/^([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.(jpg|png|webp)$/i);
        if (!match)
            return reply.code(404).send({ error: 'image_not_found' });
        const contentTypes = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
        const filePath = path.join(imageDirectory, request.params.filename);
        try {
            const image = await readFile(filePath);
            return reply
                .type(contentTypes[match[2]])
                .header('Content-Length', image.length)
                .header('Cache-Control', 'public, max-age=31536000, immutable')
                .send(image);
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return reply.code(404).send({ error: 'image_not_found' });
            request.log.error({ err: error }, `${imageLabel} image retrieval failed`);
            return reply.code(503).send({ error: `${imageLabel}_image_unavailable` });
        }
    });
}
export function registerAdminRoutes(app, pool, adminToken, venueImageDirectory, playerImageDirectory, publicApiBaseUrl) {
    const authorize = async (request, reply) => {
        if (!pool)
            return reply.code(503).send({ error: 'database_not_configured' });
        if (!adminToken)
            return reply.code(503).send({ error: 'admin_token_not_configured' });
        const authorization = request.headers.authorization ?? '';
        const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
        const expectedBytes = Buffer.from(adminToken);
        const suppliedBytes = Buffer.from(supplied);
        if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) {
            return reply.code(401).send({ error: 'unauthorized' });
        }
    };
    app.post('/api/v1/admin/lineups/batch', { preHandler: authorize }, async (request, reply) => {
        if (!pool)
            return reply.code(503).send({ error: 'database_not_configured' });
        const schema = z.object({
            matchId: uuid,
            teamId: uuid,
            formation: z.string().trim().min(3).max(20),
            published: z.boolean(),
            players: z.array(z.object({
                playerId: uuid,
                position: z.string().trim().min(1).max(40),
                shirtNumber: z.number().int().min(1).max(99).nullable(),
                isStarting: z.boolean(),
            }).strict()).min(1).max(30),
        }).strict().refine((lineup) => new Set(lineup.players.map((player) => player.playerId)).size === lineup.players.length, { message: 'A player can only appear once in a team line-up.', path: ['players'] }).refine((lineup) => lineup.players.filter((player) => player.isStarting).length <= 11, { message: 'A team can have at most 11 starting players.', path: ['players'] });
        const parsed = schema.safeParse(request.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const match = await client.query('SELECT id FROM matches WHERE id = $1 AND (home_team_id = $2 OR away_team_id = $2)', [parsed.data.matchId, parsed.data.teamId]);
            if (!match.rowCount) {
                await client.query('ROLLBACK');
                return reply.code(400).send({ error: 'team_not_in_match', message: 'Choose a team that is playing in the selected match.' });
            }
            const playerIds = parsed.data.players.map((player) => player.playerId);
            const roster = await client.query('SELECT id FROM players WHERE team_id = $1 AND id = ANY($2::uuid[])', [parsed.data.teamId, playerIds]);
            if (roster.rowCount !== playerIds.length) {
                await client.query('ROLLBACK');
                return reply.code(400).send({ error: 'player_not_in_team', message: 'Every selected player must belong to the selected team.' });
            }
            await client.query('DELETE FROM match_lineups WHERE match_id = $1 AND team_id = $2', [parsed.data.matchId, parsed.data.teamId]);
            for (const player of parsed.data.players) {
                await client.query(`INSERT INTO match_lineups
             (match_id, team_id, player_id, is_starting, shirt_number, position, formation, published)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
                    parsed.data.matchId,
                    parsed.data.teamId,
                    player.playerId,
                    player.isStarting,
                    player.shirtNumber,
                    player.position,
                    parsed.data.formation,
                    parsed.data.published,
                ]);
            }
            await client.query('COMMIT');
            return reply.code(200).send({ data: { matchId: parsed.data.matchId, teamId: parsed.data.teamId, count: playerIds.length } });
        }
        catch (error) {
            await client.query('ROLLBACK');
            request.log.error({ err: error }, 'admin lineup batch save failed');
            return reply.code(409).send({ error: 'lineup_not_saved', message: 'The full line-up could not be saved.' });
        }
        finally {
            client.release();
        }
    });
    registerImageRoutes(app, authorize, '/api/v1/admin/venue-images', '/api/v1/venue-images', venueImageDirectory, publicApiBaseUrl, 'venue');
    registerImageRoutes(app, authorize, '/api/v1/admin/player-images', '/api/v1/player-images', playerImageDirectory, publicApiBaseUrl, 'player');
    const moderationStatus = z.enum(['pending', 'published', 'hidden', 'removed']);
    const moderationUpdate = z.object({ status: moderationStatus }).strict();
    for (const resource of ['community-posts', 'community-comments']) {
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
            if (!pool)
                return reply.code(503).send({ error: 'database_not_configured' });
            try {
                const result = await pool.query(query);
                return { data: result.rows, meta: { count: result.rowCount, limit: 250 } };
            }
            catch (error) {
                request.log.error({ err: error, resource }, 'community moderation list failed');
                return reply.code(503).send({ error: 'data_unavailable' });
            }
        });
        app.patch(`/api/v1/admin/${resource}/:id`, { preHandler: authorize }, async (request, reply) => {
            if (!pool)
                return reply.code(503).send({ error: 'database_not_configured' });
            if (!uuid.safeParse(request.params.id).success)
                return reply.code(400).send({ error: 'invalid_id' });
            const parsed = moderationUpdate.safeParse(request.body);
            if (!parsed.success)
                return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
            try {
                const result = await pool.query(`UPDATE ${table} SET status = $1 WHERE id = $2 RETURNING id, status`, [parsed.data.status, request.params.id]);
                if (!result.rowCount)
                    return reply.code(404).send({ error: 'record_not_found' });
                return { data: result.rows[0] };
            }
            catch (error) {
                request.log.error({ err: error, resource }, 'community moderation update failed');
                return reply.code(409).send({ error: 'record_not_updated' });
            }
        });
    }
    const reportStatus = z.enum(['open', 'resolved', 'dismissed']);
    app.get('/api/v1/admin/community-reports', { preHandler: authorize }, async (request, reply) => {
        if (!pool)
            return reply.code(503).send({ error: 'database_not_configured' });
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
        }
        catch (error) {
            request.log.error({ err: error }, 'community reports list failed');
            return reply.code(503).send({ error: 'data_unavailable' });
        }
    });
    app.patch('/api/v1/admin/community-reports/:id', { preHandler: authorize }, async (request, reply) => {
        if (!pool)
            return reply.code(503).send({ error: 'database_not_configured' });
        if (!uuid.safeParse(request.params.id).success)
            return reply.code(400).send({ error: 'invalid_id' });
        const parsed = z.object({ status: reportStatus }).strict().safeParse(request.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
        try {
            const result = await pool.query('UPDATE content_reports SET status = $1 WHERE id = $2 RETURNING id, status', [parsed.data.status, request.params.id]);
            if (!result.rowCount)
                return reply.code(404).send({ error: 'record_not_found' });
            return { data: result.rows[0] };
        }
        catch (error) {
            request.log.error({ err: error }, 'community report update failed');
            return reply.code(409).send({ error: 'record_not_updated' });
        }
    });
    app.get('/api/v1/admin/overview', { preHandler: authorize }, async (request, reply) => {
        if (!pool)
            return reply.code(503).send({ error: 'database_not_configured' });
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
        }
        catch (error) {
            request.log.error({ err: error }, 'admin dashboard overview failed');
            return reply.code(503).send({ error: 'data_unavailable' });
        }
    });
    app.get('/api/v1/admin/:resource', { preHandler: authorize }, async (request, reply) => {
        if (!pool)
            return reply.code(503).send({ error: 'database_not_configured' });
        if (!isCollection(request.params.resource))
            return reply.code(404).send({ error: 'unknown_resource' });
        const collection = collections[request.params.resource];
        try {
            const limit = Math.min(Math.max(Number(request.query.limit ?? 100) || 100, 1), 250);
            const sql = request.params.resource === 'matches'
                ? `SELECT m.*, home.name AS home_team, away.name AS away_team, c.name AS competition_name
           FROM matches m JOIN teams home ON home.id = m.home_team_id
           JOIN teams away ON away.id = m.away_team_id
           JOIN competitions c ON c.id = m.competition_id
           ORDER BY m.kickoff_at DESC LIMIT $1`
                : request.params.resource === 'lineups'
                    ? `SELECT l.*, p.name AS player_name, p.photo_url, t.name AS team_name,
                    m.kickoff_at, home.name AS home_team, away.name AS away_team
             FROM match_lineups l
             JOIN players p ON p.id = l.player_id
             JOIN teams t ON t.id = l.team_id
             JOIN matches m ON m.id = l.match_id
             JOIN teams home ON home.id = m.home_team_id
             JOIN teams away ON away.id = m.away_team_id
             ORDER BY m.kickoff_at DESC, l.team_id, l.is_starting DESC, l.shirt_number
             LIMIT $1`
                    : `SELECT * FROM ${collection.table} ORDER BY ${collection.order} LIMIT $1`;
            const result = await pool.query(sql, [limit]);
            return { data: result.rows, meta: { count: result.rowCount, limit } };
        }
        catch (error) {
            request.log.error({ err: error, resource: request.params.resource }, 'admin list failed');
            return reply.code(503).send({ error: 'data_unavailable' });
        }
    });
    app.post('/api/v1/admin/:resource', { preHandler: authorize }, async (request, reply) => {
        if (!pool)
            return reply.code(503).send({ error: 'database_not_configured' });
        if (!isCollection(request.params.resource))
            return reply.code(404).send({ error: 'unknown_resource' });
        const collection = collections[request.params.resource];
        const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
            ? request.body
            : {};
        const createBody = request.params.resource === 'competitions' &&
            typeof body.name === 'string' &&
            typeof body.season === 'string' &&
            (typeof body.slug !== 'string' || body.slug.trim() === '')
            ? { ...body, slug: competitionSlug(body.name.trim(), body.season.trim()) }
            : request.body;
        const parsed = collection.create.safeParse(createBody);
        if (!parsed.success)
            return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
        const values = Object.entries(parsed.data).filter(([, value]) => value !== undefined);
        const columns = values.map(([key]) => collection.fields[key]);
        try {
            const placeholders = values.map((_, index) => `$${index + 1}`);
            const result = await pool.query(`INSERT INTO ${collection.table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`, values.map(([, value]) => value));
            return reply.code(201).send({ data: result.rows[0] });
        }
        catch (error) {
            request.log.error({ err: error, resource: request.params.resource }, 'admin create failed');
            return reply.code(409).send({ error: 'record_not_created', message: 'Check unique values and linked IDs.' });
        }
    });
    app.patch('/api/v1/admin/:resource/:id', { preHandler: authorize }, async (request, reply) => {
        if (!pool)
            return reply.code(503).send({ error: 'database_not_configured' });
        if (!isCollection(request.params.resource))
            return reply.code(404).send({ error: 'unknown_resource' });
        if (request.params.resource === 'match-statistics') {
            const separator = request.params.id.lastIndexOf(':');
            const matchId = request.params.id.slice(0, separator);
            const statistic = decodeURIComponent(request.params.id.slice(separator + 1));
            if (separator < 0 || !uuid.safeParse(matchId).success)
                return reply.code(400).send({ error: 'invalid_id' });
            const parsed = collections['match-statistics'].create.partial().safeParse(request.body);
            if (!parsed.success)
                return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
            const values = Object.entries(parsed.data).filter(([key, value]) => value !== undefined && !['matchId', 'statistic'].includes(key));
            if (!values.length)
                return reply.code(400).send({ error: 'empty_update' });
            const assignments = values.map(([key], index) => `${collections['match-statistics'].fields[key]} = $${index + 1}`);
            try {
                const result = await pool.query(`UPDATE match_statistics SET ${assignments.join(', ')} WHERE match_id = $${values.length + 1} AND statistic = $${values.length + 2} RETURNING *`, [...values.map(([, value]) => value), matchId, statistic]);
                if (!result.rowCount)
                    return reply.code(404).send({ error: 'record_not_found' });
                return { data: result.rows[0] };
            }
            catch (error) {
                request.log.error({ err: error, resource: request.params.resource }, 'admin statistics update failed');
                return reply.code(409).send({ error: 'record_not_updated' });
            }
        }
        if (!uuid.safeParse(request.params.id).success)
            return reply.code(400).send({ error: 'invalid_id' });
        const collection = collections[request.params.resource];
        const parsed = collection.create.partial().safeParse(request.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
        const values = Object.entries(parsed.data).filter(([, value]) => value !== undefined);
        if (!values.length)
            return reply.code(400).send({ error: 'empty_update' });
        const assignments = values.map(([key], index) => `${collection.fields[key]} = $${index + 1}`);
        try {
            const result = await pool.query(`UPDATE ${collection.table} SET ${assignments.join(', ')} WHERE id = $${values.length + 1} RETURNING *`, [...values.map(([, value]) => value), request.params.id]);
            if (!result.rowCount)
                return reply.code(404).send({ error: 'record_not_found' });
            return { data: result.rows[0] };
        }
        catch (error) {
            request.log.error({ err: error, resource: request.params.resource }, 'admin update failed');
            return reply.code(409).send({ error: 'record_not_updated', message: 'Check values and linked IDs.' });
        }
    });
    app.delete('/api/v1/admin/:resource/:id', { preHandler: authorize }, async (request, reply) => {
        if (!pool)
            return reply.code(503).send({ error: 'database_not_configured' });
        if (!isCollection(request.params.resource))
            return reply.code(404).send({ error: 'unknown_resource' });
        if (request.params.resource === 'match-statistics') {
            const separator = request.params.id.lastIndexOf(':');
            const matchId = request.params.id.slice(0, separator);
            const statistic = decodeURIComponent(request.params.id.slice(separator + 1));
            if (separator < 0 || !uuid.safeParse(matchId).success)
                return reply.code(400).send({ error: 'invalid_id' });
            try {
                const result = await pool.query('DELETE FROM match_statistics WHERE match_id = $1 AND statistic = $2 RETURNING statistic', [matchId, statistic]);
                if (!result.rowCount)
                    return reply.code(404).send({ error: 'record_not_found' });
                return reply.code(204).send();
            }
            catch (error) {
                request.log.error({ err: error, resource: request.params.resource }, 'admin statistics delete failed');
                return reply.code(409).send({ error: 'record_not_deleted' });
            }
        }
        if (!uuid.safeParse(request.params.id).success)
            return reply.code(400).send({ error: 'invalid_id' });
        const collection = collections[request.params.resource];
        try {
            const result = await pool.query(`DELETE FROM ${collection.table} WHERE id = $1 RETURNING id`, [request.params.id]);
            if (!result.rowCount)
                return reply.code(404).send({ error: 'record_not_found' });
            return reply.code(204).send();
        }
        catch (error) {
            request.log.error({ err: error, resource: request.params.resource }, 'admin delete failed');
            return reply.code(409).send({ error: 'record_not_deleted', message: 'This record is still linked to other tournament data.' });
        }
    });
}

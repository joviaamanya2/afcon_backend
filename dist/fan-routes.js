import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { authenticateFan, fanUser, optionalFanUser } from "./fan-auth.js";
const uuid = z.string().uuid();
const mediaSchema = z.object({
    url: z.string().url().max(2048).refine((value) => {
        try {
            return ['http:', 'https:'].includes(new URL(value).protocol);
        }
        catch {
            return false;
        }
    }),
    type: z.enum(['image', 'video']),
}).strict();
const postCreateSchema = z.object({
    content: z.string().trim().max(2000),
    media: z.array(mediaSchema).max(4).default([]),
}).strict().refine((post) => post.content.length > 0 || post.media.some((item) => localUploadId(item.url) !== undefined), { message: 'Provide content or at least one uploaded media item.' });
const postUpdateSchema = z.object({
    content: z.string().trim().min(1).max(2000).optional(),
    media: z.array(mediaSchema).max(4).optional(),
}).strict().refine((value) => value.content !== undefined || value.media !== undefined);
const postParamsSchema = z.object({ id: uuid });
const feedQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
});
const mimeTypes = {
    'image/jpeg': { type: 'image', extension: 'jpg', maxBytes: 8 * 1024 * 1024 },
    'image/png': { type: 'image', extension: 'png', maxBytes: 8 * 1024 * 1024 },
    'image/webp': { type: 'image', extension: 'webp', maxBytes: 8 * 1024 * 1024 },
    'image/gif': { type: 'image', extension: 'gif', maxBytes: 8 * 1024 * 1024 },
    'video/mp4': { type: 'video', extension: 'mp4', maxBytes: 15 * 1024 * 1024 },
    'video/webm': { type: 'video', extension: 'webm', maxBytes: 15 * 1024 * 1024 },
    'video/quicktime': { type: 'video', extension: 'mov', maxBytes: 15 * 1024 * 1024 },
};
const postSelect = `
  SELECT p.id, p.user_id AS "userId", u.display_name AS "displayName", p.body AS content,
         p.created_at AS "createdAt", p.status,
         (SELECT COUNT(*)::int FROM community_post_likes l WHERE l.post_id = p.id) AS "likesCount",
         (SELECT COUNT(*)::int FROM community_comments c
          WHERE c.post_id = p.id
            AND (c.status = 'published' OR (c.user_id = $1::uuid AND c.status = 'pending'))
         ) AS "commentsCount",
         EXISTS (
           SELECT 1 FROM community_post_likes l
           WHERE l.post_id = p.id AND l.user_id = $1::uuid
         ) AS "likedByMe",
         COALESCE((
           SELECT json_agg(json_build_object('url', pm.url, 'type', pm.media_type) ORDER BY pm.position)
           FROM community_post_media pm WHERE pm.post_id = p.id
         ), '[]'::json) AS media
  FROM community_posts p
  JOIN app_users u ON u.id = p.user_id`;
function localUploadId(url) {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/api\/v1\/community\/media\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/i);
    return match?.[1];
}
async function validateMediaOwnership(client, userId, media) {
    const ids = [...new Set(media.map((item) => localUploadId(item.url)).filter((id) => Boolean(id)))];
    const invalidMediaPath = media.some((item) => {
        const pathname = new URL(item.url).pathname;
        return pathname.includes('/api/v1/community/media/') && !localUploadId(item.url);
    });
    if (invalidMediaPath)
        return false;
    if (!ids.length)
        return true;
    const { rows } = await client.query('SELECT id, mime_type FROM community_media_uploads WHERE id = ANY($1::uuid[]) AND owner_id = $2', [ids, userId]);
    if (rows.length !== ids.length)
        return false;
    const mediaById = new Map(rows.map((row) => [row.id, mimeTypes[row.mime_type].type]));
    return media.every((item) => {
        const id = localUploadId(item.url);
        return !id || mediaById.get(id) === item.type;
    });
}
async function savePostMedia(client, postId, media) {
    for (const [position, item] of media.entries()) {
        await client.query('INSERT INTO community_post_media (post_id, position, url, media_type) VALUES ($1, $2, $3, $4)', [postId, position, item.url, item.type]);
    }
}
async function getPost(pool, postId, userId) {
    const { rows } = await pool.query(`${postSelect} WHERE p.id = $2`, [userId, postId]);
    return rows[0];
}
function requestUserId(request) {
    return fanUser(request).id;
}
export function registerFanRoutes(app, pool, secret, mediaDirectory, publicApiBaseUrl) {
    const auth = authenticateFan(pool, secret);
    const optionalAuth = optionalFanUser(pool, secret);
    const uploadHandler = async (request, reply) => {
        const schema = z.object({
            contentType: z.string().toLowerCase().optional(),
            mimeType: z.string().toLowerCase().optional(),
            filename: z.string().trim().min(1).max(255),
            data: z.string().min(4),
        }).strict().refine((value) => Boolean(value.contentType || value.mimeType));
        const parsed = schema.safeParse(request.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
        const mimeType = (parsed.data.contentType ?? parsed.data.mimeType);
        const mime = mimeTypes[mimeType];
        if (!mime)
            return reply.code(415).send({ error: 'unsupported_media_type' });
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(parsed.data.data)) {
            return reply.code(400).send({ error: 'invalid_base64_data' });
        }
        const buffer = Buffer.from(parsed.data.data, 'base64');
        if (!buffer.length || buffer.length > mime.maxBytes) {
            return reply.code(413).send({ error: 'media_size_exceeded', maxBytes: mime.maxBytes });
        }
        if (!pool)
            return reply.code(503).send({ error: 'database_not_configured' });
        const id = randomUUID();
        const storageKey = `${id}.${mime.extension}`;
        const filePath = path.join(mediaDirectory, storageKey);
        try {
            await mkdir(mediaDirectory, { recursive: true });
            await writeFile(filePath, buffer, { flag: 'wx' });
            const { rows } = await pool.query(`INSERT INTO community_media_uploads (id, owner_id, storage_key, mime_type, size_bytes)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`, [id, requestUserId(request), storageKey, mimeType, buffer.length]);
            if (!rows[0])
                throw new Error('upload metadata was not saved');
            const baseUrl = publicApiBaseUrl?.replace(/\/+$/, '') ?? `${request.protocol}://${request.headers.host}`;
            const url = `${baseUrl}/api/v1/community/media/${id}`;
            return reply.code(201).send({ data: { id, url, type: mime.type } });
        }
        catch (error) {
            await rm(filePath, { force: true }).catch(() => undefined);
            request.log.error({ err: error }, 'community media upload failed');
            return reply.code(503).send({ error: 'media_upload_unavailable' });
        }
    };
    app.post('/api/v1/community/uploads', {
        preHandler: auth,
        bodyLimit: 21 * 1024 * 1024,
    }, uploadHandler);
    app.get('/api/v1/community/media/:id', async (request, reply) => {
        if (!pool)
            return reply.code(503).send({ error: 'database_not_configured' });
        if (!uuid.safeParse(request.params.id).success)
            return reply.code(404).send({ error: 'media_not_found' });
        try {
            const { rows } = await pool.query('SELECT storage_key, mime_type, size_bytes FROM community_media_uploads WHERE id = $1', [request.params.id]);
            const upload = rows[0];
            if (!upload || !new RegExp(`^${request.params.id}\\.(jpg|png|webp|gif|mp4|webm|mov)$`).test(upload.storage_key)) {
                return reply.code(404).send({ error: 'media_not_found' });
            }
            const file = await readFile(path.join(mediaDirectory, upload.storage_key));
            return reply
                .type(upload.mime_type)
                .header('Content-Length', upload.size_bytes)
                .header('Cache-Control', 'public, max-age=31536000, immutable')
                .send(file);
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return reply.code(404).send({ error: 'media_not_found' });
            request.log.error({ err: error }, 'community media retrieval failed');
            return reply.code(503).send({ error: 'media_unavailable' });
        }
    });
    app.get('/api/v1/community/posts', { preHandler: optionalAuth }, async (request, reply) => {
        if (!pool)
            return reply.code(503).send({ error: 'database_not_configured' });
        const parsed = feedQuerySchema.safeParse(request.query);
        if (!parsed.success)
            return reply.code(400).send({ error: 'invalid_query', details: parsed.error.flatten() });
        const userId = request.headers.authorization ? requestUserId(request) : null;
        try {
            const { rows } = await pool.query(`${postSelect}
         WHERE p.status = 'published'
            OR ($1::uuid IS NOT NULL AND p.user_id = $1 AND p.status = 'pending')
         ORDER BY p.created_at DESC
         LIMIT $2`, [userId, parsed.data.limit]);
            return { data: rows, meta: { count: rows.length, limit: parsed.data.limit } };
        }
        catch (error) {
            request.log.error({ err: error }, 'community feed query failed');
            return reply.code(503).send({ error: 'community_unavailable' });
        }
    });
    app.post('/api/v1/community/posts', { preHandler: auth }, async (request, reply) => {
        const parsed = postCreateSchema.safeParse(request.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
        if (!pool)
            return reply.code(503).send({ error: 'database_not_configured' });
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            if (!(await validateMediaOwnership(client, requestUserId(request), parsed.data.media))) {
                await client.query('ROLLBACK');
                return reply.code(403).send({ error: 'media_not_owned' });
            }
            const { rows } = await client.query(`INSERT INTO community_posts (user_id, body, status)
         VALUES ($1, $2, 'published') RETURNING id`, [requestUserId(request), parsed.data.content]);
            const postId = rows[0].id;
            await savePostMedia(client, postId, parsed.data.media);
            await client.query('COMMIT');
            return reply.code(201).send({ data: await getPost(pool, postId, requestUserId(request)) });
        }
        catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            request.log.error({ err: error }, 'community post creation failed');
            return reply.code(503).send({ error: 'community_unavailable' });
        }
        finally {
            client.release();
        }
    });
    app.patch('/api/v1/community/posts/:id', { preHandler: auth }, async (request, reply) => {
        const params = postParamsSchema.safeParse(request.params);
        if (!params.success)
            return reply.code(400).send({ error: 'invalid_id' });
        const parsed = postUpdateSchema.safeParse(request.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
        if (!pool)
            return reply.code(503).send({ error: 'database_not_configured' });
        const userId = requestUserId(request);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            if (parsed.data.media && !(await validateMediaOwnership(client, userId, parsed.data.media))) {
                await client.query('ROLLBACK');
                return reply.code(403).send({ error: 'media_not_owned' });
            }
            const updated = await client.query(`UPDATE community_posts
         SET body = COALESCE($1, body),
             status = 'published'
         WHERE id = $2 AND user_id = $3 AND status IN ('pending', 'published')
         RETURNING id`, [parsed.data.content ?? null, params.data.id, userId]);
            if (!updated.rowCount) {
                await client.query('ROLLBACK');
                const exists = await pool.query('SELECT 1 FROM community_posts WHERE id = $1', [params.data.id]);
                return exists.rowCount ? reply.code(403).send({ error: 'post_not_owned' }) : reply.code(404).send({ error: 'post_not_found' });
            }
            if (parsed.data.media) {
                await client.query('DELETE FROM community_post_media WHERE post_id = $1', [params.data.id]);
                await savePostMedia(client, params.data.id, parsed.data.media);
            }
            await client.query('COMMIT');
            return { data: await getPost(pool, params.data.id, userId) };
        }
        catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            request.log.error({ err: error }, 'community post update failed');
            return reply.code(503).send({ error: 'community_unavailable' });
        }
        finally {
            client.release();
        }
    });
    app.delete('/api/v1/community/posts/:id', { preHandler: auth }, async (request, reply) => {
        if (!uuid.safeParse(request.params.id).success)
            return reply.code(400).send({ error: 'invalid_id' });
        if (!pool)
            return reply.code(503).send({ error: 'database_not_configured' });
        try {
            const result = await pool.query('DELETE FROM community_posts WHERE id = $1 AND user_id = $2 RETURNING id', [request.params.id, requestUserId(request)]);
            if (!result.rowCount) {
                const exists = await pool.query('SELECT 1 FROM community_posts WHERE id = $1', [request.params.id]);
                return exists.rowCount ? reply.code(403).send({ error: 'post_not_owned' }) : reply.code(404).send({ error: 'post_not_found' });
            }
            return reply.code(204).send();
        }
        catch (error) {
            request.log.error({ err: error }, 'community post deletion failed');
            return reply.code(503).send({ error: 'community_unavailable' });
        }
    });
    app.put('/api/v1/community/posts/:id/like', { preHandler: auth }, async (request, reply) => {
        if (!uuid.safeParse(request.params.id).success)
            return reply.code(400).send({ error: 'invalid_id' });
        if (!pool)
            return reply.code(503).send({ error: 'database_not_configured' });
        try {
            const result = await pool.query(`INSERT INTO community_post_likes (post_id, user_id)
         SELECT id, $2 FROM community_posts
         WHERE id = $1 AND status = 'published'
         ON CONFLICT (post_id, user_id) DO NOTHING
         RETURNING post_id`, [request.params.id, requestUserId(request)]);
            if (!result.rowCount) {
                const post = await pool.query('SELECT 1 FROM community_posts WHERE id = $1 AND status = $2', [request.params.id, 'published']);
                if (!post.rowCount)
                    return reply.code(404).send({ error: 'post_not_found' });
            }
            return { data: { liked: true } };
        }
        catch (error) {
            request.log.error({ err: error }, 'community post like failed');
            return reply.code(503).send({ error: 'community_unavailable' });
        }
    });
    app.delete('/api/v1/community/posts/:id/like', { preHandler: auth }, async (request, reply) => {
        if (!uuid.safeParse(request.params.id).success)
            return reply.code(400).send({ error: 'invalid_id' });
        if (!pool)
            return reply.code(503).send({ error: 'database_not_configured' });
        try {
            const post = await pool.query('SELECT 1 FROM community_posts WHERE id = $1 AND status = $2', [request.params.id, 'published']);
            if (!post.rowCount)
                return reply.code(404).send({ error: 'post_not_found' });
            await pool.query('DELETE FROM community_post_likes WHERE post_id = $1 AND user_id = $2', [request.params.id, requestUserId(request)]);
            return reply.code(204).send();
        }
        catch (error) {
            request.log.error({ err: error }, 'community post unlike failed');
            return reply.code(503).send({ error: 'community_unavailable' });
        }
    });
    const commentParams = z.object({ id: uuid });
    app.get('/api/v1/community/posts/:id/comments', { preHandler: optionalAuth }, async (request, reply) => {
        const params = commentParams.safeParse(request.params);
        if (!params.success)
            return reply.code(400).send({ error: 'invalid_id' });
        if (!pool)
            return reply.code(503).send({ error: 'database_not_configured' });
        const userId = request.headers.authorization ? requestUserId(request) : null;
        try {
            const { rows } = await pool.query(`SELECT c.id, c.user_id AS "userId", u.display_name AS "displayName",
                c.body AS content, c.status, c.created_at AS "createdAt"
         FROM community_comments c
         JOIN app_users u ON u.id = c.user_id
         JOIN community_posts p ON p.id = c.post_id
         WHERE c.post_id = $1
           AND (p.status = 'published' OR (p.user_id = $2::uuid AND p.status = 'pending'))
           AND (c.status = 'published' OR (c.user_id = $2::uuid AND c.status = 'pending'))
         ORDER BY c.created_at ASC`, [params.data.id, userId]);
            return { data: rows, meta: { count: rows.length } };
        }
        catch (error) {
            request.log.error({ err: error }, 'community comments query failed');
            return reply.code(503).send({ error: 'community_unavailable' });
        }
    });
    app.post('/api/v1/community/posts/:id/comments', { preHandler: auth }, async (request, reply) => {
        const params = commentParams.safeParse(request.params);
        if (!params.success)
            return reply.code(400).send({ error: 'invalid_id' });
        const parsed = z.object({ content: z.string().trim().min(1).max(1000) }).strict().safeParse(request.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
        if (!pool)
            return reply.code(503).send({ error: 'database_not_configured' });
        try {
            const { rows } = await pool.query(`INSERT INTO community_comments (post_id, user_id, body, status)
         SELECT p.id, $2, $3, 'pending'
         FROM community_posts p
         WHERE p.id = $1
           AND (p.status = 'published' OR (p.user_id = $2 AND p.status = 'pending'))
         RETURNING id, body AS content, status, created_at AS "createdAt"`, [params.data.id, requestUserId(request), parsed.data.content]);
            if (!rows[0])
                return reply.code(404).send({ error: 'post_not_found' });
            return reply.code(201).send({
                data: {
                    ...rows[0],
                    userId: requestUserId(request),
                    displayName: fanUser(request).displayName,
                },
            });
        }
        catch (error) {
            request.log.error({ err: error }, 'community comment creation failed');
            return reply.code(503).send({ error: 'community_unavailable' });
        }
    });
    app.delete('/api/v1/community/posts/:id/comments/:commentId', { preHandler: auth }, async (request, reply) => {
        const params = z.object({ id: uuid, commentId: uuid }).safeParse(request.params);
        if (!params.success)
            return reply.code(400).send({ error: 'invalid_id' });
        if (!pool)
            return reply.code(503).send({ error: 'database_not_configured' });
        try {
            const result = await pool.query('DELETE FROM community_comments WHERE id = $1 AND post_id = $2 AND user_id = $3 RETURNING id', [params.data.commentId, params.data.id, requestUserId(request)]);
            if (!result.rowCount)
                return reply.code(404).send({ error: 'comment_not_found' });
            return reply.code(204).send();
        }
        catch (error) {
            request.log.error({ err: error }, 'community comment deletion failed');
            return reply.code(503).send({ error: 'community_unavailable' });
        }
    });
    app.post('/api/v1/community/posts/:id/reports', { preHandler: auth }, async (request, reply) => {
        const params = commentParams.safeParse(request.params);
        if (!params.success)
            return reply.code(400).send({ error: 'invalid_id' });
        const parsed = z.object({ reason: z.string().trim().min(3).max(500) }).strict().safeParse(request.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
        if (!pool)
            return reply.code(503).send({ error: 'database_not_configured' });
        try {
            const { rows } = await pool.query(`INSERT INTO content_reports (reporter_id, post_id, reason)
         SELECT $2, p.id, $3
         FROM community_posts p
         WHERE p.id = $1
           AND (p.status = 'published' OR (p.user_id = $2 AND p.status = 'pending'))
         RETURNING id, status, created_at AS "createdAt"`, [params.data.id, requestUserId(request), parsed.data.reason]);
            if (!rows[0])
                return reply.code(404).send({ error: 'post_not_found' });
            return reply.code(201).send({ data: rows[0] });
        }
        catch (error) {
            request.log.error({ err: error }, 'community post report failed');
            return reply.code(503).send({ error: 'community_unavailable' });
        }
    });
    app.get('/api/v1/account/follows', { preHandler: auth }, async (request, reply) => {
        if (!pool)
            return reply.code(503).send({ error: 'database_not_configured' });
        try {
            const { rows } = await pool.query(`SELECT t.id, t.name, t.short_name AS "shortName", t.crest_url AS "crestUrl",
                f.created_at AS "createdAt"
         FROM user_follows f JOIN teams t ON t.id = f.team_id
         WHERE f.user_id = $1 ORDER BY t.name`, [requestUserId(request)]);
            return { data: rows };
        }
        catch (error) {
            request.log.error({ err: error }, 'team follows query failed');
            return reply.code(503).send({ error: 'account_unavailable' });
        }
    });
    app.put('/api/v1/account/follows/:teamId', { preHandler: auth }, async (request, reply) => {
        if (!uuid.safeParse(request.params.teamId).success)
            return reply.code(400).send({ error: 'invalid_team_id' });
        if (!pool)
            return reply.code(503).send({ error: 'database_not_configured' });
        try {
            const result = await pool.query(`INSERT INTO user_follows (user_id, team_id)
         SELECT $1, id FROM teams WHERE id = $2 AND published = TRUE
         ON CONFLICT (user_id, team_id) DO NOTHING`, [requestUserId(request), request.params.teamId]);
            if (!result.rowCount) {
                const existing = await pool.query('SELECT 1 FROM user_follows WHERE user_id = $1 AND team_id = $2', [requestUserId(request), request.params.teamId]);
                if (!existing.rowCount)
                    return reply.code(404).send({ error: 'team_not_found' });
            }
            return { data: { teamId: request.params.teamId, followed: true } };
        }
        catch (error) {
            request.log.error({ err: error }, 'team follow update failed');
            return reply.code(503).send({ error: 'account_unavailable' });
        }
    });
    app.delete('/api/v1/account/follows/:teamId', { preHandler: auth }, async (request, reply) => {
        if (!uuid.safeParse(request.params.teamId).success)
            return reply.code(400).send({ error: 'invalid_team_id' });
        if (!pool)
            return reply.code(503).send({ error: 'database_not_configured' });
        try {
            await pool.query('DELETE FROM user_follows WHERE user_id = $1 AND team_id = $2', [requestUserId(request), request.params.teamId]);
            return reply.code(204).send();
        }
        catch (error) {
            request.log.error({ err: error }, 'team unfollow failed');
            return reply.code(503).send({ error: 'account_unavailable' });
        }
    });
    const defaultPreferences = {
        matchReminders: true,
        kickoffChanges: true,
        teamNews: false,
        tournamentNews: true,
        quietHoursStart: null,
        quietHoursEnd: null,
    };
    const preferenceSchema = z.object({
        matchReminders: z.boolean().optional(),
        kickoffChanges: z.boolean().optional(),
        teamNews: z.boolean().optional(),
        tournamentNews: z.boolean().optional(),
        quietHoursStart: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
        quietHoursEnd: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
    }).strict().refine((value) => Object.keys(value).length > 0);
    app.get('/api/v1/account/notification-preferences', { preHandler: auth }, async (request, reply) => {
        if (!pool)
            return reply.code(503).send({ error: 'database_not_configured' });
        try {
            const { rows } = await pool.query(`SELECT match_reminders AS "matchReminders", kickoff_changes AS "kickoffChanges",
                team_news AS "teamNews", tournament_news AS "tournamentNews",
                quiet_hours_start AS "quietHoursStart", quiet_hours_end AS "quietHoursEnd"
         FROM notification_preferences WHERE user_id = $1`, [requestUserId(request)]);
            return { data: rows[0] ?? defaultPreferences };
        }
        catch (error) {
            request.log.error({ err: error }, 'notification preference query failed');
            return reply.code(503).send({ error: 'account_unavailable' });
        }
    });
    app.put('/api/v1/account/notification-preferences', { preHandler: auth }, async (request, reply) => {
        const parsed = preferenceSchema.safeParse(request.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
        if (!pool)
            return reply.code(503).send({ error: 'database_not_configured' });
        const settings = parsed.data;
        try {
            const { rows } = await pool.query(`INSERT INTO notification_preferences (
           user_id, match_reminders, kickoff_changes, team_news, tournament_news, quiet_hours_start, quiet_hours_end
         ) VALUES (
           $1, COALESCE($2, TRUE), COALESCE($3, TRUE), COALESCE($4, FALSE), COALESCE($5, TRUE), $6::time, $7::time
         )
         ON CONFLICT (user_id) DO UPDATE SET
           match_reminders = COALESCE($2, notification_preferences.match_reminders),
           kickoff_changes = COALESCE($3, notification_preferences.kickoff_changes),
           team_news = COALESCE($4, notification_preferences.team_news),
           tournament_news = COALESCE($5, notification_preferences.tournament_news),
           quiet_hours_start = CASE WHEN $8 THEN $6::time ELSE notification_preferences.quiet_hours_start END,
           quiet_hours_end = CASE WHEN $9 THEN $7::time ELSE notification_preferences.quiet_hours_end END
         RETURNING match_reminders AS "matchReminders", kickoff_changes AS "kickoffChanges",
                   team_news AS "teamNews", tournament_news AS "tournamentNews",
                   quiet_hours_start AS "quietHoursStart", quiet_hours_end AS "quietHoursEnd"`, [
                requestUserId(request),
                settings.matchReminders ?? null,
                settings.kickoffChanges ?? null,
                settings.teamNews ?? null,
                settings.tournamentNews ?? null,
                settings.quietHoursStart ?? null,
                settings.quietHoursEnd ?? null,
                Object.hasOwn(settings, 'quietHoursStart'),
                Object.hasOwn(settings, 'quietHoursEnd'),
            ]);
            return { data: rows[0] };
        }
        catch (error) {
            request.log.error({ err: error }, 'notification preference update failed');
            return reply.code(503).send({ error: 'account_unavailable' });
        }
    });
}

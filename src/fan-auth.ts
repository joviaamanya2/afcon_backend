import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHmac } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';

const tokenIssuer = 'afcon-fan-api';
const tokenLifetimeSeconds = 7 * 24 * 60 * 60;

function derivePasswordKey(password: string, salt: Buffer, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, {
      N: 16384,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    }, (error, key) => error ? reject(error) : resolve(key as Buffer));
  });
}

export type FanUser = { id: string; email: string; displayName: string };
type AuthenticatedRequest = FastifyRequest & { fanUser?: FanUser };

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function issueToken(userId: string, secret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = encodeJson({ alg: 'HS256', typ: 'JWT' });
  const payload = encodeJson({ iss: tokenIssuer, sub: userId, iat: now, exp: now + tokenLifetimeSeconds });
  const signingInput = `${header}.${payload}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

function verifyToken(token: string, secret: string): string | undefined {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return undefined;
  const [headerPart, payloadPart, signaturePart] = parts;
  const expected = createHmac('sha256', secret).update(`${headerPart}.${payloadPart}`).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signaturePart, 'base64url');
    const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as { alg?: unknown; typ?: unknown };
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as {
      iss?: unknown; sub?: unknown; iat?: unknown; exp?: unknown;
    };
    const now = Math.floor(Date.now() / 1000);
    if (
      header.alg !== 'HS256' || header.typ !== 'JWT' ||
      payload.iss !== tokenIssuer ||
      typeof payload.sub !== 'string' || !z.string().uuid().safeParse(payload.sub).success ||
      typeof payload.iat !== 'number' || payload.iat > now + 60 ||
      typeof payload.exp !== 'number' || payload.exp <= now
    ) return undefined;
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
    return payload.sub;
  } catch {
    return undefined;
  }
}

export function authenticateFan(pool: Pool | undefined, secret: string | undefined): preHandlerHookHandler {
  return async (request, reply) => {
    const authorization = request.headers.authorization;
    const match = authorization?.match(/^Bearer ([^\s]+)$/i);
    if (!secret) return reply.code(503).send({ error: 'auth_not_configured' });
    if (!match) {
      reply.header('WWW-Authenticate', 'Bearer');
      return reply.code(401).send({ error: 'authentication_required' });
    }
    if (!pool) return reply.code(503).send({ error: 'database_not_configured' });
    const userId = verifyToken(match[1]!, secret);
    if (!userId) {
      reply.header('WWW-Authenticate', 'Bearer');
      return reply.code(401).send({ error: 'invalid_token' });
    }
    try {
      const { rows } = await pool.query<FanUser>(
        `SELECT id, email, display_name AS "displayName"
         FROM app_users WHERE id = $1 AND password_hash IS NOT NULL`,
        [userId],
      );
      if (!rows[0]) {
        reply.header('WWW-Authenticate', 'Bearer');
        return reply.code(401).send({ error: 'invalid_token' });
      }
      (request as AuthenticatedRequest).fanUser = rows[0];
    } catch (error) {
      request.log.error({ err: error }, 'fan authentication lookup failed');
      return reply.code(503).send({ error: 'authentication_unavailable' });
    }
  };
}

export function fanUser(request: FastifyRequest): FanUser {
  return (request as AuthenticatedRequest).fanUser!;
}

export function optionalFanUser(pool: Pool | undefined, secret: string | undefined): preHandlerHookHandler {
  const authenticate = authenticateFan(pool, secret);
  return async (request, reply) => {
    if (!request.headers.authorization) return;
    await authenticate.call(request.server, request, reply, () => undefined);
  };
}

const registerSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
  password: z.string().min(12).max(128),
}).strict();
const loginSchema = z.object({
  email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
  password: z.string().min(1).max(128),
}).strict();

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derivePasswordKey(password, salt, 64);
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

async function checkPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt' || parts[1] !== '16384' || parts[2] !== '8' || parts[3] !== '1') return false;
  try {
    const salt = Buffer.from(parts[4]!, 'base64url');
    const expected = Buffer.from(parts[5]!, 'base64url');
    const actual = await derivePasswordKey(password, salt, expected.length);
    return expected.length === actual.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function registerFanAuthRoutes(app: FastifyInstance, pool: Pool | undefined, secret: string | undefined): void {
  app.post('/api/v1/auth/register', async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
    if (!pool) return reply.code(503).send({ error: 'database_not_configured' });
    if (!secret) return reply.code(503).send({ error: 'auth_not_configured', message: 'Configure AUTH_TOKEN_SECRET to enable fan accounts.' });
    try {
      const passwordHash = await hashPassword(parsed.data.password);
      const { rows } = await pool.query<FanUser>(
        `INSERT INTO app_users (email, display_name, password_hash)
         VALUES ($1, $2, $3)
         RETURNING id, email, display_name AS "displayName"`,
        [parsed.data.email, parsed.data.name, passwordHash],
      );
      const user = rows[0]!;
      return reply.code(201).send({ data: { token: issueToken(user.id, secret), user } });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        return reply.code(409).send({ error: 'email_already_registered' });
      }
      request.log.error({ err: error }, 'fan registration failed');
      return reply.code(503).send({ error: 'registration_unavailable' });
    }
  });

  app.post('/api/v1/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
    if (!pool) return reply.code(503).send({ error: 'database_not_configured' });
    if (!secret) return reply.code(503).send({ error: 'auth_not_configured', message: 'Configure AUTH_TOKEN_SECRET to enable fan accounts.' });
    try {
      const { rows } = await pool.query<FanUser & { password_hash: string | null }>(
        `SELECT id, email, display_name AS "displayName", password_hash
         FROM app_users WHERE LOWER(email) = $1`,
        [parsed.data.email],
      );
      const user = rows[0];
      if (!user?.password_hash || !(await checkPassword(parsed.data.password, user.password_hash))) {
        return reply.code(401).send({ error: 'invalid_credentials' });
      }
      const { password_hash: _passwordHash, ...publicUser } = user;
      return { data: { token: issueToken(user.id, secret), user: publicUser } };
    } catch (error) {
      request.log.error({ err: error }, 'fan login failed');
      return reply.code(503).send({ error: 'login_unavailable' });
    }
  });

  app.get('/api/v1/auth/me', { preHandler: authenticateFan(pool, secret) }, async (request) => ({
    data: { user: fanUser(request) },
  }));

  app.patch('/api/v1/auth/me', { preHandler: authenticateFan(pool, secret) }, async (request, reply) => {
    const parsed = z.object({ displayName: z.string().trim().min(1).max(80) }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
    if (!pool) return reply.code(503).send({ error: 'database_not_configured' });
    try {
      const { rows } = await pool.query<FanUser>(
        `UPDATE app_users SET display_name = $1
         WHERE id = $2 AND password_hash IS NOT NULL
         RETURNING id, email, display_name AS "displayName"`,
        [parsed.data.displayName, fanUser(request).id],
      );
      if (!rows[0]) return reply.code(404).send({ error: 'user_not_found' });
      return { data: { user: rows[0] } };
    } catch (error) {
      request.log.error({ err: error }, 'fan profile update failed');
      return reply.code(503).send({ error: 'profile_update_unavailable' });
    }
  });
}

import { describe, expect, it } from 'vitest';
import { prisma } from '../src/prisma.js';
import { createUser, request } from './helpers.js';

interface HasHeaders {
  headers: Record<string, unknown>;
}

function setCookies(response: HasHeaders): string[] {
  const raw = response.headers['set-cookie'];
  return Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : [];
}

function readCookie(response: HasHeaders, name: string): string | null {
  const found = setCookies(response).find((cookie) => cookie.startsWith(`${name}=`));
  if (!found) return null;
  return (found.split(';')[0] ?? '').slice(name.length + 1);
}

describe('POST /api/auth/register', () => {
  it('is removed — accounts are created by an administrator only', async () => {
    await request()
      .post('/api/auth/register')
      .send({
        email: 'new.user@example.test',
        password: 'correct-horse-battery-staple',
        firstName: 'New',
        lastName: 'User',
      })
      .expect(404);
  });
});

describe('POST /api/auth/login', () => {
  it('signs in with the right password', async () => {
    const user = await createUser();

    const response = await request()
      .post('/api/auth/login')
      .send({ email: user.email, password: user.password })
      .expect(200);

    expect(response.body.user.id).toBe(user.id);
  });

  it('gives the same 401 for a wrong password and an unknown account', async () => {
    const user = await createUser();

    const wrongPassword = await request()
      .post('/api/auth/login')
      .send({ email: user.email, password: 'not-the-right-password' })
      .expect(401);

    const unknownUser = await request()
      .post('/api/auth/login')
      .send({ email: 'nobody@example.test', password: 'not-the-right-password' })
      .expect(401);

    // Identical wording: the response must not reveal which emails exist.
    expect(wrongPassword.body.error.message).toBe(unknownUser.body.error.message);
  });
});

describe('GET /api/auth/me', () => {
  it('returns the signed-in account', async () => {
    const user = await createUser();
    const response = await user.agent.get('/api/auth/me').expect(200);
    expect(response.body.user.email).toBe(user.email);
  });

  it('401s without credentials', async () => {
    const response = await request().get('/api/auth/me').expect(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });

  it('401s on a forged token', async () => {
    await request()
      .get('/api/auth/me')
      .set('Cookie', ['ge_access=not.a.jwt'])
      .expect(401);
  });
});

describe('POST /api/auth/refresh', () => {
  it('issues a new session and rotates the refresh token', async () => {
    const user = await createUser();

    const first = await user.agent.post('/api/auth/refresh').expect(200);
    expect(first.body.user.id).toBe(user.id);

    // The rotated cookie is now in the agent's jar; the session still works.
    await user.agent.get('/api/auth/me').expect(200);
  });

  it('revokes the whole family when an already-used token is replayed', async () => {
    const user = await createUser();
    const login = await request()
      .post('/api/auth/login')
      .send({ email: user.email, password: user.password })
      .expect(200);

    const first = readCookie(login, 'ge_refresh');
    expect(first).toBeTruthy();

    // Legitimate rotation: the first token is spent, a second is issued.
    const rotation = await request()
      .post('/api/auth/refresh')
      .set('Cookie', [`ge_refresh=${first}`])
      .expect(200);

    const second = readCookie(rotation, 'ge_refresh');
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);

    // Within moments of the rotation, a replay is two tabs renewing at once:
    // told to retry, nothing revoked, and the cookies are left alone.
    const race = await request()
      .post('/api/auth/refresh')
      .set('Cookie', [`ge_refresh=${first}`])
      .expect(409);
    expect(race.body.error.code).toBe('REFRESH_RACE');
    expect(readCookie(race, 'ge_refresh')).toBeNull();

    // Later than that, replaying the spent token is the signature of a stolen cookie.
    await prisma.refreshToken.updateMany({
      where: { userId: user.id, rotatedAt: { not: null } },
      data: { rotatedAt: new Date(Date.now() - 60_000) },
    });
    await request()
      .post('/api/auth/refresh')
      .set('Cookie', [`ge_refresh=${first}`])
      .expect(401);

    // ...so the token issued by the legitimate rotation is revoked too, ending
    // the session for both the thief and the victim.
    await request()
      .post('/api/auth/refresh')
      .set('Cookie', [`ge_refresh=${second}`])
      .expect(401);
  });

  it('401s on a refresh token that was never issued', async () => {
    await request()
      .post('/api/auth/refresh')
      .set('Cookie', ['ge_refresh=clearly-not-a-real-token'])
      .expect(401);
  });

  it('401s with no refresh cookie at all', async () => {
    await request().post('/api/auth/refresh').expect(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the cookies and ends the session', async () => {
    const user = await createUser();
    await user.agent.get('/api/auth/me').expect(200);

    await user.agent.post('/api/auth/logout').expect(204);

    // The access cookie is cleared, so the agent is anonymous again.
    await user.agent.get('/api/auth/me').expect(401);
  });

  it('is not an error when called twice', async () => {
    const user = await createUser();
    await user.agent.post('/api/auth/logout').expect(204);
    await user.agent.post('/api/auth/logout').expect(204);
  });
});

import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { createTestService } from './helpers.js';

describe('web authentication', () => {
  it('registers, verifies, persists a cookie session, logs out, and signs in again', async () => {
    const { service, workspaceDatabase, verificationNotices } = createTestService({ exposeDevelopmentVerificationCode: true });
    const app = await buildApp(service);

    const registrationResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { displayName: 'Alice', email: 'Alice@Example.com', password: 'correct-password' },
    });
    expect(registrationResponse.statusCode).toBe(202);
    const registration = registrationResponse.json<{
      registrationId: string;
      verifiedEmail: string;
      developmentVerificationCode?: string;
    }>();
    expect(registration.verifiedEmail).toBe('alice@example.com');
    expect(verificationNotices).toHaveLength(1);
    expect(registration.developmentVerificationCode).toBe(verificationNotices[0]!.code);

    const rejectedLogin = await app.inject({
      method: 'POST', url: '/v1/auth/login', payload: { email: 'alice@example.com', password: 'correct-password' },
    });
    expect(rejectedLogin.statusCode).toBe(403);
    expect(rejectedLogin.json<{ error: { code: string } }>().error.code).toBe('EMAIL_NOT_VERIFIED');

    const invalidCode = await app.inject({
      method: 'POST', url: '/v1/auth/verify-email', payload: { registrationId: registration.registrationId, code: '000000' },
    });
    expect(invalidCode.statusCode).toBe(400);
    expect(workspaceDatabase.raw.prepare('SELECT attempts_remaining FROM email_verification_challenges WHERE id = ?')
      .get(registration.registrationId)).toEqual({ attempts_remaining: 4 });

    const verified = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { registrationId: registration.registrationId, code: verificationNotices[0]!.code },
    });
    expect(verified.statusCode).toBe(200);
    const setCookie = verified.headers['set-cookie'];
    expect(setCookie).toContain('anc_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    const cookie = String(setCookie).split(';', 1)[0]!;

    const session = await app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie } });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ displayName: 'Alice', verifiedEmail: 'alice@example.com' });
    expect((await app.inject({ method: 'GET', url: '/v1/workspaces', headers: { cookie } })).statusCode).toBe(200);

    const tokenRows = workspaceDatabase.raw.prepare("SELECT token_hash FROM api_tokens WHERE label = 'web-session'").all() as Array<{ token_hash: string }>;
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0]!.token_hash).toHaveLength(64);
    expect(String(setCookie)).not.toContain(tokenRows[0]!.token_hash);

    expect((await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie } })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie } })).statusCode).toBe(401);

    const login = await app.inject({
      method: 'POST', url: '/v1/auth/login', payload: { email: 'alice@example.com', password: 'correct-password' },
    });
    expect(login.statusCode).toBe(200);
    expect(login.headers['set-cookie']).toContain('anc_session=');
    await app.close();
  });

  it('does not expose the verification code unless development display is enabled', async () => {
    const { service, verificationNotices } = createTestService();
    const app = await buildApp(service);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { displayName: 'Bob', email: 'bob@example.com', password: 'correct-password' },
    });

    expect(response.statusCode).toBe(202);
    expect(verificationNotices).toHaveLength(1);
    expect(response.json()).not.toHaveProperty('developmentVerificationCode');
    await app.close();
  });

  it('refreshes an unfinished registration instead of trapping the email in pending verification', async () => {
    const { service, workspaceDatabase, verificationNotices } = createTestService({ exposeDevelopmentVerificationCode: true });
    const app = await buildApp(service);
    const first = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { displayName: 'Old Name', email: 'pending@example.com', password: 'old-password' },
    });
    const firstRegistration = first.json<{ registrationId: string; developmentVerificationCode: string }>();

    const refreshed = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { displayName: 'New Name', email: 'pending@example.com', password: 'new-password' },
    });
    expect(refreshed.statusCode).toBe(202);
    const refreshedRegistration = refreshed.json<{ registrationId: string; developmentVerificationCode: string }>();
    expect(refreshedRegistration.registrationId).not.toBe(firstRegistration.registrationId);
    expect(verificationNotices).toHaveLength(2);
    expect(workspaceDatabase.raw.prepare('SELECT consumed_at FROM email_verification_challenges WHERE id = ?')
      .get(firstRegistration.registrationId)).toMatchObject({ consumed_at: expect.any(Number) });

    const staleVerification = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { registrationId: firstRegistration.registrationId, code: firstRegistration.developmentVerificationCode },
    });
    expect(staleVerification.statusCode).toBe(409);
    expect(staleVerification.json<{ error: { code: string } }>().error.code).toBe('VERIFICATION_CODE_EXPIRED');

    const verification = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: {
        registrationId: refreshedRegistration.registrationId,
        code: refreshedRegistration.developmentVerificationCode,
      },
    });
    expect(verification.statusCode).toBe(200);
    expect(verification.json()).toMatchObject({ displayName: 'New Name', verifiedEmail: 'pending@example.com' });

    const newLogin = await app.inject({
      method: 'POST', url: '/v1/auth/login', payload: { email: 'pending@example.com', password: 'new-password' },
    });
    expect(newLogin.statusCode).toBe(200);
    const oldLogin = await app.inject({
      method: 'POST', url: '/v1/auth/login', payload: { email: 'pending@example.com', password: 'old-password' },
    });
    expect(oldLogin.statusCode).toBe(401);
    await app.close();
  });
});

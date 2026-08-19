import { argon2, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { DomainError, invariant } from '../lib/errors.js';
import { issueToken, newId, nowMs, sha256 } from '../lib/values.js';
import { SqliteDatabase } from '../storage/database.js';

const PASSWORD_MEMORY_KIB = 19_456;
const PASSWORD_PASSES = 2;
const PASSWORD_PARALLELISM = 2;
const PASSWORD_TAG_LENGTH = 32;
const VERIFICATION_LIFETIME_MS = 10 * 60 * 1000;
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionHuman {
  id: string;
  displayName: string;
  verifiedEmail: string;
}

export interface VerificationCodeNotice {
  registrationId: string;
  verifiedEmail: string;
  code: string;
  expiresAt: number;
}

export type VerificationCodeSink = (notice: VerificationCodeNotice) => void;

export interface AuthenticatedSession {
  human: SessionHuman;
  token: string;
  expiresAt: number;
}

export interface VerificationChallengeResponse {
  registrationId: string;
  verifiedEmail: string;
  verificationExpiresAt: number;
  developmentVerificationCode?: string;
}

interface CredentialRow {
  actor_id: string;
  display_name: string;
  verified_email: string;
  status: 'pending_verification' | 'active' | 'disabled';
  password_hash: string;
}

interface ChallengeRow {
  id: string;
  human_actor_id: string;
  code_hash: string;
  attempts_remaining: number;
  expires_at: number;
  consumed_at: number | null;
  display_name: string;
  verified_email: string;
  status: 'pending_verification' | 'active' | 'disabled';
}

export function consoleVerificationCodeSink(notice: VerificationCodeNotice): void {
  process.stderr.write(
    `[auth] verification email=${notice.verifiedEmail} registration=${notice.registrationId} code=${notice.code} expiresAt=${notice.expiresAt}\n`,
  );
}

export class AuthService {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly verificationCodeSink: VerificationCodeSink = consoleVerificationCodeSink,
    private readonly exposeDevelopmentVerificationCode = false,
  ) {}

  async register(input: { displayName: string; email: string; password: string }): Promise<VerificationChallengeResponse> {
    const displayName = input.displayName.trim();
    const verifiedEmail = normalizeEmail(input.email);
    validateDisplayName(displayName);
    validatePassword(input.password);

    const existing = this.database.raw
      .prepare('SELECT actor_id, status FROM humans WHERE verified_email = ?')
      .get(verifiedEmail) as { actor_id: string; status: 'pending_verification' | 'active' | 'disabled' } | undefined;
    const passwordHash = await hashPassword(input.password);
    const timestamp = nowMs();
    if (existing?.status === 'pending_verification') {
      const challenge = createChallenge(existing.actor_id, verifiedEmail, timestamp);
      this.database.transaction(() => {
        this.database.raw.prepare('UPDATE humans SET display_name = ? WHERE actor_id = ?')
          .run(displayName, existing.actor_id);
        this.database.raw.prepare(
          'UPDATE human_password_credentials SET password_hash = ?, updated_at = ? WHERE human_actor_id = ?',
        ).run(passwordHash, timestamp, existing.actor_id);
        this.database.raw
          .prepare('UPDATE email_verification_challenges SET consumed_at = ? WHERE human_actor_id = ? AND consumed_at IS NULL')
          .run(timestamp, existing.actor_id);
        insertChallenge(this.database, challenge);
      });
      this.verificationCodeSink(challenge.notice);
      return {
        registrationId: challenge.id,
        verifiedEmail,
        verificationExpiresAt: challenge.expiresAt,
        ...(this.exposeDevelopmentVerificationCode ? { developmentVerificationCode: challenge.notice.code } : {}),
      };
    }
    invariant(!existing, 'EMAIL_ALREADY_REGISTERED', 'This email is already registered.', 409);

    const humanId = newId();
    const challenge = createChallenge(humanId, verifiedEmail, timestamp);
    this.database.transaction(() => {
      this.database.raw.prepare("INSERT INTO actors (id, actor_type, created_at) VALUES (?, 'human', ?)").run(humanId, timestamp);
      this.database.raw
        .prepare(
          `INSERT INTO humans (actor_id, display_name, verified_email, status, created_at)
           VALUES (?, ?, ?, 'pending_verification', ?)`,
        )
        .run(humanId, displayName, verifiedEmail, timestamp);
      this.database.raw
        .prepare(
          `INSERT INTO human_password_credentials (human_actor_id, password_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(humanId, passwordHash, timestamp, timestamp);
      insertChallenge(this.database, challenge);
    });
    this.verificationCodeSink(challenge.notice);
    return {
      registrationId: challenge.id,
      verifiedEmail,
      verificationExpiresAt: challenge.expiresAt,
      ...(this.exposeDevelopmentVerificationCode ? { developmentVerificationCode: challenge.notice.code } : {}),
    };
  }

  resendVerification(registrationId: string): VerificationChallengeResponse {
    const current = this.requireChallenge(registrationId);
    invariant(current.status === 'pending_verification', 'EMAIL_ALREADY_VERIFIED', 'This email is already verified.', 409);
    const timestamp = nowMs();
    const challenge = createChallenge(current.human_actor_id, current.verified_email, timestamp);
    this.database.transaction(() => {
      this.database.raw
        .prepare('UPDATE email_verification_challenges SET consumed_at = ? WHERE human_actor_id = ? AND consumed_at IS NULL')
        .run(timestamp, current.human_actor_id);
      insertChallenge(this.database, challenge);
    });
    this.verificationCodeSink(challenge.notice);
    return {
      registrationId: challenge.id,
      verifiedEmail: current.verified_email,
      verificationExpiresAt: challenge.expiresAt,
      ...(this.exposeDevelopmentVerificationCode ? { developmentVerificationCode: challenge.notice.code } : {}),
    };
  }

  verifyEmail(registrationId: string, code: string): AuthenticatedSession {
    const outcome = this.database.transaction<
      | { ok: true; session: AuthenticatedSession }
      | { ok: false; code: string; message: string; statusCode: number }
    >(() => {
      const challenge = this.requireChallenge(registrationId);
      const timestamp = nowMs();
      if (challenge.status !== 'pending_verification') {
        return { ok: false, code: 'EMAIL_ALREADY_VERIFIED', message: 'This email is already verified.', statusCode: 409 };
      }
      if (challenge.consumed_at !== null || challenge.expires_at <= timestamp) {
        return { ok: false, code: 'VERIFICATION_CODE_EXPIRED', message: 'The verification code has expired.', statusCode: 409 };
      }
      if (challenge.attempts_remaining <= 0) {
        return { ok: false, code: 'VERIFICATION_ATTEMPTS_EXHAUSTED', message: 'Verification attempts are exhausted.', statusCode: 409 };
      }
      if (challenge.code_hash !== verificationCodeHash(registrationId, code.trim())) {
        this.database.raw
          .prepare('UPDATE email_verification_challenges SET attempts_remaining = attempts_remaining - 1 WHERE id = ?')
          .run(registrationId);
        return { ok: false, code: 'INVALID_VERIFICATION_CODE', message: 'The verification code is invalid.', statusCode: 400 };
      }

      this.database.raw.prepare("UPDATE humans SET status = 'active' WHERE actor_id = ?").run(challenge.human_actor_id);
      this.database.raw.prepare('UPDATE email_verification_challenges SET consumed_at = ? WHERE id = ?').run(timestamp, registrationId);
      return {
        ok: true,
        session: this.issueSession(
          {
            id: challenge.human_actor_id,
            displayName: challenge.display_name,
            verifiedEmail: challenge.verified_email,
          },
          timestamp,
        ),
      };
    });
    if (!outcome.ok) throw new DomainError(outcome.code, outcome.message, outcome.statusCode);
    return outcome.session;
  }

  async login(email: string, password: string): Promise<AuthenticatedSession> {
    const verifiedEmail = normalizeEmail(email);
    validatePassword(password);
    const credential = this.database.raw
      .prepare(
        `SELECT h.actor_id, h.display_name, h.verified_email, h.status, c.password_hash
         FROM humans h
         JOIN human_password_credentials c ON c.human_actor_id = h.actor_id
         WHERE h.verified_email = ?`,
      )
      .get(verifiedEmail) as CredentialRow | undefined;
    invariant(credential, 'INVALID_LOGIN', 'Email or password is incorrect.', 401);
    invariant(credential.status !== 'pending_verification', 'EMAIL_NOT_VERIFIED', 'Verify your email before signing in.', 403);
    invariant(credential.status === 'active', 'ACCOUNT_DISABLED', 'This account is disabled.', 403);
    invariant(await verifyPassword(password, credential.password_hash), 'INVALID_LOGIN', 'Email or password is incorrect.', 401);
    return this.database.transaction(() => this.issueSession({
      id: credential.actor_id,
      displayName: credential.display_name,
      verifiedEmail: credential.verified_email,
    }, nowMs()));
  }

  getSession(rawToken: string): SessionHuman {
    const row = this.database.raw
      .prepare(
        `SELECT h.actor_id, h.display_name, h.verified_email
         FROM api_tokens t
         JOIN humans h ON h.actor_id = t.human_actor_id
         WHERE t.token_hash = ? AND t.principal_type = 'human' AND t.status = 'active'
           AND h.status = 'active' AND (t.expires_at IS NULL OR t.expires_at > ?)`,
      )
      .get(sha256(rawToken), nowMs()) as { actor_id: string; display_name: string; verified_email: string } | undefined;
    invariant(row, 'UNAUTHORIZED', 'The session is invalid or expired.', 401);
    return { id: row.actor_id, displayName: row.display_name, verifiedEmail: row.verified_email };
  }

  logout(rawToken: string): void {
    const timestamp = nowMs();
    this.database.raw
      .prepare(
        `UPDATE api_tokens SET status = 'revoked', revoked_at = ?
         WHERE token_hash = ? AND principal_type = 'human' AND status = 'active'`,
      )
      .run(timestamp, sha256(rawToken));
  }

  private requireChallenge(registrationId: string): ChallengeRow {
    const row = this.database.raw
      .prepare(
        `SELECT v.*, h.display_name, h.verified_email, h.status
         FROM email_verification_challenges v
         JOIN humans h ON h.actor_id = v.human_actor_id
         WHERE v.id = ?`,
      )
      .get(registrationId) as ChallengeRow | undefined;
    invariant(row, 'REGISTRATION_NOT_FOUND', 'Registration does not exist.', 404);
    return row;
  }

  private issueSession(human: SessionHuman, timestamp: number): AuthenticatedSession {
    const token = issueToken();
    const expiresAt = timestamp + SESSION_LIFETIME_MS;
    this.database.raw
      .prepare(
        `INSERT INTO api_tokens (
           id, principal_type, human_actor_id, token_hash, label, status, created_at, expires_at
         ) VALUES (?, 'human', ?, ?, 'web-session', 'active', ?, ?)`,
      )
      .run(newId(), human.id, token.hash, timestamp, expiresAt);
    return { human, token: token.raw, expiresAt };
  }
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  invariant(email.length >= 3 && email.length <= 320 && email.includes('@'), 'INVALID_EMAIL', 'A valid email is required.');
  return email;
}

function validateDisplayName(value: string): void {
  invariant(value.length >= 1 && value.length <= 120, 'INVALID_DISPLAY_NAME', 'Display name is required.');
}

function validatePassword(value: string): void {
  invariant(value.length >= 10 && value.length <= 128, 'INVALID_PASSWORD', 'Password must contain 10 to 128 characters.');
}

async function derivePassword(password: string, salt: Buffer, parameters = {
  memory: PASSWORD_MEMORY_KIB,
  passes: PASSWORD_PASSES,
  parallelism: PASSWORD_PARALLELISM,
  tagLength: PASSWORD_TAG_LENGTH,
}): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    argon2('argon2id', { message: password, nonce: salt, ...parameters }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derivePassword(password, salt);
  return [
    'argon2id',
    String(PASSWORD_MEMORY_KIB),
    String(PASSWORD_PASSES),
    String(PASSWORD_PARALLELISM),
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('$');
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, memoryText, passesText, parallelismText, saltText, hashText] = encoded.split('$');
  if (algorithm !== 'argon2id' || !memoryText || !passesText || !parallelismText || !saltText || !hashText) return false;
  const expected = Buffer.from(hashText, 'base64url');
  const actual = await derivePassword(password, Buffer.from(saltText, 'base64url'), {
    memory: Number(memoryText),
    passes: Number(passesText),
    parallelism: Number(parallelismText),
    tagLength: expected.length,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function createChallenge(humanId: string, verifiedEmail: string, timestamp: number): {
  id: string;
  humanId: string;
  codeHash: string;
  expiresAt: number;
  timestamp: number;
  notice: VerificationCodeNotice;
} {
  const id = newId();
  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  const expiresAt = timestamp + VERIFICATION_LIFETIME_MS;
  return {
    id,
    humanId,
    codeHash: verificationCodeHash(id, code),
    expiresAt,
    timestamp,
    notice: { registrationId: id, verifiedEmail, code, expiresAt },
  };
}

function insertChallenge(database: SqliteDatabase, challenge: ReturnType<typeof createChallenge>): void {
  database.raw
    .prepare(
      `INSERT INTO email_verification_challenges (
         id, human_actor_id, code_hash, attempts_remaining, expires_at, consumed_at, created_at
       ) VALUES (?, ?, ?, 5, ?, NULL, ?)`,
    )
    .run(challenge.id, challenge.humanId, challenge.codeHash, challenge.expiresAt, challenge.timestamp);
}

function verificationCodeHash(registrationId: string, code: string): string {
  return sha256(`${registrationId}:${code}`);
}

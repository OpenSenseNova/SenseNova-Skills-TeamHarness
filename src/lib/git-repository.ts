import { invariant } from './errors.js';

export interface NormalizedGitRepository {
  cloneUrl: string;
  repositoryIdentity: string;
}

function normalizePath(rawPath: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath).replace(/^\/+|\/+$/gu, '').replace(/\.git$/u, '');
  } catch {
    invariant(false, 'INVALID_REPOSITORY_URL', 'Repository path is invalid.');
  }
  invariant(decoded.length > 0 && decoded.length <= 1500, 'INVALID_REPOSITORY_URL', 'Repository path is invalid.');
  invariant(!decoded.split('/').some((part) => part === '' || part === '.' || part === '..'),
    'INVALID_REPOSITORY_URL', 'Repository path is invalid.');
  return decoded;
}

export function normalizeGitCloneUrl(input: string): NormalizedGitRepository {
  const cloneUrl = input.trim();
  invariant(cloneUrl.length > 0 && cloneUrl.length <= 2000,
    'INVALID_REPOSITORY_URL', 'Repository clone URL is required.');
  invariant(!cloneUrl.startsWith('/') && !cloneUrl.startsWith('./') && !cloneUrl.startsWith('../'),
    'INVALID_REPOSITORY_URL', 'Local repository paths cannot be used as shared clone URLs.');

  const scp = /^(?<user>[A-Za-z0-9._-]+)@(?<host>[A-Za-z0-9.-]+):(?<path>[^?#]+)$/u.exec(cloneUrl);
  if (scp?.groups) {
    const host = scp.groups.host!.toLowerCase();
    const path = normalizePath(scp.groups.path!);
    return { cloneUrl, repositoryIdentity: `${host}/${path}` };
  }

  let parsed: URL;
  try {
    parsed = new URL(cloneUrl);
  } catch {
    invariant(false, 'INVALID_REPOSITORY_URL', 'Repository clone URL must use HTTPS or SSH.');
  }
  invariant(parsed.protocol === 'https:' || parsed.protocol === 'ssh:',
    'INVALID_REPOSITORY_URL', 'Repository clone URL must use HTTPS or SSH.');
  invariant(parsed.hash === '' && parsed.search === '',
    'INVALID_REPOSITORY_URL', 'Repository clone URL cannot contain a query or fragment.');
  invariant(parsed.password === '', 'INVALID_REPOSITORY_URL', 'Repository clone URL cannot contain a password or token.');
  invariant(parsed.protocol === 'ssh:' || parsed.username === '',
    'INVALID_REPOSITORY_URL', 'HTTPS Repository clone URL cannot contain credentials.');
  invariant(parsed.hostname.length > 0, 'INVALID_REPOSITORY_URL', 'Repository host is required.');
  const host = `${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ''}`;
  const path = normalizePath(parsed.pathname);
  return { cloneUrl, repositoryIdentity: `${host}/${path}` };
}

export function normalizeDefaultBranch(input: string): string {
  const branch = input.trim();
  const invalidCharacters = new Set([' ', '~', '^', ':', '?', '*', '[', '\\']);
  const hasInvalidCharacter = [...branch].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127 || invalidCharacters.has(character);
  });
  invariant(branch.length > 0 && branch.length <= 255, 'INVALID_DEFAULT_BRANCH', 'Default branch is required.');
  invariant(
    !branch.startsWith('-')
      && !branch.startsWith('/')
      && !branch.endsWith('/')
      && !branch.endsWith('.')
      && !branch.includes('..')
      && !branch.includes('@{')
      && !hasInvalidCharacter,
    'INVALID_DEFAULT_BRANCH',
    'Default branch is invalid.',
  );
  return branch;
}

/** Normalized error returned by Workspace API transports. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: unknown = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type ErrorPayload = { error?: { code?: string; message?: string; details?: unknown } };

export function commandKey(): string {
  if (typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function unwrap<T = unknown>(
  request: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const result = await request;
  if (result.data !== undefined || result.response.ok) return result.data as T;
  const error = result.error as ErrorPayload | undefined;
  throw new ApiError(
    result.response.status,
    error?.error?.code ?? 'REQUEST_FAILED',
    error?.error?.message ?? `请求失败（${result.response.status}）`,
    error?.error?.details,
  );
}

export async function readResponsePayload(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function errorFromPayload(status: number, payload: unknown): ApiError {
  const error = payload && typeof payload === 'object' && 'error' in payload
    ? (payload as ErrorPayload).error
    : undefined;
  return new ApiError(
    status,
    error?.code ?? 'REQUEST_FAILED',
    error?.message ?? `请求失败（${status}）`,
    error?.details,
  );
}

/** JSON transport for endpoints that are not yet represented by openapi-fetch. */
export async function requestJson<T>(input: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(input, { credentials: 'include', ...init });
  const payload = await readResponsePayload(response);
  if (response.ok) return payload as T;
  throw errorFromPayload(response.status, payload);
}

export async function requestBlob(input: string, init: RequestInit = {}): Promise<Blob> {
  const response = await fetch(input, { credentials: 'include', ...init });
  if (!response.ok) {
    throw errorFromPayload(response.status, await readResponsePayload(response));
  }
  return response.blob();
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const known: Record<string, string> = {
      INVALID_LOGIN: '邮箱或密码错误。',
      EMAIL_NOT_VERIFIED: '请先完成邮箱验证。',
      EMAIL_ALREADY_REGISTERED: '该邮箱已经注册，请直接登录。',
      INVALID_VERIFICATION_CODE: '验证码不正确。',
      VERIFICATION_CODE_EXPIRED: '验证码已过期，请重新发送。',
      STALE_REVISION: '内容已经发生变化，请刷新后重试。',
      CONVERSATION_VERSION_CONFLICT: '会话参与者已经变化，请刷新后重试。',
      WORKSPACE_MEMBERSHIP_REQUIRED: '你已经不再是这个 Workspace 的成员。',
      COMPUTER_OFFLINE: '这台计算机当前离线，请重新连接后再创建 Agent。',
      RUNTIME_UNAVAILABLE_ON_COMPUTER: '所选本地 Agent 在这台计算机上尚未就绪，请检查安装或登录状态后重试。',
      COMPUTER_NOT_FOUND: '这台计算机不存在、已停用或不属于当前账号。',
      CONVERSATION_CLOSED: '对方已不再是成员，这个私聊只能查看历史消息。',
    };
    return known[error.code] ?? `${error.message}（${error.code}）`;
  }
  return error instanceof Error ? error.message : '发生未知错误。';
}

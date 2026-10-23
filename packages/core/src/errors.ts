/**
 * Failure classes an adapter can report. The router (phase 1) decides fallback
 * from the kind alone, so adapters must map every provider error onto one.
 */
export type ProviderErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'unavailable'
  | 'refusal'
  | 'malformed'
  | 'bad_request'
  | 'cancelled'
  | 'budget';

const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set([
  'rate_limit',
  'unavailable',
  'refusal',
  'malformed',
]);

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly provider: string;
  readonly status: number | undefined;

  constructor(
    kind: ProviderErrorKind,
    provider: string,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ProviderError';
    this.kind = kind;
    this.provider = provider;
    this.status = options.status;
  }

  /** True when another model may succeed where this one failed. */
  get fallbackEligible(): boolean {
    return RETRYABLE.has(this.kind);
  }
}

/** Maps an HTTP status code onto an error kind. */
export function kindFromStatus(status: number): ProviderErrorKind {
  // A 2xx "error" is a stream that broke after the provider accepted it (review N2).
  if (status >= 200 && status < 300) return 'unavailable';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  // 402 out of credits, 404 retired model, 413 too large for this model: another
  // provider or model may well succeed, so these are fallback-eligible (review F12).
  if (MODEL_SPECIFIC.has(status) || status >= 500) return 'unavailable';
  return 'bad_request';
}

const MODEL_SPECIFIC: ReadonlySet<number> = new Set([402, 404, 408, 409, 413]);

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'APIUserAbortError');
}

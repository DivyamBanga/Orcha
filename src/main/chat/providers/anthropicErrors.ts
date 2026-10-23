import Anthropic, { type APIError } from '@anthropic-ai/sdk'
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { ProviderError, type ProviderErrorCode, type TokenUsage } from '../provider'

// What went wrong with a call to Anthropic, in plain words and as a code the
// chat can react to (offer another key, wait, explain).

// A limit the owner set in the Console. The API's own message says when
// access returns, so it is shown as it is.
const OWN_LIMIT = /^You have reached your specified (workspace )?API usage limits/i

interface ErrorBody {
  error?: { type?: string; message?: string; details?: { error_code?: string } }
}

// A reply the safety checks declined and no fallback model answered. It still
// costs tokens, which the usage ledger needs.
export class RefusalError extends ProviderError {
  constructor(
    message: string,
    public category: string | null,
    public recommendedModel: string | null,
    public usage: TokenUsage | null,
    public model: string | null
  ) {
    super(message, 'refused')
  }
}

export function refusalOf(
  final: Pick<BetaMessage, 'model' | 'stop_details'>,
  usage: TokenUsage | null
): RefusalError {
  const details = final.stop_details
  const why = details?.explanation ? ` ${details.explanation}` : ''
  return new RefusalError(
    `Claude declined to answer this one.${why} Try rephrasing it, or ask another model.`,
    details?.category ?? null,
    details?.recommended_model ?? null,
    usage,
    final.model
  )
}

function retryAfterMs(headers: Headers | undefined): number | null {
  const value = headers?.get('retry-after')
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000))
  const at = Date.parse(value)
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now())
}

function wait(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000))
  if (seconds < 90) return `${seconds} second${seconds === 1 ? '' : 's'}`
  return `${Math.ceil(seconds / 60)} minutes`
}

// `model` is only for the words of a "no such model" answer.
export function toProviderError(err: unknown, model?: string): ProviderError {
  if (err instanceof ProviderError) return err
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new ProviderError('Anthropic took too long to answer. Try again.', 'unreachable')
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError(
      "Couldn't reach Anthropic. Check your internet connection and try again.",
      'unreachable'
    )
  }
  if (err instanceof Anthropic.APIError) return fromApi(err, model)
  if (err instanceof Anthropic.AnthropicError) {
    // The SDK wraps a connection that broke mid-reply this way.
    const broke = err.cause != null || /stream ended|request ended/i.test(err.message)
    return broke
      ? new ProviderError(
          'The connection to Anthropic broke before the reply finished. Try again.',
          'unreachable'
        )
      : new ProviderError(err.message, 'unknown')
  }
  return new ProviderError(err instanceof Error ? err.message : String(err), 'unknown')
}

// An error answer, or one sent as an event in the middle of a reply (which has
// no status, only the type in its body).
function fromApi(err: APIError, model?: string): ProviderError {
  const body = (err.error ?? {}) as ErrorBody
  const kind = body.error?.type ?? err.type ?? ''
  const said = body.error?.message ?? ''
  const status = err.status ?? null
  const make = (
    message: string,
    code: ProviderErrorCode,
    retryAfter: number | null = null
  ): ProviderError => new ProviderError(message, code, retryAfter, status)
  const request = err.requestID ? ` (request ${err.requestID})` : ''

  if (status === 401 || kind === 'authentication_error') {
    return make(
      "Anthropic didn't accept this API key. It may be wrong, revoked or expired.",
      'auth'
    )
  }
  if (status === 403 || kind === 'permission_error') {
    return make(
      "This API key isn't allowed to do that. Check its permissions in the Anthropic Console.",
      'auth'
    )
  }
  if (status === 402 || kind === 'billing_error') {
    return make(
      'This API key is out of credit. Add credit in the Anthropic Console, or use another key.',
      'no-credit'
    )
  }
  if (status === 429 || kind === 'rate_limit_error') {
    // The monthly spend cap looks like a rate limit but has no retry-after and
    // keeps failing until access returns; its message says when.
    if (body.error?.details?.error_code === 'enforced_spend_limit_reached') {
      return make(said || 'This key has reached its monthly spend cap.', 'no-credit')
    }
    const after = retryAfterMs(err.headers)
    const soon = after === null ? 'Wait a little' : `Try again in ${wait(after)}`
    return make(
      `Anthropic is rate limiting this key. ${soon}, or use another key.`,
      'rate-limit',
      after
    )
  }
  if (status === 529 || kind === 'overloaded_error') {
    return make('Claude is overloaded right now. Try again in a moment.', 'overloaded')
  }
  if ((status ?? 0) >= 500 || kind === 'api_error' || kind === 'timeout_error') {
    const code = status ? ` (HTTP ${status})` : ''
    return make(`Anthropic had a problem on its side${code}. Try again in a moment.`, 'overloaded')
  }
  if (status === 404 || kind === 'not_found_error') {
    const which = model ? `“${model}”` : 'that model'
    return make(
      `Anthropic doesn't offer ${which} to this key. It may have been retired, or the key may not have access to it.`,
      'not-found'
    )
  }
  if (status === 413 || kind === 'request_too_large') {
    return make(
      'That was too much to send at once. Remove some attachments or start a new chat.',
      'bad-request'
    )
  }
  if (OWN_LIMIT.test(said)) return make(said, 'no-credit')
  if (/prompt is too long/i.test(said)) {
    return make('This chat is too long for the model to read in one go.', 'context-full')
  }
  if (status === 400 || kind === 'invalid_request_error') {
    return make(`Anthropic rejected the request: ${said || err.message}${request}`, 'bad-request')
  }
  return make(`Anthropic answered with an error: ${said || err.message}${request}`, 'unknown')
}

import { Hono } from 'hono'
import type { Context } from 'hono'
import { proxy } from 'hono/proxy'
import { timingSafeEqual } from 'hono/utils/buffer'

// テストの ProvidedEnv から参照するため export する
export type Bindings = {
  /** クライアントが Authorization: Bearer または x-api-key で送る任意のキー */
  API_KEY: string
  /** Cloudflare Access で保護された内部トンネルのホスト名（スキームなし） */
  TUNNEL_HOSTNAME: string
  /** Cloudflare Service Token Client ID */
  CF_CLIENT_ID: string
  /** Cloudflare Service Token Client Secret */
  CF_CLIENT_SECRET: string
}

type AppEnv = { Bindings: Bindings }

const app = new Hono<AppEnv>()

const UNAUTHORIZED_MESSAGE = 'Incorrect API key provided.'

/**
 * 上流（Cloudflare Tunnel / Access）が生成した HTML エラーページを、
 * クライアント SDK が解釈できる方言付き JSON エラーへ整形する際のメッセージ。
 */
const GATEWAY_TIMEOUT_MESSAGE =
  'Upstream did not respond in time (Cloudflare Proxy Read Timeout, ~125s). ' +
  'This usually means the model is still loading into memory, or the request used stream: false ' +
  'for a long-running generation. Use stream: true and keep the model warm on the upstream side.'
const BAD_GATEWAY_MESSAGE = 'Upstream (Cloudflare Tunnel / Access) is unreachable or rejected the request.'

/**
 * 上流の Anthropic 互換エンドポイント（Ollama / LM Studio）は x-api-key の
 * 存在を前提にするが値は検証しない。プロキシの API_KEY を上流へ渡さないため
 * ダミー値に差し替えて転送する。
 */
const UPSTREAM_API_KEY = 'local'

/**
 * Anthropic 互換クライアント（Anthropic SDK / Claude Code）は
 * パス /v1/messages・anthropic-version・x-api-key のいずれかを伴う。
 */
const isAnthropicDialect = (c: Context<AppEnv>) =>
  c.req.path.startsWith('/v1/messages') ||
  c.req.header('anthropic-version') !== undefined ||
  c.req.header('x-api-key') !== undefined

// Anthropic 互換のエラー形状。Anthropic SDK / Claude Code がメッセージを表示できる
const anthropicError = (message: string = UNAUTHORIZED_MESSAGE, type: string = 'authentication_error') => ({
  type: 'error',
  error: {
    type,
    message
  },
  request_id: `req_${crypto.randomUUID().replaceAll('-', '')}`
})

// OpenAI 互換のエラー形状。Cursor / OpenAI SDK がメッセージを表示できる
const openaiError = (
  message: string = UNAUTHORIZED_MESSAGE,
  type: string = 'invalid_request_error',
  code: string | null = 'invalid_api_key'
) => ({
  error: {
    message,
    type,
    param: null,
    code
  }
})

/**
 * 上流（Cloudflare Tunnel / Access）が返した Cloudflare 生成の HTML エラーページを判定する。
 * Ollama / LM Studio 自身が返すエラーは JSON なので content-type で確実に切り分けられる。
 */
const isCloudflareGeneratedError = (res: Response) => {
  const isErrorStatus = (res.status >= 520 && res.status <= 530) || res.status === 401 || res.status === 403
  if (!isErrorStatus) return false
  // application/problem+json や大文字小文字違いも JSON として扱う（+json サフィックスを含む）
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
  const mediaType = contentType.split(';', 1)[0].trim()
  const isJson = mediaType === 'application/json' || mediaType.endsWith('+json')
  return !isJson
}

/**
 * Cloudflare 生成のエラーページ（HTML）を、上流ステータスに応じた
 * 方言付き JSON エラーへ整形する。判定はヘッダーのみで完結するため、
 * ボディが流れ始めている通常の（成功・上流エラー問わず JSON の）レスポンスには影響しない。
 *
 * upstreamStatus が null の場合は、Worker からの fetch 自体が失敗しており
 * （Tunnel 到達不能など）実際の上流ステータスコードは存在しない。
 */
const upstreamErrorResponse = (c: Context<AppEnv>, upstreamStatus: number | null) => {
  // 524: first byte が Proxy Read Timeout（~125秒）以内に来なかった
  if (upstreamStatus === 524) {
    return c.json(
      isAnthropicDialect(c)
        ? anthropicError(GATEWAY_TIMEOUT_MESSAGE, 'timeout_error')
        : openaiError(GATEWAY_TIMEOUT_MESSAGE, 'server_error', null),
      504
    )
  }
  // 運用時の原因特定のため、実際の上流ステータスが分かる場合はメッセージに含める
  const message =
    upstreamStatus === null
      ? `${BAD_GATEWAY_MESSAGE} (fetch to upstream failed before a response was received)`
      : `${BAD_GATEWAY_MESSAGE} (upstream status: ${upstreamStatus})`
  return c.json(
    isAnthropicDialect(c) ? anthropicError(message, 'api_error') : openaiError(message, 'server_error', null),
    502
  )
}

app.use('/*', async (c, next) => {
  const key = c.env.API_KEY

  // OpenAI 互換は Authorization: Bearer、Anthropic 互換は x-api-key を送る。
  // 分岐で早期 return せず両方を評価してから判定する。
  const [byBearer, byApiKey] = await Promise.all([
    timingSafeEqual(`Bearer ${key}`, c.req.header('Authorization') ?? ''),
    timingSafeEqual(key, c.req.header('x-api-key') ?? '')
  ])

  if (!byBearer && !byApiKey) {
    return c.json(isAnthropicDialect(c) ? anthropicError() : openaiError(), 401, {
      // RFC 9110 は 401 に WWW-Authenticate を要求するため方言に関わらず付与する
      'WWW-Authenticate': 'Bearer error="invalid_token"'
    })
  }

  return next()
})

app.all('/*', async (c) => {
  // パス・クエリはそのまま、ホストだけ内部トンネルへ差し替える
  const url = new URL(c.req.url)
  url.protocol = 'https:'
  url.hostname = c.env.TUNNEL_HOSTNAME
  url.port = ''

  // Headers は大文字小文字を区別せず 1 名前につき値を1つに保つため、
  // プレーンオブジェクトのスプレッドで済ませず delete/set で明示的に組み立てる
  const headers = new Headers(c.req.raw.headers)
  headers.delete('authorization')
  headers.delete('cookie')
  headers.delete('host')
  headers.delete('cf-access-jwt-assertion')
  // プロキシのキーは渡さず、ヘッダーの存在だけ満たす
  headers.set('x-api-key', UPSTREAM_API_KEY)
  // Cloudflare Access Service Token 認証
  headers.set('CF-Access-Client-Id', c.env.CF_CLIENT_ID)
  headers.set('CF-Access-Client-Secret', c.env.CF_CLIENT_SECRET)

  let res: Response
  try {
    res = await proxy(url, {
      raw: c.req.raw, // method / body / duplex:'half' / signal を引き継ぐ
      headers
    })
  } catch {
    // Worker からの fetch 自体が失敗（Tunnel 到達不能など）。実際の上流ステータスは存在しない
    return upstreamErrorResponse(c, null)
  }

  // 524（Proxy Read Timeout）や Access 拒否の HTML ページはそのまま返さず、
  // クライアント SDK が解釈できる方言付き JSON エラーに整形する
  if (isCloudflareGeneratedError(res)) {
    return upstreamErrorResponse(c, res.status)
  }

  return res
})

export default app

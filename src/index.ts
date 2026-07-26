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
const anthropicError = () => ({
  type: 'error',
  error: {
    type: 'authentication_error',
    message: UNAUTHORIZED_MESSAGE
  },
  request_id: `req_${crypto.randomUUID().replaceAll('-', '')}`
})

// OpenAI 互換のエラー形状。Cursor / OpenAI SDK がメッセージを表示できる
const openaiError = () => ({
  error: {
    message: UNAUTHORIZED_MESSAGE,
    type: 'invalid_request_error',
    param: null,
    code: 'invalid_api_key'
  }
})

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

  return await next()
})

app.all('/*', (c) => {
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

  return proxy(url, {
    raw: c.req.raw, // method / body / duplex:'half' / signal を引き継ぐ
    headers
  })
})

export default app

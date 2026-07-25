import { Hono } from 'hono'
import { proxy } from 'hono/proxy'
import { timingSafeEqual } from 'hono/utils/buffer'

type Bindings = {
  /** クライアントが Authorization: Bearer で送る任意のキー */
  API_KEY: string
  /** Cloudflare Access で保護された内部トンネルのホスト名（スキームなし） */
  TUNNEL_HOSTNAME: string
  /** Cloudflare Service Token Client ID */
  CF_CLIENT_ID: string
  /** Cloudflare Service Token Client Secret */
  CF_CLIENT_SECRET: string
}

const app = new Hono<{ Bindings: Bindings }>()

// OpenAI 互換のエラー形状。Cursor / OpenAI SDK がメッセージを表示できる
const unauthorized = {
  error: {
    message: 'Incorrect API key provided.',
    type: 'invalid_request_error',
    param: null,
    code: 'invalid_api_key'
  }
} as const

app.use('/*', async (c, next) => {
  const expected = `Bearer ${c.env.API_KEY}`
  const actual = c.req.header('Authorization') ?? ''

  if (!(await timingSafeEqual(expected, actual))) {
    return c.json(unauthorized, 401, {
      'WWW-Authenticate': 'Bearer error="invalid_token"'
    })
  }

  await next()
})

app.all('/*', (c) => {
  // パス・クエリはそのまま、ホストだけ内部トンネルへ差し替える
  const url = new URL(c.req.url)
  url.protocol = 'https:'
  url.hostname = c.env.TUNNEL_HOSTNAME
  url.port = ''

  return proxy(url, {
    raw: c.req.raw, // method / body / duplex:'half' / signal を引き継ぐ
    headers: {
      ...c.req.header(),
      // 上流へ渡したくないヘッダー（undefined = 削除）
      authorization: undefined,
      cookie: undefined,
      host: undefined,
      'cf-access-jwt-assertion': undefined,
      // Cloudflare Access Service Token 認証
      'CF-Access-Client-Id': c.env.CF_CLIENT_ID,
      'CF-Access-Client-Secret': c.env.CF_CLIENT_SECRET
    }
  })
})

export default app

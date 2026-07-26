import { env, exports } from 'cloudflare:workers'
import { afterEach, describe, it, vi } from 'vitest'

afterEach(() => {
  vi.restoreAllMocks()
})

/** Worker のエントリーポイントへリクエストを送る。ホストはワーカー内で必ず上書きされるためダミー */
const request = (path: string, init?: RequestInit) => exports.default.fetch(`https://client.example.com${path}`, init)

/** 上流(Cloudflare Access で保護されたトンネル)への fetch をモックする */
const mockUpstream = (handler: (req: Request) => Response | Promise<Response>) => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => handler(new Request(input, init)))
}

/** 認証成功パスで使う、単に 200 を返すだけの上流モック */
const mockUpstreamOk = () =>
  mockUpstream(() => new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } }))

/** 401 で止まるはずのテストで、誤って上流に転送されていないかを検知するガード */
const mockUpstreamMustNotBeCalled = () =>
  mockUpstream(() => {
    throw new Error('upstream must not be called when authentication fails')
  })

describe('authentication', () => {
  it('allows requests with a valid Authorization: Bearer', async ({ expect }) => {
    mockUpstreamOk()
    const res = await request('/v1/models', {
      headers: { Authorization: `Bearer ${env.API_KEY}` }
    })
    expect(res.status).toBe(200)
  })

  it('allows requests with a valid x-api-key', async ({ expect }) => {
    mockUpstreamOk()
    const res = await request('/v1/messages', {
      headers: { 'x-api-key': env.API_KEY }
    })
    expect(res.status).toBe(200)
  })

  it('rejects requests with no auth header', async ({ expect }) => {
    mockUpstreamMustNotBeCalled()
    const res = await request('/v1/models')
    expect(res.status).toBe(401)
  })

  it('rejects requests with a wrong bearer token', async ({ expect }) => {
    mockUpstreamMustNotBeCalled()
    const res = await request('/v1/models', {
      headers: { Authorization: 'Bearer wrong-key' }
    })
    expect(res.status).toBe(401)
  })

  it('rejects requests with a wrong x-api-key', async ({ expect }) => {
    mockUpstreamMustNotBeCalled()
    const res = await request('/v1/messages', {
      headers: { 'x-api-key': 'wrong-key' }
    })
    expect(res.status).toBe(401)
  })

  it('rejects requests with a malformed Authorization header (no Bearer prefix)', async ({ expect }) => {
    mockUpstreamMustNotBeCalled()
    const res = await request('/v1/models', {
      headers: { Authorization: env.API_KEY }
    })
    expect(res.status).toBe(401)
  })
})

describe('401 response body shape', () => {
  it('returns an OpenAI-shaped error for /v1/chat/completions', async ({ expect }) => {
    mockUpstreamMustNotBeCalled()
    const res = await request('/v1/chat/completions')
    const body = await res.json()
    expect(body).toMatchObject({
      error: {
        type: 'invalid_request_error',
        param: null,
        code: 'invalid_api_key'
      }
    })
    expect(body).not.toHaveProperty('type')
  })

  it('returns an Anthropic-shaped error for /v1/messages', async ({ expect }) => {
    mockUpstreamMustNotBeCalled()
    const res = await request('/v1/messages')
    const body = await res.json()
    expect(body).toMatchObject({
      type: 'error',
      error: { type: 'authentication_error' },
      request_id: expect.stringMatching(/^req_/)
    })
  })

  it('returns an Anthropic-shaped error when anthropic-version is present, regardless of path', async ({ expect }) => {
    mockUpstreamMustNotBeCalled()
    const res = await request('/v1/models', {
      headers: { 'anthropic-version': '2023-06-01' }
    })
    const body = await res.json()
    expect(body).toMatchObject({ type: 'error', error: { type: 'authentication_error' } })
  })

  it('returns an Anthropic-shaped error when x-api-key is present but wrong, regardless of path', async ({
    expect
  }) => {
    mockUpstreamMustNotBeCalled()
    const res = await request('/v1/models', {
      headers: { 'x-api-key': 'wrong-key' }
    })
    const body = await res.json()
    expect(body).toMatchObject({ type: 'error', error: { type: 'authentication_error' } })
  })

  it('always includes WWW-Authenticate on 401', async ({ expect }) => {
    mockUpstreamMustNotBeCalled()
    const res = await request('/v1/models')
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer error="invalid_token"')
  })
})

describe('forwarding', () => {
  it('rewrites the target host and injects Cloudflare Access headers while stripping client auth', async ({
    expect
  }) => {
    let captured: Request | undefined
    mockUpstream((req) => {
      captured = req
      return new Response('ok')
    })

    await request('/v1/models', {
      headers: { Authorization: `Bearer ${env.API_KEY}`, Cookie: 'session=1' }
    })

    expect(captured).toBeDefined()
    expect(captured?.url).toBe(`https://${env.TUNNEL_HOSTNAME}/v1/models`)
    expect(captured?.headers.get('authorization')).toBeNull()
    expect(captured?.headers.get('cookie')).toBeNull()
    expect(captured?.headers.get('x-api-key')).toBe('local')
    expect(captured?.headers.get('CF-Access-Client-Id')).toBe(env.CF_CLIENT_ID)
    expect(captured?.headers.get('CF-Access-Client-Secret')).toBe(env.CF_CLIENT_SECRET)
  })

  it('does not let a client-supplied CF-Access header spoof the injected Service Token', async ({ expect }) => {
    let captured: Request | undefined
    mockUpstream((req) => {
      captured = req
      return new Response('ok')
    })

    await request('/v1/models', {
      headers: {
        Authorization: `Bearer ${env.API_KEY}`,
        'cf-access-client-id': 'attacker-spoofed-id',
        'CF-ACCESS-CLIENT-SECRET': 'attacker-spoofed-secret'
      }
    })

    expect(captured?.headers.get('cf-access-client-id')).toBe(env.CF_CLIENT_ID)
    expect(captured?.headers.get('cf-access-client-secret')).toBe(env.CF_CLIENT_SECRET)
  })

  it('passes through a streaming SSE upstream response unmodified', async ({ expect }) => {
    mockUpstream(() => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"chunk":0}\n\n'))
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
          controller.close()
        }
      })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    })

    const res = await request('/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true })
    })

    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(await res.text()).toBe('data: {"chunk":0}\n\ndata: [DONE]\n\n')
  })

  it('forwards the POST body to the upstream untouched', async ({ expect }) => {
    let receivedBody: string | undefined
    mockUpstream(async (req) => {
      receivedBody = await req.text()
      return new Response('ok')
    })

    const payload = JSON.stringify({ model: 'llama3.2', messages: [{ role: 'user', content: 'hello' }] })
    await request('/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.API_KEY}`, 'content-type': 'application/json' },
      body: payload
    })

    expect(receivedBody).toBe(payload)
  })
})

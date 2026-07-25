import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          API_KEY: 'test-key',
          TUNNEL_HOSTNAME: 'tunnel.test',
          CF_CLIENT_ID: 'test-client-id',
          CF_CLIENT_SECRET: 'test-client-secret'
        }
      }
    })
  ]
})

import type { Bindings } from '../src/index'

// `wrangler types` leaves `Cloudflare.Env` empty because Secrets aren't
// declared in wrangler.jsonc. Merge in the Worker's own Bindings so `env`
// (imported from `cloudflare:workers`) is typed inside tests.
// `declare global` is required because this file has a top-level `import`,
// which makes it a module — without it, the namespace below would be scoped
// to this file instead of merging with the ambient `Cloudflare` namespace.
declare global {
  namespace Cloudflare {
    interface Env extends Bindings {}
  }
}

export {}

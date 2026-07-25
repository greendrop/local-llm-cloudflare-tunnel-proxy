# local-llm-cloudflare-tunnel-proxy

自宅の [Ollama](https://ollama.com/) を [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/) 経由で外部公開する際の、認証変換リバースプロキシです。

Tunnel は [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) の Service Token 認証で保護されています。Cursor や各種 SDK などの OpenAI / Anthropic 互換クライアントは `Authorization: Bearer <APIキー>` または `x-api-key: <APIキー>` しか送れないため、この Worker が間に立ち、キーを検証したうえで Cloudflare Access 用のヘッダー（`CF-Access-Client-Id` / `CF-Access-Client-Secret`）を付与して内部 Tunnel へ転送します。

```
Client (Cursor / OpenAI SDK / Anthropic SDK / Claude Code)
  │  Authorization: Bearer <API_KEY> または x-api-key: <API_KEY>
  ▼
Cloudflare Worker (このリポジトリ)
  │  CF-Access-Client-Id / CF-Access-Client-Secret を付与
  ▼
Cloudflare Access で保護された Tunnel
  ▼
Ollama / LM Studio (OpenAI 互換 API・Anthropic 互換 API)
```

- `/*` すべてのパス・メソッドを転送（`/v1/chat/completions`, `/v1/models`, `/v1/messages` など）
- OpenAI 互換（`Authorization: Bearer`）と Anthropic 互換（`x-api-key`）の両方の認証ヘッダーに対応
- Ollama v0.14.0 以降や LM Studio が提供する Anthropic Messages API 互換の `/v1/messages` にも対応
- SSE ストリーミング応答・POST ボディをそのまま貫通
- 認証に失敗した場合は `401` を返し、上流へは転送しない。ボディの形状はリクエストの方言（`/v1/messages` へのアクセスか、`anthropic-version` / `x-api-key` ヘッダーの有無）に応じて OpenAI 互換・Anthropic 互換のいずれか正規の形状で返す

## セットアップ

```bash
pnpm install
```

`.dev.vars.example` を参考に `.dev.vars` を作成し、ローカル用の値を入れてください（`.dev.vars` は Git 管理対象外です）。

```bash
cp .dev.vars.example .dev.vars
```

Worker 用の型を生成します（[Wrangler の Types コマンド](https://developers.cloudflare.com/workers/wrangler/commands/#types)）:

```bash
pnpm cf-typegen
```

## ローカル開発

```bash
pnpm dev
```

```bash
curl -N -s -X POST http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"llama3.2","messages":[{"role":"user","content":"hello"}],"stream":true}'
```

## テスト・型チェック

```bash
pnpm test
pnpm typecheck
```

## Secret の設定

本番デプロイ前に、以下 4 つをすべて [Wrangler Secrets](https://developers.cloudflare.com/workers/configuration/secrets/) として登録します（`wrangler.jsonc` には書き込みません）。

```bash
# APIキーの生成例
openssl rand -hex 32

pnpm wrangler secret put API_KEY
pnpm wrangler secret put TUNNEL_HOSTNAME
pnpm wrangler secret put CF_CLIENT_ID
pnpm wrangler secret put CF_CLIENT_SECRET

# 登録済み一覧の確認
pnpm wrangler secret list
```

| 変数名 | 説明 |
| --- | --- |
| `API_KEY` | クライアントに配布する任意のキー（`Authorization: Bearer` または `x-api-key` として送信） |
| `TUNNEL_HOSTNAME` | Cloudflare Access で保護された内部トンネルのホスト名（スキーム・パスなし。例: `llm.example.com`） |
| `CF_CLIENT_ID` | Cloudflare Access Service Token の Client ID |
| `CF_CLIENT_SECRET` | Cloudflare Access Service Token の Client Secret |

## デプロイ

```bash
pnpm deploy
```

## クライアント側の設定例

### Cursor

Cursor の設定で OpenAI 互換エンドポイントとして、この Worker の URL（例: `https://<worker>.<subdomain>.workers.dev/v1`）と `API_KEY` を登録します。

### OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://<worker>.<subdomain>.workers.dev/v1",
    api_key="<API_KEY>",
)

stream = client.chat.completions.create(
    model="llama3.2",
    messages=[{"role": "user", "content": "hello"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

### Anthropic Python SDK

Anthropic SDK は既定で `Authorization` ではなく `x-api-key` を送信します。この Worker はどちらの認証ヘッダーにも対応しているため、`base_url` と `api_key` を差し替えるだけで利用できます。

```python
import anthropic

client = anthropic.Anthropic(
    base_url="https://<worker>.<subdomain>.workers.dev",
    api_key="<API_KEY>",  # x-api-key として送信される
)

with client.messages.stream(
    model="qwen3-coder",
    max_tokens=1024,
    messages=[{"role": "user", "content": "hello"}],
) as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)
```

上流が Ollama の場合は v0.14.0 以降が必要です（[Anthropic 互換 API](https://docs.ollama.com/api/anthropic-compatibility)）。LM Studio は標準で `/v1/messages` に対応しています。

### Claude Code

```bash
export ANTHROPIC_BASE_URL="https://<worker>.<subdomain>.workers.dev"
export ANTHROPIC_AUTH_TOKEN="<API_KEY>"
```

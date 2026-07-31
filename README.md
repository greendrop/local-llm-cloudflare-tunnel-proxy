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

### ローカルから

```bash
pnpm deploy
```

### GitHub Actions から（`workflow_dispatch`）

GitHub の Actions タブから「Deploy」ワークフローを選び、「Run workflow」で手動デプロイできます。

事前に、リポジトリの Settings → Secrets and variables → Actions に以下の Secrets を登録してください。

| Secret 名 | 説明 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API トークン（"Edit Cloudflare Workers" テンプレート、または `Account / Workers Scripts: Edit` 権限で作成） |
| `CLOUDFLARE_ACCOUNT_ID` | デプロイ先の Cloudflare アカウント ID（ダッシュボード、または `pnpm wrangler whoami` で確認） |
| `CLOUDFLARE_WORKER_NAME` | デプロイ先の Worker 名（`wrangler.jsonc` の `name` を上書きします） |

これらは CI がデプロイ先を特定するための認証情報であり、[Secret の設定](#secret-の設定) で登録する 4 つの Wrangler Secrets（Worker のランタイム用シークレット）とは別物です。Wrangler Secrets はデプロイ先の Worker ごとに、初回のみ手動で登録する必要があります。

## 制限事項・タイムアウトについて

Worker から Cloudflare Tunnel（Access で保護された内部ホスト）への `fetch()` には、Cloudflare 側の **Proxy Read Timeout（約125秒）** が掛かります。これは上流からの最初のバイト（またはアイドル区間）が125秒以内に届かなかった場合に Cloudflare が `524` を返すというもので、Free/Pro/Business プランでは変更できません（Enterprise のみ Cache Rules 等で最大6000秒まで延長可能）。

- **Worker はクライアントが接続を維持している限り、ストリーミングで長時間レスポンスを送り続けられます**（HTTP トリガーの Worker に一律の実行時間上限はありません）。ただし Worker には別途 CPU time の制限（有料プランは既定30秒、`limits.cpu_ms` で最大5分まで延長可）があります。この Worker は `hono/proxy` で上流のストリームをそのまま中継するだけで実際に CPU を消費する処理はほぼ無いため、通常この制限には掛かりません。Client ↔ Worker 間や Worker → Tunnel 間のストリーミング中の転送そのものは125秒制限の対象外です（あくまで「最初のバイトが届くまで」のタイマー）。
- 制限に引っかかるのは主に次の2パターンです。
  1. **`stream: false` での長時間生成** — Ollama / LM Studio は生成が完了するまで1バイトも返さないため、生成に125秒以上かかると 524 になります。
  2. **モデルのコールドロード** — `stream: true` でも、モデルがメモリに常駐しておらず読み込みに時間がかかる場合、最初の SSE チャンクが届く前に125秒を超えることがあります。
- **したがって `stream: true` を強く推奨します。** また上流側で `OLLAMA_KEEP_ALIVE=-1`（Ollama）などを設定し、モデルを常駐させてコールドロードを避けることを推奨します。
- 上流が Cloudflare の生成した HTML エラーページ（524 / 520–523 / 525 / 526 / 530、または Access に拒否された HTML の 401 / 403）を返した場合、この Worker はそれをそのまま返さず、リクエストの方言（OpenAI 互換 / Anthropic 互換）に合わせた JSON エラーへ整形して返します。
  - `524` → `504`（`timeout_error` / `server_error`）
  - それ以外の Cloudflare 生成エラー → `502`（`api_error` / `server_error`）
  - Anthropic SDK / OpenAI SDK はいずれも 408/409/429/5xx を既定でリトライするため、コールドロードが原因の一時的なタイムアウトは多くの場合クライアント側のリトライで解消します。
- cloudflared 側では SSE を壊さないよう `--no-chunked-encoding` を使わないでください。必要に応じて `http2Origin: true` の設定も検討してください。

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

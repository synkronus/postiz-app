# Konversify SSO

Single-sign-on from the Konversify shell (ChatbotX) into this Postiz
deployment. Purely additive on top of upstream Postiz: one NestJS module, one
frontend page, one middleware exception and one CI workflow.

## Flow

```
ChatbotX shell (my.konversify.app)
  └─ iframe src: https://social.konversify.app/sso#t=<jwt>   (fragment, never query)
       └─ /sso page reads location.hash, POSTs { token } to POST /integrations/konversify-sso
            └─ backend: JWKS + iss + aud + exp verification (ES256)
                 └─ JIT user by email → ensure organization → ensure owner membership
                      └─ Postiz session issued exactly like POST /auth/login (auth + showorg cookies)
                           └─ /sso page redirects to /
```

The shell mints a short-lived (120s) ES256 access token with BetterAuth's JWT
plugin. Claims: `sub` (ChatbotX user id), `email`, `workspaceId`, `role`,
`iss`, `aud`, `iat`, `exp`. The token only ever travels in the URL fragment
(fragments are not sent to servers or written to proxy logs) and is stripped
from the URL/history as soon as the `/sso` page reads it. Tokens are never
logged.

## Endpoint

`POST /integrations/konversify-sso` with body `{ "token": "<jwt>" }`

- `404` when `KONVERSIFY_SSO_ENABLED` is not `true` (endpoint hidden when off)
- `401` when the token fails verification (bad signature / unknown `kid`,
  wrong issuer, wrong audience, expired, missing `email` or `workspaceId`)
- `200` + `auth`/`showorg` cookies on success (same cookies `POST /auth/login`
  sets; in `NOT_SECURED` mode the values are additionally exposed as `auth` /
  `showorg` response headers, like login does)

The endpoint is public (it authenticates with the Konversify token itself) and
is covered by the global throttle guard like every other route.

## Workspace → organization mapping

One ChatbotX workspace maps to one Postiz organization. The Prisma
`Organization` model has no external-key column, so the deterministic key is
the organization **name**: `konversify-ws-<workspaceId>` (see
`konversifyOrgName` in `apps/backend/src/services/konversify-sso/konversify.sso.repository.ts`).
First SSO login for a workspace creates the organization; later logins
find-or-create by exact name match (oldest match wins if several exist, e.g.
after a manual rename). Postiz has no `OWNER` role; `SUPERADMIN` is its
owner-grade role (the one `createOrgAndUser` grants the founding user), so
membership is ensured with `SUPERADMIN`.

JIT users are created as `LOCAL` provider (so all existing email-based lookups
work) with a random 64-char password — dashboard password login is effectively
impossible for them, they sign in through Konversify only. The account is
pre-activated; `email` is the join key, matching what login/invite flows use.

## Environment variables

| Variable | Purpose |
|---|---|
| `KONVERSIFY_SSO_ENABLED` | Must be `true` to enable the endpoint; anything else → 404 |
| `KONVERSIFY_JWKS_URL` | JWKS endpoint of the shell, e.g. `https://my.konversify.app/api/auth/jwks` |
| `KONVERSIFY_SSO_ISSUER` | Required `iss`, e.g. `https://my.konversify.app` |
| `KONVERSIFY_SSO_AUDIENCE` | Required `aud`, e.g. `konversify-tools` |

All four live in the backend environment (backend container env / `.env`).

## Tests

`pnpm run test:sso` — spins up a local JWKS server with a locally generated
ES256 keypair and covers: valid token → session, wrong audience → 401,
expired token → 401, feature flag off → 404 (plus JIT idempotence cases).

## CI

`.github/workflows/docker.yml` builds the repo docker image
(`Dockerfile.dev`, build-arg `NEXT_PUBLIC_VERSION`) on every push to `main`
and on `v*` tags, publishing to `ghcr.io/synkronus/postiz-app` as `main`,
`sha-<short>`, semver tags and `latest` (amd64 only).

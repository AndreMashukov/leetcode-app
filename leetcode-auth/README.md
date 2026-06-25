# leetcode-auth

Cognito UserPool + UserPoolClient shared by every BFF in the leetcode system.

- **Stack name:** `leetcode-auth-dev`
- **UserPool name:** `leetcode-auth-dev-user-pool`
- **Client name:** `leetcode-auth-dev-bff-client`
- **Resources:** 1 `AWS::Cognito::UserPool` + 1 `AWS::Cognito::UserPoolClient`
- **Business logic:** none — pure infrastructure

## Why a separate stack

problems-bff, submissions-bff, and status-bff are independently versioned. Putting Cognito inside any one of them would couple "auth" with that stack's deploy cycle. The UserPool is a system-wide resource — it belongs at the same architectural level as the event bus.

## Outputs (consumed by every BFF)

| Output key | What it is | Example value |
|---|---|---|
| `UserPoolId` | The UserPool ID (used in `cognito-idp` API calls and HTTP API JWT authorizer `issuer` URL) | `ap-southeast-1_abc123` |
| `UserPoolArn` | The UserPool ARN | `arn:aws:cognito-idp:ap-southeast-1:579273601730:userpool/ap-southeast-1_abc123` |
| `UserPoolClientId` | The client ID the BFFs include in JWT verification config | `7f8a9b0c1d2e3f4g5h6i7j8k9l` |
| `IssuerUrl` | Full issuer URL (use this for `authorizer.issuerUrl` in HTTP API JWT authorizers) | `https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_abc123` |

Cross-stack consumers use `${cf:leetcode-auth-${opt:stage}.UserPoolId, '...fallback...'}` (with the `${cf:..., 'fallback'}` syntax for the package gate to succeed before this stack is deployed).

## Auth flows enabled

- `ALLOW_USER_SRP_AUTH` — standard browser flow (production)
- `ALLOW_REFRESH_TOKEN_AUTH` — silent refresh
- `ALLOW_ADMIN_USER_PASSWORD_AUTH` — **dev-only e2e flow**, used by `scripts/e2e-bff-cognito.py` to mint a JWT. **Removed in prd** via stage params.

## Self sign-up

Disabled. `AllowAdminCreateUserOnly: true` — users are created by an admin via the AWS CLI / Cognito console / a future admin BFF. Public sign-up is a v2 feature.

## Deploy

```bash
yarn deploy:auth
# or: NX_SKIP_NATIVE_FILE_CACHE=true npx nx run leetcode-auth:deploy
```

This is the **second** stack to deploy in the leetcode-app build order (after `leetcode-event-hub`, before any BFF).

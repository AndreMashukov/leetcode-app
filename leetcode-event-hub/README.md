# leetcode-event-hub

EventBridge bus for the leetcode system. One shared bus; every other stack publishes and consumes on it.

- **Stack name:** `leetcode-event-hub-dev`
- **Bus name:** `leetcode-event-hub-dev-bus`
- **Archive name:** `leetcode-event-hub-dev-archive`
- **Resources:** 1 `AWS::Events::EventBus` + 1 `AWS::Events::Archive` + auto-generated LogGroup
- **Business logic:** none — pure infrastructure

## Outputs (consumed by other stacks)

| Output key | What it is | Example value |
|---|---|---|
| `busName` | The bus name (used as `EventBusName` in `PutEvents` and rule targets) | `leetcode-event-hub-dev-bus` |
| `busArn` | The bus ARN (used for IAM `events:PutEvents` scoping) | `arn:aws:events:ap-southeast-1:579273601730:event-bus/leetcode-event-hub-dev-bus` |
| `archiveName` | The archive name | `leetcode-event-hub-dev-archive` |
| `archiveArn` | The archive ARN | `arn:aws:events:ap-southeast-1:579273601730:archive/leetcode-event-hub-dev-archive` |

Other stacks reference the bus via `${cf:leetcode-event-hub-${opt:stage}.busName, '...'}` (with `${cf:..., 'fallback'}` syntax for the package gate to succeed before this stack is deployed).

## Deploy

```bash
yarn deploy:event-hub
# or: NX_SKIP_NATIVE_FILE_CACHE=true npx nx run leetcode-event-hub:deploy
```

This is the **first** stack to deploy in the leetcode-app build order.

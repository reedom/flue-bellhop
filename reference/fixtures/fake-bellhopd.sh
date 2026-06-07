#!/usr/bin/env bash
# Usage: fake-bellhopd.sh <instance-id> [rounds]
# Polls its inbox; replies {"echo": <payload>} to each ask, except
# payload.op == "agent.status" with name "ghost" -> canned ErrorReply.
set -euo pipefail
AGENTBUS="${AGENTBUS_BIN:-agentbus}"
ID="${1:?instance id}"
ROUNDS="${2:-50}"

"$AGENTBUS" register "$ID" --persistent 1>/dev/null

i=0
while [ "$i" -lt "$ROUNDS" ]; do
  BATCH=$("$AGENTBUS" check-inbox "$ID")
  COUNT=$(printf '%s' "$BATCH" | jq '.envelopes | length')
  if [ 0 -lt "$COUNT" ]; then
    printf '%s' "$BATCH" | jq -c '.envelopes[]' | while IFS= read -r env; do
      KIND=$(printf '%s' "$env" | jq -r '.kind')
      [ "$KIND" = "ask" ] || continue
      REQ=$(printf '%s' "$env" | jq -r '.request_id // .id')
      OP=$(printf '%s' "$env" | jq -r '.payload.op // "none"')
      NAME=$(printf '%s' "$env" | jq -r '.payload.name // "none"')
      if [ "$OP" = "agent.status" ] && [ "$NAME" = "ghost" ]; then
        printf '%s' '{"error":{"code":"unknown_agent","message":"no such agent","retryable":false}}' \
          | "$AGENTBUS" reply "$REQ" "$ID" 1>/dev/null
      else
        printf '%s' "$env" | jq -c '{echo: .payload}' | "$AGENTBUS" reply "$REQ" "$ID" 1>/dev/null
      fi
    done
    exit 0
  fi
  sleep 0.2
  i=$((i + 1))
done
exit 1

# agentbus CLI output shapes — verification spike

- Date: 2026-06-07
- agentbus version: 0.2.0 (note: spec says 0.3, see concern below)
- AGENTBUS_DIR: isolated tempdir (mktemp -d) for all commands
- Branch: feat/connector

## Summary table

| Question | Finding | Consequence |
|---|---|---|
| (a) timeout request_id machine-readable? | **No** — only in stderr as freeform text `error[timeout]: no reply within N ms; retrieve a late reply with: agentbus ask-result <id>` | **ADJUST**: must parse stderr with regex to extract request_id; stdout is empty on timeout |
| (b) `--since` semantics | **after (exclusive)**: `--since 6` returns only seq 7; seq 6 is excluded | ok — connector should pass last-seen seq as `--since` cursor |
| (c) error output format and exit codes | Stderr: `error[<code>]: <message>` freeform text; stdout empty; exit 1 for `unknown_instance`, `unknown_request_id`; exit 2 for `timeout` | **ADJUST**: error code must be parsed from stderr with regex `error\[([^\]]+)\]:`; not a JSON object |
| (d) register shape | `{"ok":true}` stdout, exit 0 | ok |
| (d) ls shape | `{"instances":[{id,alive,pid,persistent,on_delivery,registered_at}]}` | ok — field names confirmed |
| (d) ask-result shape | `{"status":"pending","expires_at":"..."}` or `{"status":"replied","payload":{...},"replied_at":"..."}` or `{"status":"expired","expires_at":"..."}` | ok — three states confirmed |
| (d) reply shape | `{"ok":true}` stdout, exit 0 | ok |
| version mismatch | Installed binary is **0.2.0**; spec references 0.3; `--pid` flag does not exist | **CONCERN**: spec says `register --pid N` but 0.2.0 only has `--persistent`; pid appears in ls output for non-persistent registrations (set by the registering process) |

---

## Version note

The installed binary is **agentbus 0.2.0**, not 0.3 as referenced in the spec. The `register` subcommand does not accept a `--pid` flag. The pid is recorded automatically (set to the calling process's PID) when `--persistent` is omitted; with `--persistent` the pid field is null and `alive` is true regardless.

---

## Verb-by-verb findings

### `agentbus --help`

```
agentbus CLI (daemonless spool store)

Usage: agentbus [OPTIONS] <COMMAND>

Commands:
  register     Register an instance id (non-persistent rows die with this process; pair with --persistent for durable addresses)
  unregister   Remove a registration (the inbox file is kept)
  ls           List registered instances
  send         Send a one-way message (payload from --file or stdin)
  ask          Send a request and wait for the reply
  ask-result   Fetch the (possibly late) reply to an earlier ask
  reply        Reply to an ask as <from>
  check-inbox  Drain an instance's inbox without blocking
  await        Block until messages arrive, or time out (empty list)
  publish      Publish a broadcast event
  events       Read the event log as {"seq":..,"envelope":..} lines; --follow polls
  watch        Stream envelopes addressed to one instance, one compact JSON per line, never consuming the inbox (spec 6.7; for harness monitor tools)
  sweep        Crash recovery: prune dead registrations, re-fire stale hooks, report expired asks (spec 6.8)
  help         Print this message or the help of the given subcommand(s)

Options:
      --dir <DIR>  Store directory (default ~/.agentbus) [env: AGENTBUS_DIR=]
  -h, --help       Print help
  -V, --version    Print version
```

---

### `register`

**Command:** `agentbus register spike`

**Flags available:** `--persistent`, `--on-delivery <ON_DELIVERY>`
**Flags NOT available:** `--pid` (spec assumption broken — see concern above)

**stdout:**
```json
{"ok":true}
```

**stderr:** (empty)

**exit:** 0

**Consequence:** ok — shape is `{"ok":true}`. The `--pid` flag does not exist; non-persistent registration auto-records the calling process's PID. With `--persistent`, pid is null and alive is always true.

---

### `ls`

**Command:** `agentbus ls`

**stdout (non-persistent, process gone):**
```json
{
  "instances": [
    {
      "alive": false,
      "id": "spike",
      "on_delivery": null,
      "persistent": false,
      "pid": 20627,
      "registered_at": "2026-06-07T13:02:17.196429Z"
    }
  ]
}
```

**stdout (persistent):**
```json
{
  "instances": [
    {
      "alive": true,
      "id": "spike",
      "on_delivery": null,
      "persistent": true,
      "pid": null,
      "registered_at": "2026-06-07T13:02:46.265444Z"
    }
  ]
}
```

**stderr:** (empty)

**exit:** 0

**Consequence:** ok — shape is `{"instances":[...]}` with fields: `id` (string), `alive` (bool), `pid` (number|null), `persistent` (bool), `on_delivery` (null|string), `registered_at` (ISO-8601 string).

---

### `send`

**Command:** `echo '{"n":1}' | agentbus send spike --from ext:spike`

**stdout:**
```json
{"id":"msg_01KTH2VJ9MKF539VKGK4BXBSJH"}
```

**stderr:** (empty)

**exit:** 0

**Consequence:** ok — envelope id returned as `{"id":"<msg_id>"}`.

---

### `check-inbox`

**Command:** `agentbus check-inbox spike`

**stdout:**
```json
{
  "envelopes": [
    {
      "from": "ext:spike",
      "id": "msg_01KTH2VJ9MKF539VKGK4BXBSJH",
      "kind": "message",
      "payload": {
        "n": 1
      },
      "to": "spike",
      "ts": "2026-06-07T13:02:50.164379Z"
    }
  ]
}
```

**stdout (empty inbox):**
```json
{
  "envelopes": []
}
```

**stderr:** (empty)

**exit:** 0 (even for nonexistent instance — returns empty envelopes)

**Envelope field names (message kind):** `id`, `kind` ("message"), `from`, `to`, `ts`, `payload`

**Envelope field names (ask kind):** `id`, `kind` ("ask"), `from`, `to`, `timeout_ms`, `ts`, `payload`

**Consequence:** ok.

---

### `ask` — success path

**Command:** `echo '{"query":"ping"}' | agentbus ask worker --from ext:test --timeout-ms 5000`

**stdout (when reply arrives):**
```json
{
  "request_id": "msg_01KTH2Y069R2BAMY4CR9D38F7V",
  "payload": {
    "response": "pong"
  }
}
```

**stderr:** (empty)

**exit:** 0

**Consequence:** ok — shape is `{"request_id":"...","payload":{...}}`. The `request_id` field is present in the success response too.

---

### `ask` — timeout path

**Command:** `echo '{"q":2}' | agentbus ask spike --from ext:spike --timeout-ms 2000`

**stdout:** (empty)

**stderr:**
```
error[timeout]: no reply within 2000 ms; retrieve a late reply with: agentbus ask-result msg_01KTH2VWWKPXFK3E32FW0Z50H9
```

**exit:** 2

**ADJUST — request_id extraction:** The request_id is embedded in stderr freeform text, not as JSON. The connector must parse stderr with a pattern such as:
```
/agentbus ask-result (msg_[A-Z0-9]+)/
```
or more generally:
```
/ask-result\s+(\S+)\s*$/
```

---

### `ask` — unknown instance path

**Command:** `echo '{"q":1}' | agentbus ask nosuch --from ext:spike --timeout-ms 1000`

**stdout:** (empty)

**stderr:**
```
error[unknown_instance]: unknown instance `nosuch`
```

**exit:** 1

**Consequence:** ADJUST — error is freeform stderr text with code in brackets. Parse with regex `error\[([^\]]+)\]: (.+)`.

---

### `ask-result`

**Command:** `agentbus ask-result <REQUEST_ID>`

**stdout (pending):**
```json
{
  "status": "pending",
  "expires_at": "2026-06-07T13:03:23.06096Z"
}
```

**stdout (replied):**
```json
{
  "status": "replied",
  "payload": {
    "a": 1
  },
  "replied_at": "2026-06-07T13:03:21.268576Z"
}
```

**stdout (expired — ask timed out and was not replied to):**
```json
{
  "status": "expired",
  "expires_at": "2026-06-07T13:03:03.011765Z"
}
```

**stdout (nonexistent request_id):**

(empty — error on stderr)

**stderr (nonexistent):**
```
error[unknown_request_id]: unknown request_id `msg_NONEXISTENT`
```

**exit:** 0 for pending/replied/expired; 1 for unknown_request_id

**Consequence:** ok — three-state enum via `status` field. Reply payload is at top-level `payload`. No nested `{"reply":{...}}` wrapper.

---

### `reply`

**Command:** `echo '{"a":1}' | agentbus reply <REQUEST_ID> spike`

**Note on argument order:** `reply <REQUEST_ID> <FROM>` — FROM is the second positional arg, not `--from`.

**stdout:**
```json
{"ok":true}
```

**stderr:** (empty)

**exit:** 0

**Consequence:** ok.

---

### `reply` — unknown request_id

**Command:** `echo '{"a":1}' | agentbus reply msg_UNKNOWN spike`

**stdout:** (empty)

**stderr:**
```
error[unknown_request_id]: unknown request_id `msg_UNKNOWN`
```

**exit:** 1

---

### `publish`

**Command:** `echo '{"e":1}' | agentbus publish --from ext:spike`

**stdout:**
```json
{"id":"msg_01KTH2WRNC98QCC29Q7AZRXMKR"}
```

**stderr:** (empty)

**exit:** 0

**Consequence:** ok — same `{"id":"..."}` shape as `send`.

---

### `events --since`

**Command:** `agentbus events --since 0`

**stdout (one line per event, compact JSON):**
```
{"seq":1,"envelope":{"id":"msg_01KTH2VJ9MKF539VKGK4BXBSJH","kind":"message","from":"ext:spike","to":"spike","ts":"2026-06-07T13:02:50.164379Z","payload":{"n":1}}}
{"seq":2,"envelope":{"id":"msg_01KTH2VP7PW6BD9NWJZ1D60BH3","kind":"ask","from":"ext:spike","to":"spike","timeout_ms":2000,"ts":"2026-06-07T13:02:54.199Z","payload":{"q":1}}}
{"seq":5,"envelope":{"id":"msg_01KTH2WGNM6JPMC5H5096J5JMP","kind":"reply","from":"spike","to":"ext:spike","request_id":"msg_01KTH2W8N4GZ68QAXJ5HEV2TMY","ts":"2026-06-07T13:03:21.268576Z","payload":{"a":1}}}
{"seq":6,"envelope":{"id":"msg_01KTH2WRNC98QCC29Q7AZRXMKR","kind":"event","from":"ext:spike","ts":"2026-06-07T13:03:29.452823Z","payload":{"e":1}}}
{"seq":7,"envelope":{"id":"msg_01KTH2WRQZ619AGXD2ZY076FCN","kind":"event","from":"ext:spike","ts":"2026-06-07T13:03:29.535049Z","payload":{"e":2}}}
```

**--since semantics test:** With events at seq 6 and 7, running `agentbus events --since 6` returned **only seq 7**. Seq 6 was excluded.

**Conclusion: `--since N` means "after seq N" (exclusive).** To re-read seq N, use `--since <N-1>`. To poll from current position, use `--since <last-seen-seq>`.

**exit:** 0

**Consequence:** ok — use last-seen seq as the `--since` cursor directly (exclusive, so next call naturally skips it).

---

### `await`

**Command:** `agentbus await spike --timeout-ms 1000`

**stdout (timeout, empty batch):**
```json
{
  "envelopes": []
}
```

**stderr:** (empty)

**exit:** 0

**Consequence:** ok — empty batch on timeout; same `{"envelopes":[...]}` shape as `check-inbox`. Distinguish from a real message batch by checking length, not exit code.

---

### `unregister`

**Command:** `agentbus unregister spike`

**stdout:**
```json
{"ok":true}
```

**stderr:** (empty)

**exit:** 0

---

### `sweep`

**Command:** `agentbus sweep`

**stdout:**
```json
{
  "dead_instances": [],
  "recovered_inboxes": [],
  "rehooked": [],
  "expired_asks": [
    "msg_01KTH2VP7PW6BD9NWJZ1D60BH3",
    "msg_01KTH2VWWKPXFK3E32FW0Z50H9"
  ],
  "purged_inboxes": []
}
```

**exit:** 0

---

## Assumptions that break or need adjustment

### 1. `register --pid` does not exist (ADJUST)

The spec (section 4) says: `register <id> [--pid N | --persistent]`. In agentbus 0.2.0, `--pid` is not a valid flag. The connector must use `--persistent` for durable orchestrator addresses, or omit both flags to let the CLI auto-record the calling PID for the process-lifetime case.

**Practical impact:** The connector's `connectBellhop({ anchor: 'pid' })` path cannot pass `--pid process.pid` explicitly. It must either rely on non-persistent registration (which auto-records the calling process PID) or use `--persistent` for the durable case.

### 2. Timeout error carries request_id only in stderr freeform text (ADJUST)

On `ask` timeout, stdout is empty and exit code is 2. The request_id appears only in stderr as:
```
error[timeout]: no reply within N ms; retrieve a late reply with: agentbus ask-result <id>
```

The connector must capture stderr and apply a regex such as `/ask-result\s+(\S+)$/` to extract the request_id for the `AskTimeout { requestId }` error object.

### 3. All error output is freeform stderr, not JSON (ADJUST)

The spec (section 6) says: `Control-plane errors ({"error":{code,...}} with exit 1)`. In 0.2.0, errors are never JSON. They are plaintext stderr in the form `error[<code>]: <message>`. The connector must parse stderr rather than parse stdout JSON for errors.

**Known error codes observed:**
- `timeout` — exit 2 — ask timed out
- `unknown_instance` — exit 1 — instance not registered
- `unknown_request_id` — exit 1 — request_id not found

### 4. agentbus version is 0.2.0, not 0.3 (CONCERN)

The spec references `agentbus-cli@^0.3`. The installed binary is 0.2.0. If 0.3 introduces breaking changes (e.g., adds JSON error output, adds `--pid` flag), the reference implementation should be written against the observed 0.2.0 behavior and documented as requiring a minimum version. The install hint in the constructor error message should reference the actual minimum tested version.

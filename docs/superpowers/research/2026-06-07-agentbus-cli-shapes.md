# agentbus CLI output shapes — verification spike

- Date: 2026-06-07
- agentbus version: 0.3.0 (re-verified 2026-06-07; originally captured against 0.2.0)
- AGENTBUS_DIR: isolated tempdir (mktemp -d) for all commands
- Branch: feat/connector

## Summary table

| Question | Finding | Consequence |
|---|---|---|
| (a) timeout request_id machine-readable? | **No** — only in stderr as freeform text `error[timeout]: no reply within N ms; retrieve a late reply with: agentbus ask-result <id>` | **ADJUST**: must parse stderr with regex to extract request_id; stdout is empty on timeout |
| (b) `--since` semantics | **after (exclusive)**: `--since 6` returns only seq 7; seq 6 is excluded | ok — connector should pass last-seen seq as `--since` cursor |
| (c) error output format and exit codes | Stderr: `error[<code>]: <message> (recovery hint)` freeform text; stdout empty; exit 1 for `unknown_instance`, `unknown_request_id`; exit 2 for `timeout` | **ADJUST**: error code must be parsed from stderr with regex `error\[([^\]]+)\]:`; not a JSON object; 0.3.0 appends recovery hints after the message but the `error[<code>]:` prefix is unchanged |
| (d) register shape | `{"ok":true}` stdout, exit 0 | ok |
| (d) register `--pid` flag | **Now exists in 0.3.0**: `agentbus register x --pid 12345` sets `pid` to 12345 in ls output; `--pid` and `--persistent` are mutually exclusive (exit 2, clap error) | **RESOLVED**: connector may now pass `--pid process.pid` explicitly for the non-persistent anchor case |
| (d) ls shape | `{"instances":[{id,alive,pid,persistent,on_delivery,registered_at}]}` | ok — field names confirmed; `pid` reflects value from `--pid` when supplied |
| (d) ask-result shape | `{"status":"pending","expires_at":"..."}` or `{"status":"replied","payload":{...},"replied_at":"..."}` or `{"status":"expired","expires_at":"..."}` | ok — three states confirmed |
| (d) reply shape | `{"ok":true}` stdout, exit 0 | ok |
| version re-verification | Binary is now **0.3.0**; all previously-adjusted behaviors confirmed unchanged; `--pid` flag added | **CONFIRMED**: no breaking changes from 0.2.0 to 0.3.0 for shapes already documented; `--pid` concern resolved |

---

## Version note

Re-verified 2026-06-07 against **agentbus 0.3.0** (previously recorded against 0.2.0).

Changes in 0.3.0 confirmed:
1. `register` now accepts `--pid <PID>` — sets the owner pid explicitly for non-persistent rows (e.g. anchor to an AI harness process). `--pid` and `--persistent` are mutually exclusive; combining them exits 2 with a clap conflict error on stderr.
2. Error messages now include recovery hints appended after the human-readable description (e.g. `error[unknown_instance]: unknown instance \`nosuch\` (recipients must register first; check list_instances / \`agentbus ls\`)`). The `error[<code>]:` prefix format is unchanged.

All other shapes (register stdout, ls fields, ask timeout stderr wording, ask-result status enum, reply stdout, send stdout, events line format, --since semantics) are identical to 0.2.0 observations.

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

**Command (basic):** `agentbus register spike`

**Flags available (0.3.0):** `--persistent`, `--on-delivery <ON_DELIVERY>`, `--pid <PID>`

**`--pid` semantics (new in 0.3.0):** Sets the owner pid for the non-persistent row explicitly. Useful to anchor a registration to a long-lived parent process (e.g. the AI harness) rather than the short-lived CLI process that issued the command. `alive` reflects whether the pid given is still alive.

**`--pid` + `--persistent` conflict:**

**Command:** `agentbus register y --pid 12345 --persistent`

**stderr:**
```
error: the argument '--pid <PID>' cannot be used with '--persistent'

Usage: agentbus register --pid <PID> <ID>

For more information, try '--help'.
```

**exit:** 2

**`--pid` + `ls` verification:**

**Command:** `agentbus register x --pid 12345` then `agentbus ls`

**stdout (register):**
```json
{"ok":true}
```

**stdout (ls, pid reflects supplied value):**
```json
{
  "instances": [
    {
      "alive": false,
      "id": "x",
      "on_delivery": null,
      "persistent": false,
      "pid": 12345,
      "registered_at": "2026-06-07T13:07:56.973773Z"
    }
  ]
}
```

**stderr:** (empty)

**exit:** 0

**Consequence:** ok — shape is `{"ok":true}`. With `--pid`, the `pid` field in ls reflects the supplied value (not the calling process pid). With `--persistent`, pid is null and alive is always true. Without both flags, pid defaults to calling process pid.

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

**Command:** `echo '{"q":1}' | agentbus ask x --from ext:s --timeout-ms 1500`

**stdout:** (empty)

**stderr (0.3.0 — wording unchanged from 0.2.0, no recovery hint appended to timeout errors):**
```
error[timeout]: no reply within 1500 ms; retrieve a late reply with: agentbus ask-result msg_01KTH354183H51Q62FHAW0WX1P
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

**0.3.0 verification:** regex `/ask-result\s+(\S+)$/` extracts the request_id correctly against 0.3.0 stderr. Wording is byte-for-byte identical to 0.2.0; no new hint lines appended.

---

### `ask` — unknown instance path

**Command:** `echo '{}' | agentbus send nosuch --from ext:s` (also applies to `ask nosuch`)

**stdout:** (empty)

**stderr (0.3.0 — recovery hint now appended):**
```
error[unknown_instance]: unknown instance `nosuch` (recipients must register first; check list_instances / `agentbus ls`)
```

**exit:** 1

**Consequence:** ADJUST — error is freeform stderr text with code in brackets. Parse with regex `error\[([^\]]+)\]:` to extract code. In 0.3.0 the human-readable message portion may include a parenthesised recovery hint; the `error[<code>]:` prefix format is unchanged and the regex remains valid.

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

### 1. `register --pid` now exists in 0.3.0 (RESOLVED)

The spec (section 4) says: `register <id> [--pid N | --persistent]`. In agentbus 0.2.0 this flag was absent; in **0.3.0 it is present**. The connector's `connectBellhop({ anchor: 'pid' })` path may now pass `--pid process.pid` explicitly. The `--pid` and `--persistent` flags are mutually exclusive (clap enforces this; exit 2 on conflict).

**`register --help` (0.3.0):**
```
--pid <PID>   Owner pid for the non-persistent row (e.g. the AI harness process)
```

### 2. Timeout error carries request_id only in stderr freeform text (ADJUST — still required)

On `ask` timeout, stdout is empty and exit code is 2. The request_id appears only in stderr as:
```
error[timeout]: no reply within N ms; retrieve a late reply with: agentbus ask-result <id>
```

Wording is **unchanged in 0.3.0**. The connector must capture stderr and apply a regex such as `/ask-result\s+(\S+)$/` to extract the request_id for the `AskTimeout { requestId }` error object. Verified working against 0.3.0.

### 3. All error output is freeform stderr, not JSON (ADJUST — still required)

The spec (section 6) says: `Control-plane errors ({"error":{code,...}} with exit 1)`. In 0.3.0, errors remain plaintext stderr in the form `error[<code>]: <message>`. In 0.3.0 some errors append a parenthesised recovery hint after the message; the `error[<code>]:` prefix is unchanged.

The connector must parse stderr with regex `error\[([^\]]+)\]:` to extract the error code.

**Known error codes observed (0.3.0):**
- `timeout` — exit 2 — ask timed out
- `unknown_instance` — exit 1 — instance not registered (now includes recovery hint)
- `unknown_request_id` — exit 1 — request_id not found

### 4. agentbus version re-verified as 0.3.0 (CONFIRMED — concern resolved)

The installed binary is now **0.3.0**, matching the spec reference `agentbus-cli@^0.3`. No breaking changes were introduced from 0.2.0 to 0.3.0 for the shapes used by the connector. The minimum required version for the connector is 0.3.0 (due to `--pid` dependency).

# pi-output-translate — Full Design Specification (SPEC v2.1)

> A display-only translation companion for Pi: streams faithful, localized
> Simplified Chinese translations of assistant output (text + thinking) into a
> shared browser window across multiple Pi sessions — without touching the
> agent's execution, context, or terminal output.

---

## 0. Requirements → design mapping

| # | Requirement | Design section |
|---|-------------|----------------|
| 1 | No MVP — ship the complete version | §15 implementation order (single v1.0 delivery) |
| 2 | Efficiency matters | §12 performance budget |
| 3 | Command-mode config + web config | §10 command system, §9.3 settings panel |
| 4 | Multiple Pi windows are the norm; switch between them | §8 host/client shared service + multi-session page |
| 5 | Low resource usage | §12 resource caps |
| 6 | Faithful + localized translation (no weird wording) | §6 translation quality trio |
| 7 | Never translate code/commands; comments optional later | §5.3 code-comment policy |
| 8 | Absorb lessons from prior translation extensions | §1 lessons table |
| 9 | Never block the Pi CLI (async isolation) | §3 isolation design |
| 10 | Think through the edge cases | §13 edge-case catalogue |

---

## 1. Lessons that shaped the design

This is not the first translation companion in the Pi ecosystem. Before
writing code we studied the failure modes and good ideas of existing
extensions (the ones that still exist, the ones that 404'd, and our own
earlier plugins). No code was borrowed; what survived is a set of design
decisions:

| Lesson | Where it landed |
|--------|-----------------|
| Mask literals, then **detect language before** deciding to translate; pure-Chinese / pure-code segments are never sent | §5.2 language gate |
| Models swallow placeholders — plan a repair pass, then degrade gracefully | §5.4 protection protocol |
| Long answers split into chunks, each with its own deadline | §7.2 batched requests + timeouts |
| messageId dedupe; journal persists before display | §7.4 / §7.5 |
| Translation requests carry zero history / zero tools / zero cache session — never let translation side-effects reach the provider session | §7.1 isolated requests |
| Short thinking blocks aren't worth translating — gate by length | §5.2 per-segment gate |
| Validate engine output strictly; malformed output never reaches the page | §6.3 output protocol |
| Never sendMessage / appendEntry / rewrite returns — pollution of session, compaction, and provider cache is irreversible | §3 isolation red lines |
| A syntax error at load time bricks the whole host — typecheck + tests are a release gate | §14 |
| Free non-LLM translation APIs produce odd output; only LLM backends | §7.1 |
| Translate text parts only; structural blocks pass through untouched | §4.2 / §5 |
| "/command → local server → open browser" is a proven extension shape | §8 / §10 |
| Loopback + token + Host-header guard + form-writes-file + mtime hot reload is a solid config-server pattern | §9.3 / §9.4 |
| Multiple Pi windows are the norm, not the exception — design for sharing from day one | §8 host/client |

---

## 2. Goals and non-goals

**Goals**: real-time faithful translation of assistant text and thinking into
Simplified Chinese; multiple Pi sessions sharing one browser window; command +
web configuration entry points; a local or cheap cloud model does the
translating; zero interference, low footprint.

**Non-goals**: nothing on the input side; never
modify messages/context/system prompts; no chat-back from the page; no free
translation API backends; no session-tree view (the page is an append-only
timeline).

---

## 3. Isolation design (requirement 9: never block the Pi CLI)

One sentence: **the Pi event stream only ever does O(1) synchronous pushes;
everything else lives in a bypass outside the event loop, and every failure
in the bypass is absorbed as a display-layer state.**

1. **Handler contract**: every `message_*` / `tool_execution_*` handler body
   may only — read input fields, build small objects, push to arrays,
   `return undefined`. No awaiting network/disk, no throwing (whole-body
   try/catch). Pi may await some handlers in stream order (documented for
   `provider_stream_event`; not guaranteed otherwise for the message family),
   so we design for the worst case.
2. **No mutating-event subscriptions**: never touches `context*`,
   `before_agent_start`, `tool_call`, `tool_result`; `message_end` handlers
   always return undefined (subscription is observation-only); never touches
   `provider_stream_event` (a slow handler there stalls stream consumption).
3. **Lifecycle**: the server may only start on `session_start` (Pi forbids
   opening sockets in factories); `session_shutdown` converges idempotently
   (cancel / reload / session replace / process exit — four paths).
4. **Fault absorption**: engine down / timeout, host lost, ports exhausted,
   all viewer pages closed — each failure notifies at most once via
   `ctx.ui.notify` (guarded by `ctx.hasUI`; silent in RPC/JSON/print modes),
   then degrades silently. No retry storms, nothing ever propagates up.
5. **Hard verification metrics** (§14): with the engine mocked as
   `sleep(∞)`, all handlers return synchronously in < 1 ms; all handler
   return values are undefined; Pi main-loop throughput deviates < 1% from a
   no-plugin baseline.

---

## 4. Overall architecture

```
┌─ pi process A (host role) ──┐   ┌─ pi process B (client role) ─┐
│ agent → TUI (untouched)     │   │ agent → TUI (untouched)      │
│   │ message_* events        │   │   │ message_* events         │
│   ▼ O(1) push               │   │   ▼ O(1) push               │
│ Collector → EventBus        │   │ Collector → UplinkBuffer     │
│             │               │   │            │ micro-batched   │
│             ▼               │   │            │ POST            │
│ Hub (in-process) ◀─ /api/ingest ────────────┘
│   ├─ RingBuffer (replay)    │
│   ├─ TranslateQueue (1 worker)  ← all translation happens on the host:
│   ├─ Cache (LRU + disk)         │  one queue / one cache / one engine
│   ├─ Journal (jsonl on disk)    │  connection shared by all sessions
│   └─ HttpServer (127.0.0.1)  │
│        │ SSE                 │
└────────┼────────────────────┘
         ▼
  Browser (one window, many sessions: sidebar switching + unread badges +
  settings panel + history)
```

Role rules (detail in §8): the first process to bind port 7330 is the host;
later processes become clients, registering over HTTP and forwarding events;
when the host exits, clients race to take over (OS bind atomicity makes the
election brainless); when all exit, the server disappears — no daemon
residue.

---

## 5. Collection → segmentation → protection → translation pipeline

### 5.1 Collection layer

| Event | Use |
|-------|-----|
| `message_start` | Opens a block (user / assistant / toolResult) |
| `message_update` | `assistantMessageEvent`: `text_delta` / `thinking_delta` split by `contentIndex`; 50 ms micro-batch forwarding of raw text |
| `message_end` | Finalize: flush trailing segments, publish msg_end (returns nothing) |
| `tool_execution_start/end` | Tool lines (name + summary + duration, not translated) |
| `session_start` / `session_shutdown` | Service lifecycle, session register/unregister |

Dispatch by content-block type: `text` → translation
pipeline; `thinking` → translation pipeline (`redacted:true` blocks render a
placeholder and are never sent); `toolCall` → tool-line summary.

### 5.2 Language gate (the first efficiency valve)

Each segment passes two gates before being sent:
1. After masking code/literals, count English prose characters; below 40
   (configurable) → never sent, marked `notrans` (pure-Chinese segments,
   symbol-only segments, and short confirmations like "OK." are all caught);
2. No English word at all after masking → same. Chinese user input naturally
   never enters the translation pipeline — but since r12b, untranslated
   (`notrans`) **user** segments are still journaled (see §7.5) so history
   replay and session topics stay complete.

### 5.3 Code-comment policy (requirement 7)

- Fenced code blocks, inline code, command lines, URLs, paths: **never
  translated**; passed to the frontend verbatim as `code` elements
  (comments included, byte-for-byte).
- Optional `codeComments: "off" | "below"`, default **off**. In `below`
  mode, `// …`, `# …`, `/* … */`, `<!-- … -->` comment lines inside blocks
  are extracted and translated; renderings appear in a side-by-side list
  under the code block — **display-only, the code itself is never touched**.

### 5.4 Content protection protocol

Placeholders are substituted before sending and restored after:

| Type | Rule |
|------|------|
| fenced code | whole block stripped, passed through |
| inline code / command lines (`$ …`, `> …` whole line) | → `⟦n⟧` |
| URLs / absolute paths / `~/` paths | → `⟦n⟧` |
| obvious identifiers (CamelCase, snake_case, kebab-case technical words) | → `⟦n⟧` |
| Markdown structure (`#`, `**`, list markers, table pipes) | kept as-is and declared in the prompt |

- Placeholder `⟦n⟧`: rare brackets that translation models reliably leave
  alone.
- **Restoration check**: if the placeholder set in the translation differs
  from the source set → one repair pass (lost placeholders + context sent
  back for the model to fix); a second failure marks the segment
  `degraded` — the page shows the original text plus a badge.

---

## 6. Translation quality: faithful + localized (requirement 6)

"Weird wording" comes from three sources, each plugged:

### 6.1 System prompt (three parts)

```
[Role] You are a software-engineering documentation translator; output only
       the translation.
[Faithful] Translate sentence by sentence; add nothing, remove nothing,
       rewrite nothing, explain nothing, summarize nothing. Preserve
       Markdown structure, list nesting, and table column counts. Keep ⟦n⟧
       placeholders verbatim (position may shift for Chinese word order).
[Localization] Use vocabulary current in mainland-China software-engineering
       communities, aiming for "an engineer understands at a glance".
       Examples: race condition→竞态条件; idempotent→幂等; backpressure→背压;
       boilerplate→样板代码; side effect→副作用; dry run→试运行;
       scaffold→脚手架; gotcha→坑. For technical terms not in the glossary:
       use the accepted translation if one exists; otherwise "中文 (English)"
       on first occurrence, Chinese only afterwards.
[Glossary] {glossary pairs — ~120 built-in entries + user extensions}
```

### 6.2 Context continuity

Every request carries: the current segment + source/translation summaries of
the previous 2 segments + the session's locked term list (a term's first
translation is recorded and forced in later prompts — prevents
"竞态条件/竞态状况" drift within one session).

### 6.3 Output protocol and validation

- The engine outputs pure translation (no JSON wrapper, no prefixes); output
  cleaning: strip ``` wrappers, strip "以下是翻译"-style prefaces, sanity-check
  line count against the source (±20%); failures go to the repair pass.
- temperature 0.1; `contextSegments: 2`; at most one retry per segment.
- Translations never flow back into the agent (no sendMessage, no
  appendEntry, nothing enters any context).

---

## 7. Engines, queue, cache, journal

### 7.1 Engines (one interface, three backends)

```ts
interface TranslateEngine {
  id: string;                       // "ollama" | "openai-compat" | "pi-model"
  complete(system: string, user: string, signal: AbortSignal): Promise<string>;
  healthCheck(): Promise<boolean>;
  listModels?(): Promise<string[]>;
}
```

| Backend | Notes |
|---------|-------|
| `ollama` (default) | Direct `127.0.0.1:11434` `/api/chat`, `think:false`, keep-alive |
| `openai-compat` | Any `/chat/completions` endpoint (llama.cpp / LM Studio / vLLM / hosted). `baseUrl` accepts a bare host, a versioned base (`…/v4`), or a full endpoint path — all normalized |
| `pi-model` | In-host `ctx.modelRegistry` (reasoning: low); explicit opt-in only (avoids competing with the main model's rate limits) |

Isolated requests: every translation carries zero history,
zero tools, zero cache session, zero provider retry; AbortSignal threads
through the whole chain (page "cancel", segment timeout, host shutdown all
cut promptly).

### 7.2 Batched requests (the efficiency key)

- The queue worker batches: 300 ms window or 4 segments, whichever first
  (one request, numbered segments);
- **Batch deadlines scale with batch size** (up to 2× the per-segment
  budget): a fixed per-call timeout used to guarantee that 4-segment
  batches fail on slower engines — every batch then burned a full timeout
  before degrading to singles, collapsing throughput to ~4 segments per
  90 s while the queue merely looked "stuck";
- **Adaptive batch sizing**: a failed multi-segment batch is requeued at
  half the size (4 → 2 → 1, terminating without a loop guard); every
  successful multi-segment batch relaxes the ceiling back toward the
  configured size. The current ceiling is published in `status` events
  (`bs`) for observability;
- **Batch character budget** (`maxBatchChars`, default 2400): a batch is
  sliced by total source length so the full prompt — glossary included —
  stays inside small local-model context windows (ollama's default
  `num_ctx` of 4096 silently truncates oversized batches);
- Segments over 1200 chars are split first (on segment/line boundaries,
  never inside a placeholder);
- Batch failure → split into single-segment retries (1 round) → still
  failing marks `failed` (manual retry available on the page);
- Per-segment timeout 45 s (configurable); concurrency 1 (configurable 1–2).

### 7.3 Cache

key = `sha1(engine+model+targetLang+source)`; hits return `cached` directly.
In-memory LRU 2000 + disk at `~/.pi/agent/output-translate/cache.json`
(10 s debounced flush, loaded at startup). Shared across sessions:
identical sentences never hit the model twice.

### 7.4 Dedupe

`messageId + contentIndex + segIndex` is unique; segments already done/cached
in the RingBuffer are never retranslated (page reconnects replay terminal
states directly).

### 7.5 Journal (history persistence)

- `~/.pi/agent/output-translate/history/<sessionId>.jsonl`: appended records
  of `{ts, s, cwd, m, k, id, src, tgt, st}`; `cwd` rides every record so
  grouping survives without external state;
- Micro-batched to disk (1 s / 4 KB debounce); write failures are silent
  (history is best-effort, never blocks the live path);
- **Retention (r12)**: at most `maxFiles` (20) non-empty journals, each
  truncated to `maxFileMb` (2 MB) on line boundaries. Stale **empty**
  journals (> 1 h old, zero bytes — sessions that never produced a
  translation) are deleted outright; a fresh empty file (possibly a
  just-started session) is spared and never counts against the cap. Empty
  files therefore can no longer evict real history;
- **User prompts (r12b)**: `notrans` user segments (typically Chinese
  prompts) are journaled too — they power session topics and let history
  replay show user cards;
- **Topic labels (r12/r13)**: each session gets a one-line topic from the
  first user prompt, extracted from the journal (`peekTopic`, head then tail
  scan) with a fallback to Pi's own session store
  (`~/.pi/agent/sessions/**/<ts>_<sessionId>.jsonl`, first user message) —
  covering journals written before topics existed. Recovery results are
  memoized per session;
- Rendered in the page's History area (the persistence layer beyond SSE
  replay), grouped by project (see §8.2).

---

## 8. Multi-session: the host/client shared service (requirement 4)

### 8.1 Roles and election

```
session_start:
  1. Try to bind 127.0.0.1:7330 (increment +1, up to 10 ports)
  2. Bind wins → HOST: start the server, register self as first session
  3. Bind fails but /healthz answers with this plugin's fingerprint → CLIENT:
     POST /api/sessions (sessionId, cwd, name, pid),
     then forward events via UplinkBuffer → micro-batched POST /api/ingest
  4. Both fail → disable for this session, notify once, stay silent
host exits (session_shutdown / crash):
  a client's next POST fails → everyone enters a reconnect loop (≤2 s tick,
  heartbeat 30 s) → each races to bind → winner becomes the new host
  (OS bind is atomic — no election protocol) → losers re-register; meanwhile
  local events buffer with bounds (overflow drops deltas first, segments last)
all exit → the server disappears with the last host; zero residue
```

### 8.2 Session identity and page presentation

- Session identity: the Pi sessionId; display: project folders (cwd
  basename) with **VSCode-style nesting** (indent guides, caret rotation),
  per-session **topic labels** (first user prompt, ≤32 chars), unread
  badges, model name; **ended sessions are grayed out** (gray dot, reduced
  opacity) and sessions missing from a fresh `hello` (host restart /
  takeover) are diff-removed — ghost rows no longer accumulate;
- Same-basename projects (two `…/app` dirs) get parent-disambiguated titles
  (`alpha/app` vs `beta/app`);
- Page layout:
```
┌────────┬──────────────────────────────┬────────┐
│sidebar │  current session message flow │ dual-  │
│        │  (translation-first, thinking │ view   │
│ ● projA│   collapsible, code highlight,│ toggle │
│ ○ projB│   tool lines)                 │        │
│ ──────│                              │        │
│ history│                              │        │
│ ⚙ settings                            │        │
└────────┴──────────────────────────────┴────────┘
```
- Unread badges: per-session counts of new segments while in background;
- Instant switching (per-session DOM containers suspended via
  `display:none`; a session's message DOM is capped — oldest messages fold
  with a "see History" note);
- **History area (r12/r13)**: journals grouped by project (cwd from journal
  records — head scan, tail scan, then Pi-store recovery — with per-session
  memoization); rows show date + topic (not uuids); sessions that are live
  right now carry a green "in progress" badge explaining the duplicate;
  empty journals are never listed; long lists announce truncation
  ("… N more") instead of hiding rows; opening a session replays it with
  roles restored (user cards with the "你" avatar, collapsible thinking
  blocks) rather than a flat assistant stream.

### 8.3 Host reporting protocol (client → host)

- `POST /api/sessions` (register / 30 s heartbeat; 90 s silence = dead,
  pruned)
- `POST /api/ingest`: batched events (same shape as SSE events),
  micro-batched 50 ms / 8 KB, session info piggybacked;
- Token auth (§9.4); clients read `~/.pi/agent/output-translate.token`;
- Clients never translate (the host does it all) — one model connection and
  one GPU footprint no matter how many windows are open.

---

## 9. Web service and frontend

### 9.1 Service (inside the host)

| Route | Description |
|-------|-------------|
| `GET /` | Reader page (token substitution; cookie planted on first authorized visit) |
| `GET /app.js` `/style.css` `/md.js` `/vendor/*` | Static assets, read from disk per request (a browser refresh always picks up frontend changes) |
| `GET /events?since=` | SSE: snapshot hello + ring-buffer replay, then live |
| `POST /api/ingest` | Client event upload (token) |
| `POST /api/focus` / `POST /api/typing` | Terminal key-activity proxy (focus-follow) |
| `POST /api/sessions` | Client register / heartbeat / remove |
| `POST /api/sessions/:id/mute` | Per-session translation mute |
| `GET /api/config` / `POST /api/config` | Config read/write (masked apiKey round-trips; file is the source of truth) |
| `GET /api/engine/models` | List engine models |
| `POST /api/engine/test` | Translate one sentence (settings-panel verification) |
| `POST /api/retry` `{segId}` | Manual retranslation of one segment |
| `POST /api/retry-failed` `{sessionId}` | Retry all failed segments of a session |
| `POST /api/cache/clear` / `GET /api/cache/stats` | Cache management |
| `GET /api/history` | Grouped journal list: `{sessions, groups[{cwd,name,sessions[{sessionId,mtime,bytes,topic}]}], live[]}` |
| `GET /api/history/:id` | One session's journal records |
| `GET /healthz` | Fingerprint `{app, ver, pipeline, host, sessions, queue, engine}` |

### 9.2 SSE protocol (actual event names)

```
hello          {sessions[], engine, cfg, focus?, ver?}   // snapshot on connect
focus          {s, ts}        // transient: a terminal received keystrokes
typing         {s, ts}        // transient: focused terminal is typing
session_up     {s: SessionInfo}
session_down   {s, reason}    // shutdown | timeout
session_mute   {s, muted}
msg_start      {s, m, role, model?}
delta          {s, m, k: text|thinking, c, d}
segment        {s, m, k, id, src, pb?, r?, lang?, of?}
trans          {id, st, tgt?, rsn?, dg?, ms?}   // translating|done|failed|skipped|cached|notrans|degraded
tool           {s, m, tc, name, ph, sum?, ms?, ok?}
msg_end        {s, m}
cfg            {cfg}          // hot-applied config broadcast
status         {q, eng, drop, clients, p, a, old}  // queue depth, engine health, backlog detail
```

`hello`/`focus`/`typing` semantics worth noting: `hello` carries the full
session snapshot (the frontend uses it to diff-remove ghosts); `focus` and
`typing` are transient (never replayed) so reconnects don't yank the view
back in time.

### 9.3 Settings panel (web config, requirement 3)

Config-server pattern (form over file, mtime hot reload): form → `POST /api/config` →
write `~/.pi/agent/output-translate.json` → broadcast `cfg` → host hot-applies
(clients poll file mtime). The form always reflects the **file** (the source
of truth), never a process's stale memory — a lesson burned in by the
"settings panel showed defaults after a zombie process takeover" incident.
Panel contents: engine/model (dropdown fetched from `/api/engine/models`),
target language, content-source toggles, performance parameters, glossary
editor, cache management (clear / hit-rate), idle behavior, and a "test
translate" button. A masked apiKey in the payload means "keep the stored
one".

### 9.4 Security

- Loopback only; Host-header validation (DNS-rebinding guard);
- Persistent token: generated by the first host, written to
  `~/.pi/agent/output-translate.token` (0600); pages authorize via URL
  token (then a cookie), APIs via Bearer or query token;
- SSE client cap 8; per-client send buffer > 4 MB disconnects (slow-
  consumer protection); request body cap 1 MB.

---

## 10. Command system (CLI config, requirement 3)

```
/pot                    open the reader page (or print the URL in non-TUI modes)
/pot open               same, explicit
/pot on | off           master switch
/pot thinking on|off    thinking translation toggle
/pot tools on|off       tool-line toggle
/pot engine <id>        switch engine: ollama | openai-compat | pi-model
/pot model <name>       switch translation model
/pot lang <zh-Hans|…>   target language
/pot glossary add k=v | del k | list
/pot cache clear | stats
/pot retry-failed       retry every failed segment of the current session
/pot config             open the web settings panel
/pot status             port / role / engine / queue / cache / session overview
/pot stop               host: shut the server down; client: deregister + stop uplink
```

Every command writes the config file immediately (same source of truth as
the web panel) and is guarded by `ctx.hasUI`. Hotkey `ctrl+alt+p` toggles
the master switch (registered with a super-key alias).

---

## 11. Configuration schema

`~/.pi/agent/output-translate.json` (mtime hot-reload):

```jsonc
{
  "enabled": true,
  "server": { "port": 7330, "host": "127.0.0.1", "autoOpen": false, "tokenFile": "" },
  "sources": { "assistantText": true, "thinking": true, "userMessage": true, "toolLines": true },
  "translate": {
    "engine": "ollama",
    "baseUrl": "http://127.0.0.1:11434",
    "apiKey": "",                      // optional, openai-compat
    "model": "qwen3:8b",
    "piModelId": "",                   // provider/model-id for the pi-model engine
    "targetLang": "zh-Hans",
    "temperature": 0.1,
    "concurrency": 1,
    "timeoutSeconds": 45,
    "maxSegmentChars": 1200,
    "minEnglishChars": 40,
    "contextSegments": 2,
    "batchWindowMs": 300, "batchSize": 4,
    "codeComments": "off"
  },
  "glossary": { "race condition": "竞态条件" },   // merged over the built-in table
  "queue": { "maxPending": 300 },
  "cache": { "persist": true, "maxEntries": 2000 },
  "journal": { "dir": "", "maxFileMb": 2, "maxFiles": 20 },
  "display": { "defaultShowOriginal": false, "autoScroll": true, "thinkingCollapsed": true },
  "idle": { "noViewerBehavior": "text-only" }   // none | text-only | full
}
```

---

## 12. Performance budget and resource caps (requirements 2, 5)

### 12.1 Performance budget (hard metrics, test-asserted)

| Stage | Budget |
|-------|--------|
| Single event handler (worst-case delta) | < 1 ms synchronous return, zero awaits |
| First-segment visible latency (local qwen3:8b, 200-char segment) | < 3 s (cache hit < 50 ms) |
| SSE delta forwarding granularity | 50 ms micro-batches (never per token) |
| Page segment rendering | append-only per-segment nodes, O(1) incremental |
| Syntax highlighting | once per finalized block (plain text while streaming) |
| Translation request count | ≈ segments/4 after batching; 0 on cache hits |
| `/api/history` | metadata cached per journal mtime; Pi-store recovery memoized per session |

### 12.2 Resource caps

| Item | Cap | Overflow behavior |
|------|-----|-------------------|
| RingBuffer | 4000 events global | drop oldest |
| Translation cache | LRU 2000 (~4 MB) + disk | evict |
| Page DOM | 250 messages per session container | fold oldest with a History note |
| Journal | 2 MB × 20 non-empty files (~40 MB) | rolling delete (stale empties first) |
| Client uplink buffer | 256 events | drop deltas first, keep segments |
| All pages closed | `idle.noViewerBehavior` (default text-only: text still translates into cache, thinking pauses) | — |
| Idle CPU | no polling loops (heartbeat 30 s, mtime 5 s, health 60 s — all second-scale and unref'd) | — |

### 12.3 Why the footprint stays low

Translation concentrates in one host worker (one model connection / one GPU
footprint shared by all windows); zero npm runtime dependencies;
marked/highlight.js are browser-side static files costing the Pi process
nothing; every buffer is bounded with an explicit overflow policy.

---

## 13. Edge-case catalogue (requirement 10)

| Case | Handling |
|------|----------|
| thinking block `redacted:true` | shows "thinking was safety-filtered", never sent |
| mixed Chinese/English paragraph | language gate judges by post-mask English prose chars |
| user message in Chinese | displayed untranslated — and journaled (r12b) so topics and history replay include it |
| session branch rollback / tree navigation | page is an append-only timeline; new branches render as continuation |
| compaction | unaffected (never reads context) |
| session replace (/new, resume) | old session deregisters, new registers, sidebar updates |
| RPC/JSON/print modes | everything guarded by `ctx.hasUI`; server still runs (notifications silent) |
| port held by a foreign process | 7330+1 increments; all 10 busy → disable + notify once |
| two Pi processes start the same second | OS bind is atomic; one host, one client, zero races |
| host crash | client POST fails → reconnect loop → race to take over (§8.1); history journals survive on disk |
| **host restart while pages stay open (r12)** | pages reconnect via SSE; the fresh `hello` snapshot diff-removes ghost sessions; the config panel reads the file, never stale memory |
| translation model swapped mid-flight (hot config) | in-flight batches finish on old config; later segments use the new one; cache keys include engine+model so entries never collide |
| very long thinking (10 k+ chars) | coarse segmentation + backpressure drops thinking first (`skipped`) + page collapses by default |
| multiple browser tabs | independent SSE each; replay is idempotent (terminal-state dedupe) |
| system sleep/wake | SSE auto-reconnects with `since` cursor catch-up |
| corrupt journal | line-by-line parse, bad lines skipped (jsonl is naturally tolerant) |
| missing token file / bad permissions | host regenerates; client notifies once and disables uplink |
| **journals predating cwd recording (r13)** | cwd recovered by tail-scanning the journal, then from Pi's session store — memoized per session |
| **journal without any user prompt (r13)** | topic falls back to Pi's own session file (first user message); uuid only as a last resort |
| **two projects sharing a basename** | group titles disambiguate as `parent/name` |

---

## 14. Testing and acceptance (must-pass gates)

1. **typecheck + vitest green** before any commit/release (a load-time crash in any extension bricks the host).
2. Units: segmenter (sentence boundaries / fences / long-split / comment
   extraction), protect (round-trip, swallowed-placeholder repair,
   degrade), language gate, glossary merge, cache, batch splitting, journal
   parsing + retention policy.
3. Zero-blocking assertions: engine mocked as `sleep(∞)`; every handler
   returns < 1 ms and undefined.
4. Host/client integration: two module instances in one test process →
   host exit → takeover → no segment-level loss.
5. e2e (real Pi): headless session + SSE receives done segments; kill the
   engine, the agent still completes, segments mark failed, retry works
   after recovery.
6. Resource assertions: 8 sessions × 5000 segments → host RSS growth
   < 40 MB.
7. Manual checklist: `/reload` idempotency, no residual ports on shutdown,
   two real windows switching, web config change hot-applies to both
   sessions, tokenless requests 401.
8. **History-logic suite (r12/r13)**: topic extraction & the marker-stripping
   regex, journal head/tail cwd scanning, Pi-store cwd+topic recovery,
   empty-journal filtering and retention fairness, same-basename group
   disambiguation, `notrans` user-prompt journaling, grouped-list ordering.

Current suite: **287 tests / 19 files** (`npm test`).

---

## 15. Project structure and implementation order

```
pi-output-translate/
├── package.json            # zero runtime deps; pi-package manifest
├── tsconfig.json           # + vitest config
├── README.md / SPEC.md
├── scripts/                # e2e.ts, r12-smoke.ts (real-data smoke)
├── src/
│   ├── index.ts            # entry: event registration, commands, hotkey, role wiring
│   ├── config.ts           # schema + defaults + mtime hot-reload + atomic write
│   ├── role.ts             # host/client election, uplink buffer, reconnect/takeover
│   ├── collector.ts        # events → bus (O(1), all try/catch)
│   ├── hub.ts              # session registry + ring buffer + routing + journal writes
│   ├── segmenter.ts        # sentence segmentation / code stripping / comment extraction
│   ├── protect.ts          # mask / placeholders / restore / repair
│   ├── langgate.ts         # language gate
│   ├── glossary.ts         # built-in glossary + user extensions + term lock
│   ├── queue.ts            # batching worker, timeouts, retries, backpressure
│   ├── cache.ts            # LRU + disk
│   ├── journal.ts          # jsonl micro-batched persistence, retention, cwd/topic peek & recovery
│   ├── engines/{ollama,openai-compat,pi-model}.ts
│   ├── prompt.ts           # three-part system prompt assembly
│   ├── server.ts           # http + SSE + API (loopback + token + Host guard) + history metadata cache
│   └── web/                # index.html / app.js / style.css / md.js / vendor/
└── test/                   # §14 in full
```

Implementation order (one version, not phased releases):
① config + collector + hub + server + SSE + reader page (raw-text multi-
session stream) → ② segmenter + protect + langgate + glossary + engines +
queue + cache (the full translation chain) → ③ role/uplink (host/client,
takeover) → ④ journal + history page → ⑤ settings panel + full command set
→ ⑥ all §14 gates green → v1.0.

---

## 16. Open decisions (defaults chosen, revisit anytime)

| Decision | Default | Alternative |
|----------|---------|-------------|
| default engine | ollama direct | openai-compat / pi-model |
| code-comment translation | off (`below` available) | always-on `below` |
| all pages closed | text-only (keep translating into cache) | none (full stop) |
| port | 7330 | any |
| disk cache / journal | on | off (memory only) |
| history retention | 20 non-empty × 2 MB, stale empties purged | larger window |

---

## 17. Revision history

| Rev | Scope |
|-----|-------|
| r11 | URL-compat normalization for openai-compat baseUrls; history folder collapse fix; queue observability; pi-model abort fix |
| r12 | Session/history overhaul: hello diff-removal of ghost sessions + `_gone` styling; per-session topic labels; empty journals filtered from the list and from retention slots; role-aware history replay; truncation notes; cwd head+tail scanning with mtime-keyed caching; Pi-store recovery memoized; group-name disambiguation (`parent/name`); fingerprint without mtime |
| r12b | `notrans` user prompts journaled (topics + replay for Chinese-prompt sessions); `peekTopic` tail fallback |
| r13 | Topic fallback chain completed via Pi's own session store (first user message per session); VSCode-style sidebar nesting with indent guides; docs translated to English and sanitized |
| r13a | Sidebar group-naming regression fix (one-shot Map iterator exhaustion made every live folder "（未知）") with extraction-based regression tests |
| r13b | Proportional batch deadlines + adaptive batch sizing: multi-segment batches get up to 2× the per-segment timeout, and a failing batch shrinks 4→2→1 instead of burning a timeout per single retry (the "queue looked stuck at ~4 segments/90 s" field report) |
| r14 | Translation pipeline strip (user proposal): a top backlog bar whose length tracks the remaining untranslated count per wave, plus a live stage view (accumulate → batch → translate → done) with adaptive batch size and engine-health states; per-session pending breakdown in status events |
| r14a | Settings-controls audit (17 new unit+integration tests): fixed concurrency=2 never actually overlapping (the batch loop awaited each batch inline), added the missing idle "full" option (type + UI), verified every content-source gate, codeComments, idle policies, batch window/size, timeout retry, and live hot-apply over HTTP |
| r15 | All UI icons replaced with Lucide (v1.63.0, ISC): 18-icon inline sprite embedded in the page, stroke follows currentColor — zero extra requests, zero runtime dependencies |

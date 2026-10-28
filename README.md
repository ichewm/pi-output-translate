# pi-output-translate

> A **display-only, real-time Chinese translation companion** for the
> [Pi coding agent](https://github.com/earendil-works/pi-coding-agent): it
> faithfully translates assistant text and thinking into Simplified Chinese and
> streams everything to an independent browser reader page, shared across all
> running Pi sessions. It never modifies the agent's execution, context, or
> terminal output.

## Features

- **Bypass isolation** — Pi event handlers only do O(1) synchronous pushes;
  translation happens in a separate worker. Engine crashes, timeouts, or a
  closed reader page never affect the agent (asserted by dedicated
  zero-blocking tests).
- **Multi-session sharing** — the first Pi process to bind port 7330 becomes
  the host (it runs all translations); later processes register as clients and
  forward their events. When the host exits, a client takes over
  automatically. When the last process exits, the service disappears — zero
  residual daemons.
- **Faithful, localized translation** — no summarizing, no rewriting. Ships a
  built-in glossary of ~150 software-engineering terms (race condition →
  竞态条件, idempotent → 幂等, gotcha → 坑, …), user-extendable; a per-session
  term lock keeps translations consistent within a conversation.
- **Code is never translated** — code blocks, inline code, commands, paths,
  and URLs are stripped out and rendered verbatim. Optionally, code-comment
  translations can be appended under code blocks (`codeComments: "below"`,
  off by default).
- **Browser reader page** — multi-session sidebar with per-project folders
  (VSCode-style nesting with indent guides), unread badges, per-session
  **topic labels** (the first user prompt — Chinese included), translation-
  first view with per-segment original toggle, collapsible thinking, syntax
  highlighting, tool lines, manual retry for failed segments, **history
  replay with user/assistant roles restored**, and a web settings panel that
  hot-applies on save.
- **Self-healing sessions list** — sessions that ended or were forgotten
  after a host restart are grayed out or diff-removed; ghost rows with live
  green dots can no longer accumulate.
- **History done right** — journals are grouped by project with recovered
  cwd; every entry gets a readable topic (recovered from the journal or from
  Pi's own session store); empty journals are filtered out and never consume
  retention slots; live sessions are badged; truncation is always announced
  ("… N more") instead of silently hiding rows.
- **Performance friendly** — one translation worker shared by all sessions;
  batched requests (300 ms window / 4 segments); LRU translation cache
  persisted to disk (reopen = no retranslation); when no viewer page is open,
  only assistant text is translated into the cache.
- **Zero npm runtime dependencies**; binds 127.0.0.1 only + token + Host
  header validation.

## Install

```bash
# from npm
pi install npm:pi-output-translate

# from git (pinned to a tag once released)
pi install git:github.com/ichewm/pi-output-translate

# try it once without installing
pi -e npm:pi-output-translate

# development
pi -e /path/to/pi-output-translate
```

Restart Pi or run `/reload`. Default configuration is written to
`~/.pi/agent/output-translate.json`.

## Usage

```bash
/pot              # open the browser reader page (or print the URL)
/pot status       # role / port / engine / queue / session counts
/pot thinking off # disable thinking translation
/pot engine openai-compat
/pot model qwen3:8b
/pot glossary add "backpressure=背压"
/pot cache stats
/pot retry-failed
/pot stop
ctrl+alt+p        # global on/off hotkey
```

Open the ⚙ settings panel (bottom-right of the reader page) for:
engine/model selection (with model-list fetching), content-source toggles,
performance parameters, glossary editing, a "test translate" button, cache
management, and per-session mute.

## Translation engines

| Engine | Notes |
|---|---|
| `ollama` (default) | Direct local Ollama `/api/chat` (`think:false`) |
| `openai-compat` | Any OpenAI-compatible `/chat/completions` endpoint: llama.cpp, LM Studio, vLLM, or hosted services (e.g. Zhipu bigmodel) |
| `pi-model` | Reuses a model already configured in Pi (`ctx.modelRegistry`, reasoning: low) |

The `openai-compat` engine accepts three `baseUrl` forms and normalizes them:
a bare host (`https://api.example.com`), a base with version path
(`…/api/paas/v4`), and a full endpoint (`…/chat/completions`).

Example configuration:

```jsonc
{
  "translate": {
    "engine": "openai-compat",
    "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
    "apiKey": "<your-key>",
    "model": "glm-4-flash",
    "targetLang": "zh-Hans"
  }
}
```

> Tip: a free-tier flash model (e.g. `glm-4-flash`) comfortably keeps up with
> live agent output at concurrency 1; a local 8B model works but is ~30 s per
> batch.

## Architecture

```
pi process A (host)                       pi process B (client)
 agent → TUI (untouched)                  agent → TUI (untouched)
   │ message_* events                       │ message_* events
   ▼ O(1) push                              ▼ O(1) push
 Collector → Hub ── RingBuffer ── SSE ──► Browser ◄── POST /api/ingest ← Uplink
              └→ TranslateQueue (batch/retry/repair) → ollama/openai-compat/pi-model
              └→ Cache (LRU + disk) / Journal (jsonl history)
```

Design red lines: never subscribes to mutating events (`context*`,
`tool_call`, …), `message_end` handlers never return a value, never calls
`sendMessage` / `appendEntry` / injects prompts; translation results never
flow back into the agent.

## Tests

```bash
npm test        # 317 unit/integration tests (vitest)
npm run typecheck
npm run e2e     # full chain: mock engine + real Hub/Server/Role + SSE assertions
```

Coverage highlights: segmenter (sentence boundaries / fences / cross-delta),
content-protection round-trips and repair, language gate, batch protocol
parsing, timeout/retry/backpressure, cache, journal (including retention and
empty-file policy), SSE replay, token/Host hardening, host/client election
and takeover, **zero-blocking assertions** (with the engine mocked as
`sleep(∞)`, handlers still return in milliseconds), plus the r12/r13
history-logic suite (topic extraction & recovery, cwd head/tail scanning,
group disambiguation, ghost-session behavior).

See [SPEC.md](./SPEC.md) for the full design document.

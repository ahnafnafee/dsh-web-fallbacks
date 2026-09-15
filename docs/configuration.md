# Configuration reference

Merge the [example patch](../examples/cordis.patch.example.yml) into your local DSH patch. Run `node scripts/print-config.mjs` from the checkout to produce the correct file URL automatically. The printer reads only the public template and package version; it does not read your existing DSH configuration or credentials.

## Providers

| Option | Default | Behavior |
| --- | --- | --- |
| `primary` | `deepseek-official` | Search provider ID in DSH; empty string skips it |
| `bin` | `claude` | Claude Code executable |
| `model` | `haiku` | Claude model alias |
| `codexBin` | `codex` | Codex executable; empty string disables Codex |
| `codexModel` | `gpt-5.6-sol` | Codex model; choose one available to your account |
| `fetchPrimary` | `http` | Fetch provider ID in DSH; empty string skips it |
| `fetchMinChars` | `200` | Minimum trimmed content length accepted from the primary HTTP fetch |
| `firecrawlMcpUrl` | `""` | Firecrawl MCP streamable HTTP endpoint; empty string disables it |
| `linkscMcpUrl` | `""` | Linksc MCP streamable HTTP endpoint; empty string disables it |
| `linkscHeaders` | `{}` | Additional HTTP headers for Linksc |

The minimum-length check is a heuristic for the primary HTTP provider. It can send a legitimate short page to a later provider and does not detect every script-only page. Later backends must return non-empty content.

Keep `primary` and `fetchPrimary` different from `claude-code`: selecting this plugin as its own primary would recurse. Missing primary provider registrations are skipped.

## Deadlines

All values are positive integer milliseconds.

| Option | Default |
| --- | ---: |
| `primaryTimeoutMs` | `5000` |
| `timeoutMs` | `25000` |
| `codexTimeoutMs` | `40000` |
| `firecrawlSearchTimeoutMs` | `20000` |
| `fetchPrimaryTimeoutMs` | `15000` |
| `fetchTimeoutMs` | `60000` |
| `codexFetchTimeoutMs` | `45000` |
| `firecrawlTimeoutMs` | `30000` |
| `linkscTimeoutMs` | `20000` |
| `searchToolTimeoutMs` | `120000` |
| `fetchToolTimeoutMs` | `180000` |

Provider timeouts advance the chain. Cancellation from the caller stops it. The primary provider receives an abort signal and is bounded by a deadline race; a provider that ignores cancellation may continue its own work in the background.

When DSH's `tools` service is available, the plugin raises existing web tool budgets and checks them again before execution. It restores the previous values when unloaded, provided another plugin has not changed them. Agent presets still need to register the web tools and enable site fetch themselves.

## Executable paths

`bin` and `codexBin` are passed directly to `spawn`, without a shell. Use executable names on `PATH` or absolute executable paths. For Windows, point to the native `.exe` when a shell wrapper cannot be spawned:

```yaml
bin: "C:/tools/claude.exe"
codexBin: "C:/tools/codex.exe"
```

Those are illustrative paths. The installed CLIs must already be authenticated. The plugin does not perform login flows.

## Optional MCP backends

Firecrawl must expose:

- `firecrawl_search`, accepting `{ query, limit }`.
- `firecrawl_scrape`, accepting `{ url, formats: ["markdown"], onlyMainContent: true }`.

Use a [Firecrawl MCP endpoint](https://github.com/firecrawl/firecrawl-mcp-server) appropriate to your deployment. This adapter passes no custom Firecrawl headers, so the configured endpoint must support the authentication carried by its URL or require no additional headers.

Linksc must expose:

- `search`, accepting `{ q }`.
- `fetch`, accepting `{ url, timeout }`, with timeout in seconds.

The client initializes each operation, preserves an MCP session ID when returned, and accepts JSON or SSE responses. Linksc search responses can contain structured result arrays or explicit Markdown links; page responses can contain Markdown, text, or HTML.

Credentials belong in the local DSH patch, outside the repository. URL-based credentials, headers, CLI errors, and provider responses can contain sensitive data, so review diagnostic output before sharing it. Setting an endpoint to an empty string disables that backend. Firecrawl is attempted before Linksc whenever both are configured.

## Reloading

The configuration printer adds `?v=0.1.0` to the absolute module file URL. Node caches imported modules, so editing the file alone may leave a running DSH process using older code. Restart DSH, or change that suffix when reloading the patch.

Use an **absolute file URL** for a version suffix. A relative filename with a query string can be interpreted by the DSH loader as a literal filename. Keep both schema files beside the module.

## Compatibility

The integration was exercised with DSH `0.1.5-rc.1`, Claude Code `2.1.273`, Codex CLI `0.154.0`, and Node.js `24.19.0` on Windows. Offline CI also targets Node.js 22 and 24 on Linux and Windows.

Codex runs with live web search, read-only sandboxing, schema output, and shell tools disabled. Its final reply is accepted only after a completed turn and a native web action. Codex CLI `0.154.0` represents some URL opens as a web item with action `other`; the adapter accepts that observed format only when its query exactly matches the requested URL.

Claude runs with only the relevant web tool enabled, a dedicated system prompt, no session persistence, and user settings and MCP configuration excluded. Claude search enforces the sources schema. Fetch returns the text exposed by WebFetch.

The plugin reads DSH's provider registries and adjusts model-facing tool definitions directly. Those are integration points to recheck when upgrading DSH. These backends are suitable for retrieved page text; they do not provide byte-for-byte downloads, complete-page guarantees, or reliable origin HTTP status through the CLIs.

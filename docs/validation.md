# Validation

## Reproducible checks

```sh
npm test
npm run test:live
```

The default command needs no external accounts or network services. Tests use subprocess fixtures and loopback MCP servers. The live command enables five additional integration cases using the installed, authenticated Claude Code and Codex CLIs.

The live cases verify:

1. Claude returns sources for a public documentation search.
2. Two documentation queries succeed after the primary search provider fails.
3. Codex returns sources when Claude cannot launch.
4. Claude retrieves text from `example.com`.
5. Codex retrieves text from `example.com` when Claude cannot launch.

The sanitized public suite was rerun on 2026-09-15: **29 passed, 0 failed, 0 skipped** in 83.086 seconds. This included all five live integration cases using the generic documentation fixtures.

## Initial integration validation

The underlying implementation passed 29 tests, with no failures or skips, on 2026-09-15. Six additional probes exercised it inside a running DSH host:

| Probe | Observed result |
| --- | --- |
| Search through DSH's registered provider | Non-empty source list |
| Claude site fetch | Expected Example Domain text |
| Search with Claude deliberately unavailable | Codex returned sources |
| Fetch with Claude deliberately unavailable | Codex returned expected page text |
| Search with both CLIs deliberately unavailable | Firecrawl returned sources |
| Fetch with both CLIs deliberately unavailable | Firecrawl returned expected page text |

A mutation check removed the Claude schema flag from a temporary copy. The schema regression then failed on a prose-only response, demonstrating that it detects the original parsing defect.

The public test fixtures replace private troubleshooting queries with generic Node.js documentation queries. Session exports, endpoint credentials, local paths, raw subprocess logs, and host identifiers are not part of this repository.

## Limits

These checks confirm structured output, provider selection, error handling, and retrieval of a small public page. They do not establish retrieval completeness for long pages or availability across all accounts and providers.

The tested Linksc deployment returned an upstream 502 for search and timed out during site fetch. Its adapter and fallback order passed local mock tests; that deployment did not pass live validation. Firecrawl succeeded ahead of it. Service availability is specific to the configured deployment and time of testing.

CI runs only the offline cases. A green workflow therefore does not imply that any external account is authenticated or that a particular live service is healthy.

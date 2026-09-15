# Contributing

Use Node.js 22.12 or newer. The plugin and test suite have no npm dependencies.

```sh
npm test
```

Add regression coverage when changing provider parsing, fallback order, cancellation, or deadlines. Prefer local mock servers and subprocess fixtures so the default suite stays independent of accounts and external services.

Run `npm run test:live` when changing CLI integration. This requires authenticated Claude Code and Codex installations and uses their account quotas. Describe what you actually tested in the pull request, including any unavailable provider.

Keep issues, fixtures, and pull requests free of credentials, home-directory paths, session exports, and private search queries. Use generic examples and summarize live results instead of attaching raw logs. Use Conventional Commits for commit subjects and pull-request titles.

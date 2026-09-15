// npm test; npm run test:live also exercises authenticated CLI providers.
// Live tests use the existing CLI accounts and consume their provider quota.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import { apply, claudeFetch, claudeSearch, firecrawlScrape, normalizeSources, parseSources, resolveOptions, unfence } from '../web-search-claude-code.mjs';

const NO_BIN = 'definitely-not-a-binary';
const LONG = 'x'.repeat(500);

function fakeCtx({ search, fetch } = {}) {
  const registered = {};
  return {
    web: {
      searchProviders: new Map(search ? [[search.id, search]] : []),
      fetchProviders: new Map(fetch ? [[fetch.id, fetch]] : []),
      registerSearchProvider: (provider) => { registered.search = provider; },
      registerFetchProvider: (provider) => { registered.fetch = provider; },
    },
    registered,
  };
}

const okPage = (content) => ({ url: 'https://p', statusCode: 200, body: { kind: 'html', content }, truncated: false });
const httpProvider = (fetch) => ({ id: 'http', available: () => true, fetch });

test('web tools retain enough time for all fallback providers and restore on unload', async () => {
  const ctx = fakeCtx();
  const searchTool = { timeoutMs: 60000 };
  let beforeExecute, dispose;
  ctx.inject = (deps, setup) => setup({
    tools: { get: name => name === 'web_search' ? searchTool : undefined },
    on: (event, callback) => { assert.equal(event, 'tools/pre-execute'); beforeExecute = callback; },
    effect: setup => { dispose = setup(); },
  });
  apply(ctx);
  let observedTimeout;
  await beforeExecute({ name: 'web_search' }, () => { observedTimeout = searchTool.timeoutMs; });
  assert.equal(observedTimeout, 120000);
  dispose();
  assert.equal(searchTool.timeoutMs, 60000);
});

const SEARCH_QUERY = 'Node.js 22 release native TypeScript support official documentation';
const PROSE_REPLY = "Based on my search, the feature belongs to a different release. Here is a prose explanation instead of the requested source JSON.";

function mockCommands(t, respond) {
  const calls = [];
  t.mock.method(childProcess, 'spawn', (bin, args, options) => {
    const call = { bin, args, options, stdin: '' };
    calls.push(call);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const aborted = () => {
      child.emit('error', Object.assign(new Error('aborted'), { name: 'AbortError' }));
      child.emit('close', null);
    };
    options.signal.addEventListener('abort', aborted, { once: true });
    child.stdin = new Writable({
      write(chunk, encoding, done) { call.stdin += chunk.toString(); done(); },
      final(done) {
        setImmediate(() => {
          if (options.signal.aborted) return;
          const reply = respond(call);
          if (reply === null) return; // Deliberately wait for the subprocess timeout.
          options.signal.removeEventListener('abort', aborted);
          if (reply instanceof Error) child.emit('error', reply);
          else {
            child.stdout.end(reply.stdout ?? '');
            child.stderr.end(reply.stderr ?? '');
          }
          child.emit('close', reply.code ?? 0);
        });
        done();
      },
    });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return calls;
}

const CODEX_SOURCES = [{ url: 'https://nodejs.org/en/blog/release/v22.0.0', title: 'Node.js 22', snippet: 'Release documentation.' }];
const codexEvents = (last = { type: 'turn.completed' }) => [
  { type: 'thread.started', thread_id: 'test' },
  { type: 'item.completed', item: { type: 'agent_message', text: 'Searching the documentation.' } },
  { type: 'item.completed', item: { type: 'web_search', status: 'completed', query: SEARCH_QUERY } },
  { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ sources: CODEX_SOURCES }) } },
  last,
].map(x => JSON.stringify(x)).join('\n') + '\n';

test('fetch: Codex opens the requested site after Claude fails', async (t) => {
  const page = { success: true, url: 'https://example.com/', content: '# Example Domain' };
  const stdout = [
    { type: 'item.completed', item: { type: 'web_search', query: page.url, action: { type: 'other' } } },
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(page) } },
    { type: 'turn.completed' },
  ].map(x => JSON.stringify(x)).join('\n');
  const calls = mockCommands(t, ({ bin }) => bin === 'fake-claude' ? new Error('Claude unavailable') : { stdout });
  const ctx = fakeCtx();
  apply(ctx, { fetchPrimary: '', bin: 'fake-claude', codexBin: 'fake-codex' });
  assert.deepEqual(await ctx.registered.fetch.fetch({ url: page.url }), {
    url: page.url, statusCode: 200, body: { kind: 'text', content: page.content }, truncated: false,
  });
  assert.deepEqual(calls.map(x => x.bin), ['fake-claude', 'fake-codex']);
  assert.ok(calls[1].stdin.includes(page.url));
});

test('search: Firecrawl precedes Linksc after both headless providers fail', async () => {
  const seen = [];
  let firecrawlFails = false;
  const firecrawl = await mockFirecrawl(params => {
    seen.push('firecrawl');
    assert.equal(params.name, 'firecrawl_search');
    assert.equal(params.arguments.query, SEARCH_QUERY);
    return firecrawlFails ? { isError: true, content: [{ type: 'text', text: 'quota exhausted' }] }
      : { content: [{ type: 'text', text: JSON.stringify({ success: true, data: { web: [{ url: 'https://firecrawl.test', title: 'FC', description: 'Found by Firecrawl' }] } }) }] };
  });
  const linksc = await mockFirecrawl(params => {
    seen.push('linksc');
    assert.equal(params.name, 'search');
    assert.deepEqual(params.arguments, { q: SEARCH_QUERY });
    return { content: [{ type: 'text', text: JSON.stringify({ results: [{ url: 'https://linksc.test', title: 'Linksc', snippet: 'Last fallback' }] }) }] };
  });
  try {
    const ctx = fakeCtx();
    apply(ctx, { primary: '', bin: NO_BIN, codexBin: NO_BIN, firecrawlMcpUrl: firecrawl.url, linkscMcpUrl: linksc.url });
    assert.equal((await ctx.registered.search.search({ query: SEARCH_QUERY })).sources[0].url, 'https://firecrawl.test');
    assert.deepEqual(seen, ['firecrawl']);
    firecrawlFails = true;
    assert.equal((await ctx.registered.search.search({ query: SEARCH_QUERY })).sources[0].url, 'https://linksc.test');
    assert.deepEqual(seen, ['firecrawl', 'firecrawl', 'linksc']);
  } finally { await firecrawl.close(); await linksc.close(); }
});

test('fetch: rejected Codex page falls through to Firecrawl, then Linksc on scrape failure', async (t) => {
  const seen = [];
  let firecrawlFails = false;
  const stdout = [
    { type: 'item.completed', item: { type: 'web_search', action: { type: 'open_page', url: 'https://p' } } },
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ success: false, url: 'https://p', content: 'blocked page' }) } },
    { type: 'turn.completed' },
  ].map(x => JSON.stringify(x)).join('\n');
  mockCommands(t, ({ bin }) => bin === 'fake-claude' ? new Error('Claude unavailable') : { stdout });
  const firecrawl = await mockFirecrawl(params => {
    seen.push('firecrawl');
    assert.equal(params.name, 'firecrawl_scrape');
    return { content: [{ type: 'text', text: JSON.stringify({ markdown: '# Page', metadata: { statusCode: firecrawlFails ? 503 : 200 } }) }] };
  });
  const linksc = await mockFirecrawl(params => {
    seen.push('linksc');
    assert.equal(params.name, 'fetch');
    return { content: [{ type: 'text', text: '# Linksc page' }] };
  });
  try {
    const ctx = fakeCtx();
    apply(ctx, { fetchPrimary: '', bin: 'fake-claude', codexBin: 'fake-codex', firecrawlMcpUrl: firecrawl.url, linkscMcpUrl: linksc.url });
    assert.equal((await ctx.registered.fetch.fetch({ url: 'https://p' })).body.content, '# Page');
    assert.deepEqual(seen, ['firecrawl']);
    firecrawlFails = true;
    assert.equal((await ctx.registered.fetch.fetch({ url: 'https://p' })).body.content, '# Linksc page');
    assert.deepEqual(seen, ['firecrawl', 'firecrawl', 'linksc']);
  } finally { await firecrawl.close(); await linksc.close(); }
});

test('search: a stalled primary and empty Claude results still reach Codex', async (t) => {
  const calls = mockCommands(t, ({ bin }) => bin === 'fake-claude' ? { stdout: JSON.stringify({ structured_output: { sources: [] } }) } : { stdout: codexEvents() });
  const primary = { id: 'deepseek-official', available: () => true, search: () => new Promise(() => {}) };
  const ctx = fakeCtx({ search: primary });
  apply(ctx, { bin: 'fake-claude', codexBin: 'fake-codex', primaryTimeoutMs: 5 });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    assert.deepEqual((await ctx.registered.search.search({ query: SEARCH_QUERY })).sources, CODEX_SOURCES);
    assert.deepEqual(calls.map(x => x.bin), ['fake-claude', 'fake-codex']);
  } finally { clearTimeout(keepAlive); }
});

test('search: Codex headless recovers Claude failures and prose-only replies', async (t) => {
  for (const failure of [new Error('Claude unavailable'), { stdout: JSON.stringify({ result: PROSE_REPLY }) }]) {
    await t.test(failure instanceof Error ? 'launch failure' : 'unstructured reply', async (t) => {
      const calls = mockCommands(t, ({ bin }) => bin === 'fake-claude' ? failure : { stdout: codexEvents() });
      const ctx = fakeCtx();
      apply(ctx, { primary: '', bin: 'fake-claude', codexBin: 'fake-codex' });
      assert.deepEqual(await ctx.registered.search.search({ query: SEARCH_QUERY }), { sources: CODEX_SOURCES, truncated: false });
      assert.deepEqual(calls.map(x => x.bin), ['fake-claude', 'fake-codex']);
      assert.ok(calls[1].stdin.includes(SEARCH_QUERY));
      assert.ok(calls[1].args.includes('--output-schema'));
      assert.ok(calls[1].args.includes('--ignore-user-config'));
      assert.ok(calls[1].args.includes('web_search="live"'));
      assert.equal(calls[1].args[calls[1].args.indexOf('--sandbox') + 1], 'read-only');
    });
  }
});

test('search: a Claude timeout falls back, but caller cancellation never does', async (t) => {
  await t.test('provider timeout', async (t) => {
    const calls = mockCommands(t, ({ bin }) => bin === 'fake-claude' ? null : { stdout: codexEvents() });
    const ctx = fakeCtx();
    apply(ctx, { primary: '', bin: 'fake-claude', codexBin: 'fake-codex', timeoutMs: 5 });
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      assert.deepEqual((await ctx.registered.search.search({ query: SEARCH_QUERY })).sources, CODEX_SOURCES);
      assert.equal(calls.length, 2);
    } finally { clearTimeout(keepAlive); }
  });
  await t.test('caller cancellation', async (t) => {
    const calls = mockCommands(t, () => null);
    const ctx = fakeCtx();
    apply(ctx, { primary: '', bin: 'fake-claude', codexBin: 'fake-codex' });
    const controller = new AbortController();
    const result = ctx.registered.search.search({ query: SEARCH_QUERY }, controller.signal);
    controller.abort();
    await assert.rejects(result, { code: 'WEB_ABORTED' });
    assert.equal(calls.length, 1);
  });
});

test('search: Codex failed or incomplete turns cannot return apparent success', async (t) => {
  for (const stdout of [codexEvents({ type: 'turn.failed', error: { message: 'quota exhausted' } }), codexEvents().split('\n').slice(0, -2).join('\n')]) {
    await t.test(stdout.includes('quota') ? 'failed turn' : 'incomplete turn', async (t) => {
      mockCommands(t, ({ bin }) => bin === 'fake-claude' ? new Error('Claude unavailable') : { stdout });
      const ctx = fakeCtx();
      apply(ctx, { primary: '', bin: 'fake-claude', codexBin: 'fake-codex' });
      await assert.rejects(ctx.registered.search.search({ query: SEARCH_QUERY }), /codex.*(quota exhausted|complete)/i);
    });
  }
});

test('search: failed primary returns structured sources despite the prose reply', async (t) => {
  const sources = [{ url: 'https://nodejs.org/en/blog/release/v22.0.0', title: 'Node.js 22' }];
  let invocation;
  let stdin = '';
  t.mock.method(childProcess, 'spawn', (bin, args, options) => {
    invocation = { bin, args, options };
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({
      write(chunk, encoding, callback) { stdin += chunk.toString(); callback(); },
      final(callback) {
        const schemaIndex = args.indexOf('--json-schema');
        const reply = { is_error: false, result: PROSE_REPLY };
        // Without the flag, replay a representative prose-only parsing failure.
        if (schemaIndex >= 0) reply.structured_output = { sources };
        queueMicrotask(() => {
          child.stdout.end(JSON.stringify(reply));
          child.emit('close', 0);
        });
        callback();
      },
    });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const search = { id: 'deepseek-official', available: () => true, search: async () => { throw new Error('HTTP 402'); } };
  const ctx = fakeCtx({ search });
  apply(ctx);
  assert.deepEqual(await ctx.registered.search.search({ query: SEARCH_QUERY }), { sources, truncated: false });
  assert.equal(stdin, SEARCH_QUERY);
  assert.equal(invocation.options.windowsHide, true);
  const schema = JSON.parse(invocation.args[invocation.args.indexOf('--json-schema') + 1]);
  assert.deepEqual(schema.required, ['sources']);
  assert.deepEqual(schema.properties.sources.items.required, ['url', 'title', 'snippet']);
  assert.equal(invocation.args[invocation.args.indexOf('--output-format') + 1], 'json');
});

/** Minimal MCP streamable-HTTP server answering initialize + firecrawl_scrape. */
function mockFirecrawl(scrapeResult) {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const { id, method, params } = JSON.parse(raw);
      if (method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
      const result = method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock', version: '0' } }
        : scrapeResult(params);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    close: () => new Promise((done) => server.close(done)),
  })));
}

test('parseSources strips fences, drops rows without a url, dedupes by url', () => {
  const text = 'Here:\n```json\n{"sources":[{"url":"https://a","title":"A","snippet":"s"},{"url":"https://a"},{"title":"no url"},{"url":"https://b","title":""}]}\n```';
  assert.deepEqual(parseSources(text), {
    sources: [{ url: 'https://a', title: 'A', snippet: 's' }, { url: 'https://b' }],
    truncated: false,
  });
  assert.throws(() => parseSources('no json here'), /no JSON/);
});

test('normalizeSources handles the schema-validated object and prose still fails loudly', () => {
  assert.deepEqual(normalizeSources({ sources: [{ url: 'https://a', title: 'A', snippet: '' }, { url: 'https://a' }] }), {
    sources: [{ url: 'https://a', title: 'A' }],
    truncated: false,
  });
  assert.deepEqual(normalizeSources({}), { sources: [], truncated: false });
  assert.throws(() => parseSources("Based on the search results, here's what I found about the release:"), /no JSON/);
});

test('unfence strips only a fence around the whole reply', () => {
  assert.equal(unfence('```markdown\n# T\n\n```js\ncode\n```\n```'), '# T\n\n```js\ncode\n```');
  assert.equal(unfence('# T\n\n```js\ncode\n```'), '# T\n\n```js\ncode\n```');
});

test('search: primary provider wins when it works', async () => {
  const search = { id: 'deepseek-official', available: () => true, search: async () => ({ sources: [{ url: 'https://ds' }], truncated: false }) };
  const ctx = fakeCtx({ search });
  apply(ctx, { bin: NO_BIN });
  assert.equal(ctx.registered.search.id, 'claude-code');
  assert.deepEqual(await ctx.registered.search.search({ query: 'x' }), { sources: [{ url: 'https://ds' }], truncated: false });
});

test('search: falls through to claude when primary is unavailable or fails', async () => {
  const primaries = [
    { id: 'deepseek-official', available: () => false, search: async () => { throw new Error('unreachable'); } },
    { id: 'deepseek-official', available: () => true, search: async () => { throw new Error('HTTP 402'); } },
  ];
  for (const search of primaries) {
    const ctx = fakeCtx({ search });
    apply(ctx, { bin: NO_BIN, codexBin: '' });
    await assert.rejects(ctx.registered.search.search({ query: 'x' }), /claude-code WebSearch could not run/);
  }
});

test('fetch: a healthy HTTP result is returned untouched', async () => {
  const ctx = fakeCtx({ fetch: httpProvider(async () => okPage(LONG)) });
  apply(ctx, { bin: NO_BIN });
  assert.equal(ctx.registered.fetch.id, 'claude-code');
  assert.deepEqual(await ctx.registered.fetch.fetch({ url: 'https://p' }), okPage(LONG));
});

test('fetch: 4xx, a JS shell, or an HTTP error falls through to claude', async () => {
  const primaries = [
    httpProvider(async () => ({ ...okPage(LONG), statusCode: 403 })),
    httpProvider(async () => okPage('<html>Please enable JavaScript</html>')),
    httpProvider(async () => { throw new Error('blocked destination'); }),
  ];
  for (const fetch of primaries) {
    const ctx = fakeCtx({ fetch });
    apply(ctx, { bin: NO_BIN, codexBin: '' });
    await assert.rejects(ctx.registered.fetch.fetch({ url: 'https://p' }), /claude-code WebFetch could not run/);
  }
});

test('fetch: Firecrawl unwraps its MCP page response after headless providers fail', async () => {
  const seen = [];
  const mock = await mockFirecrawl((params) => {
    seen.push(params);
    return { content: [{ type: 'text', text: JSON.stringify({ markdown: '# Scraped', metadata: { statusCode: 200, url: 'https://p/final' } }) }] };
  });
  try {
    const ctx = fakeCtx({ fetch: httpProvider(async () => ({ ...okPage(LONG), statusCode: 503 })) });
    apply(ctx, { bin: NO_BIN, codexBin: '', firecrawlMcpUrl: mock.url });
    assert.deepEqual(await ctx.registered.fetch.fetch({ url: 'https://p' }), {
      url: 'https://p/final', statusCode: 200, body: { kind: 'text', content: '# Scraped' }, truncated: false,
    });
    assert.deepEqual(seen, [{ name: 'firecrawl_scrape', arguments: { url: 'https://p', formats: ['markdown'], onlyMainContent: true } }]);
  } finally {
    await mock.close();
  }
});

test('fetch: firecrawl tool errors surface as failures', async () => {
  const mock = await mockFirecrawl(() => ({ isError: true, content: [{ type: 'text', text: 'quota exhausted' }] }));
  try {
    await assert.rejects(firecrawlScrape('https://p', resolveOptions({ firecrawlMcpUrl: mock.url })), /quota exhausted/);
  } finally {
    await mock.close();
  }
});

const live = process.env.RUN_LIVE ? false : 'set RUN_LIVE=1';

test('live: claude -p search returns sources', { skip: live }, async () => {
  const result = await claudeSearch('deepseek harness dsh npm', resolveOptions({}));
  assert.ok(result.sources.length > 0, 'expected at least one source');
  assert.match(result.sources[0].url, /^https?:\/\//);
});

test('live: documentation queries return sources through the registered fallback', { skip: live }, async () => {
  const search = { id: 'deepseek-official', available: () => true, search: async () => { throw new Error('HTTP 402'); } };
  const ctx = fakeCtx({ search });
  apply(ctx, { codexBin: '', timeoutMs: 60_000 });
  for (const query of [SEARCH_QUERY, 'Node.js official documentation test runner command line']) {
    const result = await ctx.registered.search.search({ query });
    assert.ok(result.sources.length > 0, `expected sources for ${query}`);
    for (const source of result.sources) assert.match(source.url, /^https?:\/\//);
  }
});

test('live: Codex headless returns documentation sources when Claude cannot launch', { skip: live }, async () => {
  const ctx = fakeCtx();
  apply(ctx, { primary: '', bin: NO_BIN });
  const result = await ctx.registered.search.search({ query: SEARCH_QUERY });
  assert.ok(result.sources.length > 0, 'Codex fallback returned no sources');
  for (const source of result.sources) assert.match(source.url, /^https?:\/\//);
});

test('live: claude -p fetch returns the page as text', { skip: live }, async () => {
  const result = await claudeFetch('https://example.com', resolveOptions({}));
  assert.equal(result.body.kind, 'text');
  assert.match(result.body.content, /Example Domain/);
});

test('live: Codex opens and fetches a site when Claude cannot launch', { skip: live }, async () => {
  const ctx = fakeCtx();
  apply(ctx, { fetchPrimary: '', bin: NO_BIN });
  const result = await ctx.registered.fetch.fetch({ url: 'https://example.com/' });
  assert.equal(result.statusCode, 200);
  assert.match(result.body.content, /Example Domain/);
});

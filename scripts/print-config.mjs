import { readFile } from 'node:fs/promises';
import pkg from '../package.json' with { type: 'json' };

const moduleUrl = new URL('../web-search-claude-code.mjs', import.meta.url);
moduleUrl.searchParams.set('v', pkg.version);
const template = await readFile(new URL('../examples/cordis.patch.example.yml', import.meta.url), 'utf8');
process.stdout.write(template.replace('file:///absolute/path/dsh-web-fallbacks/web-search-claude-code.mjs?v=0.1.0', moduleUrl.href));

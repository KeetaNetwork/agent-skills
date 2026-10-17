// Writes dist/package.json, the manifest Firebase installs for the function.
// The @keeta-compute/* workspace packages are bundled into dist/index.js and
// are not on npm, so only the bundle's external runtime dependencies are listed.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const source = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const dependencies = Object.fromEntries(Object.entries(source.dependencies).filter(([name]) => !name.startsWith('@keeta-compute/')));
const manifest = {
	name: source.name,
	version: source.version,
	private: true,
	type: 'module',
	main: 'index.js',
	engines: source.engines,
	dependencies
};
mkdirSync(new URL('../dist/', import.meta.url), { recursive: true });
writeFileSync(new URL('../dist/package.json', import.meta.url), `${JSON.stringify(manifest, null, '\t')}\n`);

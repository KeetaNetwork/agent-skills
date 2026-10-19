/**
 * Pin the Keeta stablecoins: resolve each `$K` code (KUSD, KEUR, KJPY, KMXN,
 * KCAD, KAED, KGBP) through each network's anchor resolver, read its decimals
 * from the token on the ledger, and write packages/protocol/src/asset-pins.ts.
 *
 *   npm run assets:pin            (both networks)
 *   npm run assets:pin -- test    (one network)
 *
 * Only reads the ledger. Review the diff before committing it.
 */

import { fileURLToPath } from 'node:url';
import { ASSET_DEFINITIONS, type NetworkName } from '@keeta-compute/protocol';
import { ASSET_PINS } from '../../../packages/protocol/src/asset-pins.ts';
import { resolveStablecoins, writePinsFile } from '../src/ledger.ts';

const requested = process.argv.slice(2).filter((arg): arg is NetworkName => arg === 'test' || arg === 'main');
const networks: NetworkName[] = requested.length ? requested : ['test', 'main'];
const codes = ASSET_DEFINITIONS.flatMap((a) => (a.resolverCode ? [{ symbol: a.symbol, resolverCode: a.resolverCode }] : []));
const pins = { ...ASSET_PINS };
for (const network of networks) {
	pins[network] = await resolveStablecoins(network, codes);
	console.log(`${network}: pinned ${Object.keys(pins[network]).join(', ') || 'nothing'}`);
}
const file = fileURLToPath(new URL('../../../packages/protocol/src/asset-pins.ts', import.meta.url));
writePinsFile(file, 'ASSET_PINS', pins);
console.log(`Wrote ${file}.`);

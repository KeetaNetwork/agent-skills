/**
 * Writes catalog.json, which the keeta.ai site build reads to render the
 * models table. Run after editing src/catalog.ts: npm run catalog:export
 */
import { writeFileSync } from 'node:fs';
import { CATALOG } from '../src/catalog.ts';

export function catalogExport() {
	return CATALOG.map((model) => ({
		id: model.id,
		name: model.name,
		parameters: model.parameters,
		quantization: model.quantization,
		memoryBytes: Math.round(model.memoryBytes),
		diskBytes: Math.round(model.diskBytes),
		license: { name: model.license.name, url: model.license.url },
		suggestedPrice: model.suggestedPrice,
		...(model.requiresCluster ? { requiresCluster: true } : {})
	}));
}

if (import.meta.url === `file://${process.argv[1]}`) {
	writeFileSync(new URL('../catalog.json', import.meta.url), `${JSON.stringify(catalogExport(), null, 2)}\n`);
}

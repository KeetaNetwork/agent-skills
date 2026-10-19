/**
 * The FX provider's one-off ledger operations: creating the credit token,
 * publishing the FX service in the FX account's metadata, and reading what
 * the pins record. Used by the scripts and by the live test suite.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import * as KeetaAnchor from '@keetanetwork/anchor';
import { decodeTokenMetadata, encodeTokenMetadata } from '@keetanetwork/anchor/lib/token-metadata.js';
import { CREDIT_DECIMALS, CREDIT_NAME, CREDIT_TICKER, type NetworkName } from '@keeta-compute/protocol';

type UserClient = InstanceType<typeof KeetaNet.UserClient>;
type Account = InstanceType<typeof KeetaNet.lib.Account>;

/** The service id the FX provider is listed under in the FX account's metadata. */
export const FX_SERVICE_ID = 'keeta-compute-credits';

function asAccount(address: string): Account {
	return KeetaNet.lib.Account.fromPublicKeyString(address as Parameters<typeof KeetaNet.lib.Account.fromPublicKeyString>[0]);
}

/**
 * Create the Keeta Compute Credits token, owned by `client`'s account, mint
 * `supply` base units and send it all to the FX account, in one publish.
 * Anyone may hold and send it (default permission ACCESS). Resolves to the
 * token address.
 */
export async function createCreditToken(client: UserClient, args: { fx: string; supply: bigint }): Promise<string> {
	if (args.supply <= 0n) {
		throw new Error('the supply must be more than zero');
	}
	const builder = client.initBuilder();
	const pending = builder.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	await builder.computeBlocks();
	const token = pending.account;
	builder.setInfo(
		{
			name: CREDIT_TICKER,
			description: CREDIT_NAME,
			metadata: encodeTokenMetadata({ decimalPlaces: CREDIT_DECIMALS }),
			defaultPermission: new KeetaNet.lib.Permissions(['ACCESS'])
		},
		{ account: token }
	);
	builder.modifyTokenSupply(args.supply, { account: token });
	await builder.computeBlocks();
	builder.send(asAccount(args.fx), args.supply, token, undefined, { account: token });
	await client.publishBuilder(builder);
	return token.publicKeyString.get();
}

/** A token's decimal places from its metadata on the ledger. */
export async function tokenDecimals(client: UserClient, token: string): Promise<number> {
	const { info } = await client.client.getAccountInfo(token);
	return decodeTokenMetadata(info.metadata).decimalPlaces;
}

/**
 * Publish the FX service in the FX account's metadata, as the anchor
 * resolver reads it: clients root their resolver at the FX account (the
 * control plane's /v1/config `credits.fx`) and find this service there.
 */
export async function publishFxMetadata(client: UserClient, service: unknown): Promise<string> {
	const metadata = KeetaAnchor.lib.Resolver.Metadata.formatMetadata({ version: 1, currencyMap: {}, services: { fx: { [FX_SERVICE_ID]: service } } } as never);
	const result = await client.setInfo({ name: 'KEETA_COMPUTE_FX', description: 'keeta.ai FX provider for Keeta Compute Credits', metadata });
	return 'voteStaple' in result ? result.voteStaple.blocks[0]!.hash.toString() : result.blocks[0]!.hash.toString();
}

/**
 * Resolve each Keeta stablecoin's `$K` code through the network's anchor
 * resolver and read its decimals from the ledger. Codes the resolver does
 * not know are left out.
 */
export async function resolveStablecoins(network: NetworkName, codes: Array<{ symbol: string; resolverCode: string }>): Promise<Record<string, { address: string; decimals: number }>> {
	const client = KeetaAnchor.KeetaNet.UserClient.fromNetwork(network, null);
	const reader = KeetaNet.UserClient.fromNetwork(network, null);
	try {
		const resolver = new KeetaAnchor.lib.Resolver({
			client,
			root: KeetaAnchor.KeetaNet.lib.Account.generateNetworkAddress(client.network),
			trustedCAs: []
		});
		const pins: Record<string, { address: string; decimals: number }> = {};
		for (const { symbol, resolverCode } of codes) {
			const found = await resolver.lookupToken(resolverCode as never).catch(() => null);
			if (!found) {
				console.log(`${symbol}: ${resolverCode} is not listed by the ${network} network's resolver; left unpinned`);
				continue;
			}
			pins[symbol] = { address: found.token, decimals: await tokenDecimals(reader, found.token) };
		}
		return pins;
	} finally {
		await client.destroy().catch(() => undefined);
		await reader.destroy().catch(() => undefined);
	}
}

/** Replace the value of `export const NAME ... = {...};` in a pins file with `value`, keeping the rest. */
export function writePinsFile(file: string, name: string, value: unknown): void {
	const source = readFileSync(file, 'utf8');
	const start = source.indexOf(`export const ${name}`);
	const equals = source.indexOf('= ', start);
	const end = source.lastIndexOf('};');
	if (start < 0 || equals < 0 || end < equals) {
		throw new Error(`${file} does not declare ${name} as expected`);
	}
	writeFileSync(file, `${source.slice(0, equals + 2)}${JSON.stringify(value, null, '\t')};\n`);
}

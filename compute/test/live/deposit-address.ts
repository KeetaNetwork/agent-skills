/**
 * Prints an address on an EVM chain (Base) that forwards USDC to the live
 * suite's test-network funding account, from the Keeta asset-movement (EVM)
 * anchors the test network's resolver lists. Send test USDC there to fund the
 * suite. Test network only; run from compute/ on a machine that reaches it:
 *
 *   npm run live:deposit-address
 */

import * as KeetaAnchor from '@keetanetwork/anchor';
import { NETWORKS } from '@keeta-compute/protocol';
import { NETWORK, USDC, fundingSeed } from './support.ts';

const KEETA = `chain:keeta:${BigInt(NETWORKS.test.caip2.split(':')[1]!)}` as const;
/** EVM chains by id; Base first. */
const EVM_NAMES: Record<string, string> = { '84532': 'Base Sepolia', '8453': 'Base', '11155111': 'Ethereum Sepolia', '1': 'Ethereum' };
const preference = (location: string) => {
	const index = Object.keys(EVM_NAMES).indexOf(location.split(':')[2] ?? '');
	return index < 0 ? Object.keys(EVM_NAMES).length : index;
};

const account = KeetaAnchor.KeetaNet.lib.Account.fromSeed(await fundingSeed(), 0);
const address = account.publicKeyString.get();
const user = KeetaAnchor.KeetaNet.UserClient.fromNetwork(NETWORK, account);
try {
	const client = new KeetaAnchor.AssetMovement.Client(user, { signer: account, account });
	/*
	 * One provider at a time: the resolver's lookup stops at the first listed
	 * provider whose metadata cannot be read (the test network lists a
	 * disabled one), so it would never reach the others.
	 */
	const root = (await client.resolver.getRootMetadata()) as { services?: (kind: 'object') => Promise<{ assetMovement?: (kind: 'object') => Promise<Record<string, unknown>> }> };
	const listed = Object.keys((await (await root.services?.('object'))?.assetMovement?.('object')) ?? {});
	const providers: NonNullable<Awaited<ReturnType<typeof client.getProvidersForTransfer>>> = [];
	for (const id of listed) {
		try {
			providers.push(...((await client.getProvidersForTransfer({}, { providerIDs: [id] })) ?? []));
		} catch (error) {
			console.log(`  skipping ${id}: ${(error as Error).message}`);
		}
	}
	console.log(`Test USDC on Keeta: ${USDC.address}\nDestination (live funding account): ${address}\nAsset-movement anchors listed: ${listed.join(', ') || 'none'}; ${providers.length} answered`);

	/* Every route from an EVM chain into Keeta test USDC, best chain first. */
	const routes: Array<{ provider: (typeof providers)[number]; location: string; evmAsset: string; kyc: string[] }> = [];
	for (const provider of providers) {
		for (const supported of provider.serviceInfo.supportedAssets) {
			for (const path of supported.paths) {
				const [a, b] = path.pair;
				for (const [from, to] of [
					[a, b],
					[b, a]
				] as const) {
					const inbound = 'inbound' in to.rails ? to.rails.inbound : undefined;
					console.log(`  ${String(provider.providerID)}: ${from.location ?? '?'} ${String(from.id)} -> ${to.location ?? '?'} ${String(to.id)}${inbound ? ` (inbound rails: ${JSON.stringify(inbound)})` : ''}`);
					if (from.location?.startsWith('chain:evm:') && to.location === KEETA && to.id === USDC.address) {
						routes.push({ provider, location: from.location, evmAsset: String(from.id), kyc: path.kycProviders ?? [] });
					}
				}
			}
		}
	}
	routes.sort((x, y) => preference(x.location) - preference(y.location));
	const route = routes[0];
	if (!route) {
		throw new Error('no anchor lists a route from an EVM chain to test USDC on Keeta');
	}
	const chain = EVM_NAMES[route.location.split(':')[2]!] ?? route.location;
	console.log(`\nUsing ${String(route.provider.providerID)}: ${chain} ${route.evmAsset} -> Keeta test USDC${route.kyc.length ? ` (lists KYC providers: ${route.kyc.join(', ')})` : ''}`);
	const forwarding = await route.provider.createPersistentForwardingAddress({
		sourceLocation: route.location as never,
		destinationLocation: KEETA,
		asset: { from: route.evmAsset as never, to: USDC.address as never },
		destinationAddress: address
	});
	console.log(`\nDeposit address on ${chain}: ${String(forwarding.address)}`);
	if (forwarding.depositMessage) {
		console.log(`Deposit message (include it with the transfer): ${JSON.stringify(forwarding.depositMessage)}`);
	}
	if (forwarding.fees) {
		console.log(`Fees: ${JSON.stringify(forwarding.fees)}`);
	}
	console.log(`USDC sent to it on ${chain} arrives as test USDC at ${address}.`);
} finally {
	await user.destroy();
}

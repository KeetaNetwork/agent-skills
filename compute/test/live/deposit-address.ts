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
/** EVM test chains by id; Base Sepolia first. */
const EVM_NAMES: Record<string, string> = { '84532': 'Base Sepolia', '11155111': 'Ethereum Sepolia', '421614': 'Arbitrum Sepolia', '43113': 'Avalanche Fuji', '80002': 'Polygon Amoy' };
/** Circle's test USDC contract on each of those chains (developers.circle.com, "USDC on test networks"). */
const CIRCLE_USDC: Record<string, string> = {
	'84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
	'11155111': '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
	'421614': '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
	'43113': '0x5425890298aed601595a70AB815c96711a31Bc65',
	'80002': '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582'
};
const chainOf = (location: string) => location.split(':')[2] ?? '';
const preference = (location: string) => {
	const index = Object.keys(EVM_NAMES).indexOf(chainOf(location));
	return index < 0 ? Object.keys(EVM_NAMES).length : index;
};
const isCircleUsdc = (location: string, asset: string) => asset.toLowerCase() === `evm:${CIRCLE_USDC[chainOf(location)] ?? ''}`.toLowerCase();
/** Whether a rail list offers persistent forwarding addresses (the only kind this script asks for). */
const forwards = (rails: unknown) => Array.isArray(rails) && rails.some((rail) => typeof rail === 'object' && rail !== null && (rail as { supportedOperations?: { createPersistentForwarding?: boolean } }).supportedOperations?.createPersistentForwarding === true);

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

	/*
	 * Every route from Circle's USDC on an EVM test chain into a Keeta token,
	 * best first: routes that give persistent forwarding addresses, then Base
	 * Sepolia, then routes landing on the suite's pinned test USDC.
	 */
	const routes: Array<{ provider: (typeof providers)[number]; location: string; evmAsset: string; keetaToken: string; forwarding: boolean; kyc: string[] }> = [];
	for (const provider of providers) {
		for (const supported of provider.serviceInfo.supportedAssets) {
			for (const path of supported.paths) {
				const [a, b] = path.pair;
				for (const [from, to] of [
					[a, b],
					[b, a]
				] as const) {
					const inbound = 'inbound' in from.rails ? from.rails.inbound : undefined;
					console.log(`  ${String(provider.providerID)}: ${from.location ?? '?'} ${String(from.id)} -> ${to.location ?? '?'} ${String(to.id)}${inbound ? ` (inbound rails: ${JSON.stringify(inbound)})` : ''}`);
					if (from.location?.startsWith('chain:evm:') && isCircleUsdc(from.location, String(from.id)) && to.location === KEETA && String(to.id).startsWith('keeta_')) {
						routes.push({ provider, location: from.location, evmAsset: String(from.id), keetaToken: String(to.id), forwarding: forwards(inbound), kyc: path.kycProviders ?? [] });
					}
				}
			}
		}
	}
	routes.sort((x, y) => Number(y.forwarding) - Number(x.forwarding) || preference(x.location) - preference(y.location) || Number(y.keetaToken === USDC.address) - Number(x.keetaToken === USDC.address));
	const route = routes[0];
	if (!route) {
		throw new Error("no anchor lists a route from Circle's USDC on an EVM test chain into Keeta");
	}
	const chain = EVM_NAMES[chainOf(route.location)] ?? route.location;
	console.log(`\nUsing ${String(route.provider.providerID)}: ${chain} USDC ${route.evmAsset} -> Keeta ${route.keetaToken}${route.kyc.length ? ` (lists KYC providers: ${route.kyc.join(', ')})` : ''}`);
	if (!route.forwarding) {
		console.log('  (this route does not list persistent forwarding; the anchor may refuse)');
	}
	if (route.keetaToken !== USDC.address) {
		console.log(`  Note: it lands on ${route.keetaToken}, not the test USDC the live suite is pinned to (${USDC.address}).`);
	}
	const forwarding = await route.provider.createPersistentForwardingAddress({
		sourceLocation: route.location as never,
		destinationLocation: KEETA,
		asset: { from: route.evmAsset as never, to: route.keetaToken as never },
		destinationAddress: address
	});
	console.log(`\nDeposit address on ${chain}: ${String(forwarding.address)}`);
	if (forwarding.depositMessage) {
		console.log(`Deposit message (include it with the transfer): ${JSON.stringify(forwarding.depositMessage)}`);
	}
	if (forwarding.fees) {
		console.log(`Fees: ${JSON.stringify(forwarding.fees)}`);
	}
	console.log(`USDC sent to it on ${chain} arrives as ${route.keetaToken} at ${address}.`);
} finally {
	await user.destroy();
}

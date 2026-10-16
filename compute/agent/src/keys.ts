/**
 * Keys held by the agent.
 *
 * - Node key (macOS): Secure Enclave P-256, signing through the app.
 * - Node key (Linux helper): a software key in a 0600 file. It can only sign
 *   receipts and requests; it never holds funds (plan §5.7).
 * - Agent budget key: a software key in a 0600 file holding only what the
 *   operator moved into the budget. Agents on the Mac spend from it.
 * - Operator key: derived from the passkey PRF output on demand and dropped
 *   after the operation; never stored.
 */

import { join } from 'node:path';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { fromHex, toHex, type NetworkName } from '@keeta-compute/protocol';
import { Account, accountFromPasskeyEntropy, externalP256Account } from '@keeta-compute/protocol/keeta';
import { readOrCreateSecret } from './state.ts';

export type KeetaAccount = InstanceType<typeof Account>;

export function enclaveNodeAccount(compressedPublicKeyHex: string, signDigest: (digestHex: string) => Promise<string>): KeetaAccount {
	return externalP256Account(fromHex(compressedPublicKeyHex), async (digest) => fromHex(await signDigest(toHex(digest))));
}

export function fileAccount(dataDir: string, name: string): KeetaAccount {
	const seed = readOrCreateSecret(join(dataDir, `${name}.seed`), () => Account.generateRandomSeed({ asString: true }) as string);
	return Account.fromSeed(seed, 0);
}

export function spendAccount(dataDir: string, network: NetworkName): KeetaAccount {
	return fileAccount(dataDir, `budget-${network}`);
}

export async function operatorAccount(entropyHex: string): Promise<KeetaAccount> {
	const entropy = fromHex(entropyHex);
	try {
		return await accountFromPasskeyEntropy(entropy, 0, (bytes) => entropyToMnemonic(bytes, wordlist));
	} finally {
		entropy.fill(0);
	}
}

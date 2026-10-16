/**
 * Keeta SDK bindings for signing and verification. Separate from the main
 * entry so the relay Worker does not have to bundle the SDK.
 */

import * as KeetaNet from '@keetanetwork/keetanet-client';
import { fromHex, toHex } from './canonical.ts';
import type { Signer, Verifier } from './messages.ts';

type Account = InstanceType<typeof KeetaNet.lib.Account>;

export const Account = KeetaNet.lib.Account;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function signatureBytes(signature: unknown): Uint8Array {
	const value = signature as { get?: () => ArrayBuffer; getBuffer?: () => Uint8Array };
	if (typeof value.get === 'function') {
		return new Uint8Array(value.get());
	}
	if (value instanceof Uint8Array) {
		return value;
	}
	if (value instanceof ArrayBuffer) {
		return new Uint8Array(value);
	}
	if (typeof value.getBuffer === 'function') {
		return new Uint8Array(value.getBuffer());
	}
	throw new Error('unsupported signature type');
}

export function accountSigner(account: Account): Signer {
	return {
		publicKey: account.publicKeyString.get(),
		async sign(message) {
			return toHex(signatureBytes(await account.sign(toArrayBuffer(message))));
		}
	};
}

export const verifyKeetaSignature: Verifier = (publicKey, message, signatureHex) => {
	try {
		const account = Account.fromPublicKeyString(publicKey as Parameters<typeof Account.fromPublicKeyString>[0]);
		if (!account.isAccount() || account.isToken() || account.isStorage() || account.isNetwork() || account.isMultisig()) {
			return false;
		}
		return account.verify(toArrayBuffer(message), toArrayBuffer(fromHex(signatureHex)));
	} catch {
		return false;
	}
};

/**
 * The operator account derivation used by the Keeta web wallet's passkey-PRF
 * driver: PRF output → BIP-39 entropy → passphrase → seed → account index.
 * The macOS app obtains the PRF output natively and passes it here, so the
 * same passkey yields the same account in the app and in the web wallet.
 */
export async function accountFromPasskeyEntropy(entropy: Uint8Array, index = 0, entropyToMnemonic: (entropy: Uint8Array) => string): Promise<Account> {
	if (entropy.length !== 32) {
		throw new Error('passkey PRF output must be 32 bytes');
	}
	const passphrase = entropyToMnemonic(entropy);
	const seed = await Account.seedFromPassphrase(passphrase);
	return Account.fromSeed(seed, index);
}

/**
 * A Keeta account backed by a P-256 key held outside this process, such as
 * the Secure Enclave. The SDK hashes (SHA3-256) before calling `signDigest`;
 * the holder signs the 32-byte digest as-is and returns raw r||s with low S.
 */
export function externalP256Account(compressedPublicKey: Uint8Array, signDigest: (digest: Uint8Array) => Promise<Uint8Array>): Account {
	if (compressedPublicKey.length !== 33) {
		throw new Error('expected a 33-byte compressed P-256 public key');
	}
	const pair = new Account.ExternalKeyPair(
		{
			supportsEncryption: false,
			async sign(data) {
				const signature = await signDigest(new Uint8Array(data));
				if (signature.length !== 64) {
					throw new Error('external signer must return a 64-byte r||s signature');
				}
				/* Only used for receipts and request signing, never for publishing blocks. */
				return Buffer.from(signature) as unknown as Awaited<ReturnType<InstanceType<typeof Account.ExternalKeyPair>["sign"]>>;
			}
		},
		toArrayBuffer(compressedPublicKey),
		Account.AccountKeyAlgorithm.ECDSA_SECP256R1
	);
	return new Account(pair);
}

export interface ExpectedPayment {
	blockHash: string;
	from: string;
	to: string;
	asset: string;
	minAmount: bigint;
	/** The job id the buyer put in the send's external reference. */
	reference: string;
}

export type PaymentCheck = { status: 'confirmed'; amount: bigint } | { status: 'not-found' } | { status: 'mismatch'; reason: string };

/**
 * Confirm a payment block on the ledger: a block signed by `from` sending
 * `asset` to `to` (for an app job's escrow, credits to the settlement
 * account), at least `minAmount` in total, counting only sends whose
 * external reference is the job id. `amount` is that total.
 */
export async function checkPaymentBlock(client: InstanceType<typeof KeetaNet.Client>, expected: ExpectedPayment): Promise<PaymentCheck> {
	const block = await client.getBlock(expected.blockHash);
	if (!block) {
		return { status: 'not-found' };
	}
	if (block.account.publicKeyString.get() !== expected.from) {
		return { status: 'mismatch', reason: 'block was not signed by the buyer account' };
	}
	let total = 0n;
	for (const operation of block.operations ?? []) {
		if (operation.type !== KeetaNet.lib.Block.OperationType.SEND) {
			continue;
		}
		const send = operation as InstanceType<typeof KeetaNet.lib.Block.Operation.SEND>;
		if (send.to.publicKeyString.get() !== expected.to || send.token.publicKeyString.get() !== expected.asset) {
			continue;
		}
		/* The job id is the only link between a send and a receipt: without it one send could clear many jobs. */
		if (send.external !== expected.reference) {
			continue;
		}
		total += send.amount;
	}
	if (total < expected.minAmount) {
		return { status: 'mismatch', reason: `paid ${total}, due ${expected.minAmount}` };
	}
	return { status: 'confirmed', amount: total };
}

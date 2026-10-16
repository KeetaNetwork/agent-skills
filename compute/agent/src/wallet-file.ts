/**
 * The Linux CLI's own operator wallet: 32 bytes of entropy, the same shape as
 * the passkey PRF output the macOS app derives its operator from, kept
 * encrypted in the data directory (0600). The key is scrypt over the user's
 * passphrase; the cipher is AES-256-GCM with the file header as associated
 * data. The 24-word recovery phrase is the entropy as a BIP-39 mnemonic, so
 * it restores this wallet and is also a standard Keeta passphrase for the
 * same operator account.
 *
 * Entropy buffers are wiped after use. Hex copies handed to AgentApp are JS
 * strings and cannot be wiped; they live only for the one operation.
 */

import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback, type ScryptOptions } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { toHex } from '@keeta-compute/protocol';
import { operatorAccount } from './keys.ts';

export const WALLET_FILE = 'operator-wallet.json';

/** scrypt cost: N = 2^17, r = 8 needs 128 MiB; maxmem leaves headroom. */
const DEFAULT_KDF = { N: 2 ** 17, r: 8, p: 1 };
const MAX_N = 2 ** 20;
const MIN_PASSPHRASE = 8;

export interface KdfParams {
	N: number;
	r: number;
	p: number;
}

export interface WalletFile {
	version: 1;
	/** The operator account, readable without the passphrase. Bound into the ciphertext as associated data. */
	operator: string;
	createdAt: number;
	kdf: { name: 'scrypt'; salt: string } & KdfParams;
	cipher: { name: 'aes-256-gcm'; iv: string; tag: string };
	ciphertext: string;
}

export class WalletError extends Error {}

export function walletPath(dataDir: string): string {
	return join(dataDir, WALLET_FILE);
}

/** The wallet header (no secrets), or null when this data directory has no wallet. */
export function readWallet(dataDir: string): WalletFile | null {
	const path = walletPath(dataDir);
	if (!existsSync(path)) {
		return null;
	}
	const file = JSON.parse(readFileSync(path, 'utf8')) as WalletFile;
	if (file.version !== 1 || file.kdf?.name !== 'scrypt' || file.cipher?.name !== 'aes-256-gcm') {
		throw new WalletError(`${path} is not a wallet file this version understands`);
	}
	return file;
}

function scrypt(passphrase: string, salt: Buffer, params: KdfParams): Promise<Buffer> {
	if (!Number.isInteger(params.N) || params.N < 2 || params.N > MAX_N || params.r < 1 || params.r > 32 || params.p < 1 || params.p > 16) {
		throw new WalletError('wallet file has unreasonable scrypt parameters');
	}
	const options: ScryptOptions = { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r + 32 * 1024 * 1024 };
	return new Promise((resolve, reject) => scryptCallback(passphrase.normalize('NFKC'), salt, 32, options, (error, key) => (error ? reject(error) : resolve(key))));
}

function associatedData(file: Pick<WalletFile, 'version' | 'operator' | 'createdAt'>): Buffer {
	return Buffer.from(JSON.stringify({ version: file.version, operator: file.operator, createdAt: file.createdAt }), 'utf8');
}

export function assertNewPassphrase(passphrase: string): void {
	if (passphrase.length < MIN_PASSPHRASE) {
		throw new WalletError(`the passphrase must be at least ${MIN_PASSPHRASE} characters`);
	}
}

/** The entropy behind a 24-word recovery phrase. */
export function entropyFromPhrase(phrase: string): Uint8Array {
	const words = phrase.trim().toLowerCase().split(/\s+/).join(' ');
	if (!validateMnemonic(words, wordlist)) {
		throw new WalletError('that is not a valid recovery phrase (check the words and their order)');
	}
	const entropy = mnemonicToEntropy(words, wordlist);
	if (entropy.length !== 32) {
		entropy.fill(0);
		throw new WalletError('the recovery phrase must be 24 words');
	}
	return entropy;
}

/**
 * Write a new wallet. Pass `entropy` to restore from a recovery phrase;
 * otherwise 32 fresh random bytes are used. Returns the operator and the
 * recovery phrase, which the caller shows once and never stores.
 */
export async function createWallet(
	dataDir: string,
	passphrase: string,
	options: { entropy?: Uint8Array; kdf?: KdfParams; now?: number } = {}
): Promise<{ operator: string; phrase: string }> {
	const path = walletPath(dataDir);
	if (existsSync(path)) {
		throw new WalletError(`a wallet already exists at ${path}`);
	}
	assertNewPassphrase(passphrase);
	const entropy = options.entropy ? Uint8Array.from(options.entropy) : new Uint8Array(randomBytes(32));
	let key: Buffer | null = null;
	try {
		if (entropy.length !== 32) {
			throw new WalletError('wallet entropy must be 32 bytes');
		}
		const phrase = entropyToMnemonic(entropy, wordlist);
		const operator = (await operatorAccount(toHex(entropy))).publicKeyString.get();
		const kdf = options.kdf ?? DEFAULT_KDF;
		const salt = randomBytes(16);
		const iv = randomBytes(12);
		key = await scrypt(passphrase, salt, kdf);
		const header = { version: 1 as const, operator, createdAt: options.now ?? Date.now() };
		const cipher = createCipheriv('aes-256-gcm', key, iv);
		cipher.setAAD(associatedData(header));
		const ciphertext = Buffer.concat([cipher.update(entropy), cipher.final()]);
		const file: WalletFile = {
			...header,
			kdf: { name: 'scrypt', salt: salt.toString('base64'), ...kdf },
			cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
			ciphertext: ciphertext.toString('base64')
		};
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, path);
		return { operator, phrase };
	} finally {
		entropy.fill(0);
		key?.fill(0);
	}
}

/** Decrypt the wallet's entropy. The caller must wipe the result (or use withOperatorEntropy). */
export async function unlockWallet(dataDir: string, passphrase: string): Promise<Uint8Array> {
	const file = readWallet(dataDir);
	if (!file) {
		throw new WalletError('this machine has no wallet yet; run `keeta-compute-agent init` first');
	}
	const key = await scrypt(passphrase, Buffer.from(file.kdf.salt, 'base64'), file.kdf);
	try {
		const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.cipher.iv, 'base64'));
		decipher.setAAD(associatedData(file));
		decipher.setAuthTag(Buffer.from(file.cipher.tag, 'base64'));
		const plain = Buffer.concat([decipher.update(Buffer.from(file.ciphertext, 'base64')), decipher.final()]);
		const entropy = new Uint8Array(plain);
		plain.fill(0);
		if (entropy.length !== 32) {
			entropy.fill(0);
			throw new WalletError('wallet file is damaged');
		}
		return entropy;
	} catch (error) {
		if (error instanceof WalletError) {
			throw error;
		}
		throw new WalletError('wrong passphrase (or the wallet file was changed)');
	} finally {
		key.fill(0);
	}
}

/** Run `use` with the wallet entropy as hex (the form AgentApp takes), then wipe the bytes. */
export async function withOperatorEntropy<T>(dataDir: string, passphrase: string, use: (entropyHex: string) => Promise<T>): Promise<T> {
	const entropy = await unlockWallet(dataDir, passphrase);
	try {
		return await use(toHex(entropy));
	} finally {
		entropy.fill(0);
	}
}

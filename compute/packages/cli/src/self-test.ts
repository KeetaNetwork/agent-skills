/**
 * `keeta-compute-agent self-test`: runs, inside this binary, what the macOS app
 * needs first. It initializes the agent with a P-256 node key that signs
 * through a callback (the Secure Enclave path), signs and verifies with that
 * key, and derives an operator account from passkey output (the wallet path).
 * scripts/bundle-agent.sh runs it on every freshly compiled agent, so a runtime
 * that lacks something the agent needs fails the build, not the app (bun
 * before 1.3.14, for one, had no SHA3-256 HMAC, which Keeta key derivation uses).
 *
 * Nothing leaves this machine: the control plane and relay point at a closed
 * local port, and the data directory is temporary.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { p256 } from '@noble/curves/p256';
import { AgentApp } from '@keeta-compute/agent';
import { fromHex, toHex } from '@keeta-compute/protocol';
import { accountSigner, verifyKeetaSignature } from '@keeta-compute/protocol/keeta';
import { enclaveNodeAccount, operatorAccount } from '@keeta-compute/wallet';

const CLOSED_PORT = 'http://127.0.0.1:9';

/** A software stand-in for the Secure Enclave node key: it signs the digest as-is and returns raw r||s with low S, as the app does. */
function softwareNodeKey(): { publicKeyHex: string; signDigest: (digestHex: string) => Promise<string> } {
	const key = p256.utils.randomPrivateKey();
	return {
		publicKeyHex: toHex(p256.getPublicKey(key, true)),
		signDigest: async (digestHex) => toHex(p256.sign(fromHex(digestHex), key, { prehash: false, lowS: true }).toCompactRawBytes())
	};
}

export async function selfTest(out: (line: string) => void): Promise<void> {
	const dataDir = mkdtempSync(join(tmpdir(), 'keeta-compute-self-test-'));
	const node = softwareNodeKey();
	const app = new AgentApp({ dataDir, noRuntime: true, signDigest: node.signDigest, notify: () => undefined, log: () => undefined });
	try {
		const state = await app.initialize({
			network: 'test',
			controlUrl: CLOSED_PORT,
			relayUrl: CLOSED_PORT,
			nodePublicKey: node.publicKeyHex,
			appVersion: 'self-test',
			machineName: 'self-test'
		});
		if (!state.nodeKey) {
			throw new Error('agent.initialize returned no node key');
		}
		const signer = accountSigner(enclaveNodeAccount(node.publicKeyHex, node.signDigest));
		const message = new TextEncoder().encode('keeta-compute self-test');
		if (signer.publicKey !== state.nodeKey || !verifyKeetaSignature(signer.publicKey, message, await signer.sign(message))) {
			throw new Error('the node key did not sign and verify');
		}
		const operator = await operatorAccount('00'.repeat(32));
		out(`ok: node ${state.nodeKey}, operator ${operator.publicKeyString.get()}`);
	} finally {
		app.shutdown();
		rmSync(dataDir, { recursive: true, force: true });
	}
}

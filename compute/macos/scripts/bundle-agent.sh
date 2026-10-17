#!/bin/bash
# Compiles the TypeScript agent (compute/packages/cli, @keeta-compute/cli) with
# bun and places it in the app bundle at Contents/Resources/keeta-compute-agent,
# signed with the app's identity and the agent's JIT entitlements. Run by the
# Xcode build phase. A signed app only talks to a helper signed by its own team
# with the identifier ai.keeta.compute.agent (AgentCodeCheck in
# KeetaCompute/Agent/AgentRPCClient.swift).
set -euo pipefail

COMPUTE_DIR="${SRCROOT}/.."
AGENT_DIR="${COMPUTE_DIR}/packages/cli"
OUT_DIR="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}"
BINARY="${AGENT_DIR}/dist/darwin-arm64/keeta-compute-agent"

BUN="$(command -v bun || true)"
[ -z "${BUN}" ] && [ -x "${HOME}/.bun/bin/bun" ] && BUN="${HOME}/.bun/bin/bun"
if [ -z "${BUN}" ]; then
	if [ "${CONFIGURATION}" = "Debug" ]; then
		echo "warning: bun not found; this Debug build has no bundled keeta-compute-agent"
		exit 0
	fi
	echo "error: bun is required to bundle the agent (https://bun.sh)"
	exit 1
fi

if [ ! -d "${COMPUTE_DIR}/node_modules" ]; then
	(cd "${COMPUTE_DIR}" && npm ci)
fi
(cd "${AGENT_DIR}" && "${BUN}" build src/main.ts --compile --minify --target=bun-darwin-arm64 \
	--external bufferutil --external utf-8-validate --outfile dist/darwin-arm64/keeta-compute-agent)

mkdir -p "${OUT_DIR}"
install -m 0755 "${BINARY}" "${OUT_DIR}/keeta-compute-agent"

if [ "${CODE_SIGNING_ALLOWED:-YES}" = "YES" ] && [ -n "${EXPANDED_CODE_SIGN_IDENTITY:-}" ]; then
	codesign --force --options runtime --timestamp=none --identifier ai.keeta.compute.agent \
		--entitlements "${SRCROOT}/Config/keeta-compute-agent.entitlements" \
		--sign "${EXPANDED_CODE_SIGN_IDENTITY}" "${OUT_DIR}/keeta-compute-agent"
fi

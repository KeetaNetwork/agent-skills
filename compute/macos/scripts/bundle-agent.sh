#!/bin/bash
# Compiles the TypeScript agent (compute/packages/cli, @keeta-compute/cli) with
# bun and places it in the app bundle at Contents/Resources/keeta-compute-agent,
# signed with the app's identity and the agent's JIT entitlements. Run by the
# Xcode build phase. A signed app only talks to a helper signed by its own team
# with the identifier ai.keeta.compute.agent (AgentCodeCheck in
# KeetaCompute/Agent/AgentRPCClient.swift).
#
# The bun that compiles it is the one pinned in compute/package.json, which npm
# installs into compute/node_modules, never whatever bun is on this Mac: older
# releases build an agent that can't derive Keeta keys, so the app's first call
# never answers. The compiled agent then runs its self-test, and a binary that
# fails it fails the build.
set -euo pipefail

# Xcode runs build phases with a short PATH; add where Homebrew installs npm.
export PATH="${PATH}:/opt/homebrew/bin:/usr/local/bin"

COMPUTE_DIR="${SRCROOT}/.."
AGENT_DIR="${COMPUTE_DIR}/packages/cli"
OUT_DIR="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}"
BINARY="${AGENT_DIR}/dist/darwin-arm64/keeta-compute-agent"
BUN="${COMPUTE_DIR}/node_modules/.bin/bun"
PINNED_BUN="$(sed -n 's/^ *"bun": "\([0-9][^"]*\)",*$/\1/p' "${COMPUTE_DIR}/package.json")"
if [ -z "${PINNED_BUN}" ]; then
	echo "error: compute/package.json doesn't pin a bun version in devDependencies"
	exit 1
fi

pinned_bun_installed() {
	[ -x "${BUN}" ] && [ "$("${BUN}" --version 2>/dev/null)" = "${PINNED_BUN}" ]
}

if ! pinned_bun_installed && command -v npm >/dev/null; then
	echo "Installing compute/ dependencies, including bun ${PINNED_BUN}, with npm ci"
	(cd "${COMPUTE_DIR}" && npm ci) || echo "warning: npm ci failed in compute/"
fi
if ! pinned_bun_installed; then
	# Never leave a helper from an earlier build behind: it may be one this check would refuse.
	rm -f "${OUT_DIR}/keeta-compute-agent"
	if [ "${CONFIGURATION}" = "Debug" ]; then
		echo "warning: bun ${PINNED_BUN} isn't installed, so this Debug build has no bundled keeta-compute-agent. Run npm ci in compute/ and build again."
		exit 0
	fi
	echo "error: bun ${PINNED_BUN} is required to bundle the agent. Run npm ci in compute/ and build again."
	exit 1
fi

(cd "${AGENT_DIR}" && "${BUN}" build src/main.ts --compile --minify --target=bun-darwin-arm64 \
	--external bufferutil --external utf-8-validate --outfile dist/darwin-arm64/keeta-compute-agent)

if ! "${BINARY}" self-test; then
	rm -f "${OUT_DIR}/keeta-compute-agent"
	echo "error: the compiled keeta-compute-agent failed its self-test (above), so it was not bundled"
	exit 1
fi

mkdir -p "${OUT_DIR}"
install -m 0755 "${BINARY}" "${OUT_DIR}/keeta-compute-agent"

if [ "${CODE_SIGNING_ALLOWED:-YES}" = "YES" ] && [ -n "${EXPANDED_CODE_SIGN_IDENTITY:-}" ]; then
	codesign --force --options runtime --timestamp=none --identifier ai.keeta.compute.agent \
		--entitlements "${SRCROOT}/Config/keeta-compute-agent.entitlements" \
		--sign "${EXPANDED_CODE_SIGN_IDENTITY}" "${OUT_DIR}/keeta-compute-agent"
fi

#!/bin/sh
# Installs keeta-compute-agent, the Keeta Compute Linux helper.
#
#   curl -fsSL https://keeta.ai/compute/install-helper.sh | sh
#
# Downloads the release binary for this machine from GitHub, checks it
# against the published SHA-256, and installs it. It needs no root unless
# KEETA_COMPUTE_PREFIX points somewhere only root can write.
#
#   KEETA_COMPUTE_VERSION   release tag to install (default: latest)
#   KEETA_COMPUTE_PREFIX    install directory (default: /usr/local/bin if
#                           writable, otherwise ~/.local/bin)
set -eu

REPO="KeetaNetwork/agent-skills"
NAME="keeta-compute-agent"

fail() {
	echo "install-helper: $*" >&2
	exit 1
}

[ "$(uname -s)" = "Linux" ] || fail "the helper runs on Linux; on a Mac, install the Keeta Compute app instead"

case "$(uname -m)" in
	x86_64 | amd64) arch="x64" ;;
	aarch64 | arm64) arch="arm64" ;;
	*) fail "unsupported CPU architecture $(uname -m)" ;;
esac

command -v curl >/dev/null 2>&1 || fail "curl is required"
if command -v sha256sum >/dev/null 2>&1; then
	sha() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
	sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
	fail "sha256sum or shasum is required"
fi

version="${KEETA_COMPUTE_VERSION:-latest}"
if [ "$version" = "latest" ]; then
	base="https://github.com/$REPO/releases/latest/download"
else
	base="https://github.com/$REPO/releases/download/$version"
fi
asset="$NAME-linux-$arch"

if [ -n "${KEETA_COMPUTE_PREFIX:-}" ]; then
	prefix="$KEETA_COMPUTE_PREFIX"
elif [ -w /usr/local/bin ]; then
	prefix="/usr/local/bin"
else
	prefix="$HOME/.local/bin"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

echo "Downloading $asset ($version)..."
curl -fsSL -o "$tmp/$asset" "$base/$asset" || fail "download failed: $base/$asset"
curl -fsSL -o "$tmp/$asset.sha256" "$base/$asset.sha256" || fail "checksum download failed"

expected="$(cut -d' ' -f1 "$tmp/$asset.sha256")"
actual="$(sha "$tmp/$asset")"
[ "$expected" = "$actual" ] || fail "checksum mismatch (expected $expected, got $actual)"

mkdir -p "$prefix"
install -m 0755 "$tmp/$asset" "$prefix/$NAME"
echo "Installed $prefix/$NAME ($("$prefix/$NAME" version))"

case ":$PATH:" in
	*":$prefix:"*) ;;
	*) echo "Add $prefix to your PATH to run $NAME directly." ;;
esac

cat <<NEXT

Next:
  1. In the Mac app, open Fleet and choose Add a Linux machine.
  2. Run: $NAME helper pair <CODE>
  3. Register a model served by a local OpenAI-compatible server:
     $NAME helper add-model --id <catalog id> --url http://127.0.0.1:8080/v1 --served-name <name> --weights <path>
  4. Run: $NAME helper run

Guide: https://keeta.ai/compute/helper
NEXT

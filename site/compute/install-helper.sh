#!/bin/sh
# Installs keeta-compute-agent, Keeta Compute for Linux (a full node with its
# own wallet, or a helper paired with another node).
#
#   curl -fsSL https://keeta.ai/compute/install-helper.sh | sh
#
# Downloads the release binary for this machine from GitHub, checks it
# against the SHA-256 pinned in this script, and installs it. The digest
# lives here, in reviewed source, so replacing a release asset is not enough
# to change what gets installed. It needs no root unless KEETA_COMPUTE_PREFIX
# points somewhere only root can write.
#
#   KEETA_COMPUTE_VERSION   another release tag to install; then
#   KEETA_COMPUTE_SHA256    must give that binary's SHA-256
#   KEETA_COMPUTE_PREFIX    install directory (default: /usr/local/bin if
#                           writable, otherwise ~/.local/bin)
set -eu

REPO="KeetaNetwork/keeta-inference"
NAME="keeta-compute-agent"

# Set together when a release is published (see compute/README.md, Deploy).
VERSION=""
SHA256_X64=""
SHA256_ARM64=""

fail() {
	echo "install-helper: $*" >&2
	exit 1
}

[ "$(uname -s)" = "Linux" ] || fail "this installs the Linux agent; on a Mac, install the Keeta Compute app instead"

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

if [ -n "${KEETA_COMPUTE_VERSION:-}" ]; then
	version="$KEETA_COMPUTE_VERSION"
	expected="${KEETA_COMPUTE_SHA256:-}"
	[ -n "$expected" ] || fail "KEETA_COMPUTE_SHA256 is required with KEETA_COMPUTE_VERSION"
else
	version="$VERSION"
	if [ "$arch" = "x64" ]; then expected="$SHA256_X64"; else expected="$SHA256_ARM64"; fi
	[ -n "$version" ] && [ -n "$expected" ] || fail "no Linux release has been published yet"
fi
base="https://github.com/$REPO/releases/download/$version"
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

Next, as a full node with its own wallet:
  1. Run: $NAME init
  2. Register a model served by a local OpenAI-compatible server:
     $NAME models add --id <catalog id> --url http://127.0.0.1:8080/v1 --served-name <name> --weights <path>
  3. Run: $NAME provide --on, then $NAME run

Or as a helper paid to another node: $NAME helper pair <CODE> (code from the
Mac app's Fleet or \`$NAME pair\` on a Linux node), then helper add-model and
helper run.

Guide: https://keeta.ai/compute/helper
NEXT

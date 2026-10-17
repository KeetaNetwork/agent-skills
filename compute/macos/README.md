# Keeta Compute for macOS

Keeta Compute is a menu bar app for Apple Silicon Macs, built like the Keeta
Agent app: it has no Dock icon or main window, and everything happens in a
popover under its menu bar icon (right-click the icon for Quit). The popover
opens by itself on first launch for setup. It lets the owner of a Mac:

- **Pay with Keeta stablecoins**: buy Keeta Compute Credits (one credit is one
  US dollar) with KUSD, KEUR, KJPY, KMXN, KCAD, KAED, KGBP or USDC in the Wallet
  (Buy credits, KUSD by default), and cash credits out to any of them.
- **Earn**: install AI models, offer them to the network at a price in credits
  per million tokens, and earn credits for each request the Mac serves.
- **Use**: give tools and agents on the Mac an OpenAI-compatible endpoint
  (`http://127.0.0.1:11435/v1`) that runs requests on other providers. Each
  request escrows its maximum cost in credits from an "agent budget" before it
  runs; the provider is paid what it billed, less a 0.25% network fee, and
  the rest comes back.
- **Manage a fleet**: pair Linux machines as provider-only helpers whose
  earnings land in this Mac's wallet.

The app is a thin SwiftUI shell. All network, payment and model work happens in
a bundled helper, `keeta-compute-agent` (TypeScript compiled with bun), which
the app starts and talks to over JSON-RPC.

## Open in Xcode

The Xcode project is generated from `project.yml`, so it is not in the
repository. From `compute/macos`:

```sh
make open    # installs XcodeGen with Homebrew if needed, generates KeetaCompute.xcodeproj and opens it
```

Opening the folder or `Package.swift` in Xcode instead shows only
`KeetaComputeKit`, the shared logic package, which has no UI. Run
`make project` again after pulling changes to `project.yml` or new files.

- **See the screens without running anything**: open
  `KeetaCompute/Views/Previews.swift` and show the canvas (Editor > Canvas).
  Every popover screen is there with sample data.
- **Run it**: choose your team under the KeetaCompute target's Signing &
  Capabilities (passkeys and the Secure Enclave key need a real signing
  identity), then run the `KeetaCompute` scheme. There is no window or Dock
  icon: click the Keeta mark in the menu bar. On a MacBook with a full menu
  bar the icon can sit behind the camera notch; quit a few menu bar apps to
  bring it into view. The build bundles the agent with the bun pinned in
  `compute/package.json`, running `npm ci` in `compute/` first if needed. A
  Debug build that can't install it has no bundled agent, so the popover says
  it doesn't include the background service (see "The bundled agent" below).

## Requirements

- macOS 15.0 or later, Apple Silicon (arm64 only)
- Xcode 16 (Swift 6 compiler, Swift 5 language mode)
- [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`)
- An Apple Developer team for signing (passkeys and the Secure Enclave key need
  real entitlements; see below)

## Layout

| Path | What it is |
| --- | --- |
| `project.yml` | XcodeGen spec: app target `KeetaCompute`, framework `KeetaComputeKit`, test target `KeetaComputeKitTests`, the agent bundling run script |
| `Package.swift`, `Sources/KeetaComputeKit/` | Pure Swift logic shared by the app and tests: RPC contract types, JSON-RPC framing, DER→raw ECDSA and low-S, compressed points, amount and price formatting |
| `Tests/KeetaComputeKitTests/` | XCTest tests for the above |
| `KeetaCompute/App/` | App entry (`LSUIElement`, no main window), the status item and its popover, the logs window, termination handling, Debug-only screenshot mode |
| `KeetaCompute/Agent/` | `AgentRPCClient` actor: process lifecycle, request ids, timeouts, restart with backoff |
| `KeetaCompute/Security/` | `NodeKeySigner` (Secure Enclave node key), `PasskeyWallet` + `PasskeyPRF` (operator wallet) |
| `KeetaCompute/Model/AppModel.swift` | Observable state driven by `event.state` and call results |
| `KeetaCompute/Views/` | The popover (`RootView`): Onboarding, Home, Wallet, Models, Provide, Use, Fleet, Settings; panels that stand in for sheets; Logs |
| `Config/` | `Info.plist`, app entitlements, entitlements for signing the agent helper |

## Build and run

```sh
make open                            # generate the project and open it in Xcode
make project                         # xcodegen generate -> KeetaCompute.xcodeproj
make build                           # Debug build (CONFIGURATION=Release for release)
make build DEVELOPMENT_TEAM=ABCDE12345
make test                            # swift test (KeetaComputeKit)
make xctest                          # same tests through the Xcode project
make run                             # build and open the app
```

Or open `KeetaCompute.xcodeproj` after `make project` and run the
`KeetaCompute` scheme.

### Screenshots

A Debug build can draw every popover screen with made-up sample data, without
the agent, a wallet or a network, and quit:

```sh
"build/DerivedData/Build/Products/Debug/Keeta Compute.app/Contents/MacOS/Keeta Compute" --snapshot /tmp/keeta-compute-screenshots
```

CI does this on every change and uploads the images as the
`macos-popover-screenshots` artifact of the CI run.

### The bundled agent

A Run Script phase calls `scripts/bundle-agent.sh`, which compiles the agent
from `compute/packages/cli` and places it at
`Keeta Compute.app/Contents/Resources/keeta-compute-agent`. It compiles with
the bun pinned in `compute/package.json` (npm installs it into
`compute/node_modules`), never with a bun installed on the Mac: older releases
build an agent that can't derive Keeta keys, so the app's first call never
answers. If the pinned bun isn't installed, the script runs `npm ci` in
`compute/`. When that isn't possible, a Debug build only prints a warning and
has no agent, and a Release build fails.

The script then runs the compiled agent's `self-test`, which initializes it as
the app does, signs with a stand-in node key and derives an operator account,
all without the network. A binary that fails it is not bundled, and the build
fails. CI also drives the bundled agent over stdin and stdout as the app does
(`npm run test:agent-binary` in `compute/`).

The script must also sign the helper, because Xcode does not sign executables
in `Resources`:

```sh
codesign --force --options runtime --timestamp --identifier ai.keeta.compute.agent \
  --entitlements "${SRCROOT}/Config/keeta-compute-agent.entitlements" \
  --sign "${EXPANDED_CODE_SIGN_IDENTITY}" \
  "${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}/keeta-compute-agent"
```

`Config/keeta-compute-agent.entitlements` grants the JIT exceptions a
bun-compiled executable needs under the hardened runtime.

The agent receives passkey output and asks the node key to sign, so a signed
app checks the running helper before it talks to it: its signature must come
from the app's own team under Apple's anchor, with the identifier
`ai.keeta.compute.agent`. Otherwise the app stops it and says so. Unsigned and
ad-hoc builds have no team to compare with and skip the check.

During development you can point the app at any agent build by setting
`KEETA_COMPUTE_AGENT_PATH` (an absolute path to an executable) in the scheme's
environment, in Debug builds only. It takes precedence over the bundled helper
and is not signature-checked.

The app runs the agent as:

```
keeta-compute-agent app --data-dir "~/Library/Application Support/Keeta Compute"
```

## Signing, entitlements and notarization

- Bundle id `ai.keeta.compute`, product name "Keeta Compute".
- **Not sandboxed**: the agent downloads models and runs a Python MLX runtime.
- **Hardened runtime on** for the app and framework (required for notarization).
- Entitlements (`Config/KeetaCompute.entitlements`):
  - `com.apple.developer.associated-domains` = `webcredentials:keeta.ai`, so the
    app can create and use passkeys for the relying party `keeta.ai`.
  - `keychain-access-groups` = `$(AppIdentifierPrefix)ai.keeta.compute`, for the
    Secure Enclave node key in the data protection keychain.
- Both are restricted entitlements on macOS, so distribution outside the App
  Store needs a **Developer ID provisioning profile** for `ai.keeta.compute`
  with the Associated Domains capability enabled. With automatic signing in
  Xcode, enable the capability on the App ID in the developer portal.
- Distribute as a Developer ID–signed app and notarize it, for example:

  ```sh
  xcodebuild -project KeetaCompute.xcodeproj -scheme KeetaCompute -configuration Release \
    -archivePath build/KeetaCompute.xcarchive archive
  xcodebuild -exportArchive -archivePath build/KeetaCompute.xcarchive \
    -exportOptionsPlist ExportOptions.plist -exportPath build/export   # method: developer-id
  ditto -c -k --keepParent "build/export/Keeta Compute.app" build/KeetaCompute.zip
  xcrun notarytool submit build/KeetaCompute.zip --keychain-profile <profile> --wait
  xcrun stapler staple "build/export/Keeta Compute.app"
  ```

  The helper inside `Resources` must be signed with the hardened runtime and a
  secure timestamp before the app is signed, or notarization fails.

### Associated domain (passkeys)

Passkeys for `keeta.ai` only work if `https://keeta.ai/.well-known/apple-app-site-association`
lists this app. Until it does, creating or using the wallet passkey fails with
`ASAuthorizationError` 1004. The keeta.ai site serves that file from
`site/.well-known/apple-app-site-association` (as `application/json`, with no
redirect), listing the app signed by team `2BG69HN56W`:

```json
{ "webcredentials": { "apps": ["2BG69HN56W.ai.keeta.compute"] } }
```

A build signed by another team needs its `TEAMID.ai.keeta.compute` added to
that list. Apple's CDN caches the file, so a change can take a while to reach
Macs. To fetch it straight from keeta.ai while testing, add `?mode=developer`
to the associated domain in `Config/KeetaCompute.entitlements` and run
`sudo swcutil developer-mode -e true`.

## Keys

- **Node key** (this Mac's identity; signs receipts, never moves funds): a P-256
  key in the Secure Enclave, permanent, access control `.privateKeyUsage` only
  (no user presence, because signing runs unattended), accessible after first
  unlock, this device only. The agent sends `signer.signDigest` with a 32-byte
  digest; the app signs it as-is with `SecKeyCreateSignature(...,
  .ecdsaSignatureDigestX962SHA256, ...)`, converts the DER signature to raw
  64-byte r‖s and normalizes to low S. The public key is passed to the agent as a
  33-byte compressed point. If the Secure Enclave can't be used (no enclave, or a
  build without the keychain entitlement), a software P-256 key is stored in the
  login Keychain instead and Settings says so. While the enclave works the app
  never adopts a software key it finds in the login Keychain, since any process
  running as the user could have put one there.
- **Operator wallet**: a passkey (relying party `keeta.ai`) with the WebAuthn PRF
  extension, salt SHA-256("keeta.com/wallet/seed/v1"), the same scheme as the
  Keeta web wallet. Onboarding creates the passkey, then performs an assertion to
  get the 32-byte PRF output and passes it to the agent (`wallet.setOperator`).
  Every send, credit purchase, cash-out and move into the agent budget performs
  a fresh assertion (Touch ID). The PRF output is never stored; the app keeps only the passkey's
  credential ID in UserDefaults. There is no seed phrase. Because platform
  passkeys sync through iCloud Keychain, "I already have a wallet passkey"
  restores the same wallet on another Mac.

## RPC contract

The app and the agent speak JSON-RPC 2.0, one JSON object per line, over the
agent's stdin (app → agent) and stdout (agent → app); the agent's stderr is
forwarded to `os.Logger` (subsystem `ai.keeta.compute`, category
`agent-stderr`) and to the in-app Logs window.

The contract is defined in `compute/packages/protocol/src/app-rpc.ts` (`@keeta-compute/protocol/rpc`), with shared shapes
from `compute/packages/protocol/src/`. The Swift mirror is
`Sources/KeetaComputeKit/RPCTypes.swift`, `ProtocolTypes.swift` and
`RPCMethods.swift`; change those together with the TypeScript and keep
`Tests/KeetaComputeKitTests/RPCCodecTests.swift` in step. Amounts are always
strings of integer base units and are formatted with the decimals the agent
reports (`WalletState.asset` for credits, `WalletState.stablecoins` for each
stablecoin), without floating point.

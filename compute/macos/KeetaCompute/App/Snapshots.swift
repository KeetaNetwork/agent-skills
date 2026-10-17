#if DEBUG
import AppKit
import KeetaComputeKit
import SwiftUI

/// `--snapshot <dir>` draws each popover screen with sample data to PNG files
/// and quits, so the look can be checked without a signed build, the agent or
/// a network. CI runs it on the Debug build and uploads the images.
@MainActor
enum Snapshots {
    static var directory: URL? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "--snapshot"), arguments.indices.contains(index + 1) else { return nil }
        return URL(fileURLWithPath: arguments[index + 1], isDirectory: true)
    }

    static func makeModel() -> AppModel {
        let model = AppModel(sample: ())
        let now = Date().timeIntervalSince1970 * 1000
        let decoder = JSONDecoder()
        do {
            model.loadSample(
                state: try decoder.decode(AgentState.self, from: Data(SampleData.state(now: now).utf8)),
                catalog: try decoder.decode([CatalogEntry].self, from: Data(SampleData.catalog(now: now).utf8)),
                progress: [InstallProgress(modelId: "llama-3.1-8b-instruct", phase: .downloading, bytesDone: 2.9e9, bytesTotal: 4.8e9)],
                networkModels: try decoder.decode([NetworkModel].self, from: Data(SampleData.networkModels.utf8)),
                fleet: try decoder.decode([FleetHelper].self, from: Data(SampleData.fleet(now: now).utf8)),
                running: try decoder.decode([JobSummary].self, from: Data(SampleData.running(now: now).utf8))
            )
        } catch {
            FileHandle.standardError.write(Data("Sample data didn't decode: \(error)\n".utf8))
            exit(1)
        }
        return model
    }

    static func run(_ model: AppModel, into directory: URL) async {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        } catch {
            FileHandle.standardError.write(Data("Can't create \(directory.path): \(error)\n".utf8))
            exit(1)
        }
        let screens: [(String, Page?)] = [
            ("1-home", nil),
            ("2-wallet", .wallet),
            ("3-models", .models),
            ("4-provide", .provide),
            ("5-use", .use),
            ("6-fleet", .fleet),
            ("7-settings", .settings),
        ]
        for (name, page) in screens {
            await render(RootView(page: page).environmentObject(model), name: name, into: directory)
        }
        model.onboardingComplete = false
        await render(RootView().environmentObject(model), name: "8-onboarding", into: directory)
    }

    private static func render<V: View>(_ view: V, name: String, into directory: URL) async {
        let size = NSSize(width: PopoverMetrics.width, height: PopoverMetrics.height)
        let hosting = NSHostingView(rootView: view)
        hosting.frame = NSRect(origin: .zero, size: size)
        let window = NSWindow(contentRect: hosting.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentView = hosting
        window.orderFrontRegardless()
        // Let SwiftUI lay out and draw.
        try? await Task.sleep(for: .milliseconds(800))
        hosting.layoutSubtreeIfNeeded()
        hosting.display()

        // Drawn at 2x so the images are sharp on any display.
        if let rep = bitmap(size: size, scale: 2) {
            hosting.cacheDisplay(in: hosting.bounds, to: rep)
            write(rep, to: directory.appendingPathComponent("\(name).png"))
        }
        // The same view through Core Animation, in case AppKit's cache misses layer content.
        if let layer = hosting.layer, let rep = bitmap(size: size, scale: 2), let context = NSGraphicsContext(bitmapImageRep: rep) {
            let cg = context.cgContext
            cg.scaleBy(x: 2, y: 2)
            if !layer.contentsAreFlipped() {
                cg.translateBy(x: 0, y: size.height)
                cg.scaleBy(x: 1, y: -1)
            }
            layer.render(in: cg)
            write(rep, to: directory.appendingPathComponent("\(name).layer.png"))
        }
        window.orderOut(nil)
    }

    private static func bitmap(size: NSSize, scale: CGFloat) -> NSBitmapImageRep? {
        let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: Int(size.width * scale),
            pixelsHigh: Int(size.height * scale),
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        )
        rep?.size = size
        return rep
    }

    private static func write(_ rep: NSBitmapImageRep, to url: URL) {
        guard let data = rep.representation(using: .png, properties: [:]) else { return }
        do {
            try data.write(to: url)
            print("Wrote \(url.path)")
        } catch {
            FileHandle.standardError.write(Data("Can't write \(url.path): \(error)\n".utf8))
        }
    }
}

/// Made-up balances, models and jobs on the test network.
private enum SampleData {
    static func state(now: Double) -> String {
        """
        {
          "version": "0.1.0",
          "network": "test",
          "nodeKey": "keeta_aab3yq7wqhtpg5pzd5p3hfuxp4dh6hzmbnfzm3agfwkrwuzwxyncsmhvsz",
          "onboarded": true,
          "controlReachable": true,
          "hardware": {"os": "macos", "osVersion": "macOS 15.1", "chip": "Apple M3 Max", "memoryBytes": 68719476736, "freeDiskBytes": 412316860416, "gpuCores": 40},
          "tier": "A",
          "wallet": {
            "operator": "keeta_aabxs2m4ktfqp7wdc3nrv6hyzj5ub2leog4aw7tmqx3kfdpz6n4cvhsa7e",
            "spend": "keeta_aab7pqk3m2yfwz5ndr4hgu6vtcx2bs9oaeil3jkq8mw4zcy5ntrdf6ghu",
            "balances": {
              "operator": {"credits": "42180000", "kta": "30000000000000000000", "stablecoins": {"KUSD": "125000000", "KEUR": "40000000"}},
              "spend": {"credits": "8500000", "kta": "1000000000000000000", "stablecoins": {}}
            },
            "asset": {"address": "keeta_anqcredits", "symbol": "credits", "decimals": 6},
            "creditsAvailable": true,
            "stablecoins": [
              {"symbol": "KUSD", "name": "Keeta US Dollar", "currency": "USD", "address": "keeta_akusd", "decimals": 6},
              {"symbol": "KEUR", "name": "Keeta Euro", "currency": "EUR", "address": "keeta_akeur", "decimals": 6},
              {"symbol": "USDC", "name": "USD Coin", "currency": "USD", "address": "keeta_ausdc", "decimals": 6}
            ],
            "explorer": "https://explorer.test.keeta.com"
          },
          "provider": {
            "policy": {"enabled": true, "schedule": {"mode": "idle", "idleMinutes": 10}, "pauseOnBattery": true, "maxConcurrentJobs": 2, "access": {"mode": "public", "allow": []}},
            "state": "online",
            "activeJobs": 1,
            "earnedToday": "1240000",
            "earnedTotal": "18730000",
            "tokensServedToday": 412000,
            "recentJobs": [
              \(job("p1", "provider", "qwen3-8b", 1840, 612, "92000", "paid", now - 4 * 60_000)),
              \(job("p2", "provider", "gemma-3-27b-it", 5210, 1430, "386000", "paid", now - 19 * 60_000)),
              \(job("p3", "provider", "qwen3-8b", 920, 2240, "270000", "completed", now - 41 * 60_000))
            ]
          },
          "buyer": {
            "endpoint": "http://127.0.0.1:11435/v1",
            "token": "kc_7f3a9c2e5b1d4f6a8c0e2b4d6f8a1c3e",
            "policy": {"perRequestMax": "500000", "dailyMax": "5000000", "allowedModels": [], "allowedProviders": [], "maxPrice": {"inputPerMillion": "2000000", "outputPerMillion": "6000000"}},
            "spentToday": "310000",
            "recentJobs": [
              \(job("b1", "buyer", "qwen3-32b", 3120, 840, "214000", "paid", now - 7 * 60_000)),
              \(job("b2", "buyer", "llama-3.3-70b-instruct", 1500, 420, "96000", "paid", now - 52 * 60_000))
            ]
          }
        }
        """
    }

    static func running(now: Double) -> String {
        "[\(job("r1", "provider", "qwen3-8b", 2210, 388, "0", "running", now - 6_000))]"
    }

    static func catalog(now: Double) -> String {
        """
        [
          \(entry(id: "qwen3-8b", name: "Qwen3 8B", parameters: "8B", disk: 4.6, memory: 7, context: 32768, license: "Apache-2.0", fits: true, installed: true, offered: true, now: now)),
          \(entry(id: "gemma-3-27b-it", name: "Gemma 3 27B", parameters: "27B", disk: 16.9, memory: 20, context: 131072, license: "Gemma Terms of Use", fits: true, installed: true, offered: false, now: now)),
          \(entry(id: "llama-3.1-8b-instruct", name: "Llama 3.1 8B Instruct", parameters: "8B", disk: 4.5, memory: 7, context: 131072, license: "Llama 3.1 Community License", fits: true, installed: false, offered: false, now: now)),
          \(entry(id: "qwen3-32b", name: "Qwen3 32B", parameters: "32B", disk: 18.4, memory: 24, context: 32768, license: "Apache-2.0", fits: true, installed: false, offered: false, now: now)),
          \(entry(id: "qwen3-235b-a22b", name: "Qwen3 235B A22B (MoE)", parameters: "235B", disk: 132, memory: 140, context: 32768, license: "Apache-2.0", fits: false, installed: false, offered: false, now: now))
        ]
        """
    }

    static let networkModels = """
    [
      {"id": "qwen3-8b", "name": "Qwen3 8B", "providers": 14, "lowestPrice": {"inputPerMillion": "40000", "outputPerMillion": "90000"}, "contextLength": 32768, "license": "Apache-2.0"},
      {"id": "qwen3-32b", "name": "Qwen3 32B", "providers": 6, "lowestPrice": {"inputPerMillion": "150000", "outputPerMillion": "400000"}, "contextLength": 32768, "license": "Apache-2.0"},
      {"id": "llama-3.3-70b-instruct", "name": "Llama 3.3 70B Instruct", "providers": 3, "lowestPrice": {"inputPerMillion": "300000", "outputPerMillion": "600000"}, "contextLength": 131072, "license": "Llama 3.3 Community License"}
    ]
    """

    static func fleet(now: Double) -> String {
        """
        [
          {"nodeKey": "keeta_aabhelper1", "name": "rack-01", "hardware": {"os": "linux", "osVersion": "Ubuntu 24.04", "chip": "NVIDIA RTX 4090", "memoryBytes": 137438953472, "freeDiskBytes": 1000000000000}, "tier": "A", "status": "online", "offers": ["qwen3-14b", "gemma-3-27b-it"], "completed": 318, "lastHeartbeat": \(now - 20_000)},
          {"nodeKey": "keeta_aabhelper2", "name": "office-box", "hardware": {"os": "linux", "osVersion": "Debian 12", "chip": "AMD Ryzen 9 7950X", "memoryBytes": 68719476736, "freeDiskBytes": 500000000000}, "tier": "B", "status": "paused", "offers": ["qwen3-8b"], "completed": 41, "lastHeartbeat": \(now - 3_600_000)}
        ]
        """
    }

    private static func job(_ id: String, _ role: String, _ model: String, _ input: Int, _ output: Int, _ amount: String, _ status: String, _ at: Double) -> String {
        """
        {"jobId": "\(id)", "role": "\(role)", "modelId": "\(model)", "counterparty": "keeta_aabcounterparty", "inputTokens": \(input), "outputTokens": \(output), "amount": "\(amount)", "status": "\(status)", "at": \(at)}
        """
    }

    private static func entry(id: String, name: String, parameters: String, disk: Double, memory: Double, context: Int, license: String, fits: Bool, installed: Bool, offered: Bool, now: Double) -> String {
        let gb = 1024.0 * 1024.0 * 1024.0
        let compatibility = fits
            ? "{\"fits\": true, \"headroomBytes\": \(64 * gb - memory * gb)}"
            : "{\"fits\": false, \"reason\": \"not-enough-memory\", \"shortByBytes\": \(memory * gb - 64 * gb)}"
        let price = "{\"inputPerMillion\": \"50000\", \"outputPerMillion\": \"100000\"}"
        let install = installed
            ? "{\"modelId\": \"\(id)\", \"name\": \"\(name)\", \"path\": \"/models/\(id)\", \"weightsHash\": \"sha256:9f2c41d7e0b3a6c58e1f2d4b7a9c0e3f5a7b9d1c3e5f7a9b1d3f5a7c9e1b3d5f\", \"sizeBytes\": \(disk * gb), \"installedAt\": \(now - 86_400_000), \"custom\": false, \"offer\": {\"offered\": \(offered), \"price\": \(price), \"access\": null}}"
            : "null"
        return """
        {"model": {"id": "\(id)", "name": "\(name)", "family": "sample", "parameters": "\(parameters)", "quantization": "4-bit", "runtime": "mlx", "source": {"kind": "huggingface", "repo": "mlx-community/\(id)", "revision": "main"}, "diskBytes": \(disk * gb), "memoryBytes": \(memory * gb), "contextLength": \(context), "license": {"name": "\(license)", "url": "https://keeta.ai", "operatorNotes": "Follow the license when you serve this model."}, "suggestedPrice": \(price), "tags": []}, "compatibility": \(compatibility), "installed": \(install)}
        """
    }
}
#endif

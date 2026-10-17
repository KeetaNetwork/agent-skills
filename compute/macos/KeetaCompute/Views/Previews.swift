#if DEBUG
import SwiftUI

// Every popover screen with sample data, for Xcode's canvas (Editor > Canvas).
// The same data as `--snapshot`; no agent, wallet or network needed.

@MainActor
private func previewModel(onboarded: Bool = true) -> AppModel {
    let model = Snapshots.makeModel()
    model.onboardingComplete = onboarded
    return model
}

#Preview("Home") {
    RootView().environmentObject(previewModel())
}

#Preview("Wallet") {
    RootView(page: .wallet).environmentObject(previewModel())
}

#Preview("Models") {
    RootView(page: .models).environmentObject(previewModel())
}

#Preview("Provide") {
    RootView(page: .provide).environmentObject(previewModel())
}

#Preview("Use") {
    RootView(page: .use).environmentObject(previewModel())
}

#Preview("Fleet") {
    RootView(page: .fleet).environmentObject(previewModel())
}

#Preview("Settings") {
    RootView(page: .settings).environmentObject(previewModel())
}

#Preview("Onboarding") {
    RootView().environmentObject(previewModel(onboarded: false))
}
#endif

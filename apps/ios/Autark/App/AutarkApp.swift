// Owns: the app entry – one model (with the system's notification center and push registration), its first screen, pair links (the
// Universal Link https://openautark.com/pair/#<id> once the site's association file and the signed app exist; the custom scheme
// autark://pair/<id> works without them), the lifecycle hook that reconnects when the app comes forward, and the app delegate that
// hears Apple's push token.
// Never: does anything before the model's start(), or asks for notifications at launch.
import SwiftUI

@main
struct AutarkApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    /// The unit tests run inside this app (hosted): they bring their own models, so the host app keeps to what it was before notifications.
    private static let hostsTests = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
    @StateObject private var model = AppModel.shared
    /// The Live Activity's and the controls' buttons run here (LiveActivityIntent / openAppWhenRun), also when iOS launched the app
    /// in the background for them: the handler is set before any scene exists.
    init() {
        QuickBridge.handler = { command in await QuickCenter.handle(command) }
    }
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView(model: model)
                .onAppear { model.start() }
                .onOpenURL { model.openLink($0) }
                .onChange(of: scenePhase) { _, phase in model.scenePhaseChanged(phase) }
                .sheet(isPresented: $model.dictating) { DictationView(model: model) }
                .overlay(alignment: .top) {
                    if let note = model.quickNote {
                        Text(note).font(.footnote.weight(.semibold)).padding(.horizontal, 14).padding(.vertical, 8)
                            .background(.regularMaterial, in: Capsule()).padding(.top, 8)
                            .task { try? await Task.sleep(nanoseconds: 3_000_000_000); model.quickNote = nil }
                    }
                }
        }
    }
}

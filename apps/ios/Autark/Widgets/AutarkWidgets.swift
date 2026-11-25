// Owns: the widget extension "AutarkWidgets" (iOS 18+): the Live Activity "<agent> is using this phone" on the Lock Screen and in the
// Dynamic Island (ActivityConfiguration over AutarkAgentActivityAttributes, the views in Shared/LiveViews.swift), the Lock Screen widgets
// (round: open Autark; wide: newest screenshot / dictate) and the Control Center buttons (Open, Screenshot, Dictation: ControlWidget).
// The extension's deployment target is iOS 18 (ControlWidget; a WidgetBundle with an availability check crashes on iOS 17), so on
// iOS 17 the app runs without these. Every button is an intent from Shared/LiveIntents.swift that iOS runs in the app's process.
// Never: talks to the PC, or keeps anything.
import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit
import AutarkCore

@main
struct AutarkWidgets: WidgetBundle {
    var body: some Widget {
        AutarkLiveActivity()
        AutarkLockWidget()
        AutarkOpenControl()
        AutarkScreenshotControl()
        AutarkDictateControl()
    }
}

struct AutarkLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AutarkAgentActivityAttributes.self) { context in
            LiveLockView(state: context.state)
                .activityBackgroundTint(Color.black.opacity(0.55))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { LiveExpandedLeading(state: context.state) }
                DynamicIslandExpandedRegion(.trailing) { LiveExpandedTrailing(state: context.state) }
                DynamicIslandExpandedRegion(.center) { LiveExpandedCenter(state: context.state) }
                DynamicIslandExpandedRegion(.bottom) { LiveExpandedBottom(state: context.state) }
            } compactLeading: {
                LiveCompactLeading(state: context.state)
            } compactTrailing: {
                LiveCompactTrailing(state: context.state)
            } minimal: {
                LiveMinimal(state: context.state)
            }
            .keylineTint(LiveLook.tint(context.state.state))
            .widgetURL(URL(string: "autark://open"))
        }
    }
}

struct LockEntry: TimelineEntry {
    let date: Date
}

struct LockProvider: TimelineProvider {
    func placeholder(in context: Context) -> LockEntry { LockEntry(date: Date()) }
    func getSnapshot(in context: Context, completion: @escaping (LockEntry) -> Void) { completion(LockEntry(date: Date())) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<LockEntry>) -> Void) {
        completion(Timeline(entries: [LockEntry(date: Date())], policy: .never))
    }
}

struct AutarkLockWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "com.teydralab.autark.lock", provider: LockProvider()) { _ in
            LockWidgetView()
        }
        .configurationDisplayName("Autark")
        .description("Open Autark, send your newest screenshot or dictate.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular])
    }
}

struct LockWidgetView: View {
    @Environment(\.widgetFamily) private var family

    var body: some View {
        switch family {
        case .accessoryRectangular:
            AccessoryRectangularView()
                .containerBackground(for: .widget) { Color.clear }
        default:
            AccessoryCircularView()
                .widgetURL(URL(string: "autark://open"))
                .containerBackground(for: .widget) { AccessoryWidgetBackground() }
        }
    }
}

struct AutarkOpenControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.teydralab.autark.control.open") {
            ControlWidgetButton(action: OpenAutarkIntent()) {
                Label("Autark öffnen", systemImage: "bubble.left.and.text.bubble.right.fill")
            }
        }
        .displayName("Autark öffnen")
    }
}

struct AutarkScreenshotControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.teydralab.autark.control.screenshot") {
            ControlWidgetButton(action: ScreenshotControlIntent()) {
                Label("Screenshot senden", systemImage: "camera.viewfinder")
            }
        }
        .displayName("Screenshot senden")
    }
}

struct AutarkDictateControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.teydralab.autark.control.dictate") {
            ControlWidgetButton(action: DictateControlIntent()) {
                Label("Diktat", systemImage: "mic.fill")
            }
        }
        .displayName("Diktat")
    }
}

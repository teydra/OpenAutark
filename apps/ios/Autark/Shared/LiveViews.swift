// Owns: how the Live Activity looks – the Lock Screen / banner view and the Dynamic Island's parts (compact leading and trailing,
// minimal, expanded leading / trailing / center / bottom) – and the two Lock Screen widgets, as plain SwiftUI views over LiveState so
// the widget extension shows them and the app's simulator tests render them to PNG (ImageRenderer). Wording follows Android's bubble
// ("<agent> is using this phone", Pause / Continue, ✕); the buttons are the shared intents (LiveIntents.swift). While the AI asks, the
// question's labels and ✕ replace Pause / Stop (contract IPHONE-WELLE2.md).
// Never: holds state or talks to anything; the island previews (LiveIslandPreview) exist only for the rendered pictures.
import SwiftUI
import AppIntents
import AutarkCore

enum LiveLook {
    static func tint(_ phase: LiveState.Phase) -> Color {
        switch phase {
        case .working: return Color(red: 0.20, green: 0.70, blue: 0.40)
        case .asking: return Color(red: 0.20, green: 0.45, blue: 0.95)
        case .paused: return Color(red: 0.95, green: 0.60, blue: 0.15)
        case .ended: return Color.gray
        }
    }

    static func symbol(_ phase: LiveState.Phase) -> String {
        switch phase {
        case .working: return "hand.tap.fill"
        case .asking: return "questionmark.bubble.fill"
        case .paused: return "pause.circle.fill"
        case .ended: return "checkmark.circle.fill"
        }
    }

    static func status(_ phase: LiveState.Phase) -> String {
        switch phase {
        case .working: return "Working on this phone"
        case .asking: return "Asks you"
        case .paused: return "Paused – the phone is yours"
        case .ended: return "Done"
        }
    }

    static func initial(_ state: LiveState) -> String {
        String(state.by.trimmingCharacters(in: .whitespaces).first ?? "A").uppercased()
    }

    /// The question's buttons in rows of `per`: the AI's labels, then ✕.
    static func rows(_ labels: [String], per: Int) -> [[String]] {
        let all = labels + [SayChoices.no]
        return stride(from: 0, to: all.count, by: per).map { Array(all[$0..<min($0 + per, all.count)]) }
    }
}

/// The agent's initial on the state's colour.
struct LiveBadge: View {
    let state: LiveState
    var size: CGFloat = 24

    var body: some View {
        ZStack {
            Circle().fill(LiveLook.tint(state.state))
            Text(LiveLook.initial(state)).font(.system(size: size * 0.5, weight: .bold, design: .rounded)).foregroundStyle(.white)
        }
        .frame(width: size, height: size)
    }
}

/// The activity's buttons: the question's labels and ✕ while asking, else Pause / Continue and Stop.
struct LiveButtons: View {
    let state: LiveState
    var compact = false

    var body: some View {
        if state.state == .asking {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(LiveLook.rows(state.buttons, per: compact ? 3 : 4).enumerated()), id: \.offset) { _, row in
                    HStack(spacing: 6) {
                        ForEach(row, id: \.self) { label in
                            Button(intent: LiveAnswerIntent(job: state.job, label: label)) {
                                Text(label).font(.subheadline.weight(.semibold)).lineLimit(1).frame(minWidth: 28)
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(label == SayChoices.no ? Color.red : (label == SayChoices.yes ? LiveLook.tint(.working) : LiveLook.tint(.asking)))
                        }
                    }
                }
            }
        } else if state.controls {
            HStack(spacing: 8) {
                let paused = state.state == .paused
                Button(intent: LiveControlIntent(job: state.job, action: paused ? "continue" : "pause")) {
                    Label(paused ? "Continue" : "Pause", systemImage: paused ? "play.fill" : "pause.fill").font(.subheadline.weight(.semibold))
                }
                .buttonStyle(.borderedProminent)
                .tint(paused ? LiveLook.tint(.working) : LiveLook.tint(.paused))
                Button(intent: LiveControlIntent(job: state.job, action: "stop")) {
                    Label("Stop", systemImage: "stop.fill").font(.subheadline.weight(.semibold))
                }
                .buttonStyle(.borderedProminent)
                .tint(.red)
            }
        }
    }
}

/// The Lock Screen and banner view.
struct LiveLockView: View {
    let state: LiveState

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                LiveBadge(state: state, size: 30)
                VStack(alignment: .leading, spacing: 1) {
                    Text(state.headline).font(.subheadline.weight(.semibold)).lineLimit(1)
                    Text(LiveLook.status(state.state)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 4)
                Text("Autark").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            }
            if !state.line.isEmpty {
                Text(state.line).font(.callout).lineLimit(3).fixedSize(horizontal: false, vertical: true)
            }
            LiveButtons(state: state)
        }
        .padding(14)
    }
}

struct LiveCompactLeading: View {
    let state: LiveState
    var body: some View { LiveBadge(state: state, size: 22) }
}

struct LiveCompactTrailing: View {
    let state: LiveState
    var body: some View { Image(systemName: LiveLook.symbol(state.state)).foregroundStyle(LiveLook.tint(state.state)) }
}

struct LiveMinimal: View {
    let state: LiveState
    var body: some View { Image(systemName: LiveLook.symbol(state.state)).foregroundStyle(LiveLook.tint(state.state)) }
}

struct LiveExpandedLeading: View {
    let state: LiveState
    var body: some View { LiveBadge(state: state, size: 34).padding(.leading, 4) }
}

struct LiveExpandedTrailing: View {
    let state: LiveState
    var body: some View {
        Label(state.state == .asking ? "Asks" : (state.state == .paused ? "Paused" : (state.state == .ended ? "Done" : "Working")), systemImage: LiveLook.symbol(state.state))
            .font(.caption.weight(.semibold)).foregroundStyle(LiveLook.tint(state.state)).lineLimit(1)
    }
}

struct LiveExpandedCenter: View {
    let state: LiveState
    var body: some View { Text(state.headline).font(.caption.weight(.semibold)).lineLimit(1) }
}

struct LiveExpandedBottom: View {
    let state: LiveState
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !state.line.isEmpty { Text(state.line).font(.callout).lineLimit(2) }
            LiveButtons(state: state, compact: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The Dynamic Island's shapes around the parts, for the rendered pictures only (the system draws the real island).
struct LiveIslandPreview: View {
    enum IslandShape { case compact, minimal, expanded }
    let state: LiveState
    let shape: IslandShape

    var body: some View {
        Group {
            switch shape {
            case .compact:
                HStack {
                    LiveCompactLeading(state: state)
                    Spacer(minLength: 120)
                    LiveCompactTrailing(state: state)
                }
                .padding(.horizontal, 12)
                .frame(height: 37)
                .background(Capsule().fill(Color.black))
            case .minimal:
                LiveMinimal(state: state)
                    .frame(width: 37, height: 37)
                    .background(Circle().fill(Color.black))
            case .expanded:
                VStack(spacing: 8) {
                    HStack(alignment: .top) {
                        LiveExpandedLeading(state: state)
                        Spacer()
                        LiveExpandedCenter(state: state)
                        Spacer()
                        LiveExpandedTrailing(state: state)
                    }
                    LiveExpandedBottom(state: state)
                }
                .padding(16)
                .frame(width: 370)
                .background(RoundedRectangle(cornerRadius: 44, style: .continuous).fill(Color.black))
            }
        }
        .foregroundStyle(.white)
        .environment(\.colorScheme, .dark)
        .padding(10)
    }
}

/// The round Lock Screen widget: Autark's mark, a tap opens the app.
struct AccessoryCircularView: View {
    var body: some View {
        ZStack {
            Circle().fill(Color.white.opacity(0.18))
            Text("A").font(.system(size: 26, weight: .heavy, design: .rounded))
        }
    }
}

/// The wide Lock Screen widget: two buttons – send the newest screenshot, dictate.
struct AccessoryRectangularView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Autark").font(.headline).lineLimit(1)
            HStack(spacing: 6) {
                Button(intent: ScreenshotControlIntent()) { Label("Shot", systemImage: "camera.viewfinder") }
                Button(intent: DictateControlIntent()) { Label("Diktat", systemImage: "mic.fill") }
            }
            .font(.caption.weight(.semibold))
            .buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

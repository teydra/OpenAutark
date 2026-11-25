// Owns: the screens – the native connect levels (1 "Connect to your PC" with the big "Scan QR code" and the small "Enter the code
// instead"; 2 the full-height scanner; 2b the 9 digits grouped 3-3-3 with "Connect"; 3 the wait with the 4-digit code both
// screens show and Cancel) and the page's frame (the PC's unchanged phone UI, edge to edge, with the bar areas in the page's
// own colours and the "can't reach" cover). Light and dark follow the system; the palette is Android's PairLook.
// Never: pairs, stores or sends anything itself – every action is a call on AppModel.
import SwiftUI
import AutarkCore

enum Look {
    static let accent = Color(argb: 0xFF2C665A)

    static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(uiColor: UIColor { trait in UIColor(argb: trait.userInterfaceStyle == .dark ? dark : light) })
    }

    static let bg = dynamic(light: 0xFFF6F8F7, dark: 0xFF111614)
    static let ink = dynamic(light: 0xFF16201D, dark: 0xFFE8EEEB)
    static let muted = dynamic(light: 0xFF5B6662, dark: 0xFF9AA6A1)
    static let card = dynamic(light: 0xFFFFFFFF, dark: 0xFF1C2421)
    static let line = dynamic(light: 0xFFD6DEDA, dark: 0xFF2F3A36)
    static let link = dynamic(light: 0xFF2C665A, dark: 0xFF8CCBB8)
}

struct RootView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        ZStack {
            switch model.screen {
            case .page: PageScreen(model: model)
            case .start: StartScreen(model: model)
            case .scan: ScanScreen(model: model)
            case .code: CodeScreen(model: model)
            case .waiting: WaitingScreen(model: model)
            }
        }
        .animation(.easeInOut(duration: 0.15), value: model.screen)
    }
}

// MARK: level 1

struct StartScreen: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                if model.cancelable {
                    Button(action: model.backFromLevel) { Image(systemName: "chevron.left").font(.system(size: 20, weight: .semibold)).frame(width: 48, height: 48) }
                        .accessibilityLabel("Back")
                }
                Spacer()
            }
            .frame(height: 48)
            Spacer()
            Image("BrandMark").resizable().scaledToFit().frame(width: 96, height: 96).clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous)).accessibilityHidden(true)
            Text("Connect to your PC").font(.system(size: 26, weight: .bold)).foregroundStyle(Look.ink).padding(.top, 24)
                .accessibilityIdentifier("title")
            Text("On your PC: Settings › Devices › Connect a phone").font(.system(size: 15)).foregroundStyle(Look.muted).multilineTextAlignment(.center).padding(.top, 8)
            Spacer()
            Text(model.message).font(.system(size: 15)).foregroundStyle(Look.muted).multilineTextAlignment(.center).frame(minHeight: 44).accessibilityIdentifier("message")
            Button(action: model.showScanner) {
                Text("Scan QR code").font(.system(size: 17, weight: .semibold)).foregroundStyle(.white).frame(maxWidth: .infinity, minHeight: 56)
                    .background(Look.accent, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .accessibilityIdentifier("scan")
            Button("Enter the code instead") { model.showCode() }
                .font(.system(size: 16, weight: .medium)).foregroundStyle(Look.link).padding(.top, 8).frame(minHeight: 44)
                .accessibilityIdentifier("enter-code")
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 12)
        .background(Look.bg.ignoresSafeArea())
    }
}

// MARK: level 2

struct ScanScreen: View {
    @ObservedObject var model: AppModel

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.ignoresSafeArea()
            QRScannerView(onCode: { model.scanned($0) }).ignoresSafeArea()
            HStack {
                Button(action: model.backFromLevel) { Image(systemName: "chevron.left").font(.system(size: 20, weight: .semibold)).foregroundStyle(.white).frame(width: 48, height: 48) }
                    .accessibilityLabel("Back")
                Spacer()
                Text("Point at the QR code on your PC").font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
                Spacer()
                Color.clear.frame(width: 48, height: 48)
            }
            .padding(.horizontal, 8)
            VStack {
                Spacer()
                if !model.message.isEmpty {
                    Text(model.message).font(.system(size: 15)).foregroundStyle(.white).padding(.horizontal, 16).padding(.vertical, 10)
                        .background(Color.black.opacity(0.7), in: Capsule()).padding(.bottom, 24)
                }
            }
        }
    }
}

// MARK: level 2b

struct CodeScreen: View {
    @ObservedObject var model: AppModel
    @FocusState private var focused: Bool

    private var digits: String { model.typed.filter { $0.isASCII && $0.isNumber } }

    /// 3-3-3 grouping of what was typed.
    private var grouped: String {
        let d = Array(digits.prefix(9))
        var out = ""
        for (i, c) in d.enumerated() { if i > 0 && i % 3 == 0 { out += " " }; out.append(c) }
        return out
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Button(action: model.backFromLevel) { Image(systemName: "chevron.left").font(.system(size: 20, weight: .semibold)).frame(width: 48, height: 48) }
                    .accessibilityLabel("Back")
                Spacer()
            }
            .frame(height: 48)
            Text("Enter the code").font(.system(size: 26, weight: .bold)).foregroundStyle(Look.ink).padding(.top, 24).accessibilityIdentifier("title")
            Text("The 9 digits under Settings › Devices on your PC").font(.system(size: 15)).foregroundStyle(Look.muted).padding(.top, 8)
            TextField("000 000 000", text: Binding(get: { grouped }, set: { model.typed = String($0.filter { $0.isASCII && $0.isNumber }.prefix(9)); model.message = "" }))
                .keyboardType(.numberPad)
                .font(.system(size: 34, weight: .semibold, design: .monospaced))
                .foregroundStyle(Look.ink)
                .focused($focused)
                .padding(.horizontal, 16)
                .frame(height: 72)
                .background(Look.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Look.line, lineWidth: 1))
                .padding(.top, 24)
                .accessibilityIdentifier("code-field")
            Text(model.message).font(.system(size: 15)).foregroundStyle(Look.muted).frame(minHeight: 44, alignment: .leading).padding(.top, 8).accessibilityIdentifier("message")
            Spacer()
            Button(action: model.connectTyped) {
                Text("Connect").font(.system(size: 17, weight: .semibold)).foregroundStyle(.white).frame(maxWidth: .infinity, minHeight: 56)
                    .background(digits.count == 9 ? Look.accent : Look.accent.opacity(0.35), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .disabled(digits.count != 9)
            .accessibilityIdentifier("connect")
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 12)
        .background(Look.bg.ignoresSafeArea())
        .onAppear { focused = true }
    }
}

// MARK: level 3

struct WaitingScreen: View {
    @ObservedObject var model: AppModel

    private var spacedCode: String { (model.waiting.code ?? "").map(String.init).joined(separator: " ") }

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            Image("BrandMark").resizable().scaledToFit().frame(width: 72, height: 72).clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous)).accessibilityHidden(true)
            Text(model.waiting.line).font(.system(size: 18, weight: .semibold)).foregroundStyle(Look.ink).multilineTextAlignment(.center).padding(.top, 24).padding(.horizontal, 24)
            Text(spacedCode).font(.system(size: 44, weight: .bold, design: .monospaced)).foregroundStyle(Look.ink).padding(.top, 16).frame(minHeight: 56).accessibilityIdentifier("pair-code")
            Spacer()
            Button("Cancel") { model.backFromLevel() }
                .font(.system(size: 17, weight: .medium)).foregroundStyle(Look.link).frame(minHeight: 56)
                .accessibilityIdentifier("cancel")
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Look.bg.ignoresSafeArea())
    }
}

// MARK: the page

struct PageScreen: View {
    @ObservedObject var model: AppModel

    var body: some View {
        ZStack {
            model.topColor.ignoresSafeArea()
            PageView(bridge: model.bridge).ignoresSafeArea()
            if let reason = model.offline {
                VStack(spacing: 14) {
                    Text("Can't reach").font(.system(size: 22, weight: .bold)).foregroundStyle(Look.ink)
                    Text(reason).font(.system(size: 15)).foregroundStyle(Look.muted).multilineTextAlignment(.center)
                    Text(model.connectionLine).font(.system(size: 13)).foregroundStyle(Look.muted).multilineTextAlignment(.center)
                    Button("Try again") { model.retryPage() }
                        .font(.system(size: 17, weight: .semibold)).foregroundStyle(.white).padding(.horizontal, 28).frame(minHeight: 48)
                        .background(Look.accent, in: Capsule())
                }
                .padding(24)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Look.bg.ignoresSafeArea())
            }
        }
        .preferredColorScheme(CssLight.isLight(model.topColor) ? .light : .dark)
        .confirmationDialog("Forget this phone?", isPresented: $model.askForget, titleVisibility: .visible) {
            Button("Forget this phone", role: .destructive) { model.forgetCurrent() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This company's pairing is removed from this phone. Remove the phone on the PC (Settings › Devices) as well.")
        }
        .confirmationDialog("Send your newest screenshot?", isPresented: $model.confirmShot, titleVisibility: .visible) {
            Button("Send screenshot") { Task { await QuickCenter.handle(.screenshot) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("A link asked Autark to send the newest screenshot of your photos to " + (QuickCenter.lastChat?.title ?? "your last chat") + ".")
        }
        .confirmationDialog("Which PC?", isPresented: $model.choosingPc, titleVisibility: .visible) {
            ForEach(model.pcChoices) { choice in
                Button((choice.current ? "✓ " : "") + choice.name + (choice.online ? "" : " (offline)")) { model.pick(choice) }
            }
            Button("Cancel", role: .cancel) {}
        }
    }
}

enum CssLight {
    /// True when dark status bar icons read better on this colour.
    static func isLight(_ color: Color) -> Bool {
        let ui = UIColor(color)
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        ui.getRed(&r, green: &g, blue: &b, alpha: &a)
        let argb = UInt32(r * 255) << 16 | UInt32(g * 255) << 8 | UInt32(b * 255) | 0xFF000000
        return CssColor.isLight(argb)
    }
}

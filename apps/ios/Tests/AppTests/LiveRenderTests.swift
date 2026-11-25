// Wave 2: the Live Activity's views (Lock Screen banner, Dynamic Island compact / minimal / expanded) and the Lock Screen widgets,
// rendered to PNG with SwiftUI's ImageRenderer in the simulator – the app's own views as the widget extension shows them, NOT a picture
// of the system's Lock Screen or island (the island's black shapes here are drawn by LiveIslandPreview). The pictures go to
// AUTARK_SNAPSHOT_DIR (CI artefact "ios-screenshots") and into the test result. Also: the -AutarkLiveDemo samples and the shared
// model's quick links.
import SwiftUI
import XCTest
@testable import Autark
import AutarkCore

@MainActor
final class LiveRenderTests: XCTestCase {
    private func save<V: View>(_ view: V, name: String) throws {
        let renderer = ImageRenderer(content: view)
        renderer.scale = 3
        let image = try XCTUnwrap(renderer.uiImage, "ImageRenderer gave no image for \(name)")
        XCTAssertGreaterThan(image.size.width, 10)
        XCTAssertGreaterThan(image.size.height, 10)
        let png = try XCTUnwrap(image.pngData())
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["AUTARK_SNAPSHOT_DIR"], !folder.isEmpty {
            try? FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
            try png.write(to: URL(fileURLWithPath: folder).appendingPathComponent(name + ".png"))
        }
    }

    /// A Lock Screen-like backdrop (a wallpaper gradient) around a banner card, as iOS puts the activity under the notifications.
    private func lockScreen(_ state: LiveState) -> some View {
        LiveLockView(state: state)
            .foregroundStyle(.white)
            .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(Color.black.opacity(0.55)))
            .frame(width: 370)
            .padding(12)
            .background(LinearGradient(colors: [Color(red: 0.16, green: 0.22, blue: 0.45), Color(red: 0.45, green: 0.25, blue: 0.55)], startPoint: .top, endPoint: .bottom))
            .environment(\.colorScheme, .dark)
    }

    func testLockScreenBanners() throws {
        for kind in ["working", "asking", "buttons", "paused", "ended"] {
            try save(lockScreen(LiveController.demo(kind, now: 0)), name: "w2-lock-\(kind)-rendered")
        }
    }

    func testDynamicIsland() throws {
        for kind in ["working", "asking", "buttons", "paused"] {
            let state = LiveController.demo(kind, now: 0)
            try save(LiveIslandPreview(state: state, shape: .compact).background(Color.white), name: "w2-island-compact-\(kind)-rendered")
            try save(LiveIslandPreview(state: state, shape: .expanded).background(Color.white), name: "w2-island-expanded-\(kind)-rendered")
        }
        try save(LiveIslandPreview(state: LiveController.demo("asking", now: 0), shape: .minimal).background(Color.white), name: "w2-island-minimal-rendered")
    }

    func testLockScreenWidgets() throws {
        try save(AccessoryCircularView().foregroundStyle(.white).frame(width: 72, height: 72).padding(12).background(Color.black).environment(\.colorScheme, .dark),
                 name: "w2-widget-circular-rendered")
        try save(AccessoryRectangularView().foregroundStyle(.white).frame(width: 170, height: 76).padding(12).background(Color.black).environment(\.colorScheme, .dark),
                 name: "w2-widget-rectangular-rendered")
    }

    func testDemoSamplesKeepTheContract() {
        XCTAssertEqual(LiveController.demo("asking", now: 5).json["state"] as? String, "asking")
        XCTAssertEqual(LiveController.demo("buttons", now: 5).buttons, ["Mo 9:00", "Di 14:30", "Später"])
        XCTAssertEqual(LiveController.demo("paused", now: 5).state, .paused)
        XCTAssertEqual(LiveController.demo("other", now: 5).state, .working)
        XCTAssertEqual(LiveLook.rows(["a", "b", "c", "d", "e"], per: 4), [["a", "b", "c", "d"], ["e", "✕"]])
    }

    func testTheActivityAttributesCarryTheContractState() throws {
        let state = LiveController.demo("asking", now: 1_766_345_678_901)
        let data = try JSONEncoder().encode(state)
        let back = try JSONDecoder().decode(AutarkAgentActivityAttributes.ContentState.self, from: data)
        XCTAssertEqual(back, state)
        XCTAssertEqual(String(describing: AutarkAgentActivityAttributes.self), "AutarkAgentActivityAttributes", "the PC's push-to-start names this type (attributes-type)")
    }
}

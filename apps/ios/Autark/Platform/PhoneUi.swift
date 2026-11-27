// Owns: the app's own phone interface on the iPhone – where its files are (the `ui` folder in the app bundle, built by
// Tools/build-ui.sh from apps/desktop's esbuild output, with the unsigned ui.json beside the files), where the signed, fetched
// ones live (Application Support/AutarkUi: lists/ and blobs/, UiUpdate's store), how a newer list is looked for (UiUpdate over
// URLSession, at most once a minute, off the main thread) and the one UiFiles the entrances answer the interface requests from.
// The same as Android's PhoneUi + UiUpdate.java's HTTP part; the rules: docs/ARCHITECTURE.md §8.
// Never: reads the interface from a PC, runs a look on the main thread, or lets one that fails change what the app shows.
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import AutarkCore

/// The interface the app was built with: <app bundle>/ui/<path>.
final class BundleUi: UiSource {
    private let root: URL?

    init(root: URL? = Bundle.main.resourceURL?.appendingPathComponent("ui", isDirectory: true)) { self.root = root }

    /// True when this build carries an interface (its index.html is there).
    var available: Bool { read("index.html") != nil }

    func read(_ path: String) -> Bytes? {
        guard let root = root, UiFiles.safe(path), let data = FileManager.default.contents(atPath: root.appendingPathComponent(path).path) else { return nil }
        return Bytes(data)
    }

    func pageStarts() {}
}

/// The published files over HTTPS: each one is downloaded to a temporary file, then read from it in pieces (UiUpdate checks size and hash).
final class URLSessionUiNet: UiNet {
    private let base: String
    private let session: URLSession

    init(base: String = UiUpdate.base, session: URLSession = URLSession(configuration: .ephemeral)) {
        self.base = base
        self.session = session
    }

    func open(_ name: String) throws -> UiStream {
        guard let url = URL(string: base + name) else { throw AutarkError("The interface address is wrong.") }
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let done = DispatchSemaphore(value: 0)
        let box = Download()
        let task = session.downloadTask(with: request) { location, response, error in
            box.status = (response as? HTTPURLResponse)?.statusCode ?? 0
            box.failure = error
            if let location = location {
                let keep = FileManager.default.temporaryDirectory.appendingPathComponent("autark-ui-" + UUID().uuidString)
                if (try? FileManager.default.moveItem(at: location, to: keep)) != nil { box.file = keep } // the system removes `location` on return
            }
            done.signal()
        }
        task.resume()
        done.wait()
        guard let file = box.file, box.status == 200 else {
            if let file = box.file { try? FileManager.default.removeItem(at: file) }
            throw box.failure ?? AutarkError("\(name): HTTP \(box.status)")
        }
        do { return try FileStream(file) } catch { try? FileManager.default.removeItem(at: file); throw error }
    }

    private final class Download {
        var status = 0
        var failure: Error?
        var file: URL?
    }

    private final class FileStream: UiStream {
        private let handle: FileHandle
        private let file: URL

        init(_ file: URL) throws {
            self.file = file
            handle = try FileHandle(forReadingFrom: file)
        }

        func read(max: Int) throws -> Bytes { Bytes(try handle.read(upToCount: max) ?? Data()) }

        func close() {
            try? handle.close()
            try? FileManager.default.removeItem(at: file)
        }
    }
}

/// The app's interface store, its entrance answer and its look for a newer list.
final class PhoneUi {
    static let shared = PhoneUi()

    let source: BundleUi
    let store: UiUpdate
    let files: UiFiles
    private let net: UiNet
    private let queue = DispatchQueue(label: "autark-ui-update", qos: .utility)

    /// `shipped` is the app's interface, `dir` the fetched files' folder, `keys` the raw public keys (none: no look).
    init(shipped: BundleUi = BundleUi(), dir: URL = PhoneUi.folder(), net: UiNet = URLSessionUiNet(), keys: [Bytes] = UiUpdate.decodedKeys()) {
        source = shipped
        self.net = net
        store = UiUpdate(dir: dir, shipped: shipped, keys: keys)
        files = UiFiles(source: store)
    }

    /// Application Support/AutarkUi, left out of the backup (it is fetched again).
    static func folder() -> URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
        var dir = support.appendingPathComponent("AutarkUi", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        #if os(iOS) || os(macOS)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? dir.setResourceValues(values)
        #endif
        return dir
    }

    /// The app came to the front: look for a newer interface (UiUpdate keeps it to one look a minute).
    func resumed() {
        let store = self.store, net = self.net
        queue.async { _ = store.check(net: net, now: Int64(Date().timeIntervalSince1970 * 1000)) }
    }

    /// True when a newer interface with other files is ready than the page that runs.
    var reloadDue: Bool { store.reloadDue }
}

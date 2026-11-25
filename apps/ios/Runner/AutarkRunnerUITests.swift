// Punkt 17 – the Autark runner: a UI test that does not test anything. The PC starts it through go-ios (`ios runtest`, see
// RUNNER-DESIGN.md 4.2) with a fresh run token and port; it serves PROTOKOLL-RUNNER.md v1 on the iPhone's loopback until the PC
// says `end`, nobody authenticates for the idle time, five proofs were wrong, or iOS ends the test process. Our own design: no
// code, names or paths of any other runner.
import XCTest

final class AutarkRunnerUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        // A failed XCUI call becomes an error answer, never the end of the runner (and no failure screenshot).
        continueAfterFailure = true
    }

    /// XCTest's findings during an operation are the operation's error (RunnerIssues); outside one they count as usual.
    override func record(_ issue: XCTIssue) {
        if RunnerIssues.capture(issue.compactDescription) { return }
        super.record(issue)
    }

    @MainActor
    func testServe() throws {
        let env = ProcessInfo.processInfo.environment
        guard let token = RunnerWire.token(env["AUTARK_RUNNER_TOKEN"]) else {
            XCTFail("AUTARK_RUNNER_TOKEN is missing or not 64 hex characters: the runner does not serve without it.")
            return
        }
        guard let port = RunnerWire.port(env["AUTARK_RUNNER_PORT"]) else {
            XCTFail("AUTARK_RUNNER_PORT is missing or not 49152-65535: the runner does not pick a port of its own.")
            return
        }
        let diag = env["AUTARK_RUNNER_DIAG"] == "1"
        let ops = RunnerOps(diag: diag)
        let shared = ops.setup()
        let server = RunnerServer(token: token, port: port, idleSeconds: RunnerWire.idleSeconds(env["AUTARK_RUNNER_IDLE_S"]), ops: ops, shared: shared, diag: diag)
        server.start()
        // XCUIAutomation runs on the main thread: the server hands every operation here, this loop keeps the main queue turning.
        while !server.finished {
            _ = RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
        }
        if let failure = server.failure { XCTFail(failure) }
        print("AUTARK-RUNNER ended (\(server.reason))")
    }
}

/// Collects XCTest's findings while an operation runs (they become its error answer).
final class RunnerIssues {
    private static let lock = NSLock()
    private static var active = false
    private static var found = [String]()

    static func begin() {
        lock.lock(); defer { lock.unlock() }
        active = true
        found = []
    }

    /// Ends the collection; the first finding, if any.
    static func end() -> String? {
        lock.lock(); defer { lock.unlock() }
        active = false
        let first = found.first
        found = []
        return first
    }

    /// True when an operation is running and took the finding.
    static func capture(_ text: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard active else { return false }
        found.append(text)
        return true
    }
}

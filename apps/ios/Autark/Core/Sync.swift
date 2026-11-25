// Owns: the few thread helpers the relay core needs (the Java code used CompletableFuture, BlockingQueue and one daemon
// scheduler): a one-shot Future with a timeout, a blocking queue, a locked box and `later`. Plain Foundation, no
// concurrency features of Swift 6, so it builds the same on Apple platforms and on Linux.
// Never: holds a lock while it calls out.
import Foundation

/// A value or an error, delivered once to whoever waits (CompletableFuture).
public final class Future<T> {
    private let condition = NSCondition()
    private var result: Result<T, Error>?

    public init() {}

    public var isDone: Bool { condition.lock(); defer { condition.unlock() }; return result != nil }

    @discardableResult
    public func complete(_ value: T) -> Bool { finish(.success(value)) }

    @discardableResult
    public func fail(_ error: Error) -> Bool { finish(.failure(error)) }

    private func finish(_ value: Result<T, Error>) -> Bool {
        condition.lock(); defer { condition.unlock() }
        if result != nil { return false }
        result = value
        condition.broadcast()
        return true
    }

    /// The value; throws the failure, or AutarkError("timeout") when nothing came within `seconds`.
    public func get(timeout seconds: TimeInterval) throws -> T {
        let deadline = Date().addingTimeInterval(seconds)
        condition.lock(); defer { condition.unlock() }
        while result == nil {
            if !condition.wait(until: deadline) { break }
        }
        guard let result = result else { throw AutarkError("timeout") }
        return try result.get()
    }
}

/// A FIFO with blocking take/poll (LinkedBlockingQueue).
public final class BlockingQueue<T> {
    private let condition = NSCondition()
    private var items = [T]()

    public init() {}

    public func offer(_ item: T) {
        condition.lock()
        items.append(item)
        condition.signal()
        condition.unlock()
    }

    /// The next item, or nil when none arrived within `seconds`.
    public func poll(timeout seconds: TimeInterval) -> T? {
        let deadline = Date().addingTimeInterval(seconds)
        condition.lock(); defer { condition.unlock() }
        while items.isEmpty {
            if !condition.wait(until: deadline) { break }
        }
        return items.isEmpty ? nil : items.removeFirst()
    }

    public func take() -> T {
        condition.lock(); defer { condition.unlock() }
        while items.isEmpty { condition.wait() }
        return items.removeFirst()
    }
}

/// A value several threads read and write.
public final class Locked<T> {
    private let lock = NSLock()
    private var stored: T

    public init(_ value: T) { stored = value }

    public var value: T {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); stored = newValue; lock.unlock() }
    }

    @discardableResult
    public func with<R>(_ body: (inout T) -> R) -> R {
        lock.lock(); defer { lock.unlock() }
        return body(&stored)
    }
}

public enum Clock {
    /// Milliseconds since 1970.
    public static func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}

private let laterQueue = DispatchQueue(label: "autark-relay-later")

/// One-shot check later on one shared serial queue (RelayLink.LATER).
public func later(milliseconds: Int, _ work: @escaping () -> Void) {
    laterQueue.asyncAfter(deadline: .now() + .milliseconds(milliseconds), execute: work)
}

/// A thread of its own that never keeps the process alive (Java daemon threads).
public func spawn(_ name: String, _ work: @escaping () -> Void) {
    let thread = Thread(block: work)
    thread.name = name
    thread.stackSize = 512 * 1024
    thread.start()
}

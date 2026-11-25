// Owns: the finger's way of a `swipe` (PROTOKOLL-RUNNER.md 5.6) – how the runner carries out the PC's points: as a pointer path
// (every point at its time, seconds from touch-down) or, without that capability, as the straight line from the first to the last
// distinct point with the remaining time held; the screen check for every point; and the reference curve the PC sends (the shape
// of planMotion style "glide" in apps/desktop/src/shared/model/pointer-motion.ts: minimum-jerk speed on a faint Bézier arc),
// stretched to a given duration with at most 32 points – used by the tests and by anything on the iPhone that has to plan a swipe.
import Foundation

public enum RunnerSwipe {
    /// The straight-line fallback: touch down at `from`, move to `to` in `moveMs`, then hold `holdMs`. `pressMs` is how long the
    /// finger rests before it moves (the first points at the same place).
    public struct Line: Equatable {
        public var fromX: Double
        public var fromY: Double
        public var toX: Double
        public var toY: Double
        public var pressMs: Int
        public var moveMs: Int
        public var holdMs: Int

        /// Points per second for XCUICoordinate's drag; 0 when the finger does not move.
        public var velocity: Double {
            let distance = ((toX - fromX) * (toX - fromX) + (toY - fromY) * (toY - fromY)).squareRoot()
            guard distance > 0, moveMs > 0 else { return 0 }
            return distance / (Double(moveMs) / 1000)
        }
    }

    /// The line from the first to the last distinct point: its duration is the time at which the finger reaches the final place,
    /// the rest of the time it holds there.
    public static func line(_ points: [RunnerPoint]) -> Line {
        guard let first = points.first, let last = points.last else { return Line(fromX: 0, fromY: 0, toX: 0, toY: 0, pressMs: 0, moveMs: 0, holdMs: 0) }
        var arrive = points.count - 1
        while arrive > 0 && points[arrive - 1].x == last.x && points[arrive - 1].y == last.y { arrive -= 1 }
        var leave = 0
        while leave < points.count - 1 && points[leave + 1].x == first.x && points[leave + 1].y == first.y { leave += 1 }
        if arrive == 0 { // never moves: a press of the whole time
            return Line(fromX: first.x, fromY: first.y, toX: first.x, toY: first.y, pressMs: last.t, moveMs: 0, holdMs: 0)
        }
        let press = points[leave].t
        return Line(fromX: first.x, fromY: first.y, toX: last.x, toY: last.y, pressMs: press,
                    moveMs: max(1, points[arrive].t - press), holdMs: last.t - points[arrive].t)
    }

    /// The first point outside the screen, if any.
    public static func outside(_ points: [RunnerPoint], screen: RunnerScreen) -> RunnerPoint? {
        points.first { !screen.contains(x: $0.x, y: $0.y) }
    }

    /// Time offsets in seconds from touch-down, as the pointer path takes them.
    public static func offsets(_ points: [RunnerPoint]) -> [Double] { points.map { Double($0.t) / 1000 } }

    // MARK: the reference curve (glide)

    /// Minimum-jerk position profile 0 → 1 (zero speed at both ends).
    static func minJerk(_ tau: Double) -> Double {
        let t = min(1, max(0, tau))
        return t * t * t * (10 - 15 * t + 6 * t * t)
    }

    /// The finger's way from `from` to `to` in `durationMs`: touch-down at t 0, then points on a faint arc (3 % of the distance to
    /// the side, like the PC's glide) with minimum-jerk timing, the last exactly at `to` and `durationMs`; t rises strictly, at most
    /// `maxPoints` points (2…32), coordinates with one decimal.
    public static func glide(fromX: Double, fromY: Double, toX: Double, toY: Double, durationMs: Int, maxPoints: Int = 24) -> [RunnerPoint] {
        let count = min(RunnerWire.swipePointsMax, max(2, maxPoints))
        let total = max(count - 1, min(10_000, durationMs))
        let dx = toX - fromX, dy = toY - fromY
        let nx = -dy, ny = dx // perpendicular, its length is the distance
        let bend = 0.03
        let c1x = fromX + dx * 0.3 + nx * bend, c1y = fromY + dy * 0.3 + ny * bend
        let c2x = fromX + dx * 0.7 + nx * bend * 0.6, c2y = fromY + dy * 0.7 + ny * bend * 0.6
        var points = [RunnerPoint(x: RunnerScreen.round1(fromX), y: RunnerScreen.round1(fromY), t: 0)]
        let steps = count - 1
        for i in 1...steps {
            let t = Int((Double(total) * Double(i) / Double(steps)).rounded())
            let s = minJerk(Double(t) / Double(total))
            let u = 1 - s
            let w0 = u * u * u, w1 = 3 * u * u * s, w2 = 3 * u * s * s, w3 = s * s * s
            let x = w0 * fromX + w1 * c1x + w2 * c2x + w3 * toX
            let y = w0 * fromY + w1 * c1y + w2 * c2y + w3 * toY
            points.append(RunnerPoint(x: RunnerScreen.round1(x), y: RunnerScreen.round1(y), t: max(points[points.count - 1].t + 1, t)))
        }
        points[points.count - 1] = RunnerPoint(x: RunnerScreen.round1(toX), y: RunnerScreen.round1(toY), t: points[points.count - 1].t)
        return points
    }
}

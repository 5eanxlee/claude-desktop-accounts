import Foundation

struct AccountError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

// claude.ai's usage response: each bucket is { utilization: percent used, resets_at: ISO date }.
struct Usage: Equatable {
    struct Bucket: Equatable {
        let used: Double
        let resets: Date?
    }
    let fiveHour: Bucket?
    let week: Bucket?

    init(fiveHour: Bucket?, week: Bucket?) { self.fiveHour = fiveHour; self.week = week }

    init(data: Data) throws {
        guard let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw AccountError(message: "Claude did not return usage.")
        }
        fiveHour = Self.bucket(body["five_hour"])
        week = Self.bucket(body["seven_day"])
    }

    static func bucket(_ value: Any?) -> Bucket? {
        guard let object = value as? [String: Any], let number = object["utilization"] as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { return nil }
        return Bucket(used: min(100, max(0, number.doubleValue)), resets: (object["resets_at"] as? String).flatMap(date))
    }

    // resets_at can carry microseconds, which ISO8601DateFormatter does not accept.
    static func date(_ text: String) -> Date? {
        let trimmed = text.replacingOccurrences(of: #"\.\d+"#, with: "", options: .regularExpression)
        return ISO8601DateFormatter().date(from: trimmed)
    }

    static func percent(_ value: Double) -> String {
        if value == 0 || value == 100 { return "\(Int(value))%" }
        if value < 1 { return "<1%" }
        if value > 99 { return ">99%" }
        return "\(Int(value.rounded()))%"
    }

    var label: String {
        "5h \(fiveHour.map { Self.percent($0.used) } ?? "–") · week \(week.map { Self.percent($0.used) } ?? "–")"
    }

    var resetLabel: String {
        func when(_ date: Date?) -> String {
            date.map { DateFormatter.localizedString(from: $0, dateStyle: .short, timeStyle: .short) } ?? "unknown"
        }
        return "5-hour resets \(when(fiveHour?.resets)) · week resets \(when(week?.resets))"
    }
}

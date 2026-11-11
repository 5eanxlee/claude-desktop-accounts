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

    // Some plans have only a weekly limit: claude.ai then sends no five-hour bucket, and the
    // weekly one is shown on its own, without the "5h" and "week" names.
    var weeklyOnly: Bool { fiveHour == nil && week != nil }

    // Percent used, for places that show reset times separately.
    var label: String {
        switch (fiveHour, week) {
        case (nil, nil): return "No limits reported"
        case (nil, let week?): return Self.percent(week.used)
        case (let fiveHour?, nil): return "5h \(Self.percent(fiveHour.used))"
        case (let fiveHour?, let week?): return "5h \(Self.percent(fiveHour.used)) · week \(Self.percent(week.used))"
        }
    }

    // Percent used with each reset time, for a menu row.
    func menuLabel(now: Date = Date(), locale: Locale = .current, timeZone: TimeZone = .current) -> String {
        func part(_ name: String?, _ bucket: Bucket) -> String {
            let used = [name, Self.percent(bucket.used)].compactMap { $0 }.joined(separator: " ")
            return bucket.resets.map { "\(used), resets \(Self.when($0, now: now, locale: locale, timeZone: timeZone))" } ?? used
        }
        switch (fiveHour, week) {
        case (nil, nil): return label
        case (nil, let week?): return part(nil, week)
        case (let fiveHour?, nil): return part("5h", fiveHour)
        case (let fiveHour?, let week?): return part("5h", fiveHour) + " · " + part("week", week)
        }
    }

    // Reset times alone, for the line under an account in the window.
    func resetLabel(now: Date = Date(), locale: Locale = .current, timeZone: TimeZone = .current) -> String {
        func when(_ date: Date?) -> String { date.map { Self.when($0, now: now, locale: locale, timeZone: timeZone) } ?? "unknown" }
        switch (fiveHour, week) {
        case (nil, nil): return "claude.ai reported no usage limits"
        case (nil, let week?): return "Resets \(when(week.resets))"
        case (let fiveHour?, nil): return "5-hour resets \(when(fiveHour.resets))"
        case (let fiveHour?, let week?): return "5-hour resets \(when(fiveHour.resets)) · week resets \(when(week.resets))"
        }
    }

    // "6:30 PM" later today; "Fri, Nov 14, 10:00 AM" on another day.
    static func when(_ date: Date, now: Date, locale: Locale, timeZone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian); calendar.locale = locale; calendar.timeZone = timeZone
        let formatter = DateFormatter(); formatter.locale = locale; formatter.timeZone = timeZone
        let template = calendar.isDate(date, inSameDayAs: now) ? "jmm" : "EEEMMMdjmm"
        formatter.dateFormat = DateFormatter.dateFormat(fromTemplate: template, options: 0, locale: locale)
        return formatter.string(from: date)
    }
}

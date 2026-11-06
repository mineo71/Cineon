import Foundation
import SQLite3

nonisolated enum SQLValue: Sendable {
    case null
    case int(Int64)
    case real(Double)
    case text(String)
    case blob(Data)

    static func opt(_ v: String?) -> SQLValue { v.map(SQLValue.text) ?? .null }
    static func opt(_ v: Int?) -> SQLValue { v.map { .int(Int64($0)) } ?? .null }
    static func opt(_ v: Int64?) -> SQLValue { v.map(SQLValue.int) ?? .null }
    static func opt(_ v: Date?) -> SQLValue { v.map { .real($0.timeIntervalSince1970) } ?? .null }
    static func opt(_ v: URL?) -> SQLValue { v.map { .text($0.absoluteString) } ?? .null }
    static func opt(_ v: Data?) -> SQLValue { v.map(SQLValue.blob) ?? .null }
    static func date(_ v: Date) -> SQLValue { .real(v.timeIntervalSince1970) }
    static func bool(_ v: Bool) -> SQLValue { .int(v ? 1 : 0) }
}

nonisolated struct SQLError: Error, CustomStringConvertible {
    let message: String
    var description: String { message }
}

private nonisolated let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

/// Read-only view of the current result row.
nonisolated struct SQLRow {
    fileprivate let stmt: OpaquePointer

    func isNull(_ i: Int32) -> Bool { sqlite3_column_type(stmt, i) == SQLITE_NULL }
    func int(_ i: Int32) -> Int64 { sqlite3_column_int64(stmt, i) }
    func intValue(_ i: Int32) -> Int { Int(sqlite3_column_int64(stmt, i)) }
    func optInt(_ i: Int32) -> Int? { isNull(i) ? nil : intValue(i) }
    func bool(_ i: Int32) -> Bool { sqlite3_column_int64(stmt, i) != 0 }
    func real(_ i: Int32) -> Double { sqlite3_column_double(stmt, i) }

    func text(_ i: Int32) -> String {
        guard let c = sqlite3_column_text(stmt, i) else { return "" }
        return String(cString: c)
    }

    func optText(_ i: Int32) -> String? { isNull(i) ? nil : text(i) }
    func date(_ i: Int32) -> Date { Date(timeIntervalSince1970: real(i)) }
    func optDate(_ i: Int32) -> Date? { isNull(i) ? nil : date(i) }
    func optURL(_ i: Int32) -> URL? { optText(i).flatMap(URL.init(string:)) }

    func optBlob(_ i: Int32) -> Data? {
        guard !isNull(i), let bytes = sqlite3_column_blob(stmt, i) else { return nil }
        return Data(bytes: bytes, count: Int(sqlite3_column_bytes(stmt, i)))
    }
}

/// Minimal SQLite wrapper with a prepared statement cache. A connection belongs to one thread at a
/// time: the app's database stays on the main actor, where small WAL queries take under a
/// millisecond, and the browser importer opens its own in the background.
nonisolated final class SQLiteDB: @unchecked Sendable {
    private var db: OpaquePointer?
    private var statements: [String: OpaquePointer] = [:]

    init(path: String) throws {
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOMUTEX
        guard sqlite3_open_v2(path, &db, flags, nil) == SQLITE_OK else {
            let message = db.map { String(cString: sqlite3_errmsg($0)) } ?? "could not open database"
            sqlite3_close(db)
            throw SQLError(message: message)
        }
        try exec("PRAGMA journal_mode=WAL")
        try exec("PRAGMA synchronous=NORMAL")
        try exec("PRAGMA foreign_keys=ON")
        try exec("PRAGMA temp_store=MEMORY")
        sqlite3_busy_timeout(db, 2000)
    }

    deinit { close() }

    func close() {
        for stmt in statements.values { sqlite3_finalize(stmt) }
        statements.removeAll()
        if let db { sqlite3_close_v2(db) }
        db = nil
    }

    func exec(_ sql: String) throws {
        var error: UnsafeMutablePointer<CChar>?
        guard sqlite3_exec(db, sql, nil, nil, &error) == SQLITE_OK else {
            let message = error.map { String(cString: $0) } ?? "exec failed"
            sqlite3_free(error)
            throw SQLError(message: "\(message) in: \(sql.prefix(120))")
        }
    }

    private func prepare(_ sql: String) throws -> OpaquePointer {
        if let cached = statements[sql] {
            sqlite3_reset(cached)
            sqlite3_clear_bindings(cached)
            return cached
        }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
            throw SQLError(message: "\(String(cString: sqlite3_errmsg(db))) in: \(sql.prefix(120))")
        }
        statements[sql] = stmt
        return stmt
    }

    private func bind(_ stmt: OpaquePointer, _ args: [SQLValue]) {
        for (offset, value) in args.enumerated() {
            let i = Int32(offset + 1)
            switch value {
            case .null: sqlite3_bind_null(stmt, i)
            case .int(let v): sqlite3_bind_int64(stmt, i, v)
            case .real(let v): sqlite3_bind_double(stmt, i, v)
            case .text(let v): sqlite3_bind_text(stmt, i, v, -1, transient)
            case .blob(let v):
                _ = v.withUnsafeBytes { sqlite3_bind_blob(stmt, i, $0.baseAddress, Int32(v.count), transient) }
            }
        }
    }

    @discardableResult
    func run(_ sql: String, _ args: [SQLValue] = []) throws -> Int64 {
        let stmt = try prepare(sql)
        defer { sqlite3_reset(stmt) }
        bind(stmt, args)
        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw SQLError(message: "\(String(cString: sqlite3_errmsg(db))) in: \(sql.prefix(120))")
        }
        return sqlite3_last_insert_rowid(db)
    }

    func query<T>(_ sql: String, _ args: [SQLValue] = [], _ map: (SQLRow) -> T) throws -> [T] {
        let stmt = try prepare(sql)
        defer { sqlite3_reset(stmt) }
        bind(stmt, args)
        var rows: [T] = []
        while true {
            let code = sqlite3_step(stmt)
            if code == SQLITE_ROW {
                rows.append(map(SQLRow(stmt: stmt)))
            } else if code == SQLITE_DONE {
                return rows
            } else {
                throw SQLError(message: "\(String(cString: sqlite3_errmsg(db))) in: \(sql.prefix(120))")
            }
        }
    }

    func transaction(_ body: () throws -> Void) throws {
        try exec("BEGIN IMMEDIATE")
        do {
            try body()
            try exec("COMMIT")
        } catch {
            try? exec("ROLLBACK")
            throw error
        }
    }

    var userVersion: Int {
        (try? query("PRAGMA user_version") { $0.intValue(0) }.first) ?? 0
    }
}

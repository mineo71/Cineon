using System.Text;
using Microsoft.Data.Sqlite;

namespace Cineon.Core.Data;

// Port of Cineon/Core/SQLite.swift on Microsoft.Data.Sqlite.

/// <summary>A value bound to a <c>?</c> in a statement. Converts implicitly from the types the database stores.</summary>
public readonly struct SqlValue
{
    internal object? Value { get; }

    private SqlValue(object? value) => Value = value;

    public static readonly SqlValue Null = default;

    public static implicit operator SqlValue(long v) => new(v);
    public static implicit operator SqlValue(long? v) => new(v);
    public static implicit operator SqlValue(int v) => new((long)v);
    public static implicit operator SqlValue(int? v) => new(v.HasValue ? (long)v.Value : null);
    public static implicit operator SqlValue(double v) => new(v);
    public static implicit operator SqlValue(double? v) => new(v);
    /// <summary>Booleans are INTEGER 0 or 1.</summary>
    public static implicit operator SqlValue(bool v) => new(v ? 1L : 0L);
    public static implicit operator SqlValue(string? v) => new(v);
    public static implicit operator SqlValue(byte[]? v) => new(v);
    /// <summary>Dates are REAL seconds since 1970, like the Mac.</summary>
    public static implicit operator SqlValue(DateTimeOffset v) => new(StoredDate.ToUnix(v));
    public static implicit operator SqlValue(DateTimeOffset? v) => new(v.HasValue ? StoredDate.ToUnix(v.Value) : null);
    /// <summary>Addresses are TEXT, exactly as written.</summary>
    public static implicit operator SqlValue(Uri? v) => new(v?.OriginalString);
}

public sealed class SqlError(string message, Exception? inner = null) : Exception(message, inner);

/// <summary>Read-only view of the current result row. Reading a NULL gives 0, 0.0 or "", like the C API.</summary>
public readonly struct SqlRow
{
    private readonly SqliteDataReader _reader;

    internal SqlRow(SqliteDataReader reader) => _reader = reader;

    public bool IsNull(int i) => _reader.IsDBNull(i);
    public long Int(int i) => IsNull(i) ? 0 : _reader.GetInt64(i);
    public int IntValue(int i) => (int)Int(i);
    public int? OptInt(int i) => IsNull(i) ? null : IntValue(i);
    public bool Bool(int i) => Int(i) != 0;
    public double Real(int i) => IsNull(i) ? 0 : _reader.GetDouble(i);
    public string Text(int i) => IsNull(i) ? "" : _reader.GetString(i);
    public string? OptText(int i) => IsNull(i) ? null : Text(i);
    public DateTimeOffset Date(int i) => StoredDate.FromUnix(Real(i));
    public DateTimeOffset? OptDate(int i) => IsNull(i) ? null : Date(i);
    public Uri? OptUrl(int i) => Urls.Parse(OptText(i));

    /// <summary>Null for NULL and for an empty blob, like <c>sqlite3_column_blob</c>.</summary>
    public byte[]? OptBlob(int i)
    {
        if (IsNull(i)) return null;
        var bytes = _reader.GetFieldValue<byte[]>(i);
        return bytes.Length == 0 ? null : bytes;
    }
}

/// <summary>
/// Minimal SQLite wrapper with a prepared statement cache. Statements use <c>?</c> placeholders,
/// bound in order. Calls are serialised with a lock, so a stray background call can't interleave
/// with a transaction; the app still keeps its database on the UI thread, like the Mac.
/// </summary>
public sealed class SqliteDb : IDisposable
{
    private SqliteConnection? _connection;
    private readonly Dictionary<string, SqliteCommand> _statements = [];
    private readonly Lock _gate = new();

    public string Path { get; }

    public SqliteDb(string path)
    {
        Path = path;
        var builder = new SqliteConnectionStringBuilder
        {
            DataSource = path,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Pooling = false,
            DefaultTimeout = 2,
        };
        var connection = new SqliteConnection(builder.ToString());
        try
        {
            connection.Open();
        }
        catch (SqliteException e)
        {
            connection.Dispose();
            throw new SqlError(e.Message, e);
        }
        _connection = connection;
        Exec("PRAGMA journal_mode=WAL");
        Exec("PRAGMA synchronous=NORMAL");
        Exec("PRAGMA foreign_keys=ON");
        Exec("PRAGMA temp_store=MEMORY");
        Exec("PRAGMA busy_timeout=2000");
    }

    public void Dispose() => Close();

    public void Close()
    {
        lock (_gate)
        {
            foreach (var statement in _statements.Values) statement.Dispose();
            _statements.Clear();
            _connection?.Dispose();
            _connection = null;
        }
    }

    private SqliteConnection Connection => _connection ?? throw new SqlError("The database is closed");

    /// <summary>Runs one or more statements with no arguments.</summary>
    public void Exec(string sql)
    {
        lock (_gate)
        {
            try
            {
                using var command = Connection.CreateCommand();
                command.CommandText = sql;
                command.ExecuteNonQuery();
            }
            catch (SqliteException e)
            {
                throw Error(e, sql);
            }
        }
    }

    /// <summary>Runs one statement. Returns the last inserted row ID, like the Mac.</summary>
    public long Run(string sql, params ReadOnlySpan<SqlValue> args)
    {
        lock (_gate)
        {
            try
            {
                var command = Prepare(sql, args);
                command.ExecuteNonQuery();
                var rowId = Prepare("SELECT last_insert_rowid()", []);
                return (long)(rowId.ExecuteScalar() ?? 0L);
            }
            catch (SqliteException e)
            {
                throw Error(e, sql);
            }
        }
    }

    public List<T> Query<T>(string sql, Func<SqlRow, T> map) => Query(sql, [], map);

    public List<T> Query<T>(string sql, ReadOnlySpan<SqlValue> args, Func<SqlRow, T> map)
    {
        lock (_gate)
        {
            try
            {
                var command = Prepare(sql, args);
                using var reader = command.ExecuteReader();
                var row = new SqlRow(reader);
                var rows = new List<T>();
                while (reader.Read()) rows.Add(map(row));
                return rows;
            }
            catch (SqliteException e)
            {
                throw Error(e, sql);
            }
        }
    }

    /// <summary>Runs the body inside <c>BEGIN IMMEDIATE</c> … <c>COMMIT</c>, rolling back if it throws.</summary>
    public void Transaction(Action body)
    {
        lock (_gate)
        {
            Exec("BEGIN IMMEDIATE");
            try
            {
                body();
                Exec("COMMIT");
            }
            catch
            {
                try { Exec("ROLLBACK"); } catch (SqlError) { }
                throw;
            }
        }
    }

    public int UserVersion
    {
        get
        {
            try
            {
                return Query("PRAGMA user_version", r => r.IntValue(0)).FirstOrDefault();
            }
            catch (SqlError)
            {
                return 0;
            }
        }
    }

    private SqliteCommand Prepare(string sql, ReadOnlySpan<SqlValue> args)
    {
        if (!_statements.TryGetValue(sql, out var command))
        {
            command = Connection.CreateCommand();
            command.CommandText = NumberPlaceholders(sql, out var count);
            for (var i = 1; i <= count; i++) command.Parameters.Add(new SqliteParameter { ParameterName = "$p" + i });
            _statements[sql] = command;
        }
        var parameters = command.Parameters;
        for (var i = 0; i < parameters.Count; i++)
        {
            // Unbound placeholders are NULL, as in the C API.
            var value = i < args.Length ? args[i].Value : null;
            var parameter = parameters[i];
            parameter.Value = value ?? DBNull.Value;
            parameter.SqliteType = value switch
            {
                long => SqliteType.Integer,
                double => SqliteType.Real,
                string => SqliteType.Text,
                byte[] => SqliteType.Blob,
                _ => SqliteType.Text,
            };
        }
        return command;
    }

    /// <summary>Microsoft.Data.Sqlite binds by name, so each <c>?</c> outside quotes becomes <c>$pN</c>.</summary>
    internal static string NumberPlaceholders(string sql, out int count)
    {
        count = 0;
        if (!sql.Contains('?')) return sql;
        var sb = new StringBuilder(sql.Length + 16);
        char? quote = null;
        foreach (var c in sql)
        {
            if (quote is not null)
            {
                if (c == quote) quote = null;
                sb.Append(c);
                continue;
            }
            switch (c)
            {
                case '\'' or '"' or '`':
                    quote = c;
                    sb.Append(c);
                    break;
                case '[':
                    quote = ']';
                    sb.Append(c);
                    break;
                case '?':
                    count++;
                    sb.Append("$p").Append(count);
                    break;
                default:
                    sb.Append(c);
                    break;
            }
        }
        return sb.ToString();
    }

    private static SqlError Error(SqliteException e, string sql) =>
        new($"{e.Message} in: {(sql.Length > 120 ? sql[..120] : sql)}", e);
}

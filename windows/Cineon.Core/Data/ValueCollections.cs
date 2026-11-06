using System.Collections;

namespace Cineon.Core.Data;

/// <summary>
/// An immutable list that compares by its contents, so records holding one keep Swift's value
/// semantics (<c>[String]</c> in a <c>Hashable</c> struct).
/// </summary>
internal sealed class ValueList<T> : IReadOnlyList<T>, IEquatable<ValueList<T>>
{
    public static readonly ValueList<T> Empty = new([]);

    private readonly T[] _items;

    private ValueList(T[] items) => _items = items;

    public static IReadOnlyList<T> Of(IEnumerable<T>? items) => items switch
    {
        null => Empty,
        ValueList<T> list => list,
        _ => items.Any() ? new ValueList<T>([.. items]) : Empty,
    };

    public T this[int index] => _items[index];
    public int Count => _items.Length;
    public IEnumerator<T> GetEnumerator() => ((IEnumerable<T>)_items).GetEnumerator();
    IEnumerator IEnumerable.GetEnumerator() => _items.GetEnumerator();

    public bool Equals(ValueList<T>? other) => other is not null && _items.AsSpan().SequenceEqual(other._items);
    public override bool Equals(object? obj) => obj is ValueList<T> other && Equals(other);

    public override int GetHashCode()
    {
        var hash = new HashCode();
        foreach (var item in _items) hash.Add(item);
        return hash.ToHashCode();
    }

    public override string ToString() => "[" + string.Join(", ", _items) + "]";
}

/// <summary>An immutable set that compares by its contents, like Swift's <c>Set</c>.</summary>
internal sealed class ValueSet<T> : IReadOnlySet<T>, IEquatable<ValueSet<T>>
{
    public static readonly ValueSet<T> Empty = new([]);

    private readonly HashSet<T> _items;

    private ValueSet(HashSet<T> items) => _items = items;

    public static IReadOnlySet<T> Of(IEnumerable<T>? items) => items switch
    {
        null => Empty,
        ValueSet<T> set => set,
        _ => new ValueSet<T>([.. items]),
    };

    public int Count => _items.Count;
    public bool Contains(T item) => _items.Contains(item);
    public IEnumerator<T> GetEnumerator() => _items.GetEnumerator();
    IEnumerator IEnumerable.GetEnumerator() => _items.GetEnumerator();
    public bool IsProperSubsetOf(IEnumerable<T> other) => _items.IsProperSubsetOf(other);
    public bool IsProperSupersetOf(IEnumerable<T> other) => _items.IsProperSupersetOf(other);
    public bool IsSubsetOf(IEnumerable<T> other) => _items.IsSubsetOf(other);
    public bool IsSupersetOf(IEnumerable<T> other) => _items.IsSupersetOf(other);
    public bool Overlaps(IEnumerable<T> other) => _items.Overlaps(other);
    public bool SetEquals(IEnumerable<T> other) => _items.SetEquals(other);

    public bool Equals(ValueSet<T>? other) => other is not null && _items.SetEquals(other._items);
    public override bool Equals(object? obj) => obj is ValueSet<T> other && Equals(other);

    public override int GetHashCode()
    {
        // Order-independent, like the set itself.
        var hash = 0;
        foreach (var item in _items) hash ^= item is null ? 0 : EqualityComparer<T>.Default.GetHashCode(item);
        return hash ^ _items.Count;
    }

    public override string ToString() => "[" + string.Join(", ", _items) + "]";
}

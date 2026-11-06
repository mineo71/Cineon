using System.Runtime.InteropServices;
using Cineon.Core.Data;

namespace Cineon.App.Services;

/// The taskbar and Start menu Jump List: Windows' place for what Siri and Shortcuts do on the Mac
/// (Cineon/App/Intents.swift). Each task launches Cineon with a `cineon://` link, which a running
/// copy picks up through SingleInstance.
///
/// WinRT's Windows.UI.StartScreen.JumpList needs package identity, which this unpackaged app doesn't
/// have, so this uses the shell's ICustomDestinationList, as Win32 apps do.
public static class JumpList
{
    /// The Mac's App Shortcuts, in the same order, plus Open Downloads.
    private static readonly (string Title, string Link)[] Tasks =
    [
        ("Continue Watching", "cineon://continue"),
        ("Play or Pause", "cineon://playpause"),
        ("Next Episode", "cineon://next"),
        ("Sleep Timer", "cineon://sleep?minutes=30"),
        ("Rate Films", "cineon://rate"),
        ("My Profile", "cineon://profile"),
        ("Open Downloads", "cineon://downloads"),
    ];

    /// Sets the tasks. Skipped for test runs, which mustn't change the installed app's list.
    public static void Install()
    {
        if (AppPaths.IsScratch || Environment.ProcessPath is not { } exe) return;
        try
        {
            var list = (ICustomDestinationList)Create(DestinationListClsid);
            var objectArray = typeof(IObjectArray).GUID;
            list.BeginList(out _, ref objectArray, out _);
            var tasks = (IObjectCollection)Create(EnumerableObjectCollectionClsid);
            foreach (var (title, link) in Tasks) tasks.AddObject(Link(exe, title, link));
            list.AddUserTasks((IObjectArray)tasks);
            list.CommitList();
        }
        catch (Exception error)
        {
            CrashLog.Write("jump list", error);
        }
    }

    private static IShellLinkW Link(string exe, string title, string arguments)
    {
        var link = (IShellLinkW)Create(ShellLinkClsid);
        link.SetPath(exe);
        link.SetArguments(arguments);
        link.SetIconLocation(exe, 0);
        link.SetDescription(title);
        var properties = (IPropertyStore)link;
        var key = TitleKey;
        var value = new PropVariant { Type = 31 /* VT_LPWSTR */, Pointer = Marshal.StringToCoTaskMemUni(title) };
        try
        {
            properties.SetValue(ref key, ref value);
            properties.Commit();
        }
        finally
        {
            Marshal.FreeCoTaskMem(value.Pointer);
        }
        return link;
    }

    private static object Create(Guid clsid) =>
        Activator.CreateInstance(Type.GetTypeFromCLSID(clsid, throwOnError: true)!)!;

    private static readonly Guid DestinationListClsid = new("77F10CF0-3DB5-4966-B520-B7C54FD35ED6");
    private static readonly Guid EnumerableObjectCollectionClsid = new("2D3468C1-36A7-43B6-AC24-D3F02FD9607A");
    private static readonly Guid ShellLinkClsid = new("00021401-0000-0000-C000-000000000046");

    /// PKEY_Title, the name a task shows.
    private static readonly PropertyKey TitleKey = new() { FormatId = new Guid("F29F85E0-4FF9-1068-AB91-08002B27B3D9"), PropertyId = 2 };

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    private struct PropertyKey
    {
        public Guid FormatId;
        public uint PropertyId;
    }

    /// A PROPVARIANT holding a string: 24 bytes on 64-bit Windows, the only kind Cineon ships for.
    [StructLayout(LayoutKind.Explicit, Size = 24)]
    private struct PropVariant
    {
        [FieldOffset(0)] public ushort Type;
        [FieldOffset(8)] public IntPtr Pointer;
    }

    [ComImport, Guid("6332DEBF-87B5-4670-90C0-5E57B408A49E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ICustomDestinationList
    {
        void SetAppID([MarshalAs(UnmanagedType.LPWStr)] string appId);
        void BeginList(out uint minSlots, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out object removed);
        void AppendCategory([MarshalAs(UnmanagedType.LPWStr)] string category, IObjectArray items);
        void AppendKnownCategory(int category);
        void AddUserTasks(IObjectArray tasks);
        void CommitList();
        void GetRemovedDestinations(ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out object removed);
        void DeleteList([MarshalAs(UnmanagedType.LPWStr)] string? appId);
        void AbortList();
    }

    [ComImport, Guid("92CA9DCD-5622-4BBA-A805-5E9F541BD8C9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IObjectArray
    {
        void GetCount(out uint count);
        void GetAt(uint index, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out object item);
    }

    [ComImport, Guid("5632B1A4-E38A-400A-928A-D4CD63230295"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IObjectCollection
    {
        // IObjectArray
        void GetCount(out uint count);
        void GetAt(uint index, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out object item);

        void AddObject([MarshalAs(UnmanagedType.Interface)] object item);
        void AddFromArray(IObjectArray source);
        void RemoveObjectAt(uint index);
        void Clear();
    }

    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellLinkW
    {
        void GetPath(IntPtr file, int size, IntPtr findData, uint flags);
        void GetIDList(out IntPtr idList);
        void SetIDList(IntPtr idList);
        void GetDescription(IntPtr name, int size);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetWorkingDirectory(IntPtr dir, int size);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string dir);
        void GetArguments(IntPtr args, int size);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
        void GetHotkey(out short hotkey);
        void SetHotkey(short hotkey);
        void GetShowCmd(out int showCmd);
        void SetShowCmd(int showCmd);
        void GetIconLocation(IntPtr iconPath, int size, out int icon);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string iconPath, int icon);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string relativePath, uint reserved);
        void Resolve(IntPtr window, uint flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string file);
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        void GetCount(out uint count);
        void GetAt(uint index, out PropertyKey key);
        void GetValue(ref PropertyKey key, out PropVariant value);
        void SetValue(ref PropertyKey key, ref PropVariant value);
        void Commit();
    }
}

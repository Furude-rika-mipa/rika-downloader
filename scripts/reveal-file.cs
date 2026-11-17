using System;
using System.IO;
using System.Runtime.InteropServices;
internal static class RevealFile
{
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHParseDisplayName(string name, IntPtr bindingContext, out IntPtr pidl, uint attributes, out uint attributesOut);
    [DllImport("shell32.dll")]
    private static extern int SHOpenFolderAndSelectItems(IntPtr folder, uint count, IntPtr children, uint flags);
    [DllImport("ole32.dll")]
    private static extern void CoTaskMemFree(IntPtr pointer);
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length != 1 || !File.Exists(args[0])) return 2;
        IntPtr pidl = IntPtr.Zero; uint attributes;
        try {
            if (SHParseDisplayName(Path.GetFullPath(args[0]), IntPtr.Zero, out pidl, 0, out attributes) != 0 || pidl == IntPtr.Zero) return 3;
            return SHOpenFolderAndSelectItems(pidl, 0, IntPtr.Zero, 0) == 0 ? 0 : 4;
        } catch { return 5; }
        finally { if (pidl != IntPtr.Zero) CoTaskMemFree(pidl); }
    }
}

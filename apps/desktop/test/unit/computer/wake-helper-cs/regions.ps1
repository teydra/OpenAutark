# Where does a process's private memory (commit charge) sit? Walks the address space with VirtualQueryEx and sums committed
# private pages and writable image pages, by kind (heap/stack/other private, image per module). Diagnostic for measure.mjs --regions;
# prints Markdown, never any content of the process. regions.ps1 -ProcessId <pid>
param([Parameter(Mandatory)][int]$ProcessId)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class Regions
{
    [StructLayout(LayoutKind.Sequential)] struct MBI { public IntPtr BaseAddress, AllocationBase; public uint AllocationProtect; public IntPtr RegionSize; public uint State, Protect, Type; }
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] static extern IntPtr VirtualQueryEx(IntPtr h, IntPtr address, out MBI info, IntPtr length);
    [DllImport("psapi.dll", CharSet = CharSet.Unicode)] static extern uint GetMappedFileName(IntPtr h, IntPtr address, StringBuilder name, uint size);
    public static string Run(int pid)
    {
        IntPtr h = OpenProcess(0x0400 | 0x0010, false, pid);
        if (h == IntPtr.Zero) return "cannot open process";
        long privateCommitted = 0, imageWritable = 0, mapped = 0;
        var perImage = new Dictionary<string, long>();
        var big = new List<string>();
        var bySize = new SortedDictionary<string, long>();
        long address = 0;
        MBI info;
        while (VirtualQueryEx(h, (IntPtr)address, out info, (IntPtr)Marshal.SizeOf(typeof(MBI))) != IntPtr.Zero)
        {
            long size = (long)info.RegionSize;
            if (info.State == 0x1000)
            {
                bool writable = (info.Protect & (0x04 | 0x08 | 0x40 | 0x80)) != 0;
                if (info.Type == 0x20000) { privateCommitted += size; if (size >= 512 * 1024) big.Add("0x" + ((long)info.BaseAddress).ToString("x") + " " + size / 1024 + " KB prot 0x" + info.Protect.ToString("x")); string k = size >= 1048576 ? ">=1MB" : size >= 262144 ? "256K-1MB" : size >= 65536 ? "64K-256K" : "<64K"; long v; bySize.TryGetValue(k, out v); bySize[k] = v + size; }
                else if (info.Type == 0x1000000 && writable)
                {
                    imageWritable += size;
                    var name = new StringBuilder(260);
                    string n = GetMappedFileName(h, info.BaseAddress, name, 260) > 0 ? name.ToString() : "?";
                    n = n.Substring(n.LastIndexOf('\\') + 1);
                    long v; perImage.TryGetValue(n, out v); perImage[n] = v + size;
                }
                else if (info.Type == 0x40000) mapped += size;
            }
            address = (long)info.BaseAddress + size;
            if (address <= 0 || address > 0x7FFFFFFEFFFF) break;
        }
        CloseHandle(h);
        var sb = new StringBuilder();
        sb.AppendLine("Private committed (MEM_PRIVATE): " + privateCommitted / 1024 + " KB; writable image pages: " + imageWritable / 1024 + " KB; mapped: " + mapped / 1024 + " KB");
        sb.AppendLine("Private by region size: " + string.Join(", ", new List<string>(Conv(bySize))));
        sb.AppendLine("Private regions of 512 KB or more: " + (big.Count == 0 ? "none" : string.Join("; ", big)));
        var list = new List<KeyValuePair<string, long>>(perImage);
        list.Sort((a, b) => b.Value.CompareTo(a.Value));
        var top = new List<string>();
        for (int i = 0; i < list.Count && i < 14; i++) top.Add(list[i].Key + " " + list[i].Value / 1024 + " KB");
        sb.AppendLine("Writable image pages by module: " + string.Join(", ", top));
        return sb.ToString();
    }
    static IEnumerable<string> Conv(SortedDictionary<string, long> d) { foreach (var p in d) yield return p.Key + " " + p.Value / 1024 + " KB"; }
}
'@
"``````"
[Regions]::Run($ProcessId)
"``````"

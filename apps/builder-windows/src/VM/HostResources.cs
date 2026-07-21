using System;
using System.Runtime.InteropServices;

namespace Flagship.Builder.VM;

/// <summary>
/// A snapshot of the host machine's capacity, used by the pure VM planning
/// math. Tests pass explicit values; the app uses Current().
/// Mirrors apps/builder-mac FlagshipBuilderCore/VM/HostResources.swift.
/// </summary>
public sealed record HostResources(int CpuCount, ulong MemoryBytes)
{
    /// <summary>
    /// The live host. The only non-deterministic entry point — everything
    /// downstream is a pure function of this value.
    /// </summary>
    public static HostResources Current()
        => new(Environment.ProcessorCount, PhysicalMemoryBytes());

    private static ulong PhysicalMemoryBytes()
    {
        if (OperatingSystem.IsWindows())
        {
            var status = new MEMORYSTATUSEX { dwLength = (uint)Marshal.SizeOf<MEMORYSTATUSEX>() };
            if (GlobalMemoryStatusEx(ref status)) return status.ullTotalPhys;
        }
        // Non-Windows (tests on CI): the GC's view of available memory is the
        // closest portable stand-in.
        return (ulong)GC.GetGCMemoryInfo().TotalAvailableMemoryBytes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MEMORYSTATUSEX
    {
        public uint dwLength;
        public uint dwMemoryLoad;
        public ulong ullTotalPhys;
        public ulong ullAvailPhys;
        public ulong ullTotalPageFile;
        public ulong ullAvailPageFile;
        public ulong ullTotalVirtual;
        public ulong ullAvailVirtual;
        public ulong ullAvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX lpBuffer);
}

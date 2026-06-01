using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Flagship.Burner;

/// <summary>
/// Native raw-disk write for Windows — the analogue of apps/burner-mac
/// DiskWrite.swift (which unmounts the disk's volumes then streams to
/// /dev/rdiskN). On Windows the equivalent dance is:
///
///   1. Find every mounted volume that lives on the target \\.\PhysicalDriveN
///      (via IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS).
///   2. Open each such \\.\X: volume and issue FSCTL_LOCK_VOLUME +
///      FSCTL_DISMOUNT_VOLUME — without this the raw PhysicalDrive write is
///      refused (sharing violation) or silently corrupted by the FS cache.
///   3. Open \\.\PhysicalDriveN for write, stream the prepared image in
///      SECTOR-ALIGNED blocks (the final short block is zero-padded to the
///      sector size — same rule as the macOS writer), flush, then unlock +
///      close the held volume handles.
///
/// The app ships a `requireAdministrator` manifest, so the CreateFile opens
/// succeed without a second UAC prompt (same posture as Rufus / balenaEtcher).
/// </summary>
[SupportedOSPlatform("windows")]
public static class DiskWrite
{
    public sealed class DiskWriteException : Exception
    {
        public DiskWriteException(string message) : base(message) { }
        public DiskWriteException(string message, Exception inner) : base(message, inner) { }
    }

    /// <summary>
    /// Write <paramref name="imagePath"/> to <paramref name="devicePath"/>
    /// (e.g. "\\.\PhysicalDrive2"), reporting a 0…1 fraction roughly once per
    /// percent. Must run elevated.
    /// </summary>
    public static void Write(string imagePath, string devicePath, Action<double> progress, int sectorSize = 512)
    {
        long size;
        try { size = new FileInfo(imagePath).Length; }
        catch { size = 0; }
        if (size < 1024) throw new DiskWriteException($"Image too small ({size} bytes); refusing to write.");
        if (!LooksLikePhysicalDrive(devicePath))
            throw new DiskWriteException($"Refusing non-PhysicalDrive device: {devicePath}");

        int driveNumber = ParseDriveNumber(devicePath);
        if (driveNumber < 0)
            throw new DiskWriteException($"Could not parse a drive number from {devicePath}.");
        if (driveNumber == 0)
            throw new DiskWriteException(@"Refusing \\.\PhysicalDrive0 (the Windows system disk).");

        // A mounted disk can't be opened for raw write — lock + dismount its
        // volumes and hold the handles open for the duration of the write.
        var heldVolumes = new List<SafeFileHandleWin>();
        try
        {
            LockAndDismountVolumesOn(driveNumber, heldVolumes);

            using var device = OpenDevice(devicePath, write: true);
            // Some drivers require the raw target to be dismounted as well;
            // best-effort (ignore failure — the per-volume dismount above is
            // the load-bearing one).
            TryFsctl(device, FSCTL_DISMOUNT_VOLUME);

            using var input = new FileStream(imagePath, FileMode.Open, FileAccess.Read, FileShare.Read);

            long written = 0;
            int lastPct = -1;
            const int chunkSize = 1024 * 1024;
            byte[] buf = new byte[chunkSize];
            while (true)
            {
                int read = input.Read(buf, 0, chunkSize);
                if (read <= 0) break;
                // Raw block-device writes must be sector-aligned. Full 1 MiB
                // chunks are aligned; only the FINAL short chunk can be partial
                // (e.g. a personalized ISO = base + ~1 KB trailer). Pad it with
                // zeros to the next sector. The box finds the trailer by the ISO
                // volume size, not the device end, so trailing zeros are
                // harmless — and without this, WriteFile fails with
                // ERROR_INVALID_PARAMETER on the unbuffered handle.
                int toWrite = read;
                int rem = read % sectorSize;
                if (rem != 0)
                {
                    int padded = read + (sectorSize - rem);
                    Array.Clear(buf, read, padded - read);
                    toWrite = padded;
                }
                WriteAll(device, buf, toWrite);
                written += read;
                int pct = (int)((double)written / size * 100);
                if (pct != lastPct)
                {
                    lastPct = pct;
                    progress(Math.Min(1.0, (double)written / size));
                }
            }
            if (!FlushFileBuffers(device))
                throw new DiskWriteException("FlushFileBuffers failed: " + new Win32Exception(Marshal.GetLastWin32Error()).Message);
            progress(1.0);
        }
        finally
        {
            // Unlock + release every held volume handle (closing the handle
            // implicitly unlocks, but be explicit so the FS remounts promptly).
            foreach (var h in heldVolumes)
            {
                try { TryFsctl(h, FSCTL_UNLOCK_VOLUME); } catch { /* ignore */ }
                h.Dispose();
            }
        }
    }

    // ---- volume discovery + lock/dismount ----

    /// <summary>
    /// Find every \\.\X: whose extents land on PhysicalDriveN, open it, and
    /// LOCK + DISMOUNT it. Handles are appended to <paramref name="held"/> so
    /// the caller keeps them open for the write and unlocks afterward.
    /// </summary>
    private static void LockAndDismountVolumesOn(int driveNumber, List<SafeFileHandleWin> held)
    {
        foreach (char letter in EnumerateDriveLetters())
        {
            string volPath = $@"\\.\{letter}:";
            SafeFileHandleWin? vol = null;
            try
            {
                vol = OpenDevice(volPath, write: true, allowMissing: true);
                if (vol == null || vol.IsInvalid) { vol?.Dispose(); continue; }
                if (!VolumeIsOnDrive(vol, driveNumber)) { vol.Dispose(); continue; }

                if (!TryFsctl(vol, FSCTL_LOCK_VOLUME))
                {
                    // Couldn't lock — something has the volume open. Surface a
                    // clear, actionable error rather than corrupting it.
                    int err = Marshal.GetLastWin32Error();
                    vol.Dispose();
                    throw new DiskWriteException(
                        $"Couldn't lock {letter}: — close any Explorer windows / programs using the drive and retry. " +
                        $"(Win32 {err})");
                }
                TryFsctl(vol, FSCTL_DISMOUNT_VOLUME);
                held.Add(vol);
                vol = null; // ownership transferred to `held`
            }
            catch (DiskWriteException)
            {
                throw;
            }
            catch
            {
                vol?.Dispose();
                // Non-fatal for a single letter (could be a CD-ROM, network
                // drive, etc.) — keep scanning the rest.
            }
        }
    }

    /// <summary>
    /// True if the open volume handle's disk extents include
    /// <paramref name="driveNumber"/> (IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS).
    /// </summary>
    private static bool VolumeIsOnDrive(SafeFileHandleWin vol, int driveNumber)
    {
        // VOLUME_DISK_EXTENTS: u32 NumberOfDiskExtents, then N DISK_EXTENT
        // { u32 DiskNumber; (4 pad); i64 StartingOffset; i64 ExtentLength }.
        // 8 + N*24. Allocate generously for spanned volumes.
        int bufSize = 8 + 24 * 16;
        IntPtr buffer = Marshal.AllocHGlobal(bufSize);
        try
        {
            if (!DeviceIoControl(vol, IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS,
                    IntPtr.Zero, 0, buffer, (uint)bufSize, out _, IntPtr.Zero))
            {
                return false;
            }
            int count = Marshal.ReadInt32(buffer, 0);
            for (int i = 0; i < count; i++)
            {
                // Each DISK_EXTENT starts 8 bytes in, 24 bytes apart; DiskNumber
                // is the first 4 bytes of the extent.
                int extentBase = 8 + i * 24;
                if (extentBase + 4 > bufSize) break;
                int diskNumber = Marshal.ReadInt32(buffer, extentBase);
                if (diskNumber == driveNumber) return true;
            }
            return false;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static IEnumerable<char> EnumerateDriveLetters()
    {
        uint mask = GetLogicalDrives();
        if (mask == 0) yield break;
        for (int i = 0; i < 26; i++)
        {
            if ((mask & (1u << i)) != 0) yield return (char)('A' + i);
        }
    }

    // ---- low-level helpers ----

    private static SafeFileHandleWin OpenDevice(string path, bool write, bool allowMissing = false)
    {
        uint access = GENERIC_READ | (write ? GENERIC_WRITE : 0u);
        var handle = CreateFile(
            path,
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            IntPtr.Zero,
            OPEN_EXISTING,
            FILE_FLAG_NO_BUFFERING | FILE_FLAG_WRITE_THROUGH,
            IntPtr.Zero);
        if (handle.IsInvalid)
        {
            int err = Marshal.GetLastWin32Error();
            if (allowMissing) return handle;
            string why = err == 5
                ? "permission denied — run the burner as Administrator"
                : new Win32Exception(err).Message;
            handle.Dispose();
            throw new DiskWriteException($"Can't open {path}: {why}");
        }
        return handle;
    }

    private static bool TryFsctl(SafeFileHandleWin h, uint code)
        => DeviceIoControl(h, code, IntPtr.Zero, 0, IntPtr.Zero, 0, out _, IntPtr.Zero);

    private static void WriteAll(SafeFileHandleWin device, byte[] buffer, int count)
    {
        int offset = 0;
        while (offset < count)
        {
            if (!WriteFile(device, buffer, count - offset, out int wrote, IntPtr.Zero, offset))
            {
                int err = Marshal.GetLastWin32Error();
                throw new DiskWriteException("Write to device failed: " + new Win32Exception(err).Message);
            }
            if (wrote <= 0)
                throw new DiskWriteException("Write to device returned 0 bytes (out of space or removed?).");
            offset += wrote;
        }
    }

    public static bool LooksLikePhysicalDrive(string devicePath)
        => !string.IsNullOrEmpty(devicePath)
           && devicePath.StartsWith(@"\\.\PhysicalDrive", StringComparison.OrdinalIgnoreCase);

    public static int ParseDriveNumber(string devicePath)
    {
        const string prefix = @"\\.\PhysicalDrive";
        if (!devicePath.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return -1;
        var rest = devicePath.Substring(prefix.Length);
        return int.TryParse(rest, out var n) ? n : -1;
    }

    // ---- P/Invoke surface ----

    private const uint GENERIC_READ = 0x80000000;
    private const uint GENERIC_WRITE = 0x40000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_FLAG_WRITE_THROUGH = 0x80000000;
    private const uint FILE_FLAG_NO_BUFFERING = 0x20000000;

    // CTL_CODE(FILE_DEVICE_FILE_SYSTEM=0x09, fn, METHOD_BUFFERED=0, FILE_ANY_ACCESS=0)
    private const uint FSCTL_LOCK_VOLUME = (0x00000009 << 16) | (6 << 2);     // 0x00090018
    private const uint FSCTL_UNLOCK_VOLUME = (0x00000009 << 16) | (7 << 2);   // 0x0009001C
    private const uint FSCTL_DISMOUNT_VOLUME = (0x00000009 << 16) | (8 << 2); // 0x00090020
    // CTL_CODE(IOCTL_VOLUME_BASE=0x00000056, 0, METHOD_BUFFERED, FILE_ANY_ACCESS)
    private const uint IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS = (0x00000056 << 16) | (0 << 2); // 0x00560000

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern SafeFileHandleWin CreateFile(
        string lpFileName, uint dwDesiredAccess, uint dwShareMode,
        IntPtr lpSecurityAttributes, uint dwCreationDisposition,
        uint dwFlagsAndAttributes, IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeviceIoControl(
        SafeFileHandleWin hDevice, uint dwIoControlCode,
        IntPtr lpInBuffer, uint nInBufferSize,
        IntPtr lpOutBuffer, uint nOutBufferSize,
        out uint lpBytesReturned, IntPtr lpOverlapped);

    // Offset-aware WriteFile via a managed buffer slice (we pass the slice start
    // through the buffer pointer using a pinned overload below).
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern unsafe bool WriteFile(
        SafeFileHandleWin hFile, byte* lpBuffer, int nNumberOfBytesToWrite,
        out int lpNumberOfBytesWritten, IntPtr lpOverlapped);

    private static unsafe bool WriteFile(SafeFileHandleWin h, byte[] buffer, int count, out int wrote, IntPtr overlapped, int bufferOffset)
    {
        fixed (byte* p = buffer)
        {
            return WriteFile(h, p + bufferOffset, count, out wrote, overlapped);
        }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FlushFileBuffers(SafeFileHandleWin hFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetLogicalDrives();
}

/// <summary>
/// Tiny SafeHandle for the raw device handles. We keep it local (rather than
/// taking a dependency on Microsoft.Win32.SafeHandles' SafeFileHandle in the
/// P/Invoke signatures) so the marshaller closes the handle deterministically
/// on Dispose, which is what unlocks a locked volume.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class SafeFileHandleWin : Microsoft.Win32.SafeHandles.SafeHandleZeroOrMinusOneIsInvalid
{
    public SafeFileHandleWin() : base(ownsHandle: true) { }

    protected override bool ReleaseHandle() => CloseHandle(handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr hObject);
}

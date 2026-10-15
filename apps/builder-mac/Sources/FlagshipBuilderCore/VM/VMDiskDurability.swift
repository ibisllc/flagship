import Foundation

/// How a hosted server's writable disk is attached, pinned in the shared
/// vm-core-vectors.json "diskDurability" section with the QEMU ports' policy.
/// The default caching mode (`.automatic`) has left Linux guests with zeroed
/// and corrupt files (home2's ext4 oopses on zeroed pages, leticia's zeroed
/// system libraries, both surviving reinstalls); `.cached` with full
/// synchronization keeps the host's own cache coherent and makes every guest
/// flush reach the host's disk.
public enum VMDiskDurability {
    public enum CachingMode: String { case automatic, cached, uncached }
    public enum SynchronizationMode: String { case full, fsync, none }

    public static let cachingMode: CachingMode = .cached
    public static let synchronizationMode: SynchronizationMode = .full
}

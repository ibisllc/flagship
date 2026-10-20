/// Whether a signed "update required" notice may lock the app. Off in release builds until the
/// lock is fit to ship: a signed lock then shows the update banner only. (The boot-unlock writes
/// are already exempt from the lock, `UpdateLock.isBootUnlock`; a live run on a locked phone has
/// still to prove that before this is switched on.) Debug builds keep the lock so the gym can
/// exercise it.
public enum SecurityNoticeFeatures {
    #if DEBUG
    public static let lockEnabled = true
    #else
    public static let lockEnabled = false
    #endif
}

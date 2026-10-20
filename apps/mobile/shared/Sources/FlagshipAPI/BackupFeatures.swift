/// Backup choices that are built but not offered yet. Peer backup (encrypted pieces on other
/// accounts' servers) stays off until a live cross-account restore has passed; a server already
/// on it keeps showing it. The box refuses the choice too (`FLAGSHIP_PEER_BACKUP`).
public enum BackupFeatures {
    public static let peerBackup = false
}

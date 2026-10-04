import Darwin

/// Whether a new agent screen may be added now. Checked when a create
/// request arrives and again right before the display is made: the display
/// work in between can wait (DisplayWork), and another request may have
/// taken the name or the last slot, or the owner may have exited, meanwhile.
public enum AgentScreenAdmission {
    /// Why a screen named `name` may not be added beside `existing`, or nil if it may.
    public static func failure(name: String, existing: [String], limit: Int, ownerPID: pid_t?,
                               ownerAlive: (pid_t) -> Bool = { kill($0, 0) == 0 || errno != ESRCH }) -> String? {
        guard existing.count < limit else { return "at most \(limit) agent screens can exist at once" }
        guard !name.isEmpty, !existing.contains(name), name != "2ndscreen" else {
            return "a screen named \"\(name)\" already exists"
        }
        if let ownerPID, !ownerAlive(ownerPID) { return "owner pid \(ownerPID) is not running" }
        return nil
    }
}

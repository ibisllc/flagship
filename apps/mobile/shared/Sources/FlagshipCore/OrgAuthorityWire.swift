import Foundation

/// JSON (JSONSerialization objects) into the org authority types, as `.com` serves them and the
/// vectors hold them. Shapes mirror `packages/protocol/src/orgAuthority.ts`.
public enum OrgAuthorityWire {
    static func bad(_ what: String) -> OrgAuthorityError { OrgAuthorityError("malformed", what) }
    static func str(_ o: [String: Any], _ k: String) throws -> String { guard let s = o[k] as? String else { throw bad(k) }; return s }
    static func num(_ o: [String: Any], _ k: String) throws -> Int64 { guard let n = OrgAuthority.i64(o[k]) else { throw bad(k) }; return n }
    static func int(_ o: [String: Any], _ k: String) throws -> Int { Int(try num(o, k)) }
    /// `custody`: absent or "hardware" = hardware, "browser" = browser; anything else is refused.
    static func custody(_ o: [String: Any]) throws -> OrgCustody {
        guard let v = o["custody"], !(v is NSNull) else { return .hardware }
        guard let s = v as? String, let c = OrgCustody(rawValue: s) else { throw bad("custody") }
        return c
    }
    static func obj(_ v: Any?, _ what: String) throws -> [String: Any] { guard let o = v as? [String: Any] else { throw bad(what) }; return o }

    public static func binding(_ v: Any?) throws -> PqKeyBindingWire {
        do { return try PqTrust.pqKeyBindingFromWire(v) } catch let e as PqTrustError { throw OrgAuthorityError("binding", e.code) }
    }

    public static func approvals(_ v: Any?) throws -> [OrgApproval] {
        guard let a = v as? [Any] else { throw bad("approvals") }
        return try a.map { try OrgAuthority.approvalFromWire($0) }
    }

    public static func record(_ v: Any?) throws -> OrgAuthorityRecord {
        let o = try obj(v, "record")
        guard let admins = o["admins"] as? [Any] else { throw bad("admins") }
        let b = try obj(o["bylaws"], "bylaws")
        let seats: [String]?
        if let s = b["overturnSeats"] as? String, s == "*" { seats = nil } else if let s = b["overturnSeats"] as? [String] { seats = s } else { throw bad("overturnSeats") }
        return OrgAuthorityRecord(
            orgId: try str(o, "orgId"), version: try num(o, "version"), prevHash: try str(o, "prevHash"),
            admins: try admins.map { a in
                let e = try obj(a, "admin")
                guard let kind = OrgAdminKind(rawValue: try str(e, "kind")) else { throw bad("kind") }
                return OrgAdminEntry(seatId: try str(e, "seatId"), kind: kind, binding: try binding(e["binding"]), custody: try custody(e))
            },
            bylaws: OrgBylaws(overturnSeats: seats, overturnK: try int(b, "overturnK"), vetoK: try int(b, "vetoK"),
                              hardwareAdmins: try hardwareAdmins(b), quorumHardware: try quorumHardware(b)),
            founderSeatId: try str(o, "founderSeatId"), kGov: try int(o, "kGov"), kGrant: try int(o, "kGrant"),
            kDestroy: try int(o, "kDestroy"), kSite: try int(o, "kSite"), issuedAt: try num(o, "issuedAt"))
    }

    static func hardwareAdmins(_ b: [String: Any]) throws -> Bool {
        guard let v = b["adminCustody"], !(v is NSNull) else { return false }
        guard let s = v as? String, s == "any" || s == "hardware" else { throw OrgAuthorityError("bylaws", "adminCustody") }
        return s == "hardware"
    }

    static func quorumHardware(_ b: [String: Any]) throws -> Bool {
        guard let v = b["quorumHardware"], !(v is NSNull) else { return true }
        guard let n = v as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { throw OrgAuthorityError("bylaws", "quorumHardware") }
        return n.boolValue
    }

    public static func entry(_ v: Any?) throws -> OrgAuthorityEntry {
        let o = try obj(v, "entry")
        var notice: OrgSigned<OrgDelayedChange>?
        if let n = o["notice"] as? [String: Any] {
            let b = try obj(n["body"], "notice")
            notice = OrgSigned(body: OrgDelayedChange(orgId: try str(b, "orgId"), oarVersion: try num(b, "oarVersion"), kind: try str(b, "kind"),
                                                      nextRecordSha256: try str(b, "nextRecordSha256"), effectiveAt: try num(b, "effectiveAt"),
                                                      issuedAt: try num(b, "issuedAt")),
                               approvals: try approvals(n["approvals"]))
        }
        return OrgAuthorityEntry(record: try record(o["record"]), via: try str(o, "via"), approvals: try approvals(o["approvals"]),
                                 notice: notice, overturnOf: OrgAuthority.i64(o["overturnOf"]))
    }

    public static func freeze(_ v: Any?) throws -> OrgSigned<OrgSeatFreeze> {
        let o = try obj(v, "freeze"), b = try obj(o["body"], "freeze")
        return OrgSigned(body: OrgSeatFreeze(orgId: try str(b, "orgId"), seatId: try str(b, "seatId"), untilMs: try num(b, "untilMs"),
                                             oarVersion: try num(b, "oarVersion"), issuedAt: try num(b, "issuedAt")),
                         approvals: try approvals(o["approvals"]))
    }

    public static func overturn(_ v: Any?) throws -> OrgSigned<OrgOverturn> {
        let o = try obj(v, "overturn"), b = try obj(o["body"], "overturn")
        return OrgSigned(body: OrgOverturn(orgId: try str(b, "orgId"), freezeSha256: try str(b, "freezeSha256"),
                                           oarVersion: try num(b, "oarVersion"), issuedAt: try num(b, "issuedAt")),
                         approvals: try approvals(o["approvals"]))
    }

    /// `.com`'s observed open time of each delayed-change notice (`noticeOpenedAt`); anything malformed is left out.
    public static func noticeOpenedAt(_ v: Any?) -> [String: Int64] {
        guard let o = v as? [String: Any] else { return [:] }
        var out: [String: Int64] = [:]
        for (k, x) in o where k.utf8.count == 64 && PqBin.isLowerHex(k) {
            if let t = OrgAuthority.i64(x), t >= 0 { out[k] = t }
        }
        return out
    }

    public static func veto(_ v: Any?) throws -> OrgSigned<OrgVeto> {
        let o = try obj(v, "veto"), b = try obj(o["body"], "veto")
        return OrgSigned(body: OrgVeto(orgId: try str(b, "orgId"), noticeSha256: try str(b, "noticeSha256"), issuedAt: try num(b, "issuedAt")),
                         approvals: try approvals(o["approvals"]))
    }

    public static func roles(_ v: Any?) throws -> [OrgSeatRole] {
        guard let a = v as? [Any] else { throw bad("roles") }
        return try a.map { r in
            let o = try obj(r, "role")
            switch try str(o, "role") {
            case "member": return .member
            case "servers-add": return .serversAdd
            case "server-admin":
                if let s = o["servers"] as? String, s == "*" { return .serverAdmin(servers: nil) }
                guard let s = o["servers"] as? [String] else { throw bad("servers") }
                return .serverAdmin(servers: s)
            case "service-admin": guard let s = o["apps"] as? [String] else { throw bad("apps") }; return .serviceAdmin(apps: s)
            case "unlock": guard let s = o["servers"] as? [String] else { throw bad("servers") }; return .unlock(servers: s)
            default: throw bad("role")
            }
        }
    }

    public static func rolesJSON(_ roles: [OrgSeatRole]) -> [[String: Any]] {
        roles.map {
            switch $0 {
            case .member: return ["role": "member"]
            case .serversAdd: return ["role": "servers-add"]
            case .serverAdmin(let s): return ["role": "server-admin", "servers": s.map { $0 as Any } ?? "*"]
            case .serviceAdmin(let a): return ["role": "service-admin", "apps": a]
            case .unlock(let s): return ["role": "unlock", "servers": s]
            }
        }
    }

    public static func grantBundle(_ v: Any?) throws -> OrgSeatGrantBundle {
        let o = try obj(v, "grant bundle"), g = try obj(o["grant"], "grant")
        let grant = OrgSeatGrant(orgId: try str(g, "orgId"), seatId: try str(g, "seatId"), labelSha256: try str(g, "labelSha256"),
                                 memberKeyId: try str(g, "memberKeyId"), adminKeyId: try str(g, "adminKeyId"), rolesHash: try str(g, "rolesHash"),
                                 oarVersion: try num(g, "oarVersion"), issuedAt: try num(g, "issuedAt"), expiresAt: try num(g, "expiresAt"),
                                 custody: try custody(g))
        let admin: PqKeyBindingWire? = o["adminBinding"] is NSNull || o["adminBinding"] == nil ? nil : try binding(o["adminBinding"])
        return OrgSeatGrantBundle(grant: grant, roles: try roles(o["roles"]), memberBinding: try binding(o["memberBinding"]),
                                  adminBinding: admin, approvals: try approvals(o["approvals"]))
    }

    public static func revokeBundle(_ v: Any?) throws -> OrgSeatRevokeBundle {
        let o = try obj(v, "revoke bundle"), r = try obj(o["revoke"], "revoke")
        return OrgSeatRevokeBundle(orgId: try str(r, "orgId"), seatId: try str(r, "seatId"), reason: try str(r, "reason"),
                                   oarVersion: try num(r, "oarVersion"), issuedAt: try num(r, "issuedAt"),
                                   approvals: try approvals(o["approvals"]), selfSignature: o["selfSignature"] as? String)
    }

    public static func action(_ v: Any?) throws -> OrgAction {
        let o = try obj(v, "action")
        switch try str(o, "kind") {
        case "seat-grant": return .seatGrant(roles: try roles(o["roles"]))
        case "seat-invite": return .seatInvite
        case "seat-revoke": return .seatRevoke
        case "freeze": return .freeze
        case "add-server": return .addServer
        case "destroy": return .destroy
        case "site": return .site
        case "operate": return .operate(server: try str(o, "server"))
        case "app-admin": return .appAdmin(server: try str(o, "server"), serviceRef: try str(o, "serviceRef"))
        default: throw bad("action")
        }
    }
}

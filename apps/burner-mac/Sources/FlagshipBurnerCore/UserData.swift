import Foundation

/// cloud-init autoinstall user-data generator (pure-Swift port of
/// packages/flagship-burner userdata.ts). The verified recipe JSON is
/// embedded base64 verbatim (no re-serialization, so it can't drop fields),
/// and a first-boot bootstrap clones the daemon and registers the server.

public enum UserDataError: LocalizedError, Equatable {
    case unsafeGitRef(String)
    case badRepo(String)
    case badBootHost(String)

    public var errorDescription: String? {
        switch self {
        case .unsafeGitRef(let r): return "Refusing to embed unsafe git ref: \(r)"
        case .badRepo(let r): return "Repo URL must be https://, got: \(r)"
        case .badBootHost(let h): return "bootHost must be https://, got: \(h)"
        }
    }
}

public enum UserData {
    public static let defaultRepoURL = "https://github.com/ibisllc/flagship.git"

    /// The dedicated boot worker (boot.flagshipserver.com). The box's boot-stage
    /// hits its identity-gated /api/boot/* contract for the LUKS unlock; baked to
    /// /boot/flagship-boot-host. Enterprise clones override via the bootHost arg.
    /// Identical to userdata.ts DEFAULT_BOOT_HOST.
    public static let defaultBootHost = "https://boot.flagshipserver.com"

    /// Strip trailing slashes + require https://, mirroring userdata.ts
    /// resolveBootstrapInputs' bootHost normalization.
    static func resolveBootHost(_ raw: String) throws -> String {
        var h = raw
        while h.hasSuffix("/") { h.removeLast() }
        guard h.hasPrefix("https://") else { throw UserDataError.badBootHost(raw) }
        return h
    }

    /// Build the autoinstall user-data. `recipeJSON` is the raw, already-
    /// verified recipe bytes (embedded as the install-blob the daemon reads).
    ///
    /// `encryptRoot` is the locked DEFAULT (true). Every burn produces a
    /// LUKS-encrypted, phone-gated box — EXPERIMENTAL, needs live validation
    /// (brick risk on first boot). encryptRoot:false is an INTERNAL debug
    /// escape only (not exposed in the GUI): it reproduces the proven
    /// unencrypted path byte-for-byte. Mirrors packages/flagship-burner
    /// userdata.ts buildAutoinstallUserData.
    public static func autoinstallYAML(recipeJSON: Data,
                                       installerGitRef: String,
                                       repoURL: String = defaultRepoURL,
                                       encryptRoot: Bool = true,
                                       bootUnlockMode: String = "auto",
                                       bootHost: String = defaultBootHost,
                                       wifiSSID: String? = nil,
                                       wifiPassword: String? = nil,
                                       debugMode: Bool = false) throws -> String {
        let trimmed = installerGitRef.trimmingCharacters(in: .whitespacesAndNewlines)
        let ref = trimmed.isEmpty ? "main" : trimmed
        guard ref.range(of: "^[A-Za-z0-9._/-]+$", options: .regularExpression) != nil else {
            throw UserDataError.unsafeGitRef(ref)
        }
        guard repoURL.hasPrefix("https://") else { throw UserDataError.badRepo(repoURL) }
        let host = try resolveBootHost(bootHost)

        // Boot-unlock policy (docs/security-phone-as-unlock-endpoint.md §7a.1).
        // Only "approve" is the critical-server path; anything else ⇒ "auto".
        let mode = bootUnlockMode == "approve" ? "approve" : "auto"
        // Write the FLAT canonical blob (top-level serverDomain/username/
        // phoneDelegatedPubKey + nested authCode) — the box bootstrap reads those
        // top-level. The .com/website hand out the envelope { blob:{…},
        // blobSignature }; normalizeEnvelope flattens it (no-op for an already-flat
        // recipe). Matches the TS burner's installBlobToJson output.
        let blobB64 = RecipeLoader.normalizeEnvelope(recipeJSON).base64EncodedString()
        let bootstrapB64 = Data(bootstrapScript(ref: ref, repoURL: repoURL, encryptRoot: encryptRoot, bootUnlockMode: mode, bootHost: host,
                                                wifiSSID: wifiSSID, wifiPassword: wifiPassword, debugMode: debugMode).utf8)
            .base64EncodedString()
        // Emitted only when encryptRoot is on; "" keeps the default path
        // byte-identical (subiquity falls back to its whole-disk layout).
        let storageBlock = encryptRoot ? luksStorageBlock() : ""
        // Pairs with storage.grub.update_nvram:false (luksStorageBlock): since we
        // skip the EFI NVRAM entry, copy curtin's SIGNED shim+grub to the
        // removable /EFI/BOOT/BOOTX64.EFI fallback path, which firmware boots
        // with no NVRAM entry (and stays Secure-Boot-valid — same signed bytes).
        let efiFallbackBlock = encryptRoot
            ? "    - curtin in-target --target=/target -- bash -c 'D=/boot/efi/EFI; mkdir -p \"$D/BOOT\"; cp \"$D/ubuntu/shimx64.efi\" \"$D/BOOT/BOOTX64.EFI\"; cp \"$D/ubuntu/grubx64.efi\" \"$D/BOOT/grubx64.efi\"; cp \"$D/ubuntu/mmx64.efi\" \"$D/BOOT/\" 2>/dev/null; true'\n"
            : ""
        // Wi-Fi is a burn-time local input (NOT part of the signed recipe).
        // networkd REJECTS `match:` for wifis (only ethernet supports it), so we
        // cannot bake a Wi-Fi glob — the interface name isn't known at burn time.
        // Instead: (1) the `network:` key carries only the optional wired
        // fallback (ethernet match IS allowed), and (2) an early-command (live
        // installer, so the install can download) plus a late-command (writes to
        // /target, so first boot is online) detect the real wifi interface NAME
        // at runtime and write its netplan. Empty SSID ⇒ all "" → a wired burn
        // is byte-identical to before.
        let ssid = (wifiSSID ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let hasWifi = !ssid.isEmpty
        let wifiScript64 = hasWifi
            ? Data(wifiSetupScript(ssid: ssid, password: wifiPassword ?? "").utf8).base64EncodedString()
            : ""
        let networkBlock = hasWifi ? wifiEthernetBlock() : ""
        let earlyCommandsBlock = hasWifi
            ? "  early-commands:\n    - \"echo \(wifiScript64) | base64 -d > /tmp/flagship-wifi.sh && bash /tmp/flagship-wifi.sh\"\n"
            : ""
        let wifiLateCommandBlock = hasWifi
            ? "    - \"echo \(wifiScript64) | base64 -d > /tmp/flagship-wifi.sh && bash /tmp/flagship-wifi.sh /target\"\n"
            : ""
        // The target needs wpasupplicant or networkd can't drive the radio on
        // the first real boot (when registration + the daemon come up). Only
        // added on the Wi-Fi path so wired burns stay byte-identical.
        let wifiPackagesBlock = hasWifi ? "    - wpasupplicant\n" : ""

        return """
        #cloud-config
        # Flagship Assembler — autoinstall user-data
        # Generated at burn time. Don't edit by hand.
        autoinstall:
          version: 1
          debconf-selections: |
            grub-pc grub2/update_nvram boolean false
            grub-efi-amd64 grub2/update_nvram boolean false
        \(networkBlock)\(earlyCommandsBlock)  identity:
            hostname: flagship-pod
            username: flagship
            password: "$6$saltsaltsaltsaltsalt$Fz2j0/yjeyqQsRGfQ2DGRrXyMz9.6CljgPwQ3UlqOPLqo4kVZk.zhztOQS9rdshOMu7w5WL9.bjvKR7vCs71y0"
          ssh:
            install-server: true
            allow-pw: false
          packages:
            - git
            - curl
            - jq
            - ca-certificates
            - xxd
            - cryptsetup
            - lvm2
            - gnupg
        \(wifiPackagesBlock)\(storageBlock)  late-commands:
        \(efiFallbackBlock)\(wifiLateCommandBlock)    - curtin in-target --target=/target -- bash -c 'mkdir -p /var/flagship && echo "\(blobB64)" | base64 -d > /var/flagship/install-blob.json && chmod 600 /var/flagship/install-blob.json'
            - curtin in-target --target=/target -- bash -c 'echo "\(bootstrapB64)" | base64 -d > /usr/local/sbin/flagship-bootstrap.sh && chmod +x /usr/local/sbin/flagship-bootstrap.sh'
            - curtin in-target --target=/target -- /usr/local/sbin/flagship-bootstrap.sh

        """
    }

    // MARK: - Debian (debian-installer / d-i) preseed

    /// Build the Debian d-i preseed.cfg — the twin of autoinstallYAML, for the
    /// debian path. Pure-Swift port of packages/flagship-burner preseed.ts
    /// buildDebianPreseed. The recipe is embedded base64 verbatim and the SAME
    /// first-boot bootstrap runs (family:"debian" only adapts the LVM-on-LUKS
    /// unlock). WHY Debian exists: its installer can be preseeded to force GRUB
    /// to the EFI removable-media path, so it installs on firmware that rejects
    /// NVRAM boot-entry writes — the class of box subiquity fatally aborts on.
    public static func debianPreseed(recipeJSON: Data,
                                     installerGitRef: String,
                                     repoURL: String = defaultRepoURL,
                                     encryptRoot: Bool = true,
                                     bootUnlockMode: String = "auto",
                                     bootHost: String = defaultBootHost,
                                     wifiSSID: String? = nil,
                                     wifiPassword: String? = nil,
                                     debugMode: Bool = false) throws -> String {
        let trimmed = installerGitRef.trimmingCharacters(in: .whitespacesAndNewlines)
        let ref = trimmed.isEmpty ? "main" : trimmed
        guard ref.range(of: "^[A-Za-z0-9._/-]+$", options: .regularExpression) != nil else {
            throw UserDataError.unsafeGitRef(ref)
        }
        guard repoURL.hasPrefix("https://") else { throw UserDataError.badRepo(repoURL) }
        let host = try resolveBootHost(bootHost)
        let mode = bootUnlockMode == "approve" ? "approve" : "auto"
        // Write the FLAT canonical blob (top-level serverDomain/username/
        // phoneDelegatedPubKey + nested authCode) — the box bootstrap reads those
        // top-level. The .com/website hand out the envelope { blob:{…},
        // blobSignature }; normalizeEnvelope flattens it (no-op for an already-flat
        // recipe). Matches the TS burner's installBlobToJson output.
        let blobB64 = RecipeLoader.normalizeEnvelope(recipeJSON).base64EncodedString()
        let bootstrapB64 = Data(
            bootstrapScript(ref: ref, repoURL: repoURL, encryptRoot: encryptRoot, bootUnlockMode: mode, bootHost: host, family: "debian",
                            wifiSSID: wifiSSID, wifiPassword: wifiPassword, debugMode: debugMode).utf8
        ).base64EncodedString()

        // Phone-home beacons → the canonical order-status channel. The serial is
        // known at generation time; we inline it (never parse the blob at runtime
        // in early_command), sanitized to an injection-proof set so it sits
        // unquoted in the URL. PUBLIC correlation hint only (serial in URL) — no
        // secrets — best-effort. Each rung maps to ONE canonical ProvisionStatus
        // phase: earliest hook = `booting`, partman = `partitioning`, late = the
        // mirror/blob fetch = `downloading`. Mirrors preseed.ts.
        let beaconSerial = beaconFields(recipeJSON).serial
        let earlyBeacon = debianBeaconCommand(phase: "booting", serial: beaconSerial)
        let lateBeacon = debianBeaconCommand(phase: "downloading", serial: beaconSerial)
        // Beacon fired from partman/early_command (the network IS up by partman,
        // so this is the most reliable "the box exists" ping — emitted BEFORE the
        // wipe so the phone hears from the box even if partitioning later fails).
        let partitionBeacon = debianBeaconCommand(phase: "partitioning", serial: beaconSerial)
        // Beacon E — `installing`, fired by base-installer right after
        // partitioning. d-i has no command-level preseed hook in the multi-minute
        // debootstrap/apt window, so partman/early_command drops a tiny executable
        // into /usr/lib/base-installer.d/ which base-installer runs as that
        // window opens. Mirrors preseed.ts.
        let installingDrop = debianBaseInstallerBeaconDrop(serial: beaconSerial)
        // Final SUCCESS beacon — emitted at the END of late_command, AFTER the
        // first-boot bootstrap succeeds, but BEFORE the box powers off (this
        // preseed sets debian-installer/exit/poweroff). NOT success: the install
        // completed but the box has not registered — it powered off awaiting the
        // user to unplug the USB + power back on (registration + cert happen on
        // the first real boot → `live`). Emitted on the success branch ONLY (the
        // failure branch posts the dev late-log + exits 1, never this).
        let installedBeacon = debianBeaconCommand(phase: "installed", serial: beaconSerial)

        let storageBlock = encryptRoot
            ? debianCryptoStorageBlock(partitionBeacon, installingDrop)
            : debianPlainStorageBlock(partitionBeacon, installingDrop)

        let ssid = (wifiSSID ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let hasWifi = !ssid.isEmpty
        let wifiScript64 = hasWifi
            ? Data(wifiSetupScript(ssid: ssid, password: wifiPassword ?? "").utf8).base64EncodedString()
            : ""
        let wifiNetcfgBlock = hasWifi ? debianWifiNetcfgBlock(ssid: ssid, password: wifiPassword ?? "") : ""
        // wpasupplicant + the non-free Wi-Fi firmware. The Debian installer
        // ships firmware (so Wi-Fi works during install), but unless we install
        // it into the target the installed system + initramfs boot with NO radio
        // firmware — the box installs/registers/seals fine yet can't bring Wi-Fi
        // up at the LUKS unlock or for the first-boot daemon. Explicit in
        // pkgsel/include (install-recommends=false can't drop them), resolved
        // from the non-free-firmware component. Broad chip-agnostic consumer set.
        // MUST match preseed.ts wifiPackagesBlock byte-for-byte.
        let wifiPackagesBlock = hasWifi
            ? " wpasupplicant firmware-iwlwifi firmware-realtek firmware-atheros firmware-brcm80211 firmware-misc-nonfree"
            : ""
        // Run via `in-target` (chroot into /target) so the script's ROOT arg is
        // EMPTY — its `/` already IS the target (passing /target would write to
        // /target/target). Chrooted execution also lets the script's enable
        // symlinks land in the installed system. Mirrors preseed.ts.
        let wifiLateCommand = hasWifi
            ? "echo '\(wifiScript64)' | base64 -d > /target/tmp/flagship-wifi.sh && in-target bash /tmp/flagship-wifi.sh; "
            : ""

        let lateCommand =
            // Beacon B — network is guaranteed up by late_command; ping home that
            // the installer is running, before the blob-decode + bootstrap.
            "\(lateBeacon); "
            + "mkdir -p /target/var/flagship; "
            + "echo '\(blobB64)' | base64 -d > /target/var/flagship/install-blob.json; "
            + "chmod 600 /target/var/flagship/install-blob.json; "
            + "echo '\(bootstrapB64)' | base64 -d > /target/usr/local/sbin/flagship-bootstrap.sh; "
            + "chmod +x /target/usr/local/sbin/flagship-bootstrap.sh; "
            + wifiLateCommand
            // Run the first-boot bootstrap capturing its output to a log on the
            // target. On SUCCESS, fire the `installed` beacon (best-effort
            // `|| true`, so it never blocks the imminent poweroff and never trips
            // the failure branch). On FAILURE, POST the last 16 KB home to the dev
            // late-log endpoint (so we can read WHY it failed via R2 without a
            // serial console / d-i shell), then exit non-zero so d-i still flags it.
            + "( in-target /usr/local/sbin/flagship-bootstrap.sh > /target/var/log/flagship-bootstrap.log 2>&1 ) && "
            + "\(installedBeacon) || "
            + "( tail -c 16000 /target/var/log/flagship-bootstrap.log > /tmp/fb-bootstrap-tail.txt 2>/dev/null; "
            + "wget -q -O- --post-file=/tmp/fb-bootstrap-tail.txt --timeout=20 https://flagshipserver.com/api/dev/late-log/\(beaconSerial)-bootstrap 2>/dev/null; exit 1 )"

        return """
        # Flagship Burner — debian-installer preseed
        # Generated at burn time. Don't edit by hand.

        ### Localization — fixed, non-interactive.
        d-i debian-installer/locale string en_US.UTF-8
        d-i keyboard-configuration/xkb-keymap select us

        ### Network.
        \(wifiNetcfgBlock)d-i netcfg/choose_interface select auto
        d-i netcfg/get_hostname string flagship-pod
        d-i netcfg/get_domain string
        d-i netcfg/hostname string flagship-pod
        # Don't block the install for a slow/absent link.
        d-i netcfg/dhcp_timeout string 60
        d-i netcfg/link_wait_timeout string 30

        ### Phone-home beacon A — the EARLIEST hook (runs before partman; the network
        ### may only just be coming up). Best-effort POST so the owner's phone sees the
        ### box the instant d-i starts. busybox wget (no curl in mini.iso d-i) needs
        ### --post-file=<path>, so we write the tiny JSON to /tmp first. Wrapped so a
        ### not-yet-up network never blocks the install.
        d-i preseed/early_command string \(earlyBeacon)

        ### Mirror — pulled from the network (netinst has no full package set).
        d-i mirror/country string manual
        d-i mirror/http/hostname string deb.debian.org
        d-i mirror/http/directory string /debian
        d-i mirror/http/proxy string

        ### Account setup. Root login disabled; one admin user (matches Ubuntu's
        ### autoinstall identity). The crypt(3) hash is the SAME baked hash the Ubuntu
        ### path ships (the box is phone-gated; this account is a break-glass console).
        d-i passwd/root-login boolean false
        d-i passwd/make-user boolean true
        d-i passwd/user-fullname string Flagship
        d-i passwd/username string flagship
        d-i passwd/user-password-crypted password $6$saltsaltsaltsaltsalt$Fz2j0/yjeyqQsRGfQ2DGRrXyMz9.6CljgPwQ3UlqOPLqo4kVZk.zhztOQS9rdshOMu7w5WL9.bjvKR7vCs71y0
        d-i user-setup/allow-password-weak boolean true
        d-i user-setup/encrypt-home boolean false

        ### Clock.
        d-i clock-setup/utc boolean true
        d-i time/zone string Etc/UTC
        d-i clock-setup/ntp boolean true

        \(storageBlock)
        ### Base system.
        d-i base-installer/install-recommends boolean false
        d-i apt-setup/non-free-firmware boolean true
        d-i apt-setup/non-free boolean false
        d-i apt-setup/contrib boolean false
        # A USB netinst booted as a CD-ROM loses its /media/cdrom mount by
        # finish-install; with the firmware netinst, apt-setup then re-scans for the
        # disc and loops forever on "please insert the disc". Force the network mirror
        # and never expect/scan the install CD again (it's already configured above).
        d-i apt-setup/use_mirror boolean true
        d-i apt-setup/cdrom/set-first boolean false
        d-i apt-setup/cdrom/set-next boolean false
        d-i apt-setup/cdrom/set-failed boolean false
        d-i cdrom-detect/eject boolean false

        ### Packages. Debian names for the bootstrap's deps (Node 20 itself comes from
        ### the bootstrap's NodeSource one-liner, reused verbatim from the Ubuntu path).
        tasksel tasksel/first multiselect standard, ssh-server
        d-i pkgsel/include string git curl jq ca-certificates xxd cryptsetup cryptsetup-initramfs lvm2 gnupg openssl\(wifiPackagesBlock)
        d-i pkgsel/upgrade select none
        popularity-contest popularity-contest/participate boolean false

        ### Bootloader — THE WHOLE POINT OF THE DEBIAN PATH.
        # Install GRUB to the disk, no other-OS probing.
        d-i grub-installer/only_debian boolean true
        d-i grub-installer/with_other_os boolean false
        d-i grub-installer/bootdev string default
        # Many boxes' UEFI firmware REJECT NVRAM boot-entry writes
        # ("failed to register the EFI boot entry: Invalid argument"), which aborts a
        # subiquity install. d-i instead installs an extra GRUB copy at the EFI
        # removable-media path (/EFI/BOOT/BOOTX64.EFI), which boots with NO NVRAM entry.
        # Two keys, two owners, set together (belt + suspenders — same intent as the
        # Ubuntu path setting both storage.grub.update_nvram AND the debconf key):
        #   - grub-installer/force-efi-extra-removable  → the d-i question
        #   - grub-efi-amd64 grub2/force_efi_extra_removable → the grub-efi pkg question
        # https://wiki.debian.org/UEFI
        d-i grub-installer/force-efi-extra-removable boolean true
        grub-efi-amd64 grub2/force_efi_extra_removable boolean true
        # Belt + suspenders for the firmware that also rejects the os-prober/efibootmgr
        # NVRAM write outright: tell grub-installer not to touch NVRAM at all.
        d-i grub-installer/update-nvram boolean false

        ### Finish — POWER OFF after install instead of rebooting. A reboot with the
        ### USB still plugged re-enters the installer (the firmware boots the USB's
        ### removable-media EFI first, and we don't write NVRAM). Powering off removes
        ### that race entirely: the box turns itself off = "done" — the user unplugs
        ### the USB and powers it on, which boots the installed disk → first real boot
        ### → auto-unlock → register → cert.
        d-i finish-install/keep-consoles boolean true
        d-i finish-install/reboot_in_progress note
        d-i debian-installer/exit/poweroff boolean true

        ### First-boot bootstrap — the same install-blob + bootstrap the Ubuntu path
        ### writes, run in the installed target (d-i in-target == curtin in-target).
        d-i preseed/late_command string \(lateCommand)

        """
    }

    /// Unconditional wipe of the resolved target disk, run inside
    /// partman/early_command right after DISK is chosen and BEFORE partman probes
    /// it. Zeroing the GPT (the front 16 MB primary header/table + the 8192-sector
    /// backup header at the tail) and rereadpt makes partman see a blank disk, so
    /// a prior install's stale encrypted VG / LUKS / GPT can't be probed (the real
    /// "volume group with no physical volume" partman failure on a repurposed
    /// disk). dmsetup remove_all first clears any active device-mapper mappings
    /// carried over from a prior boot. INTENTIONAL + UNCONDITIONAL: the burner is
    /// plug-and-play and the user already consented to a destructive install.
    /// Every sub-command is guarded (`|| true`) so it can never abort the install;
    /// dmsetup/dd/blockdev all exist in the d-i env. Mirrors preseed.ts.
    static let wipeTargetDisk =
        "dmsetup remove_all 2>/dev/null || true; "
        + "dd if=/dev/zero of=\"$DISK\" bs=1M count=16 2>/dev/null || true; "
        + "SZ=$(blockdev --getsz \"$DISK\" 2>/dev/null || echo 0); "
        + "[ \"$SZ\" -gt 8192 ] && dd if=/dev/zero of=\"$DISK\" bs=512 seek=$((SZ-8192)) count=8192 2>/dev/null || true; "
        + "blockdev --rereadpt \"$DISK\" 2>/dev/null || true"

    /// The partman/early_command line shared by both storage variants: resolve the
    /// target disk, set it, phone home (network is up by partman), then wipe it,
    /// then drop the Beacon E base-installer.d script. The preseed
    /// `\`-continuation style is kept. Mirrors preseed.ts.
    static func partmanEarlyCommand(_ partitionBeacon: String, _ installingDrop: String) -> String {
        "d-i partman/early_command string \\\n"
        + "  DISK=$(list-devices disk | head -n1); debconf-set partman-auto/disk \"$DISK\"; \\\n"
        + "  \(partitionBeacon); \\\n"
        + "  \(wipeTargetDisk); \\\n"
        + "  \(installingDrop)"
    }

    /// Beacon E dropper, appended to partman/early_command. Writes a tiny
    /// executable into /usr/lib/base-installer.d/ (the d-i hook dir
    /// base-installer runs right after partitioning) that POSTs the canonical
    /// `installing` phase — filling the otherwise-silent multi-minute
    /// debootstrap/apt window. The script body IS the shared debianBeaconCommand,
    /// additionally BACKGROUNDED (`&`) + `exit 0` so it can NEVER block or fail
    /// base-installer; the dropper itself is `( … ) || true`. The beacon's only
    /// `"` are escaped for the double-quoted echo; it contains no
    /// `$`/backslash/backtick (the serial is beaconSafe-sanitized).
    /// Byte-identical to preseed.ts debianBaseInstallerBeaconDrop.
    static func debianBaseInstallerBeaconDrop(serial: String) -> String {
        let beacon = debianBeaconCommand(phase: "installing", serial: serial)
            .replacingOccurrences(of: "\"", with: "\\\"")
        return "( mkdir -p /usr/lib/base-installer.d; "
            + "{ echo '#!/bin/sh'; echo \"\(beacon) &\"; echo 'exit 0'; } "
            + "> /usr/lib/base-installer.d/05flagship-beacon; "
            + "chmod +x /usr/lib/base-installer.d/05flagship-beacon ) || true"
    }

    /// partman-crypto LVM-on-LUKS recipe (the locked encrypted default).
    /// EXPERIMENTAL — needs live validation. Byte-identical intent to preseed.ts
    /// debianCryptoStorageBlock (Swift needs no `$`-escaping; `$primary{}` etc.
    /// are plain literals here).
    static func debianCryptoStorageBlock(_ partitionBeacon: String, _ installingDrop: String) -> String {
        return """
        ### Partitioning — EXPERIMENTAL LVM-on-LUKS (the locked encrypted default).
        # partman-crypto only reliably preseeds LVM-on-LUKS: unencrypted ESP + /boot,
        # then a LUKS container holding one VG (flagship) with a single root LV.
        d-i partman-auto/method string crypto
        d-i partman-auto/disk string /dev/sda /dev/vda /dev/nvme0n1
        \(partmanEarlyCommand(partitionBeacon, installingDrop))
        d-i partman-lvm/device_remove_lvm boolean true
        d-i partman-md/device_remove_md boolean true
        d-i partman-auto-lvm/new_vg_name string flagship
        # The fixed burn-time LUKS passphrase. The bootstrap re-keys it to a
        # phone-sealed random key on first boot, then removes this slot.
        d-i partman-crypto/passphrase password \(burnPassphrase)
        d-i partman-crypto/passphrase-again password \(burnPassphrase)
        d-i partman-crypto/weak_passphrase boolean true
        d-i partman-auto/choose_recipe select flagship-crypto
        d-i partman-auto/expert_recipe string \\
              flagship-crypto ::                                            \\
                      1 1 1 free                                            \\
                              $iflabel{ gpt }                              \\
                              $reusemethod{ }                              \\
                              method{ biosgrub }                            \\
                      .                                                     \\
                      512 512 512 free                                      \\
                              $iflabel{ gpt }                              \\
                              $reusemethod{ }                              \\
                              method{ efi } format{ }                       \\
                      .                                                     \\
                      768 768 768 ext4                                      \\
                              $primary{ } $bootable{ }                    \\
                              method{ format } format{ }                    \\
                              use_filesystem{ } filesystem{ ext4 }          \\
                              label{ FLAGSHIP_BOOT }                        \\
                              mountpoint{ /boot }                           \\
                      .                                                     \\
                      2000 5000 -1 ext4                                     \\
                              $lvmok{ }                                    \\
                              method{ format } format{ }                    \\
                              use_filesystem{ } filesystem{ ext4 }          \\
                              label{ FLAGSHIP_ROOT }                        \\
                              mountpoint{ / }                               \\
                      .
        # Make the destructive steps fully unattended.
        d-i partman-partitioning/confirm_write_new_label boolean true
        d-i partman/choose_partition select finish
        d-i partman/confirm boolean true
        d-i partman/confirm_nooverwrite boolean true
        d-i partman-lvm/confirm boolean true
        d-i partman-lvm/confirm_nooverwrite boolean true
        d-i partman-md/confirm boolean true
        d-i partman-crypto/confirm boolean true
        d-i partman-crypto/confirm_nooverwrite boolean true
        d-i partman-basicfilesystems/no_swap boolean false
        d-i partman-auto-crypto/erase_disks boolean false
        """
    }

    /// Unencrypted debug-escape layout (encryptRoot:false). Not exposed in the
    /// GUI; reproduces a known-good non-LUKS baseline. Mirrors preseed.ts
    /// debianPlainStorageBlock.
    static func debianPlainStorageBlock(_ partitionBeacon: String, _ installingDrop: String) -> String {
        return """
        ### Partitioning — DEBUG ESCAPE: plain (unencrypted) ESP + /boot + ext4 root.
        # Not exposed in the CLI/GUI; reproduces a known-good non-LUKS baseline.
        d-i partman-auto/method string regular
        d-i partman-auto/disk string /dev/sda /dev/vda /dev/nvme0n1
        \(partmanEarlyCommand(partitionBeacon, installingDrop))
        d-i partman-lvm/device_remove_lvm boolean true
        d-i partman-md/device_remove_md boolean true
        d-i partman-auto/choose_recipe select flagship-plain
        d-i partman-auto/expert_recipe string \\
              flagship-plain ::                                             \\
                      1 1 1 free                                            \\
                              $iflabel{ gpt }                              \\
                              $reusemethod{ }                              \\
                              method{ biosgrub }                            \\
                      .                                                     \\
                      512 512 512 free                                      \\
                              $iflabel{ gpt }                              \\
                              $reusemethod{ }                              \\
                              method{ efi } format{ }                       \\
                      .                                                     \\
                      768 768 768 ext4                                      \\
                              $primary{ } $bootable{ }                    \\
                              method{ format } format{ }                    \\
                              use_filesystem{ } filesystem{ ext4 }          \\
                              label{ FLAGSHIP_BOOT }                        \\
                              mountpoint{ /boot }                           \\
                      .                                                     \\
                      2000 5000 -1 ext4                                     \\
                              $primary{ }                                  \\
                              method{ format } format{ }                    \\
                              use_filesystem{ } filesystem{ ext4 }          \\
                              label{ FLAGSHIP_ROOT }                        \\
                              mountpoint{ / }                               \\
                      .
        d-i partman-partitioning/confirm_write_new_label boolean true
        d-i partman/choose_partition select finish
        d-i partman/confirm boolean true
        d-i partman/confirm_nooverwrite boolean true
        # No swap partition in this recipe — auto-answer the "no swap space, return to
        # the partitioning menu?" prompt with No (proceed). The crypto recipe carries
        # the same line; the plain recipe was missing it (the no-LUKS box stopped here).
        d-i partman-basicfilesystems/no_swap boolean false
        # Authorize partman to steamroll a prior install's LVM/crypto instead of
        # stalling (the proven cloud preseed carries these; the burner was missing them).
        d-i partman-lvm/confirm boolean true
        d-i partman-lvm/confirm_nooverwrite boolean true
        d-i partman-crypto/confirm boolean true
        d-i partman-crypto/confirm_nooverwrite boolean true
        """
    }

    /// Install-time Wi-Fi for d-i's netcfg (keys wireless by ESSID, unlike
    /// networkd). Mirrors preseed.ts debianWifiNetcfgBlock.
    static func debianWifiNetcfgBlock(ssid: String, password: String) -> String {
        return """
        d-i netcfg/wireless_show_essids select manual
        d-i netcfg/wireless_essid string \(preseedEscape(ssid))
        d-i netcfg/wireless_essid_again string \(preseedEscape(ssid))
        d-i netcfg/wireless_security_type select wpa
        d-i netcfg/wireless_wpa string \(preseedEscape(password))

        """
    }

    /// Escape a value for a single-line d-i preseed `string` scalar (no newline).
    static func preseedEscape(_ s: String) -> String {
        s.replacingOccurrences(of: "\r", with: " ")
            .replacingOccurrences(of: "\n", with: " ")
    }

    /// Parse the beacon's (serial, serverDomain) out of the verified recipe JSON.
    /// Accepts the same `{ "blob": {…} }` envelope the website/.com hand out, and
    /// the flattened recipe. Both fields are sanitized via beaconSafe so they can
    /// sit unquoted in the beacon URL/JSON. Returns ("","") if the JSON can't be
    /// read — the beacon then degrades to an empty serial/domain, never throws.
    static func beaconFields(_ recipeJSON: Data) -> (serial: String, domain: String) {
        var obj = (try? JSONSerialization.jsonObject(with: recipeJSON)) as? [String: Any] ?? [:]
        if let blob = obj["blob"] as? [String: Any] { obj = blob }
        let domain = (obj["serverDomain"] as? String) ?? ""
        let serial = ((obj["authCode"] as? [String: Any])?["serial"] as? String) ?? ""
        return (beaconSafe(serial), beaconSafe(domain))
    }

    /// Sanitize a value that gets inlined, unquoted, into a beacon URL or a
    /// single-quoted JSON literal. Strips everything outside [A-Za-z0-9._:-] —
    /// enough for an auth-code serial and an FQDN, injection-proof for the
    /// shell/JSON contexts the beacon command builds. Mirrors preseed.ts.
    static func beaconSafe(_ s: String) -> String {
        String(s.unicodeScalars.filter { sc in
            (sc >= "A" && sc <= "Z") || (sc >= "a" && sc <= "z")
                || (sc >= "0" && sc <= "9") || sc == "." || sc == "_" || sc == ":" || sc == "-"
        })
    }

    /// A best-effort phone-home beacon for the d-i environment. Writes the tiny
    /// JSON body to /tmp (busybox wget POST needs `--post-file=<path>`, not stdin
    /// — and mini.iso d-i has NO curl, only busybox wget) then POSTs the canonical
    /// `{"phase":…}` body to POST /api/order/<serial>/status — the SINGLE
    /// provisioning channel every surface reads. HTTPS works against d-i's bundled
    /// CA bundle. Wrapped in `( … ) || true` so a down/just-coming-up network never
    /// blocks the install. SECRET-FREE (serial in the URL; no detail). Byte-
    /// identical to preseed.ts debianBeaconCommand — keep in lockstep.
    static func debianBeaconCommand(phase: String, serial: String) -> String {
        "( echo '{\"phase\":\"\(phase)\"}' > /tmp/flagship-beacon.json; "
            + "wget -q -O- --post-file=/tmp/flagship-beacon.json --timeout=15 "
            + "https://flagshipserver.com/api/order/\(serial)/status ) || true"
    }

    /// curtin custom-storage layout for the OPT-IN LUKS path. EXPERIMENTAL —
    /// needs live validation (brick risk). Byte-identical to userdata.ts
    /// luksStorageBlock(). 2-space indent so it nests under `autoinstall:`.
    static func luksStorageBlock() -> String {
        return """
          # EXPERIMENTAL LUKS-on-root (opt-in; default OFF). Needs live validation.
          # UEFI GPT layout (the common case): a FAT32 ESP flagged `boot` carries
          # grub_device so curtin does a UEFI install — the SIGNED shim + grub
          # chain Secure Boot trusts. grub_device is OFF on the disk on purpose:
          # setting it makes curtin install BIOS grub-pc, leaving an UNSIGNED EFI
          # grub that Secure Boot rejects ("Secure Boot Violation: invalid
          # signature"). A reserved 1M bios_grub partition is kept for a future
          # BIOS variant. subiquity also rejects a UEFI layout with no ESP ("did
          # not create needed bootloader partition").
          # grub.update_nvram:false — many boxes' firmware reject EFI NVRAM writes
          # ("failed to register the EFI boot entry: Invalid argument"), which
          # ABORTS the install; skip the NVRAM write (a late-command then copies
          # the signed shim+grub to the removable /EFI/BOOT path, which firmware
          # boots with no NVRAM entry). Unencrypted /boot + LUKS root.
          # Byte-identical to userdata.ts luksStorageBlock().
          storage:
            grub:
              update_nvram: false
            config:
              - {id: disk0, type: disk, ptable: gpt, match: {size: largest}, wipe: superblock-recursive, grub_device: false, preserve: false}
              - {id: bios_grub, type: partition, device: disk0, size: 1M, flag: bios_grub, preserve: false}
              - {id: esp_part, type: partition, device: disk0, size: 512M, flag: boot, grub_device: true, preserve: false}
              - {id: esp_fs, type: format, fstype: fat32, volume: esp_part, preserve: false}
              - {id: boot_part, type: partition, device: disk0, size: 512M, preserve: false}
              - {id: root_part, type: partition, device: disk0, size: -1, preserve: false}
              - {id: boot_fs, type: format, fstype: ext4, volume: boot_part, label: FLAGSHIP_BOOT, preserve: false}
              - {id: root_crypt, type: dm_crypt, volume: root_part, dm_name: flagship_root, key: "\(burnPassphrase)", preserve: false}
              - {id: root_fs, type: format, fstype: ext4, volume: root_crypt, label: FLAGSHIP_ROOT, preserve: false}
              - {id: root_mount, type: mount, device: root_fs, path: /}
              - {id: boot_mount, type: mount, device: boot_fs, path: /boot}
              - {id: esp_mount, type: mount, device: esp_fs, path: /boot/efi}

        """
    }

    /// The optional wired-DHCP fallback emitted on the Wi-Fi path. networkd DOES
    /// support `match:` for ethernet, and `optional: true` means a box with no
    /// cable never blocks the install. Wi-Fi itself is added at runtime by
    /// wifiSetupScript (networkd won't take a wifi `match:`). 2-space indent so
    /// it nests under `autoinstall:`. Byte-identical to userdata.ts.
    static func wifiEthernetBlock() -> String {
        return """
          network:
            version: 2
            ethernets:
              flagship-eth:
                match: {name: "en*"}
                dhcp4: true
                optional: true

        """
    }

    /// Runtime Wi-Fi setup, run IN-TARGET (chroot for the installed system; the
    /// live env too on Ubuntu). networkd rejects `match:` for wifis ("only by
    /// interface name") and the name (wlan0 / wlp2s0 / wlo1 …) isn't known at
    /// burn time, so detect it at runtime. `$1` = root prefix: "" when run inside
    /// the target (the live installer, and the Debian d-i in-target chroot),
    /// "/target" for Ubuntu's curtin late-command (installer host, not chrooted).
    ///
    /// DISTRO BRANCH: write the config for the network stack actually present —
    /// netplan (Ubuntu), else systemd-networkd + wpa_supplicant (Debian, the
    /// lowest common denominator on both), neutralizing d-i's ifupdown wpa-ssid
    /// stanza so two managers don't fight the radio. Units are enabled by
    /// dropping the .wants symlinks directly (works chrooted or via a $ROOT
    /// prefix). Byte-identical to userdata.ts wifiSetupScript — keep the two in
    /// lockstep (cross-language sha pin).
    static func wifiSetupScript(ssid: String, password: String) -> String {
        return #"""
        #!/bin/bash
        set -u
        ROOT="${1:-}"
        IF=""
        for d in /sys/class/net/*/wireless; do
          [ -e "$d" ] || continue
          IF="$(basename "$(dirname "$d")")"
          break
        done
        if [ -z "$IF" ]; then
          echo "[flagship-wifi] no wireless interface found; skipping" >&2
          exit 0
        fi
        echo "[flagship-wifi] interface=$IF root=${ROOT:-/}"
        if [ -d "${ROOT}/etc/netplan" ]; then
          # Ubuntu: netplan drives networkd (which spawns wpa_supplicant@<iface>).
          echo "[flagship-wifi] netplan present — writing 99-flagship-wifi.yaml"
          cat > "${ROOT}/etc/netplan/99-flagship-wifi.yaml" <<'FLAGSHIP_WIFI_EOF'
        network:
          version: 2
          wifis:
            __IFACE__:
              dhcp4: true
              optional: true
              access-points:
                "\#(yamlEscape(ssid))":
                  password: "\#(yamlEscape(password))"
        FLAGSHIP_WIFI_EOF
          sed -i "s/__IFACE__/${IF}/" "${ROOT}/etc/netplan/99-flagship-wifi.yaml"
          chmod 600 "${ROOT}/etc/netplan/99-flagship-wifi.yaml"
        else
          # Debian (no netplan): systemd-networkd + wpa_supplicant, the common stack.
          echo "[flagship-wifi] no netplan — configuring systemd-networkd + wpa_supplicant for $IF"
          mkdir -p "${ROOT}/etc/systemd/network" "${ROOT}/etc/wpa_supplicant"
          cat > "${ROOT}/etc/systemd/network/10-flagship-wifi.network" <<'FLAGSHIP_NETWORKD_EOF'
        [Match]
        Name=__IFACE__
        [Network]
        DHCP=yes
        IgnoreCarrierLoss=3s
        FLAGSHIP_NETWORKD_EOF
          sed -i "s/__IFACE__/${IF}/" "${ROOT}/etc/systemd/network/10-flagship-wifi.network"
          chmod 644 "${ROOT}/etc/systemd/network/10-flagship-wifi.network"
          # The wpa_supplicant@<iface>.service template (shipped by wpasupplicant) reads
          # exactly this path. Quoted-plaintext PSK is valid; 0600 (it holds the secret).
          cat > "${ROOT}/etc/wpa_supplicant/wpa_supplicant-${IF}.conf" <<'FLAGSHIP_WPA_EOF'
        ctrl_interface=DIR=/run/wpa_supplicant GROUP=netdev
        update_config=1
        country=00
        network={
          ssid="\#(yamlEscape(ssid))"
          psk="\#(yamlEscape(password))"
          scan_ssid=1
        }
        FLAGSHIP_WPA_EOF
          chmod 600 "${ROOT}/etc/wpa_supplicant/wpa_supplicant-${IF}.conf"
          # Neutralize d-i's ifupdown wireless stanza: netcfg writes an
          #   allow-hotplug <if> / iface <if> inet dhcp / wpa-ssid / wpa-psk / wpa-conf
          # block to /etc/network/interfaces; ifupdown would start its OWN wpa_supplicant
          # on that iface and fight ours. Comment out every wireless/wpa line for our
          # iface (leave lo + any wired stanza untouched).
          IFACES_FILE="${ROOT}/etc/network/interfaces"
          if [ -f "$IFACES_FILE" ]; then
            sed -i -E "/(allow-hotplug|auto|iface)[[:space:]]+${IF}([[:space:]]|\.|$)/ s/^([^#])/# \1/" "$IFACES_FILE"
            sed -i -E "/^[[:space:]]*wpa-/ s/^([[:space:]]*)([^#[:space:]])/\1# \2/" "$IFACES_FILE"
            echo "[flagship-wifi] neutralized ifupdown wireless stanza for $IF in $IFACES_FILE"
          fi
          # Enable systemd-networkd + wpa_supplicant@<iface> by dropping the .wants
          # symlinks directly (what `systemctl enable` does) — works chrooted or via a
          # $ROOT prefix, and with systemd not running.
          mkdir -p "${ROOT}/etc/systemd/system/multi-user.target.wants" \
                   "${ROOT}/etc/systemd/system/sockets.target.wants"
          ln -sf /lib/systemd/system/systemd-networkd.service \
            "${ROOT}/etc/systemd/system/multi-user.target.wants/systemd-networkd.service"
          ln -sf /lib/systemd/system/systemd-networkd.socket \
            "${ROOT}/etc/systemd/system/sockets.target.wants/systemd-networkd.socket"
          ln -sf "/lib/systemd/system/wpa_supplicant@.service" \
            "${ROOT}/etc/systemd/system/multi-user.target.wants/wpa_supplicant@${IF}.service"
        fi
        """#
    }

    /// Escape a string for a YAML double-quoted scalar.
    static func yamlEscape(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
    }

    /// Fixed burn-time LUKS passphrase used ONLY between curtin's luksFormat and
    /// the bootstrap's re-key step; destroyed before first boot. Identical to
    /// userdata.ts BURN_PASSPHRASE.
    static let burnPassphrase = "flagship-burn-time-luks-rekey-me-immediately"

    /// First-boot bootstrap — clones flagship, generates the server identity,
    /// and registers with .com. Mirrors userdata.ts buildBootstrapScript.
    /// Bash line-continuations are written as `\\` (literal backslash); bash
    /// `$VAR` / `$(...)` / `${...}` pass through unchanged. `encryptRoot` opt-in
    /// (default OFF) splices the LUKS unlock-hook block before `installed.flag`.
    /// `family` selects the installer the bootstrap runs under. "ubuntu"
    /// (default) keeps the original output byte-identical (so the cross-language
    /// sha256 pins hold). "debian" only adapts the LVM-on-LUKS unlock inside the
    /// encrypted block — the plain bootstrap body is identical either way.
    /// Mirrors userdata.ts buildBootstrapScript.
    static func bootstrapScript(ref: String, repoURL: String, encryptRoot: Bool = true, bootUnlockMode: String = "auto", bootHost: String = defaultBootHost, family: String = "ubuntu", wifiSSID: String? = nil, wifiPassword: String? = nil, debugMode: Bool = false) -> String {
        let plain = bootstrapScriptPlain(ref: ref, repoURL: repoURL, wifiSSID: wifiSSID, wifiPassword: wifiPassword)
        guard encryptRoot else { return debugMode ? withDebugManualMarker(plain) : stripDebugFeatures(plain) }
        // Boot-unlock policy is baked into the LUKS block; only "approve" is the
        // critical-server path; anything else ⇒ "auto" (mirror userdata.ts).
        let mode = bootUnlockMode == "approve" ? "approve" : "auto"
        let fam = family == "debian" ? "debian" : "ubuntu"
        // Splice the LUKS block in just before the plain script's final two
        // lines (installed.flag + "done") so the shared body stays verbatim.
        let tail = """
        # Reached the end cleanly — disarm the error trap so the EXIT handler doesn't
        # misfire a terminal error phase on a 0 exit. On the encrypted path the LUKS
        # block is spliced in just ABOVE this line, so the trap still covers the re-key.
        trap - EXIT
        date > /var/flagship/installed.flag
        echo "[flagship-bootstrap] done"

        """
        precondition(plain.hasSuffix(tail), "plain bootstrap tail drifted; encrypted splice would be wrong")
        let assembled = String(plain.dropLast(tail.count)) + luksBootstrapBlock(mode: mode, bootHost: bootHost, family: fam, wifiSSID: wifiSSID ?? "", wifiPassword: wifiPassword ?? "") + tail
        // Production by default: strip the debug account + banner unless this is an
        // explicit debug build. Mirror of userdata.ts buildBootstrapScript.
        return debugMode ? withDebugManualMarker(assembled) : stripDebugFeatures(assembled)
    }

    /// DEBUG-only: append the /boot marker that re-enables boot-stage's console
    /// "manual" passphrase unlock fallback. Byte-identical to userdata.ts.
    static func withDebugManualMarker(_ script: String) -> String {
        script
            + "\n# DEBUG-ONLY: enable boot-stage's console 'manual' unlock fallback.\n"
            + ": > /boot/flagship-debug-mode 2>/dev/null || true\n"
    }

    /// Strip every DEBUG-only feature from an assembled bootstrap, leaving a
    /// production image: removes the "DEBUG BUILD" /etc/issue banner and the
    /// known-password `debug` sudo account (comment + useradd + chpasswd). The
    /// account block carries non-ASCII chars in its comment, so it's matched by
    /// a regex anchored on stable ASCII. FAILS LOUD if either backdoor marker
    /// survives. Byte-identical to userdata.ts `stripDebugFeatures`.
    static func stripDebugFeatures(_ script: String) -> String {
        let banner = "cat >> /etc/issue <<'FLAGSHIP_ISSUE'\n\n"
            + "  !! DEBUG BUILD - console login 'debug' / password 'flagship' (sudo).\n"
            + "  !! CHANGE OR REMOVE this user before production.\n\n"
            + "FLAGSHIP_ISSUE\n"
        var s = script.replacingOccurrences(of: banner, with: "")
        s = s.replacingOccurrences(
            of: "# .{0,4}DEBUG-ONLY console login[\\s\\S]*?echo 'debug:flagship' \\| chpasswd 2>/dev/null \\|\\| true\n\n",
            with: "",
            options: .regularExpression
        )
        precondition(
            !s.contains("debug:flagship") && !s.contains("DEBUG BUILD"),
            "stripDebugFeatures: a debug marker survived the strip — refusing to ship a production image with the backdoor"
        )
        return s
    }

    static func bootstrapScriptPlain(ref: String, repoURL: String, wifiSSID: String? = nil, wifiPassword: String? = nil) -> String {
        // wpasupplicant only on the Wi-Fi path (the safety-net needs the binary);
        // wired ⇒ "" so the plain bootstrap stays byte-identical. Mirrors userdata.ts.
        let ssid = (wifiSSID ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let wpaPkg = ssid.isEmpty ? "" : " wpasupplicant"
        let wifiSafetyNet = wifiSafetyNetBlock(ssid: wifiSSID ?? "", password: wifiPassword ?? "")
        return """
        #!/bin/bash
        # Flagship first-boot bootstrap.
        # Runs once at first boot under curtin's in-target chroot. Idempotent.
        set -uo pipefail
        exec >>/var/log/flagship-bootstrap.log 2>&1
        date
        echo "[flagship-bootstrap] starting"

        REPO_URL="${FLAGSHIP_REPO_URL:-\(repoURL)}"
        GIT_REF="\(ref)"

        # Install Node 20 + every tool the bootstrap and initramfs hook need. Do NOT
        # assume the installer's packages: list ran — a missing jq once parsed the
        # recipe into empty values and mis-sealed the LUKS key. NodeSource refreshes apt.
        #
        # docker.io/docker-cli/docker-compose: the daemon runs every marketplace app as
        # a hardened container and brings up the data-layer (postgres/minio/redis/...)
        # via compose, so docker is REQUIRED — without it the daemon's ensureNetwork
        # (`docker network create`) used to crash the process at startup. docker-cli is
        # listed explicitly because --no-install-recommends drops it (it's only a
        # Recommends of docker.io); docker-compose ships the `docker compose` subcommand
        # the data-services init.sh calls.
        export DEBIAN_FRONTEND=noninteractive
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash - || echo "[flagship-bootstrap] WARN: NodeSource setup failed; falling back to distro nodejs+npm"
        apt-get install -y --no-install-recommends nodejs jq git curl ca-certificates cryptsetup lvm2 xxd openssl gnupg docker.io docker-cli docker-compose\(wpaPkg)
        # Debian's 'nodejs' package does NOT bundle npm (separate package); NodeSource's does.
        # On Debian 13 the NodeSource setup_20.x repo may not apply, leaving npm/npx absent —
        # which fails the entire build below (npm install, tsc, gen-identity, seal-for-bak).
        # Install npm explicitly if it is still missing (no-op when NodeSource provided it).
        if ! command -v npm >/dev/null 2>&1; then
            echo "[flagship-bootstrap] npm missing after node install — installing distro npm"
            apt-get install -y --no-install-recommends npm
        fi
        command -v npm >/dev/null 2>&1 || { echo "[flagship-bootstrap] FATAL: npm unavailable; cannot build daemon"; exit 1; }

        # Read the install-blob fields the daemon needs.
        BLOB_JSON=/var/flagship/install-blob.json
        SERVER_DOMAIN="$(jq -r .serverDomain "$BLOB_JSON")"
        USERNAME="$(jq -r .username "$BLOB_JSON")"
        SERVER_NAME="$(jq -r .serverName "$BLOB_JSON")"
        REGISTRATION_URL="$(jq -r .registrationUrl "$BLOB_JSON")"
        PHONE_DELEGATED_PUBKEY="$(jq -r .phoneDelegatedPubKey "$BLOB_JSON")"
        AUTH_CODE_SERIAL="$(jq -r .authCode.serial "$BLOB_JSON")"
        echo "[flagship-bootstrap] domain=$SERVER_DOMAIN user=$USERNAME ref=$GIT_REF"

        # ── Brand the box. /etc/issue is shown by getty ABOVE the login prompt (where
        #    you see "flagship-pod login:"); /etc/motd is shown right after login.
        #    PURE ASCII ONLY: the VT decodes UTF-8 but Debian's default console font
        #    (Lat15) has no glyphs for block elements or em-dashes — every non-ASCII
        #    char rendered as the missing-glyph box on real hardware (2026-06-12
        #    photo). Single-quoted heredocs ⇒ the art is static and agetty never
        #    sees a backslash escape; the one colored line is appended with printf
        #    so a LITERAL ESC byte lands in the file (the console's 16-color
        #    palette has no teal — bright cyan is the nearest).
        cat > /etc/issue <<'FLAGSHIP_ISSUE'

          ###### ##     ###### ###### ###### ##  ## ###### ######
          ##     ##     ##  ## ##     ##     ##  ##   ##   ##  ##
          #####  ##     ###### ## ### ###### ######   ##   ######
          ##     ##     ##  ## ##  ##     ## ##  ##   ##   ##
          ##     ###### ##  ## ###### ###### ##  ## ###### ##

          This is a Flagship server - your personal cloud. You hold the keys.
        FLAGSHIP_ISSUE
        printf '  Get yours at \\033[96mflagshipserver.com\\033[0m\\n' >> /etc/issue
        cat >> /etc/issue <<'FLAGSHIP_ISSUE'

          !! DEBUG BUILD - console login 'debug' / password 'flagship' (sudo).
          !! CHANGE OR REMOVE this user before production.

        FLAGSHIP_ISSUE
        # MOTD (post-login) names this specific box. Unquoted heredoc ⇒ vars expand.
        cat > /etc/motd <<FLAGSHIP_MOTD

          Flagship - $SERVER_NAME
          https://$SERVER_DOMAIN - TLS terminates here, on your hardware.
          flagship.services is a blind pipe; it never sees your data.

        FLAGSHIP_MOTD

        # ── DEBUG-ONLY console login. The 'flagship' user is SSH-key-only (no usable
        #    password by design), which makes on-box debugging (read /boot/flagship-wifi.log,
        #    journalctl, etc.) impossible at the console. 'debug' is a sudo user with a
        #    KNOWN password so the owner can log in during bring-up. SECURITY: this is a
        #    backdoor — the /etc/issue banner warns loudly; REMOVE before production
        #    (tracked in CLAUDE.md open work).
        useradd -m -s /bin/bash -G sudo debug 2>/dev/null || true
        echo 'debug:flagship' | chpasswd 2>/dev/null || true

        # Provisioning-status → .com so the phone renders a live install timeline.
        # Best-effort: a failed report NEVER fails the install. (The Alpine live
        # installer can also report the earlier downloading/partitioning phases; the
        # d-i late_command can only report from here on — clone/build onward.)
        CONTROL_PLANE_BASE="$(echo "$REGISTRATION_URL" | sed 's|/api/server/register$||')"
        report_phase() {
            # $1 = canonical ProvisionStatusPhase, $2 = optional detail (error string)
            if [ -n "${2:-}" ]; then
                curl -fsS -m 8 -X POST -H 'content-type: application/json' \\
                    --data '{"phase":"'"$1"'","detail":"'"$2"'"}' \\
                    "$CONTROL_PLANE_BASE/api/order/$AUTH_CODE_SERIAL/status" >/dev/null 2>&1 || true
            else
                curl -fsS -m 8 -X POST -H 'content-type: application/json' \\
                    --data '{"phase":"'"$1"'"}' \\
                    "$CONTROL_PLANE_BASE/api/order/$AUTH_CODE_SERIAL/status" >/dev/null 2>&1 || true
            fi
        }
        # Error trap — any fatal bootstrap failure reports the terminal canonical
        # error phase so the phone's timeline shows the stall instead of hanging on the
        # last good phase. Fires once, only on a non-zero exit (a clean exit clears it
        # first). Best-effort + never re-raises, so the trap can't itself wedge the
        # install. The captured exit code is preserved.
        flagship_on_error() {
            _rc=$?
            [ "$_rc" -eq 0 ] && return 0
            report_phase error "bootstrap exited $_rc"
        }
        trap flagship_on_error EXIT
        report_phase downloading

        # Persist install-time facts the daemon reads on every boot.
        mkdir -p /var/flagship /boot/flagship
        echo "$SERVER_DOMAIN"          > /var/flagship/server-domain
        echo "$USERNAME"               > /var/flagship/username
        echo "$SERVER_NAME"            > /var/flagship/server-name
        echo "$PHONE_DELEGATED_PUBKEY" > /var/flagship/phone-delegated.pub
        echo "$AUTH_CODE_SERIAL"       > /var/flagship/auth-code-serial
        cp "$BLOB_JSON" /boot/install-blob.json

        # Clone flagship + build daemon.
        rm -rf /opt/flagship
        git clone --depth 50 --branch "$GIT_REF" "$REPO_URL" /opt/flagship || \\
            (git clone --depth 50 "$REPO_URL" /opt/flagship && \\
             git -C /opt/flagship fetch --depth 50 origin "$GIT_REF" && \\
             git -C /opt/flagship checkout "$GIT_REF")
        cd /opt/flagship
        npm install --no-audit --no-fund --workspaces --include-workspace-root \\
            | tee /var/log/flagship-npm.log
        if [ ! -e /opt/flagship/node_modules/@flagship/protocol/package.json ]; then
            echo "[flagship-bootstrap] WARN: workspace not symlinked; manual linking"
            mkdir -p /opt/flagship/node_modules/@flagship
            for pkg in /opt/flagship/packages/*/; do
                name=$(jq -r .name "$pkg/package.json" 2>/dev/null || echo "")
                [ -n "$name" ] && ln -sfn "$pkg" "/opt/flagship/node_modules/$name"
            done
        fi
        npx tsc -b 2>&1 | tee /var/log/flagship-tsc.log || true

        # Generate server identity.
        mkdir -p /var/flagship/identity
        chmod 700 /var/flagship/identity
        npx tsx scripts/install-helper.ts gen-identity \\
            --out-priv /var/flagship/identity/identity.priv.hex \\
            --out-pub  /var/flagship/identity/identity.pub.hex \\
            --out-pem  /boot/identity.pem
        chmod 600 /var/flagship/identity/identity.priv.hex /boot/identity.pem
        SERVER_IDENTITY_PRIV_HEX="$(tr -d '\\n' < /var/flagship/identity/identity.priv.hex)"
        SERVER_IDENTITY_PUB_HEX="$(tr -d '\\n' < /var/flagship/identity/identity.pub.hex)"

        # Mint the entitlement bundle the daemon hard-requires on every tunnel
        # HELLO. The RootEntitlement binds this box's STK (the identity pubkey
        # just generated) to its canonical FQDN.
        #
        # INTERIM SELF-SIGN — read this before touching it. The demo path signs
        # the RootEntitlement with the deterministic demo *User IRK*. The real
        # (Burner) path has NO user IRK on the box — the phone holds it — so we
        # SELF-SIGN with the box's own identity key (pass the identity priv as
        # the signer; --pod-pub is that same identity pubkey). This is SAFE today
        # ONLY because the production tunnel hub does NOT verify the RootEntitle-
        # ment's IRK signature: apps/web/src/server.ts wires startTunnelHub with
        # authLookup but no irkLookup, and tunnelHub.ts skips the signature check
        # when irkLookup is absent.
        #
        # FOLLOW-UP REQUIRED before irkLookup is enabled in production: replace
        # this self-signed bundle with a phone-signed one. The proper flow is
        # that after first boot the phone signs an EntitlementBundle for THIS
        # box's STK (identity pubkey) with the user's real IRK and delivers it to
        # /var/flagship/entitlements.json (process restart picks it up). Until
        # then a self-signed bundle would be rejected the moment irkLookup goes
        # live, so this MUST be cut over first.
        npx tsx scripts/install-helper.ts mint-entitlements \\
            --irk-priv "$SERVER_IDENTITY_PRIV_HEX" \\
            --pod-pub "$SERVER_IDENTITY_PUB_HEX" \\
            --username "$USERNAME" \\
            --pod-canonical "$SERVER_DOMAIN" \\
            --out /var/flagship/entitlements.json \\
            || echo "[flagship-bootstrap] WARNING: mint-entitlements failed; daemon will not serve"
        chmod 600 /var/flagship/entitlements.json 2>/dev/null || true

        # Daemon environment. server-daemon reads its two REQUIRED inputs
        # (FLAGSHIP_SUBDOMAIN + FLAGSHIP_IDENTITY_PRIV_HEX) from the process env
        # only; systemd loads this via EnvironmentFile= in the unit below.
        mkdir -p /etc/flagship
        cat > /etc/flagship/daemon.env <<ENVEOF
        FLAGSHIP_SUBDOMAIN=$SERVER_DOMAIN
        FLAGSHIP_IDENTITY_PRIV_HEX=$SERVER_IDENTITY_PRIV_HEX
        ENVEOF
        chmod 600 /etc/flagship/daemon.env

        # Write systemd units. We run inside curtin's in-target chroot where
        # systemd is NOT running, so we ENABLE (drops the symlink, takes effect
        # on first real boot) and never rely on `systemctl start`. Two units:
        #   flagship-first-boot-register — oneshot, POSTs /api/server/register
        #   flagship-daemon              — the long-running server-daemon
        cat > /etc/systemd/system/flagship-daemon.service <<'UNIT'
        [Unit]
        Description=Flagship server daemon
        After=network-online.target flagship-first-boot-register.service
        Wants=network-online.target

        [Service]
        Type=simple
        WorkingDirectory=/opt/flagship
        EnvironmentFile=/etc/flagship/daemon.env
        ExecStart=/usr/bin/npm run start --workspace=@flagship/server-daemon
        Restart=on-failure
        RestartSec=5
        StandardOutput=journal
        StandardError=journal

        [Install]
        WantedBy=multi-user.target
        UNIT

        cat > /etc/systemd/system/flagship-first-boot-register.service <<UNIT
        [Unit]
        Description=Flagship first-boot registration with .com
        After=network-online.target
        Wants=network-online.target
        ConditionPathExists=!/var/flagship/registered.flag

        [Service]
        Type=oneshot
        WorkingDirectory=/opt/flagship
        ExecStart=/usr/local/sbin/flagship-first-boot-register.sh

        [Install]
        WantedBy=multi-user.target
        UNIT

        # The register wrapper as a real script — easier to debug than a
        # multi-line ExecStart with systemd quoting. It signs + POSTs the
        # server-register payload on the first real boot (we deliberately do NOT
        # register inline in the chroot: no guaranteed network during install).
        cat > /usr/local/sbin/flagship-first-boot-register.sh <<'WRAPPER'
        #!/bin/bash
        set -uo pipefail
        exec >>/var/log/flagship-first-boot-register.log 2>&1
        date
        echo "[register] starting"
        cd /opt/flagship
        . /etc/flagship-bootstrap.env
        # Canonical provisioning-status report (POST /api/order/<serial>/status). On the
        # plain path the deferred register is where the registering phase first fires —
        # the encrypted path already reported it inline before its in-target register,
        # so its registered.flag makes this unit skip (no double-emit). Best-effort.
        CONTROL_PLANE_BASE="$(echo "$REGISTRATION_URL" | sed 's|/api/server/register$||')"
        report_phase() {
            curl -fsS -m 8 -X POST -H 'content-type: application/json' \\
                --data '{"phase":"'"$1"'"}' \\
                "$CONTROL_PLANE_BASE/api/order/$AUTH_CODE_SERIAL/status" >/dev/null 2>&1 || true
        }
        report_phase registering
        npx tsx scripts/install-helper.ts sign-server-register \\
            --priv-hex "$SERVER_IDENTITY_PRIV_HEX" \\
            --auth-code-blob /var/flagship/install-blob.json \\
            > /run/register-payload.json
        echo "[register] POST $REGISTRATION_URL"
        curl -fsS -X POST -H "content-type: application/json" \\
            --data @/run/register-payload.json \\
            "$REGISTRATION_URL"
        date > /var/flagship/registered.flag
        echo "[register] done"
        WRAPPER
        chmod +x /usr/local/sbin/flagship-first-boot-register.sh

        # Stash the variables the wrapper needs (the bootstrap has them in scope;
        # systemd's ExecStart sees only the unit's environment).
        cat > /etc/flagship-bootstrap.env <<ENV
        SERVER_DOMAIN=$SERVER_DOMAIN
        USERNAME=$USERNAME
        SERVER_NAME=$SERVER_NAME
        REGISTRATION_URL=$REGISTRATION_URL
        AUTH_CODE_SERIAL=$AUTH_CODE_SERIAL
        SERVER_IDENTITY_PRIV_HEX=$SERVER_IDENTITY_PRIV_HEX
        ENV
        chmod 600 /etc/flagship-bootstrap.env

        # Data-layer first-boot bring-up. The daemon hands every marketplace app a
        # provisioned Postgres/MinIO/Redis via the compose stack in the clone; init.sh
        # generates the secrets file (/var/flagship/data-services.env — the exact path
        # the daemon reads) and `docker compose up -d`s the stack. Run as a gated
        # oneshot AFTER docker is up. Deliberately NOT ordered before flagship-daemon:
        # pulling five images can take minutes and must never delay the box reaching
        # its green padlock — the daemon degrades gracefully ("data layer disabled")
        # until the env file appears and picks it up on its next restart. Best-effort:
        # init.sh's own exit status never gates anything (the containers are already
        # `up -d` by the time its healthcheck wait could time out).
        cat > /etc/systemd/system/flagship-data-services.service <<'UNIT'
        [Unit]
        Description=Flagship data-layer (postgres/minio/redis/forgejo/chromium)
        After=docker.service network-online.target
        Wants=docker.service network-online.target
        ConditionPathExists=!/var/flagship/data-services.env

        [Service]
        Type=oneshot
        RemainAfterExit=yes
        WorkingDirectory=/opt/flagship/installer/data-services
        ExecStart=/opt/flagship/installer/data-services/init.sh

        [Install]
        WantedBy=multi-user.target
        UNIT

        # daemon-reload is a no-op (and may warn) in the install chroot; the
        # enable symlinks are what matter and they persist into the booted
        # system. Do NOT `systemctl start` — systemd isn't the init here.
        systemctl daemon-reload 2>/dev/null || true
        # docker.io's postinst already enables docker/containerd, but enable again
        # explicitly so a recommends-stripped or partial install still comes up.
        systemctl enable docker.service containerd.service 2>/dev/null || \\
            echo "[flagship-bootstrap] WARNING: could not enable docker (daemon will retry network setup on boot)"
        systemctl enable flagship-daemon.service flagship-first-boot-register.service flagship-data-services.service || \\
            echo "[flagship-bootstrap] WARNING: systemctl enable failed (will retry would be needed on real boot)"
        echo "[flagship-bootstrap] systemd units installed + enabled (start deferred to first real boot)"
        \(wifiSafetyNet)
        # Reached the end cleanly — disarm the error trap so the EXIT handler doesn't
        # misfire a terminal error phase on a 0 exit. On the encrypted path the LUKS
        # block is spliced in just ABOVE this line, so the trap still covers the re-key.
        trap - EXIT
        date > /var/flagship/installed.flag
        echo "[flagship-bootstrap] done"

        """
    }

    /// First-boot Wi-Fi SAFETY-NET (the strongest reliability win). A headless
    /// appliance has no console user to fix networking, so even if the primary
    /// config (netplan / networkd+wpa_supplicant) is imperfect, this backstop
    /// guarantees the baked SSID comes up. A oneshot unit runs every boot: it
    /// waits a grace period for a default route and EXITS if one appears (never
    /// fighting a working config), else brings the radio up directly
    /// (wpa_supplicant + DHCP via networkd, with dhclient/dhcpcd/udhcpc
    /// fallbacks) and retries. Both distros (only systemd + wpa_supplicant
    /// assumed). Returns "" with no Wi-Fi, so wired burns are unchanged. SSID/PSK
    /// embedded base64 (injection-safe). Byte-identical to userdata.ts
    /// buildWifiSafetyNetBlock — keep in lockstep.
    static func wifiSafetyNetBlock(ssid: String, password: String) -> String {
        if ssid.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "" }
        let ssidB64 = Data(ssid.utf8).base64EncodedString()
        let pskB64 = Data(password.utf8).base64EncodedString()
        return #"""

        # ── First-boot Wi-Fi safety-net (headless box has no console to fix net) ──
        # Brings up the baked SSID directly IF the box is offline after boot — a backstop
        # behind the primary netplan/networkd config. Only acts when there's no default
        # route, so it never fights a working primary. Credentials embedded base64
        # (injection-safe), decoded to /etc/flagship/wifi.env at 0600.
        mkdir -p /etc/flagship
        cat > /etc/flagship/wifi.env <<'WIFIENV'
        FLAGSHIP_WIFI_SSID_B64=__SSID_B64__
        FLAGSHIP_WIFI_PSK_B64=__PSK_B64__
        WIFIENV
        chmod 600 /etc/flagship/wifi.env

        cat > /usr/local/sbin/flagship-wifi-safetynet.sh <<'SAFETYNET'
        #!/bin/bash
        set -u
        exec >>/var/log/flagship-wifi-safetynet.log 2>&1
        date
        # The initramfs premount's /run log survives the pivot (initramfs-tools moves
        # /run onto the root) — persist a copy where logs belong.
        cp /run/flagship-wifi.log /var/log/flagship-wifi-initramfs.log 2>/dev/null || true
        . /etc/flagship/wifi.env 2>/dev/null || exit 0
        SSID="$(printf '%s' "${FLAGSHIP_WIFI_SSID_B64:-}" | base64 -d 2>/dev/null)"
        PSK="$(printf '%s' "${FLAGSHIP_WIFI_PSK_B64:-}" | base64 -d 2>/dev/null)"
        [ -n "$SSID" ] || { echo "[safety-net] no baked SSID; nothing to do"; exit 0; }
        has_route() { ip route show default 2>/dev/null | grep -q .; }
        # Grace: let the primary config bring up a route (~45s). If it does, do nothing.
        for _ in $(seq 1 15); do
          has_route && { echo "[safety-net] default route present — primary config OK"; exit 0; }
          sleep 3
        done
        echo "[safety-net] still offline after grace — bringing up baked Wi-Fi directly"
        IF=""
        for d in /sys/class/net/*/wireless; do
          [ -e "$d" ] || continue
          IF="$(basename "$(dirname "$d")")"
          break
        done
        if [ -z "$IF" ]; then
          # A loaded wireless core with refcount 0 and no interface = its runtime-
          # requested op-mode module (e.g. iwlmvm) never loaded; a reload re-requests it.
          echo "[safety-net] no wireless interface — reloading idle wireless modules"
          for m in /sys/module/*; do
            m="${m##*/}"
            modinfo -n "$m" 2>/dev/null | grep -q /drivers/net/wireless/ || continue
            [ "$(cat "/sys/module/$m/refcnt" 2>/dev/null || echo 1)" = "0" ] || continue
            echo "[safety-net] reloading $m"
            modprobe -r "$m" 2>/dev/null || true
            modprobe "$m" 2>/dev/null || true
          done
          sleep 5
          for d in /sys/class/net/*/wireless; do
            [ -e "$d" ] || continue
            IF="$(basename "$(dirname "$d")")"
            break
          done
        fi
        [ -n "$IF" ] || { echo "[safety-net] no wireless interface; giving up"; exit 0; }
        echo "[safety-net] interface=$IF ssid=$SSID"
        CONF=/run/flagship-wifi-safetynet.conf
        {
          echo "ctrl_interface=DIR=/run/wpa_supplicant GROUP=netdev"
          echo "country=00"
          echo "network={"
          printf '  ssid="%s"\n' "$SSID"
          printf '  psk="%s"\n' "$PSK"
          echo "  scan_ssid=1"
          echo "}"
        } > "$CONF"
        chmod 600 "$CONF"
        ip link set "$IF" up 2>/dev/null || true
        # Replace any stale supplicant on this iface with ours (idempotent).
        pkill -f "wpa_supplicant.*-i *$IF" 2>/dev/null || true
        sleep 1
        wpa_supplicant -B -i "$IF" -c "$CONF" -Dnl80211,wext 2>/dev/null \
          || wpa_supplicant -B -i "$IF" -c "$CONF" 2>/dev/null || true
        # DHCP: prefer systemd-networkd (present on both distros); leave any existing
        # flagship .network/netplan in place, only add one if neither primary wrote it.
        mkdir -p /etc/systemd/network
        if [ ! -e /etc/systemd/network/10-flagship-wifi.network ] && [ ! -e /etc/netplan/99-flagship-wifi.yaml ]; then
          printf '[Match]\nName=%s\n[Network]\nDHCP=yes\n' "$IF" > /etc/systemd/network/10-flagship-wifi.network
        fi
        systemctl restart systemd-networkd 2>/dev/null || true
        # Retry up to ~60s; fall back to explicit DHCP clients if networkd isn't running.
        for _ in $(seq 1 20); do
          has_route && { echo "[safety-net] default route up"; exit 0; }
          for c in "dhclient -1 $IF" "dhcpcd -t 20 $IF" "udhcpc -i $IF -n -q"; do
            command -v "${c%% *}" >/dev/null 2>&1 && $c >/dev/null 2>&1 && break
          done
          sleep 3
        done
        echo "[safety-net] finished (route up: $(has_route && echo yes || echo no))"
        SAFETYNET
        chmod +x /usr/local/sbin/flagship-wifi-safetynet.sh

        cat > /etc/systemd/system/flagship-wifi-safetynet.service <<'WIFIUNIT'
        [Unit]
        Description=Flagship Wi-Fi safety-net (bring up the baked SSID if the box is offline)
        # Deliberately NO network ordering at all: network-online.target waits for
        # online (defeating the point), and on a Wi-Fi-only box even network.target can
        # be delayed by a wedged network manager — the chicken-and-egg this unit exists
        # to break. The script does its own offline detection + ~45s grace wait, by
        # which time udev has long settled the radio device.
        Before=flagship-first-boot-register.service flagship-daemon.service

        [Service]
        Type=oneshot
        ExecStart=/usr/local/sbin/flagship-wifi-safetynet.sh

        [Install]
        WantedBy=multi-user.target
        WIFIUNIT
        systemctl enable flagship-wifi-safetynet.service 2>/dev/null || \
            echo "[flagship-bootstrap] WARNING: could not enable flagship-wifi-safetynet.service"
        echo "[flagship-bootstrap] Wi-Fi safety-net installed + enabled"

        """#
        .replacingOccurrences(of: "__SSID_B64__", with: ssidB64)
        .replacingOccurrences(of: "__PSK_B64__", with: pskB64)
    }

    /// Escape a string for a single-quoted POSIX-shell scalar (`'...'`).
    /// Identical to userdata.ts shSingleQuote.
    static func shSingleQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    /// INITRAMFS Wi-Fi support for the phone-gated LUKS unlock. The unlock
    /// premount curls the boot relay assuming the network is already up — true on
    /// Ethernet (the initramfs auto-configures wired DHCP) but NOT on Wi-Fi. This
    /// stages the box's actual wl* driver + firmware + wpa_supplicant at
    /// initramfs-build time, and brings the radio up at boot BEFORE
    /// local-top/flagship-unlock runs (init-premount runs strictly first). Fully
    /// best-effort + wall-clock bounded — can NEVER hang the boot. Only emitted on
    /// the Wi-Fi path (creds present); "" on a wired encrypted burn keeps the LUKS
    /// block byte-identical. Creds embedded single-quote-escaped (no base64 in the
    /// initramfs /bin/sh env); they're on the unencrypted /boot regardless.
    /// Byte-identical to userdata.ts buildInitramfsWifiBlock — keep in lockstep.
    static func initramfsWifiBlock(ssid: String, password: String) -> String {
        if ssid.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "" }
        let ssidQ = shSingleQuote(ssid)
        let pskQ = shSingleQuote(password)
        return #"""

        # ── INITRAMFS Wi-Fi (phone-gated unlock needs network in early boot) ────────
        # The unlock premount curls the boot relay; on Wi-Fi the initramfs has NO net
        # unless we bake the radio in. Hook = build-time driver/firmware staging;
        # init-premount = boot-time bring-up, strictly BEFORE local-top/flagship-unlock.
        # Only present on the Wi-Fi path; never blocks boot (Ethernet/recovery still apply).
        apt-get install -y --no-install-recommends wpasupplicant || true

        # OBSERVABILITY: bake the order serial to /boot so the boot-time premount can
        # beacon its accumulated bring-up log home (see the post-DHCP wget below). The
        # serial is the same one the bootstrap's other beacons use ($AUTH_CODE_SERIAL,
        # in scope here); the premount reads the initrd copy the hook stages. Best-effort.
        echo "$AUTH_CODE_SERIAL" > /boot/flagship-beacon-serial 2>/dev/null || true

        cat > /etc/initramfs-tools/hooks/flagship-wifi <<'WIFIHOOK'
        #!/bin/sh
        # Build-time: stage the box's actual wl* driver + firmware + the premount's
        # tools (wpa_supplicant, wpa_cli, ip, wget) into the initramfs. Detection runs
        # HERE (build time, in-target on real hardware) so it reflects this box's radio.
        # Every stage is validated AND logged to /boot/flagship-wifi-build.log (best-
        # effort) so an initrd missing the radio is diagnosable on-box; every stage is
        # guarded so a hiccup never aborts update-initramfs. If the driver can't be
        # resolved, fall back to staging the whole wireless module class (bounded:
        # modules only — per-driver firmware can't be enumerated unprobed).
        PREREQ=""
        prereqs() { echo "$PREREQ"; }
        case "$1" in prereqs) prereqs; exit 0;; esac
        . /usr/share/initramfs-tools/hook-functions
        BLOG=/boot/flagship-wifi-build.log
        blog() { echo "flagship-wifi-hook: $*" >> "$BLOG" 2>/dev/null || true; }
        blog "hook start ($(date 2>/dev/null || echo -))"
        stage_fw() {
          for _v in "" .xz .zst; do
            if [ -f "/lib/firmware/$1$_v" ]; then
              mkdir -p "$DESTDIR/lib/firmware/$(dirname "$1")" 2>/dev/null || true
              if cp -a "/lib/firmware/$1$_v" "$DESTDIR/lib/firmware/$1$_v" 2>/dev/null; then
                blog "firmware staged: $1$_v"
              else
                blog "firmware COPY FAILED: $1$_v"
              fi
              return 0
            fi
          done
          blog "firmware MISSING: $1 (no plain/.xz/.zst variant in /lib/firmware)"
        }
        WLIF=$(ls /sys/class/net 2>/dev/null | grep -E '^wl' | head -1)
        DRV=""
        if [ -n "$WLIF" ]; then
          blog "interface detected: $WLIF"
          DRV=$(basename "$(readlink -f "/sys/class/net/$WLIF/device/driver" 2>/dev/null)" 2>/dev/null)
        else
          blog "NO wl* interface visible at build time"
        fi
        if [ -n "$DRV" ]; then
          blog "driver resolved: $DRV"
          if manual_add_modules "$DRV" 2>/dev/null; then blog "module staged: $DRV"; else blog "module STAGING FAILED: $DRV"; fi
          for _m in "$DRV" $(modprobe --show-depends "$DRV" 2>/dev/null | sed -n 's|^insmod .*/||p' | sed 's|\.ko.*||'); do
            for fw in $(modinfo -F firmware "$_m" 2>/dev/null); do stage_fw "$fw"; done
          done
        else
          blog "driver UNRESOLVED — falling back to the whole wireless module class"
          if copy_modules_dir kernel/drivers/net/wireless 2>/dev/null; then blog "fallback staged: kernel/drivers/net/wireless"; else blog "fallback STAGING FAILED: kernel/drivers/net/wireless"; fi
        fi
        manual_add_modules cfg80211 2>/dev/null || blog "module STAGING FAILED: cfg80211"
        manual_add_modules mac80211 2>/dev/null || blog "module STAGING FAILED: mac80211"
        # Op-mode modules (iwlmvm/iwlmld/iwldvm/...) are REVERSE deps of the core
        # driver — request_module'd at runtime, invisible to manual_add_modules —
        # without them the core loads firmware but never creates an interface. Stage
        # the driver's whole module directory subtree so every op-mode + its deps land.
        d=$(modinfo -n "$DRV" 2>/dev/null)
        case "$d" in
          */kernel/*)
            sub="kernel/${d#*/kernel/}"
            sub=$(dirname "$sub")
            if copy_modules_dir "$sub" 2>/dev/null; then blog "module dir staged: $sub"; else blog "module dir STAGING FAILED: $sub"; fi
            ;;
        esac
        mkdir -p "$DESTDIR/lib/firmware" 2>/dev/null || true
        for r in regulatory.db regulatory.db.p7s; do
          if [ -f "/lib/firmware/$r" ] && cp -a "/lib/firmware/$r" "$DESTDIR/lib/firmware/" 2>/dev/null; then
            blog "staged: $r"
          else
            blog "MISSING: $r"
          fi
        done
        if copy_exec /sbin/wpa_supplicant /sbin/wpa_supplicant 2>/dev/null || copy_exec /usr/sbin/wpa_supplicant /sbin/wpa_supplicant 2>/dev/null; then
          blog "staged: wpa_supplicant"
        else
          blog "MISSING: wpa_supplicant"
        fi
        if copy_exec /sbin/wpa_cli /sbin/wpa_cli 2>/dev/null || copy_exec /usr/sbin/wpa_cli /sbin/wpa_cli 2>/dev/null; then
          blog "staged: wpa_cli"
        else
          blog "MISSING: wpa_cli"
        fi
        if copy_exec /sbin/ip /sbin/ip 2>/dev/null || copy_exec /bin/ip /sbin/ip 2>/dev/null; then
          blog "staged: ip"
        else
          blog "MISSING: ip"
        fi
        # OBSERVABILITY: stage the serial (for the post-DHCP beacon) + the busybox wget
        # the beacon uses, so the boot-time premount can phone its log home.
        mkdir -p "$DESTDIR/boot" 2>/dev/null || true
        if cp /boot/flagship-beacon-serial "$DESTDIR/boot/flagship-beacon-serial" 2>/dev/null; then
          blog "staged: beacon serial"
        else
          blog "MISSING: /boot/flagship-beacon-serial"
        fi
        if copy_exec /bin/wget /bin/wget 2>/dev/null || copy_exec /usr/bin/wget /bin/wget 2>/dev/null; then
          blog "staged: wget"
        else
          blog "MISSING: wget"
        fi
        blog "hook done"
        exit 0
        WIFIHOOK
        chmod +x /etc/initramfs-tools/hooks/flagship-wifi

        mkdir -p /etc/initramfs-tools/scripts/init-premount
        cat > /etc/initramfs-tools/scripts/init-premount/flagship-wifi <<WIFIPREMOUNT
        #!/bin/sh
        # Boot-time: bring the baked Wi-Fi up BEFORE local-top/flagship-unlock curls the
        # relay. Fully best-effort + wall-clock bounded — it can NEVER hang the boot. If
        # the radio doesn't come up it falls through (Ethernet / box-lease / the kept
        # burn-time recovery passphrase still unlock the box). Creds embedded single-
        # quote-escaped (they're on the unencrypted /boot initramfs regardless).
        #
        # OBSERVABILITY (no logic change): every stage tees a timestamped line to BOTH a
        # /run accumulator AND a PERSISTENT log on the unencrypted /boot partition
        # (/dev/disk/by-label/FLAGSHIP_BOOT → /flagship-wifi.log) so a box that hangs at
        # the LUKS prompt is diagnosable after a recovery-passphrase hand-unlock (the
        # no-network case). After DHCP we also best-effort POST the accumulator home (the
        # network-up-but-unlock-still-failed case). Both are \`|| true\`, never block boot.
        PREREQ=""
        prereqs() { echo "\$PREREQ"; }
        case "\$1" in prereqs) prereqs; exit 0;; esac

        WIFI_SSID=__SSID_Q__
        WIFI_PSK=__PSK_Q__

        # OBSERVABILITY: persistent bring-up log on the unencrypted /boot partition.
        # /boot here is the initrd ramdisk (lost on pivot), so mount the REAL boot fs
        # (label FLAGSHIP_BOOT) read-write once. Every \`log_stage\` line is timestamped
        # (uptime seconds + wall-clock when available) and tee'd to the persistent log
        # AND a /run accumulator the post-DHCP beacon posts. Fully best-effort.
        FLAGSHIP_WIFI_LOG=/run/flagship-wifi.log
        FLAGSHIP_BOOTMNT=/run/flagship-bootmnt
        : > "\$FLAGSHIP_WIFI_LOG" 2>/dev/null || true
        mkdir -p "\$FLAGSHIP_BOOTMNT" 2>/dev/null || true
        log_stage() {
          _ts="\$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 0)"
          _wall="\$(date '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || echo -)"
          _line="flagship-wifi [up=\${_ts}s \${_wall}] \$*"
          echo "\$_line" >&2 || true
          echo "\$_line" >> "\$FLAGSHIP_WIFI_LOG" 2>/dev/null || true
          echo "\$_line" >> "\$FLAGSHIP_BOOTMNT/flagship-wifi.log" 2>/dev/null || true
        }
        log_stage "premount start (ssid baked)"

        # The boot fs is found by label; at init-premount udev may not have settled the
        # by-label symlink yet, so wait for it (bounded ~10s) before mounting. Lines
        # logged before the mount accumulate in /run; the cat seeds them into the
        # persistent log once mounted, so the first line is never lost — an EMPTY
        # persistent log can only mean the premount never ran.
        _bdeadline=\$(( \$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 0) + 10 ))
        while [ ! -e /dev/disk/by-label/FLAGSHIP_BOOT ]; do
          [ "\$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 999)" -ge "\$_bdeadline" ] && break
          sleep 1
        done
        if mount /dev/disk/by-label/FLAGSHIP_BOOT "\$FLAGSHIP_BOOTMNT" 2>/dev/null; then
          cat "\$FLAGSHIP_WIFI_LOG" >> "\$FLAGSHIP_BOOTMNT/flagship-wifi.log" 2>/dev/null || true
          log_stage "boot fs mounted (persistent log live)"
        else
          log_stage "boot fs mount FAILED — log stays in /run (survives pivot)"
        fi

        # Re-detect the wl* interface at boot (the name can differ from build time).
        IF=""
        _deadline=\$(( \$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 0) + 30 ))
        while [ -z "\$IF" ]; do
          IF=\$(ls /sys/class/net 2>/dev/null | grep -E '^wl' | head -1)
          [ -n "\$IF" ] && break
          [ "\$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 999)" -ge "\$_deadline" ] && break
          sleep 1
        done
        [ -n "\$IF" ] || { log_stage "no wl* interface in 30s — falling through"; exit 0; }
        log_stage "wl interface detected: \$IF"

        # Load the driver (the hook staged it) and bring the link up.
        DRV=\$(basename "\$(readlink -f /sys/class/net/\$IF/device/driver 2>/dev/null)" 2>/dev/null)
        log_stage "driver resolved: \${DRV:-none}"
        [ -n "\$DRV" ] && modprobe "\$DRV" 2>/dev/null || true
        log_stage "modprobe done (driver=\${DRV:-none})"
        # iwlwifi's op-mode (iwlmvm/iwlmld/iwldvm) is request_module'd at runtime; a
        # miss leaves the core loaded with firmware but no interface. Belt-and-braces.
        if [ "\$DRV" = iwlwifi ]; then
          for m in iwlmvm iwlmld iwldvm; do
            modprobe "\$m" 2>/dev/null && log_stage "op-mode loaded: \$m" && break
          done
        fi
        ip link set "\$IF" up 2>/dev/null || true
        log_stage "link up requested on \$IF (oper=\$(cat /sys/class/net/\$IF/operstate 2>/dev/null || echo unknown))"

        # Associate with the baked SSID.
        printf 'ctrl_interface=/run/wpa_supplicant\nnetwork={\n  ssid="%s"\n  psk="%s"\n  scan_ssid=1\n}\n' \\
          "\$WIFI_SSID" "\$WIFI_PSK" > /run/flagship-wpa.conf 2>/dev/null || true
        wpa_supplicant -B -i "\$IF" -D nl80211,wext -c /run/flagship-wpa.conf 2>/dev/null || true
        log_stage "wpa_supplicant started on \$IF"
        # Bounded ~10s wait to observe the association result (does not change the flow —
        # wpa runs in the background either way; this only records wpa_cli status if any).
        _a=0
        while [ "\$_a" -lt 5 ]; do
          _wstate="\$(wpa_cli -i "\$IF" status 2>/dev/null | sed -n 's/^wpa_state=//p' | head -1)"
          [ "\$_wstate" = "COMPLETED" ] && break
          _a=\$(( _a + 1 ))
          sleep 2
        done
        log_stage "association result: wpa_state=\${_wstate:-unknown}"

        # DHCP, bounded ~20s: prefer klibc ipconfig, fall back to busybox udhcpc.
        if command -v ipconfig >/dev/null 2>&1; then
          log_stage "DHCP method: ipconfig"
          ipconfig -t 20 "\$IF" 2>/dev/null || true
        else
          log_stage "DHCP method: udhcpc"
          _n=0
          while [ "\$_n" -lt 4 ]; do
            udhcpc -i "\$IF" -n -q -t 5 2>/dev/null && break
            _n=\$(( _n + 1 ))
          done
        fi
        _ip="\$(ip -4 -o addr show dev "\$IF" 2>/dev/null | awk '{print \$4}' | head -1)"
        if [ -n "\$_ip" ]; then
          log_stage "DHCP result: assigned \$_ip on \$IF (route=\$(ip route show default 2>/dev/null | head -1))"
        else
          log_stage "DHCP result: FAILED — no IPv4 address on \$IF"
        fi
        # klibc ipconfig records DNS in /run/net-<if>.conf but NOTHING writes
        # /etc/resolv.conf in the initramfs — the unlock curls would die on name
        # resolution even with the route up.
        if [ -n "\$_ip" ]; then
          IPV4DNS0=""
          IPV4DNS1=""
          [ -f "/run/net-\$IF.conf" ] && . "/run/net-\$IF.conf" 2>/dev/null
          _dns=""
          for _d in "\$IPV4DNS0" "\$IPV4DNS1"; do
            [ -n "\$_d" ] && [ "\$_d" != "0.0.0.0" ] && _dns="\$_dns \$_d"
          done
          : > /etc/resolv.conf 2>/dev/null || true
          for _d in \$_dns; do
            echo "nameserver \$_d" >> /etc/resolv.conf 2>/dev/null || true
          done
          if [ -s /etc/resolv.conf ]; then
            log_stage "dns configured:\$_dns"
          else
            printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > /etc/resolv.conf 2>/dev/null || true
            log_stage "dns fallback: public resolvers"
          fi
        fi
        log_stage "bring-up attempt complete on \$IF"

        # OBSERVABILITY: now that the network is (maybe) up, best-effort POST the whole
        # accumulated bring-up log to the dev late-log endpoint — the SAME channel + the
        # SAME busybox-wget --post-file form the bootstrap's other dev beacons use, keyed
        # <serial>-wifi. Covers the network-came-up-but-unlock-still-failed case. Wrapped
        # so a down/just-coming-up network never blocks the imminent unlock relay.
        _serial="\$(cat /boot/flagship-beacon-serial 2>/dev/null | tr -cd 'A-Za-z0-9._:-')"
        if [ -n "\$_serial" ] && [ -n "\$_ip" ]; then
          ( wget -q -O- --post-file="\$FLAGSHIP_WIFI_LOG" --timeout=15 \\
              "https://flagshipserver.com/api/dev/late-log/\${_serial}-wifi" 2>/dev/null; ) || true
        fi
        umount "\$FLAGSHIP_BOOTMNT" 2>/dev/null || true
        exit 0
        WIFIPREMOUNT
        chmod +x /etc/initramfs-tools/scripts/init-premount/flagship-wifi
        echo "[flagship-bootstrap] initramfs Wi-Fi hook + premount installed (runs before the unlock relay)"

        """#
        .replacingOccurrences(of: "__SSID_Q__", with: ssidQ)
        .replacingOccurrences(of: "__PSK_Q__", with: pskQ)
    }

    /// `mode` is the phone-signed boot-unlock policy
    /// (docs/security-phone-as-unlock-endpoint.md §7a.1). Baked to
    /// /boot/flagship-boot-unlock-mode; the premount script branches on it
    /// ("auto" = box-lease then relay; "approve" = relay every boot, no lease).
    /// Byte-identical to userdata.ts buildLuksBootstrapBlock(mode, family).
    /// `family` adapts ONLY the LVM-on-LUKS unlock (Debian); Ubuntu (default)
    /// renders the original literals so the cross-language pins hold.
    static func luksBootstrapBlock(mode: String = "auto", bootHost: String = defaultBootHost, family: String = "ubuntu", wifiSSID: String = "", wifiPassword: String = "") -> String {
        // INITRAMFS Wi-Fi: only on the Wi-Fi path (creds present). Emitted just
        // before update-initramfs so the hook + premount land in the rebuilt
        // initrd. Empty on a wired encrypted burn ⇒ byte-identical to before.
        let initramfsWifi = initramfsWifiBlock(ssid: wifiSSID, password: wifiPassword)
        // The only family-specific lines (mirror userdata.ts). Ubuntu = plain
        // LUKS; Debian = LVM-on-LUKS (stage lvm + vgchange after luksOpen +
        // discover the raw LUKS partition by type, label is inside the container).
        let lvmCopyExec = family == "debian"
            ? """
            copy_exec /sbin/cryptsetup /sbin/cryptsetup 2>/dev/null || copy_exec /usr/sbin/cryptsetup /sbin/cryptsetup
            copy_exec /sbin/lvm /sbin/lvm 2>/dev/null || copy_exec /usr/sbin/lvm /sbin/lvm
            """
            : "copy_exec /sbin/cryptsetup /sbin/cryptsetup 2>/dev/null || copy_exec /usr/sbin/cryptsetup /sbin/cryptsetup"
        let terminalUnlock = family == "debian"
            ? #"""
            ROOT_LUKS_PART="$(blkid -t TYPE=crypto_LUKS -o device | head -n1)"
            # Open under the CRYPTTAB target name (the installer named it e.g. sda4_crypt).
            # Debian's local-top/cryptroot runs after us (its prereqs() lists every other
            # local-top script) and skips an already-active target — but only under ITS
            # name. Opening as flagship_root left cryptroot prompting for a passphrase
            # against an in-use device: boot hung forever (proven on metal 2026-06-12).
            CRYPT_NAME="$(sed -n 's/^[[:space:]]*\([^#][^[:space:]]*\)[[:space:]].*/\1/p' /cryptroot/crypttab 2>/dev/null | head -n1)"
            [ -n "$CRYPT_NAME" ] || CRYPT_NAME=flagship_root
            xxd -r -p "$OUT_UNLOCK" | cryptsetup luksOpen --key-file - "$ROOT_LUKS_PART" "$CRYPT_NAME"
            lvm vgchange -ay 2>/dev/null || vgchange -ay 2>/dev/null || true
            shred -u "$OUT_UNLOCK" 2>/dev/null || rm -f "$OUT_UNLOCK"
            """#
            : """
            ROOT_PART=/dev/disk/by-label/FLAGSHIP_ROOT
            xxd -r -p "$OUT_UNLOCK" | cryptsetup luksOpen --key-file - "$ROOT_PART" flagship_root
            shred -u "$OUT_UNLOCK" 2>/dev/null || rm -f "$OUT_UNLOCK"
            """
        return """

        # ── EXPERIMENTAL: LUKS-on-root, phone-gated unlock (encryptRoot) ─────────
        # Needs live validation; brick risk. This whole block is absent on the
        # default unencrypted path. docs/security-phone-as-unlock-endpoint.md.
        echo "[flagship-bootstrap] encryptRoot ON — configuring phone-gated LUKS unlock"

        # Fail-closed: the re-key below is DESTRUCTIVE (it removes the burn passphrase
        # and shreds the only plaintext key). Refuse unless the recipe actually parsed —
        # empty values once sealed a disk to nothing and bricked a box (jq was missing).
        if [ -z "$SERVER_DOMAIN" ] || [ "$SERVER_DOMAIN" = "null" ] || [ -z "$PHONE_DELEGATED_PUBKEY" ] || [ "$PHONE_DELEGATED_PUBKEY" = "null" ]; then
            echo "[flagship-bootstrap] FATAL: empty SERVER_DOMAIN/PHONE_DELEGATED_PUBKEY — refusing LUKS re-key (would brick the box)"
            exit 1
        fi

        # REGISTER FIRST. The sealed-key upload (step B) requires the server to ALREADY be
        # registered with .com — luksKeys.ts returns 404 "unknown server" otherwise (it
        # verifies the upload against the registered server identity). The auth-code is
        # single-use, so we write registered.flag and the deferred first-boot register
        # service (guarded by !registered.flag) skips. Network is up here (apt + git +
        # npm already used it). Fail-closed: a failure aborts BEFORE the destructive
        # re-key, so the burn passphrase still opens the disk (recoverable).
        # NOTE (design): docs/security-phone-as-unlock-endpoint.md describes first-boot
        # registration, but the seal/upload runs in-target — so registration must run
        # in-target too, before it. Keeping register+seal together is the invariant.
        report_phase registering
        echo "[flagship-bootstrap] registering server with .com (prereq for sealed-key upload)"
        npx tsx scripts/install-helper.ts sign-server-register \\
            --priv-hex "$SERVER_IDENTITY_PRIV_HEX" \\
            --auth-code-blob /var/flagship/install-blob.json \\
            > /run/register-payload.json
        if ! curl -fsS -X POST -H 'content-type: application/json' \\
            --data @/run/register-payload.json "$REGISTRATION_URL"; then
            echo "[flagship-bootstrap] FATAL: registration failed — keeping burn passphrase (recoverable), aborting"
            exit 1
        fi
        date > /var/flagship/registered.flag
        echo "[flagship-bootstrap] registered with .com"

        # A. ADD a fresh random key (install.sh's head -c 64 /dev/urandom pattern),
        #    authorized by the burn-time passphrase. NON-destructive: the burn passphrase
        #    still opens the disk until step C, so any failure below stays recoverable.
        LUKS_BURN_PASSPHRASE='\(burnPassphrase)'
        LUKS_KEY=/run/flagship-luks.key
        head -c 64 /dev/urandom > "$LUKS_KEY"
        chmod 600 "$LUKS_KEY"
        # The encrypted root partition (curtin labelled the filesystem FLAGSHIP_ROOT;
        # the underlying LUKS container is its parent block device).
        ROOT_LUKS_PART="$(blkid -t TYPE=crypto_LUKS -o device | head -n1)"
        if [ -z "$ROOT_LUKS_PART" ]; then
            echo "[flagship-bootstrap] FATAL: no crypto_LUKS partition found; cannot re-key"
            exit 1
        fi
        echo "[flagship-bootstrap] adding random LUKS key on $ROOT_LUKS_PART"
        printf '%s' "$LUKS_BURN_PASSPHRASE" | \\
            cryptsetup luksAddKey "$ROOT_LUKS_PART" "$LUKS_KEY" --key-file=-

        # B. SEAL the random key for the phone + upload to .com — BEFORE removing the
        #    burn passphrase, so a seal/upload failure leaves the box still openable
        #    (recoverable) instead of bricked. .com stores ciphertext only.
        #
        #    Seal to the account IRK (the blob's authCode.userPubKey) — a key the phone
        #    can re-derive at unlock time (Keystore.deriveIRK) AND that survives cloud
        #    recovery. NOT phoneDelegatedPubKey: the phone generates that per-server
        #    keypair at create-time and DISCARDS the private half, so a disk key sealed
        #    to it could NEVER be unsealed by any phone (the bug that made phone-approval
        #    unlock fail with "couldn't unseal the disk key with this phone's keys").
        report_phase sealing
        USER_PUB_HEX="$(jq -r .authCode.userPubKey "$BLOB_JSON")"
        SEALED_LUKS_KEY_HEX="$(npx tsx scripts/install-helper.ts seal-for-bak \\
            --bak-ed25519-pub "$USER_PUB_HEX" \\
            --in "$LUKS_KEY" | tr -d '\\n')"
        if [ -z "$SEALED_LUKS_KEY_HEX" ]; then
            echo "[flagship-bootstrap] FATAL: seal-for-bak produced nothing — keeping burn passphrase + plaintext key (recoverable), aborting"
            exit 1
        fi
        NOW_MS=$(date +%s%3N)
        npx tsx scripts/install-helper.ts sign-sealed-key \\
            --priv "$SERVER_IDENTITY_PRIV_HEX" \\
            --server-id "$SERVER_DOMAIN" \\
            --sealed-hex "$SEALED_LUKS_KEY_HEX" \\
            --issued-at "$NOW_MS" \\
            > /run/sealed-key-payload.json
        CONTROL_PLANE_BASE="$(echo "$REGISTRATION_URL" | sed 's|/api/server/register$||')"
        if ! curl -fsS -X POST -H 'content-type: application/json' \\
            --data @/run/sealed-key-payload.json \\
            "${CONTROL_PLANE_BASE}/api/server/${SERVER_DOMAIN}/sealed-luks-key"; then
            echo "[flagship-bootstrap] FATAL: sealed-key upload failed — keeping burn passphrase (recoverable), aborting"
            exit 1
        fi

        # C. The phone-sealed key is safely stored. Normally we'd now remove the burn
        #    passphrase so the phone is the ONLY unlock.
        #
        #    BRING-UP SAFETY NET: keep the burn-time passphrase slot so a box whose
        #    phone/WiFi auto-unlock doesn't engage can still be unlocked by hand. REMOVE
        #    before GA (it's a known constant). The luksRemoveKey is guarded off (the
        #    `if false` never runs) rather than deleted, so the GA cut is a one-line flip.
        if false; then
            printf '%s' "$LUKS_BURN_PASSPHRASE" | \\
                cryptsetup luksRemoveKey "$ROOT_LUKS_PART" --key-file=-
            echo "[flagship-bootstrap] LUKS re-keyed; burn-time passphrase removed"
        fi
        echo "[flagship-bootstrap] phone-sealed key stored; burn-time passphrase KEPT as a bring-up recovery slot (remove before GA)"
        shred -u "$LUKS_KEY" 2>/dev/null || rm -f "$LUKS_KEY"

        # /boot facts the initramfs unlock hook reads on every boot (mirrors the
        # files boot-stage.sh expects: server-domain, identity.pem, boot host).
        echo "$SERVER_DOMAIN" > /boot/server-domain
        echo "$CONTROL_PLANE_BASE" > /boot/control-plane-url
        # The dedicated boot worker the unlock hook talks to (lease GET / approval
        # request POST / response poll). Baked so an enterprise clone can override it
        # without touching code — mirrors /boot/flagship-boot-unlock-mode. Default is
        # boot.flagshipserver.com.
        echo "\(bootHost)" > /boot/flagship-boot-host
        # The identity PKCS8 PEM is already at /boot/identity.pem (gen-identity --out-pem).

        # Boot-unlock policy (docs/security-phone-as-unlock-endpoint.md §7a.1). Baked
        # from the phone-signed InstallBlob.bootUnlockMode (absent ⇒ "auto"). The
        # initramfs premount script reads this on every boot (defaults to "auto" if the
        # file is absent) and branches: "auto" self-unlocks via a box-sealed lease then
        # falls back to the phone-gated relay; "approve" uses the relay EVERY boot and
        # never touches a lease. The box NEVER deposits a lease itself.
        echo "\(mode)" > /boot/flagship-boot-unlock-mode

        # C1. BAKE the unseal helper to /boot/flagship-unseal. Build-at-install from
        #     the cloned source (auditable; no committed binary). golang-go from the
        #     Ubuntu archive can build the CGO-free static helper (one dep, pinned).
        echo "[flagship-bootstrap] building flagship-unseal from source"
        apt-get install -y --no-install-recommends golang-go
        ( cd /opt/flagship/installer/unseal-helper && \\
          CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \\
            go build -trimpath -buildvcs=false -ldflags '-s -w' -o /boot/flagship-unseal . )
        chmod 755 /boot/flagship-unseal
        echo "[flagship-bootstrap] /boot/flagship-unseal baked ($(ls -l /boot/flagship-unseal))"

        # C2. INITRAMFS HOOK. The hook copies the tools + helper into the initramfs;
        #     the premount script runs unlock_via_relay() (lifted verbatim from
        #     boot-stage.sh) before the root is mounted, then luksOpen's it.
        mkdir -p /etc/initramfs-tools/hooks /etc/initramfs-tools/scripts/local-top
        cat > /etc/initramfs-tools/hooks/flagship-unlock <<'HOOK'
        #!/bin/sh
        # Flagship initramfs hook: stage the unseal helper + identity + the crypto
        # tools unlock_via_relay() needs (openssl curl xxd sed cryptsetup) into the
        # initramfs, so the root can be unlocked pre-pivot with no encrypted-root deps.
        set -e
        PREREQ=""
        prereqs() { echo "$PREREQ"; }
        case "$1" in prereqs) prereqs; exit 0;; esac
        . /usr/share/initramfs-tools/hook-functions
        copy_exec /boot/flagship-unseal /bin/flagship-unseal
        copy_exec /usr/bin/openssl /bin/openssl
        copy_exec /usr/bin/curl /bin/curl
        copy_exec /usr/bin/xxd /bin/xxd
        copy_exec /bin/sed /bin/sed 2>/dev/null || copy_exec /usr/bin/sed /bin/sed
        # ip powers the premount's net-ensure (route check / link up / carrier read);
        # a wired initrd does not stage it otherwise.
        copy_exec /sbin/ip /sbin/ip 2>/dev/null || copy_exec /bin/ip /sbin/ip
        # Resolver plumbing for the glibc-linked curl: copy_exec's ldd walk never
        # sees the dlopen'd NSS modules, and the initrd ships no nsswitch.conf —
        # proven on metal: route + /etc/resolv.conf up yet curl(6) could-not-resolve.
        # On glibc >= 2.34 dns/files are built into libc and the .so files are
        # absent; the guards make that a no-op.
        mkdir -p "${DESTDIR}/etc"
        echo "hosts: files dns" > "${DESTDIR}/etc/nsswitch.conf"
        for _nss in /lib/x86_64-linux-gnu/libnss_dns.so.2 /lib/x86_64-linux-gnu/libnss_files.so.2 /lib/x86_64-linux-gnu/libresolv.so.2; do
          [ -e "$_nss" ] && copy_exec "$_nss" || true
        done
        # CA bundle for the HTTPS unlock curls — copy_exec stages the curl binary but
        # never the trust store data file; proven on metal once DNS resolved (curl(77)
        # error setting certificate file /etc/ssl/certs/ca-certificates.crt).
        mkdir -p "${DESTDIR}/etc/ssl/certs"
        cp /etc/ssl/certs/ca-certificates.crt "${DESTDIR}/etc/ssl/certs/ca-certificates.crt" 2>/dev/null || true
        \(lvmCopyExec)
        # Identity + boot facts the premount script signs/reads with.
        mkdir -p "${DESTDIR}/boot"
        cp /boot/identity.pem "${DESTDIR}/boot/identity.pem"
        cp /boot/server-domain "${DESTDIR}/boot/server-domain"
        cp /boot/control-plane-url "${DESTDIR}/boot/control-plane-url" 2>/dev/null || true
        cp /boot/flagship-boot-host "${DESTDIR}/boot/flagship-boot-host" 2>/dev/null || true
        cp /boot/flagship-boot-unlock-mode "${DESTDIR}/boot/flagship-boot-unlock-mode" 2>/dev/null || true
        HOOK
        chmod +x /etc/initramfs-tools/hooks/flagship-unlock

        # The premount script. unlock_via_relay() below is LIFTED VERBATIM from
        # installer/boot-stage.sh (wave 3b owns its logic); only the surrounding
        # scaffolding (paths, the luksOpen target, the fallback poll) is adapted to
        # the initramfs. Keep the function body in sync with boot-stage.sh.
        cat > /etc/initramfs-tools/scripts/local-top/flagship-unlock <<'PREMOUNT'
        #!/bin/sh
        PREREQ=""
        prereqs() { echo "$PREREQ"; }
        case "$1" in prereqs) prereqs; exit 0;; esac

        set -eu
        SERVER_DOMAIN="$(cat /boot/server-domain)"
        # The dedicated boot worker (boot.flagshipserver.com), baked by the bootstrap.
        # Configurable so an enterprise clone can repoint it without touching code.
        BOOT_HOST="$(cat /boot/flagship-boot-host 2>/dev/null || echo https://boot.flagshipserver.com)"
        BOOT_HOST="${BOOT_HOST%/}"
        IDENTITY_KEY=/boot/identity.pem
        UNSEAL_HELPER=/bin/flagship-unseal
        RELAY_WINDOW_SECS="${FLAGSHIP_RELAY_WINDOW_SECS:-31536000}"
        OUT_UNLOCK=/run/unlock-key
        # Boot-unlock policy (docs/security-phone-as-unlock-endpoint.md §7a.1).
        # Baked by the bootstrap; default "auto" if the file is absent.
        BOOT_UNLOCK_MODE="$(cat /boot/flagship-boot-unlock-mode 2>/dev/null || echo auto)"

        # One-shot lock marker (packages/server-daemon BootUnlockModeSuppressor). The
        # daemon writes /boot/flagship-lock-once at RUNTIME (manual "Lock and restart"
        # or a dead-man lapse), so it lives on the LIVE FLAGSHIP_BOOT partition, NOT in
        # the frozen initrd copy the hook staged — mount that partition here to see it.
        # Present ⇒ force the approve relay for THIS boot, consumed only after a
        # successful luksOpen below so a failed unlock keeps it armed for the retry.
        # This is the SAME decision point boot-stage.sh makes for the unencrypted path;
        # on an encrypted box only THIS premount runs, so the marker is never
        # double-consumed. Best-effort throughout — it can never fail or hang the boot.
        LOCK_ONCE_MOUNT=/run/flagship-lockmnt
        LOCK_ONCE_FILE="$LOCK_ONCE_MOUNT/flagship-lock-once"
        LOCK_ONCE="no"
        mkdir -p "$LOCK_ONCE_MOUNT" 2>/dev/null || true
        if mount /dev/disk/by-label/FLAGSHIP_BOOT "$LOCK_ONCE_MOUNT" 2>/dev/null; then
            if [ -f "$LOCK_ONCE_FILE" ]; then LOCK_ONCE="yes"; fi
        else
            LOCK_ONCE_MOUNT=""
        fi

        [ -f "$IDENTITY_KEY" ] || { echo "flagship: missing $IDENTITY_KEY"; exit 0; }

        sign_canonical() {
            canonical="$1"
            msgfile="/run/flagship-sign-msg.bin"
            printf '%s' "$canonical" > "$msgfile"
            openssl pkeyutl -sign -rawin -inkey "$IDENTITY_KEY" -in "$msgfile" 2>/dev/null \\
                | xxd -p -c 256 | tr -d '\\n'
            rm -f "$msgfile"
        }
        identity_seed_hex() {
            openssl pkey -in "$IDENTITY_KEY" -outform DER 2>/dev/null \\
                | xxd -p -c 256 | tr -d '\\n' | tail -c 64
        }
        identity_pub_hex() {
            openssl pkey -in "$IDENTITY_KEY" -pubout -outform DER 2>/dev/null \\
                | xxd -p -c 256 | tr -d '\\n' | tail -c 64
        }

        # base64url-encode stdin (base64 then +→-, /→_, strip trailing '=') — the
        # encoding apps/boot/src/gate.ts parses the Authorization payload as.
        b64url() {
            openssl base64 -A | tr '+/' '-_' | tr -d '='
        }

        # Epoch milliseconds, PORTABLE. The full OS has GNU date (`%3N` = millis), but
        # the initramfs has busybox date, which prints `%N` LITERALLY — that injected a
        # non-numeric issuedAt into the signed envelope + body JSON, so the boot worker
        # rejected BOTH as malformed (proven on metal). Use %3N only when it yields pure
        # digits; otherwise fall back to whole seconds × 1000.
        now_ms() {
            _ms=$(date +%s%3N 2>/dev/null)
            case "$_ms" in
                ''|*[!0-9]*) _ms=$(( $(date +%s) * 1000 ));;
            esac
            echo "$_ms"
        }

        # Build the box-STK `Authorization: Flagship-Boot-v1 <b64url(json)>` header
        # value. Bound to (method, path, serverDomain); Ed25519 over the canonical bytes
        #   flagship/boot-auth/v1|box|<serverDomain>|<METHOD>|<path>|<pub>|<nonce>|<issuedAt>
        # Kept in sync with installer/boot-stage.sh + apps/boot/src/gate.ts.
        # Args: $1 = HTTP method (uppercase), $2 = request path (no query).
        # Uses PUB_HEX (the box STK pub) from the calling scope.
        sign_box_auth_header() {
            _bm="$1"
            _bp="$2"
            _bnonce=$(head -c 32 /dev/urandom | xxd -p -c 256 | tr -d '\\n')
            _bnow=$(now_ms)
            _bcanon="flagship/boot-auth/v1|box|${SERVER_DOMAIN}|${_bm}|${_bp}|${PUB_HEX}|${_bnonce}|${_bnow}"
            _bsig="$(sign_canonical "$_bcanon")"
            _bjson="$(printf '{"role":"box","serverDomain":"%s","method":"%s","path":"%s","pubKeyHex":"%s","nonceHex":"%s","issuedAt":%s,"signatureHex":"%s"}' \\
                "$SERVER_DOMAIN" "$_bm" "$_bp" "$PUB_HEX" "$_bnonce" "$_bnow" "$_bsig")"
            printf 'Flagship-Boot-v1 %s' "$(printf '%s' "$_bjson" | b64url)"
        }

        # ── unlock_via_box_lease() — LIFTED VERBATIM from installer/boot-stage.sh ──
        # Self-unlock on the "auto" path: GET the box-sealed lease from the boot worker
        # and unseal it LOCALLY with the STK key on /boot. The worker holds ciphertext
        # only (I1). No phone, no human. Returns 0 only if it actually unsealed; 404/empty
        # (first boot, or a revoked lease) ⇒ non-zero so the caller falls back to the relay.
        unlock_via_box_lease() {
            if [ ! -x "$UNSEAL_HELPER" ]; then
                echo "flagship: box-lease unavailable — $UNSEAL_HELPER missing/not executable"
                return 1
            fi
            SEED_HEX="$(identity_seed_hex)"
            PUB_HEX="$(identity_pub_hex)"
            if [ "${#SEED_HEX}" != 64 ] || [ "${#PUB_HEX}" != 64 ]; then
                echo "flagship: box-lease aborted — could not derive 32-byte seed/pub from $IDENTITY_KEY"
                return 1
            fi

            # GET /api/boot/lease/:serverDomain — box-STK gated.
            LEASE_PATH="/api/boot/lease/${SERVER_DOMAIN}"
            LEASE_URL="${BOOT_HOST}${LEASE_PATH}"
            LEASE_AUTH="$(sign_box_auth_header GET "$LEASE_PATH")"
            LEASE_RESP=/run/flagship-lease-v2.json
            LEASE_CODE=$(curl -sS -o "$LEASE_RESP" -w "%{http_code}" \\
                -H "Authorization: $LEASE_AUTH" \\
                --max-time 30 "$LEASE_URL" || echo "000")
            if [ "$LEASE_CODE" = "404" ]; then
                echo "flagship: no box-sealed lease (HTTP 404) — falling back"
                return 1
            fi
            if [ "$LEASE_CODE" != "200" ]; then
                echo "flagship: box-lease HTTP $LEASE_CODE; body: $(head -c 200 "$LEASE_RESP" 2>/dev/null)"
                return 1
            fi

            # The boot worker returns {serverDomain,leaseId,stkPub,sealedKey,...};
            # sealedKey is the box-sealed LUKS key (hex). Extract it the same way
            # unlock_via_relay() extracts "sealed". The box unseals it locally.
            SEALED_KEY=$(sed -n 's/.*"sealedKey":"\\([0-9a-fA-F]*\\)".*/\\1/p' "$LEASE_RESP")
            if [ -z "$SEALED_KEY" ]; then
                echo "flagship: box-lease 200 but no sealedKey: $(head -c 200 "$LEASE_RESP")"
                return 1
            fi

            if "$UNSEAL_HELPER" --identity-priv-hex "$SEED_HEX" --sealed-hex "$SEALED_KEY" \\
                > "$OUT_UNLOCK.hex" 2>/run/flagship-unseal.err; then
                tr -d '\\n' < "$OUT_UNLOCK.hex" > "$OUT_UNLOCK"
                chmod 600 "$OUT_UNLOCK"
                rm -f "$OUT_UNLOCK.hex"
                echo "flagship: self-unlocked from the box-sealed lease"
                return 0
            fi
            echo "flagship: $UNSEAL_HELPER failed on box-lease: $(head -c 200 /run/flagship-unseal.err 2>/dev/null)"
            rm -f "$OUT_UNLOCK.hex"
            return 1
        }

        # ── unlock_via_relay() — LIFTED VERBATIM from installer/boot-stage.sh ──────
        unlock_via_relay() {
            if [ ! -x "$UNSEAL_HELPER" ]; then
                echo "flagship: relay unavailable — $UNSEAL_HELPER missing/not executable"
                return 1
            fi

            SEED_HEX="$(identity_seed_hex)"
            PUB_HEX="$(identity_pub_hex)"
            if [ "${#SEED_HEX}" != 64 ] || [ "${#PUB_HEX}" != 64 ]; then
                echo "flagship: relay aborted — could not derive 32-byte seed/pub from $IDENTITY_KEY"
                return 1
            fi

            NONCE=$(head -c 32 /dev/urandom | xxd -p -c 256 | tr -d '\\n')
            NOW_MS=$(now_ms)
            # The SecretRequest body keeps its OWN STK signature (unchanged).
            # NONCE/NOW_MS/CANONICAL/SIG/REQ_BODY are built ONCE here and reused for every
            # (re-)announce — a heartbeat re-POST replays the SAME signed envelope.
            CANONICAL="flagship/secret-request/v1|${SERVER_DOMAIN}|${PUB_HEX}|unlock-key|${NONCE}|${NOW_MS}"
            SIG="$(sign_canonical "$CANONICAL")"

            # POST /api/boot/request — box-STK gated. Body carries the box's STK-signed
            # SecretRequest (its own signature, separate from the box-auth header).
            REQ_PATH="/api/boot/request"
            REQ_URL="${BOOT_HOST}${REQ_PATH}"
            REQ_BODY=$(printf '{"request":{"serverDomain":"%s","stkPub":"%s","purpose":"unlock-key","nonce":"%s","issuedAt":%s},"signature":"%s"}' \\
                "$SERVER_DOMAIN" "$PUB_HEX" "$NONCE" "$NOW_MS" "$SIG")

            # post_request: (re-)announce the SAME signed REQ_BODY with a FRESH box-auth
            # header. Idempotent on the worker (same nonce) — the first call parks the
            # request + pushes the phone; later calls only refresh the parked row's TTL.
            post_request() {
                POST_RESP=/run/flagship-secret-request-resp.json
                REQ_AUTH="$(sign_box_auth_header POST "$REQ_PATH")"
                POST_CODE=$(curl -sS -o "$POST_RESP" -w "%{http_code}" \\
                    -X POST -H 'content-type: application/json' \\
                    -H "Authorization: $REQ_AUTH" \\
                    --max-time 30 -d "$REQ_BODY" "$REQ_URL" || echo "000")
                [ "$POST_CODE" = "200" ]
            }

            # Initial announce. A failed FIRST announce is fatal (fall through to manual);
            # later heartbeat re-announce failures are non-fatal — we keep polling.
            if ! post_request; then
                echo "flagship: relay boot-request HTTP $POST_CODE; body: $(head -c 200 "$POST_RESP" 2>/dev/null)"
                return 1
            fi
            echo "flagship: posted unlock-key boot-request; waiting for phone approval (type 'manual' then Enter to unlock by passphrase)"

            # GET /api/boot/response/:serverDomain/:nonce — box-STK gated, polled. The
            # nonce is a PATH segment now (bound into the signed Authorization envelope),
            # so a fresh header is signed per poll.
            POLL_PATH="/api/boot/response/${SERVER_DOMAIN}/${NONCE}"
            POLL_URL="${BOOT_HOST}${POLL_PATH}"
            # Effectively wait forever for the phone (default ~1 year); the DEADLINE is a
            # backstop so an env override (FLAGSHIP_RELAY_WINDOW_SECS) can still bound it.
            DEADLINE=$(( $(date +%s) + RELAY_WINDOW_SECS ))
            # Re-announce the parked request every HEARTBEAT_SECS so a short worker TTL
            # stays alive while we wait; when the box powers off the TTL lapses and the
            # phone honestly sees "box stopped".
            HEARTBEAT_SECS="${FLAGSHIP_RELAY_HEARTBEAT_SECS:-120}"
            LAST_ANNOUNCE=$(date +%s)
            ATTEMPT=0
            while [ "$(date +%s)" -lt "$DEADLINE" ]; do
                ATTEMPT=$((ATTEMPT + 1))
                RESP=/run/flagship-secret-response.json
                POLL_AUTH="$(sign_box_auth_header GET "$POLL_PATH")"
                CODE=$(curl -sS -o "$RESP" -w "%{http_code}" \\
                    -H "Authorization: $POLL_AUTH" \\
                    --max-time 30 "$POLL_URL" || echo "000")

                if [ "$CODE" = "200" ]; then
                    SEALED=$(sed -n 's/.*"sealed":"\\([0-9a-fA-F]*\\)".*/\\1/p' "$RESP")
                    if [ -z "$SEALED" ]; then
                        echo "flagship: relay 200 but no sealed payload: $(head -c 200 "$RESP")"
                        return 1
                    fi
                    HELPER_JSON=/run/flagship-unseal-input.json
                    printf '{"serverDomain":"%s","requestNonceHex":"%s","purpose":"unlock-key","sealedHex":"%s","issuedAt":0}' \\
                        "$SERVER_DOMAIN" "$NONCE" "$SEALED" > "$HELPER_JSON"

                    if "$UNSEAL_HELPER" --identity-priv-hex "$SEED_HEX" --response-json "$HELPER_JSON" \\
                        > "$OUT_UNLOCK.hex" 2>/run/flagship-unseal.err; then
                        tr -d '\\n' < "$OUT_UNLOCK.hex" > "$OUT_UNLOCK"
                        chmod 600 "$OUT_UNLOCK"
                        rm -f "$OUT_UNLOCK.hex" "$HELPER_JSON"
                        echo "flagship: relay unsealed the unlock key (attempt $ATTEMPT)"
                        return 0
                    fi
                    echo "flagship: $UNSEAL_HELPER failed: $(head -c 200 /run/flagship-unseal.err 2>/dev/null)"
                    rm -f "$OUT_UNLOCK.hex" "$HELPER_JSON"
                    return 1
                elif [ "$CODE" = "404" ]; then
                    : # no reply yet — expected; keep polling
                else
                    # Transient non-200 — we wait forever now, so log and keep polling.
                    echo "flagship: relay boot-response HTTP $CODE; body: $(head -c 200 "$RESP" 2>/dev/null)"
                fi

                # Heartbeat: re-announce the parked request to refresh its TTL. A failed
                # re-post is non-fatal — keep polling.
                if [ $(( $(date +%s) - LAST_ANNOUNCE )) -ge "$HEARTBEAT_SECS" ]; then
                    if post_request; then
                        echo "flagship: heartbeat re-announced boot-request (TTL refreshed)"
                    else
                        echo "flagship: heartbeat re-announce failed (HTTP $POST_CODE); continuing"
                    fi
                    LAST_ANNOUNCE=$(date +%s)
                fi

                BACKOFF=$((ATTEMPT < 6 ? ATTEMPT * 3 : 15))
                echo "flagship: no phone reply yet (attempt $ATTEMPT); waiting $BACKOFF (type 'manual' then Enter to unlock by passphrase)"
                # Interruptible wait: any line typed on the console (e.g. Enter) drops to
                # the manual disk passphrase prompt. On a headless box read -t blocks for
                # BACKOFF and times out (acts as the sleep) — so it waits forever.
                if read -t "$BACKOFF" -r _key < /dev/console 2>/dev/null && [ "$_key" = "manual" ]; then
                    echo "flagship: manual unlock selected — falling through to the disk passphrase prompt"
                    return 1
                fi
            done

            echo "flagship: relay backstop window (${RELAY_WINDOW_SECS}s) elapsed with no phone reply"
            return 1
        }

        # ── net-ensure (the wired path) ─────────────────────────────────────────────
        # The initramfs brings up NO network for this script by itself (no ip=dhcp
        # kernel param, no configure_networking) — the relay curls below would fail on
        # every wired LUKS box. Bring up each non-lo interface and DHCP the first one
        # with carrier. On Wi-Fi the init-premount already routed: the route check
        # skips this instantly. Fully best-effort + wall-clock bounded (~45s worst
        # case) — it can never fail or hang the boot.
        if ! ip route 2>/dev/null | grep -q '^default'; then
            echo "flagship: no default route — bringing up interfaces for DHCP"
            for IFW in /sys/class/net/*; do
                IFW="${IFW##*/}"
                if [ "$IFW" = "lo" ]; then continue; fi
                ip link set "$IFW" up 2>/dev/null || true
            done
            sleep 3
            for IFW in /sys/class/net/*; do
                IFW="${IFW##*/}"
                if [ "$IFW" = "lo" ]; then continue; fi
                if [ "$(cat "/sys/class/net/$IFW/carrier" 2>/dev/null || echo 0)" != "1" ]; then continue; fi
                echo "flagship: carrier on $IFW — requesting DHCP"
                if command -v ipconfig >/dev/null 2>&1; then
                    ipconfig -t 20 "$IFW" 2>/dev/null || true
                else
                    udhcpc -i "$IFW" -n -q -t 5 2>/dev/null || true
                fi
                if ip route 2>/dev/null | grep -q '^default'; then
                    echo "flagship: default route up via $IFW"
                else
                    echo "flagship: DHCP on $IFW finished without a default route"
                fi
                break
            done
        fi

        # ── resolv-ensure (BOTH paths) ──────────────────────────────────────────────
        # klibc ipconfig records DNS in /run/net-<if>.conf but NOTHING writes
        # /etc/resolv.conf in the initramfs — the relay curls fail with "could not
        # resolve host" even with the route up. Source every recorded lease; fall back
        # to public resolvers.
        if [ ! -s /etc/resolv.conf ]; then
            _rdns=""
            for _nc in /run/net-*.conf; do
                if [ ! -f "$_nc" ]; then continue; fi
                IPV4DNS0=""
                IPV4DNS1=""
                . "$_nc" 2>/dev/null || true
                for _d in "$IPV4DNS0" "$IPV4DNS1"; do
                    if [ -n "$_d" ] && [ "$_d" != "0.0.0.0" ]; then _rdns="$_rdns $_d"; fi
                done
            done
            : > /etc/resolv.conf 2>/dev/null || true
            for _d in $_rdns; do
                echo "nameserver $_d" >> /etc/resolv.conf 2>/dev/null || true
            done
            if [ -s /etc/resolv.conf ]; then
                echo "flagship: dns configured:$_rdns"
            else
                printf 'nameserver 1.1.1.1\\nnameserver 8.8.8.8\\n' > /etc/resolv.conf 2>/dev/null || true
                echo "flagship: dns fallback: public resolvers"
            fi
        fi

        # ── Two-tier dispatch (docs/security-phone-as-unlock-endpoint.md §7a.1) ────
        # The legacy plaintext-consume path is RETIRED — never a fallback here.
        #   auto:    box-sealed lease (self-unlock); fall back to the phone relay.
        #   approve: phone relay EVERY boot; the box NEVER reads a box-sealed lease.
        # EFFECTIVE mode = baseline OR a one-shot lock. The marker forces the approve
        # relay for THIS boot on top of the baseline.
        EFFECTIVE_MODE="$BOOT_UNLOCK_MODE"
        if [ "$LOCK_ONCE" = "yes" ]; then
            echo "flagship: one-shot lock marker present — forcing approve relay for THIS boot"
            EFFECTIVE_MODE="approve"
        fi
        echo "flagship: boot-unlock mode = $EFFECTIVE_MODE (baseline=$BOOT_UNLOCK_MODE, lock-once=$LOCK_ONCE)"
        if [ "$EFFECTIVE_MODE" = "approve" ]; then
            unlock_via_relay
        else
            if ! unlock_via_box_lease; then
                unlock_via_relay
            fi
        fi

        \(terminalUnlock)
        # CONSUME the one-shot lock marker only now — AFTER a successful luksOpen (set -e
        # aborts the premount before here if the unlock failed, so the lock stays armed
        # for the retry). The next boot then reverts to the baseline BOOT_UNLOCK_MODE.
        if [ "$LOCK_ONCE" = "yes" ]; then
            rm -f "$LOCK_ONCE_FILE"
            echo "flagship: consumed one-shot lock marker; next boot reverts to baseline ($BOOT_UNLOCK_MODE)"
        fi
        [ -n "$LOCK_ONCE_MOUNT" ] && umount "$LOCK_ONCE_MOUNT" 2>/dev/null || true
        PREMOUNT
        chmod +x /etc/initramfs-tools/scripts/local-top/flagship-unlock
        \(initramfsWifi)
        # Rebuild the initramfs so the hook + premount script land in /boot's initrd.
        update-initramfs -u 2>&1 | tee /var/log/flagship-initramfs.log || \\
            echo "[flagship-bootstrap] WARNING: update-initramfs failed; unlock hook not embedded"
        echo "[flagship-bootstrap] LUKS unlock hook installed; initramfs rebuilt"


        """
    }
}

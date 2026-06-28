import XCTest
@testable import FlagshipBurnerCore

/// ISO-surgery string transforms (Remaster). The xorriso round-trip + the raw
/// disk write are exercised on real hardware (they need a device); these lock
/// the cmdline/cfg edits. Moved verbatim out of the former EngineTests when the
/// Swift preseed/user-data generator was replaced by the JavaScriptCore engine
/// (see PreseedEngineTests) — Remaster is NOT the generator and stays in Swift.
final class RemasterTests: XCTestCase {
    let grub = """
    set timeout=30
    menuentry "Try or Install Ubuntu Server" {
    \tset gfxpayload=keep
    \tlinux\t/casper/vmlinuz quiet ---
    \tinitrd\t/casper/initrd
    }
    menuentry "Test memory" {
    \tlinux16 /boot/memtest86+.bin
    }
    """

    func testGrubInsertsAutoinstall() {
        let out = Remaster.editGrubCfg(grub)
        XCTAssertTrue(out.contains("/casper/vmlinuz autoinstall ds=nocloud\\;s=/cdrom/nocloud/ quiet ---"),
                      "expected autoinstall cmdline after vmlinuz, got:\n\(out)")
    }

    func testGrubShortensTimeout() {
        let out = Remaster.editGrubCfg(grub)
        XCTAssertTrue(out.contains("set timeout=1"))
        XCTAssertFalse(out.contains("set timeout=30"))
    }

    func testGrubLeavesMemtestAlone() {
        XCTAssertTrue(Remaster.editGrubCfg(grub).contains("linux16 /boot/memtest86+.bin"))
    }

    func testGrubIdempotent() {
        let once = Remaster.editGrubCfg(grub)
        let twice = Remaster.editGrubCfg(once)
        XCTAssertEqual(once, twice)
        XCTAssertEqual(twice.components(separatedBy: "autoinstall").count - 1, 1)
    }

    func testGrubAddsTimeoutWhenMissing() {
        let noTimeout = "menuentry \"x\" {\n\tlinux /casper/vmlinuz ---\n}\n"
        XCTAssertTrue(Remaster.editGrubCfg(noTimeout).hasPrefix("set timeout=1\n"))
    }

    func testEditGrubCfgForPreseed() {
        let grub = """
        set timeout=10
        menuentry "Install" {
        \tlinux\t/install.amd/vmlinuz vga=788 --- quiet
        \tinitrd\t/install.amd/initrd.gz
        }
        menuentry "Graphical install" {
        \tlinux\t/install.amd/gtk/vmlinuz vga=788 --- quiet
        \tinitrd\t/install.amd/gtk/initrd.gz
        }
        """
        let out = Remaster.editGrubCfgForPreseed(grub)
        XCTAssertTrue(out.contains("/install.amd/vmlinuz \(Remaster.debianPreseedCmdline) vga=788"))
        XCTAssertTrue(out.contains("/install.amd/gtk/vmlinuz \(Remaster.debianPreseedCmdline) vga=788"))
        XCTAssertTrue(out.contains("preseed/file=/cdrom/preseed.cfg"))
        XCTAssertTrue(out.contains("set timeout=1"))
        XCTAssertFalse(out.contains("set timeout=10"))
        // idempotent
        XCTAssertEqual(Remaster.editGrubCfgForPreseed(out), out)
    }

    func testEditIsolinuxCfgForPreseed() {
        let txt = """
        prompt 1
        timeout 600
        label install
        \tkernel /install.amd/vmlinuz
        \tappend vga=788 initrd=/install.amd/initrd.gz --- quiet
        """
        let out = Remaster.editIsolinuxCfgForPreseed(txt)
        XCTAssertTrue(out.contains("initrd=/install.amd/initrd.gz \(Remaster.debianPreseedCmdline)"))
        XCTAssertTrue(out.range(of: "(?m)^\\s*timeout\\s+1", options: .regularExpression) != nil)
        XCTAssertFalse(out.contains("timeout 600"))
        XCTAssertTrue(out.range(of: "(?m)^\\s*prompt\\s+0", options: .regularExpression) != nil)
        XCTAssertEqual(Remaster.editIsolinuxCfgForPreseed(out), out)
    }

    func testClassifyIsoText() {
        XCTAssertEqual(Remaster.classifyIsoText("Debian 13.5.0 amd64 1"), "debian")
        XCTAssertEqual(Remaster.classifyIsoText("/install.amd\n/boot\n/EFI"), "debian")
        XCTAssertEqual(Remaster.classifyIsoText("Ubuntu-Server 22.04.5 LTS amd64"), "ubuntu")
        XCTAssertEqual(Remaster.classifyIsoText("/casper\n/boot"), "ubuntu")
        XCTAssertEqual(Remaster.classifyIsoText("ubuntu based on debian\n/casper"), "ubuntu")
        XCTAssertEqual(Remaster.classifyIsoText("Some Custom Linux 1.0"), "ubuntu")
        XCTAssertEqual(Remaster.classifyIsoText(""), "ubuntu")
    }
}

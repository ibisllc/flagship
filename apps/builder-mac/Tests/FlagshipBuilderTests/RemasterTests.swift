import XCTest
@testable import FlagshipBuilderCore

/// ISO-surgery string transforms (Remaster). The xorriso round-trip + the raw
/// disk write are exercised on real hardware (they need a device); these lock
/// the cmdline/cfg edits. Remaster is NOT the generator (see PreseedEngineTests)
/// and stays in Swift.
final class RemasterTests: XCTestCase {
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

    func testEditGrubCfgForPreseedArm64InstallDir() {
        // The Apple-silicon VM path boots an arm64 Debian netinst whose
        // installer dir is `/install.a64/`, not `/install.amd/`. The cmdline
        // injection must still fire (it was amd64-only before Phase-0).
        let grub = """
        set timeout=10
        menuentry 'Install' {
        \tlinux\t/install.a64/vmlinuz  --- quiet
        \tinitrd\t/install.a64/initrd.gz
        }
        menuentry 'Graphical install' {
        \tlinux\t/install.a64/vmlinuz  --- quiet
        \tinitrd\t/install.a64/gtk/initrd.gz
        }
        """
        let out = Remaster.editGrubCfgForPreseed(grub)
        XCTAssertTrue(out.contains("/install.a64/vmlinuz \(Remaster.debianPreseedCmdline)"))
        XCTAssertTrue(out.contains("preseed/file=/cdrom/preseed.cfg"))
        XCTAssertEqual(Remaster.editGrubCfgForPreseed(out), out) // idempotent
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

    func testIsolinuxSpeechAutobootGoesToThePlainInstaller() {
        let spk = "label installspk\n\tkernel /install.amd/vmlinuz\n\tappend vga=788 initrd=/install.amd/gtk/initrd.gz speakup.synth=soft --- quiet \ntimeout 300\nontimeout /install.amd/vmlinuz vga=788 initrd=/install.amd/gtk/initrd.gz speakup.synth=soft --- quiet \n"
        let out = Remaster.editIsolinuxCfgForPreseed(spk)
        XCTAssertTrue(out.contains("ontimeout install"))
        XCTAssertFalse(out.contains("ontimeout /install.amd"))
        XCTAssertTrue(out.range(of: "(?m)^timeout 1$", options: .regularExpression) != nil)
        XCTAssertTrue(out.contains("initrd=/install.amd/gtk/initrd.gz \(Remaster.debianPreseedCmdline) speakup.synth=soft"))
        XCTAssertEqual(Remaster.editIsolinuxCfgForPreseed(out), out)
    }

    func testClassifyIsoText() {
        XCTAssertEqual(Remaster.classifyIsoText("Debian 13.5.0 amd64 1"), "debian")
        XCTAssertEqual(Remaster.classifyIsoText("/install.amd\n/boot\n/EFI"), "debian")
        XCTAssertEqual(Remaster.classifyIsoText("Ubuntu-Server 22.04.5 LTS amd64"), "other")
        XCTAssertEqual(Remaster.classifyIsoText("/casper\n/boot"), "other")
        XCTAssertEqual(Remaster.classifyIsoText("ubuntu based on debian\n/casper"), "other")
        XCTAssertEqual(Remaster.classifyIsoText("Some Custom Linux 1.0"), "other")
        XCTAssertEqual(Remaster.classifyIsoText(""), "other")
    }

    func testRefusesAnImageThatIsNotADebianInstaller() {
        let nowhere = URL(fileURLWithPath: "/nonexistent.iso")
        XCTAssertThrowsError(try Remaster.remasterInstaller(
            srcISO: nowhere, outISO: nowhere, preseedCfg: "x", family: "other")) { error in
            XCTAssertEqual((error as? RemasterError)?.errorDescription,
                           "This is not a Debian installer image. Flagship installs from a Debian netinst ISO.")
        }
    }
}

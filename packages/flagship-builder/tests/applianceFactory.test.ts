import { describe, expect, it } from "vitest";
import {
  buildDebianApplianceFactoryPreseed,
  buildDebianCloudApplianceFactoryUserData,
} from "../src/applianceFactory.js";

describe("generalized appliance factory preseed", () => {
  it("reuses encrypted Debian install mechanics but replaces all owner provisioning", () => {
    const out = buildDebianApplianceFactoryPreseed("main");
    expect(out).toContain("d-i partman-auto/method string crypto");
    expect(out).toContain("d-i grub-installer/force-efi-extra-removable boolean true");
    expect(out).toContain("flagship-appliance-prepare.sh");
    expect(out).toContain("d-i debian-installer/exit/poweroff boolean true");
    expect(out).not.toContain("factory.invalid");
    expect(out).not.toContain("/api/order/VMFACTORY01/status");
    expect(out).not.toContain("/target/var/flagship/install-blob.json");
    expect(out).not.toContain("flagship-bootstrap.sh");
  });

  it("rejects a shell-active git ref before embedding it", () => {
    expect(() => buildDebianApplianceFactoryPreseed("main'; touch /tmp/pwn #"))
      .toThrow(/unsafe git ref|invalid appliance git ref/);
  });

  it("converts the disposable cloud disk into a separate encrypted target", () => {
    const out = buildDebianCloudApplianceFactoryUserData("main");
    const encoded = out.match(/content: ([A-Za-z0-9+/=]+)/)?.[1];
    expect(encoded).toBeTruthy();
    const script = Buffer.from(encoded!, "base64").toString("utf8");
    expect(script).toContain("TARGET_DEV=/dev/vdb");
    expect(script).toContain("using QEMU user-network DNS fallback");
    expect(script).toContain("nameserver 10.0.2.3");
    expect(script).toContain("-c 2:flagship_boot");
    expect(script).toContain('mount "$TARGET_DEV"2 "$TARGET_ROOT/boot"');
    expect(script).toContain('cryptsetup luksFormat --type luks2 --batch-mode --key-file="$FACTORY_KEY" "$TARGET_DEV"3');
    expect(script).toContain("GRUB_DISABLE_LINUX_PARTUUID=true");
    expect(script).toContain("cryptsetup luksFormat --type luks2");
    expect(script).toContain("tar --one-file-system --numeric-owner --acls --xattrs");
    expect(script).toContain("flagship-appliance-prepare.sh");
    expect(script).toContain("grub-install --target=\"$GRUB_TARGET\"");
    expect(script).toContain("GRUB_FALLBACK=BOOTAA64.EFI");
    expect(script).toContain("GRUB_FALLBACK=BOOTX64.EFI");
    expect(script).toContain("removable EFI loader missing");
    expect(script).toContain("systemctl poweroff");
    expect(script).not.toContain("factory.invalid");
  });
});

import type { BuildPlan, SystemContainer } from "./buildPlan.js";

export interface NixosFiles {
  flake: string;
  configuration: string;
  containers: string;
  hardware: string;
}

/**
 * Render the NixOS files (flake.nix, configuration.nix, etc.) that mkosi
 * will write into the image rootfs. The host distro is invisible to user
 * apps — they always run as containers — so the role of this code is to
 * configure the *host* surface: networking, the disabled-sshd policy,
 * declarative system containers, and the systemd unit that runs the
 * Flagship server-daemon.
 */
export function renderNixosFiles(plan: BuildPlan): NixosFiles {
  return {
    flake: renderFlake(),
    configuration: renderConfiguration(plan),
    containers: renderSystemContainersModule(plan.systemContainers),
    hardware: renderHardware(plan),
  };
}

function renderFlake(): string {
  return `{
  description = "Flagship server image";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";
  };

  outputs = { self, nixpkgs }: {
    nixosConfigurations.flagship = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        ./hardware-configuration.nix
        ./configuration.nix
        ./containers.nix
      ];
    };
  };
}
`;
}

function renderConfiguration(plan: BuildPlan): string {
  const wifiSsid = nixString(plan.spec.wifi.ssid);
  const userId = nixString(plan.spec.userId);
  const serverId = nixString(plan.spec.newServerId);

  return `{ config, pkgs, lib, ... }:
{
  imports = [ ./containers.nix ];

  boot = {
    loader.systemd-boot.enable = true;
    loader.efi.canTouchEfiVariables = true;
    initrd.systemd.enable = true;
    initrd.systemd.network.enable = true;
    initrd.availableKernelModules = [ "iwlwifi" "cfg80211" ];
    kernelModules = [ "kvm-intel" "kvm-amd" ];
  };

  networking = {
    hostName = ${nixString(`flagship-${plan.spec.newServerId}`)};
    wireless = {
      enable = true;
      networks.${wifiSsid} = {
        pskRaw = lib.mkDefault "@wpa-psk-from-builder@";
      };
    };
    nftables.enable = true;
    firewall = {
      enable = true;
      allowedTCPPorts = [ ];
      # Outbound HTTPS to flagshipserver.com is the only required egress
      # for the tunnel; inbound is closed by default.
    };
  };

  services.openssh.enable = false;

  programs.nix-ld.enable = true;

  users.users.flagship = {
    isSystemUser = true;
    group = "flagship";
    home = "/var/flagship";
  };
  users.groups.flagship = {};

  systemd.tmpfiles.rules = [
    "d /var/flagship 0750 flagship flagship -"
    "d /var/flagship/data 0750 flagship flagship -"
    "d /var/flagship/peer-pool 0750 flagship flagship -"
    "d /etc/flagship 0700 flagship flagship -"
  ];

  systemd.services.flagship-server-daemon = {
    description = "Flagship server-daemon";
    wantedBy = [ "multi-user.target" ];
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    serviceConfig = {
      Type = "simple";
      ExecStart = "\${pkgs.nodejs_20}/bin/node /opt/flagship/server-daemon/dist/index.js";
      Restart = "always";
      RestartSec = "5s";
      User = "flagship";
      Group = "flagship";
      Environment = [
        ${nixString(`FLAGSHIP_USER=${plan.spec.userId}`)}
        ${nixString(`FLAGSHIP_SERVER_ID=${plan.spec.newServerId}`)}
        "FLAGSHIP_CONFIG=/etc/flagship/server.json"
      ];
    };
  };

  environment.systemPackages = with pkgs; [
    nodejs_20
    podman
    git
    iproute2
  ];

  virtualisation.podman = {
    enable = true;
    dockerSocket.enable = false;
  };

  # Flagship identity baked into the image — not secrets, just metadata.
  environment.etc."flagship/identity".text = ''
    user=${plan.spec.userId}
    server=${plan.spec.newServerId}
  '';

  system.stateVersion = "24.11";

  # Sanity values surfaced to systemd-cat for support; don't include keys.
  environment.etc."flagship/banner".text = ''
    Flagship server ${plan.spec.newServerId}
    user=${plan.spec.userId}
  '';

  assertions = [
    { assertion = ${userId} != ""; message = "userId required"; }
    { assertion = ${serverId} != ""; message = "serverId required"; }
  ];
}
`;
}

function renderSystemContainersModule(containers: SystemContainer[]): string {
  const entries = containers
    .map((c) => renderContainer(c))
    .join("\n");
  return `{ config, pkgs, lib, ... }:
{
  virtualisation.oci-containers.backend = "podman";
  virtualisation.oci-containers.containers = {
${entries}
  };
}
`;
}

function renderContainer(c: SystemContainer): string {
  const volumeLines = Object.entries(c.volumes ?? {})
    .map(([containerPath, hostName]) => {
      const hostPath = `/var/flagship/system/${c.name}/${hostName}`;
      return `        ${nixString(`${hostPath}:${containerPath}`)}`;
    })
    .join("\n");
  return `    ${nixIdent(c.name)} = {
      image = ${nixString(c.image)};
      autoStart = true;
${volumeLines.length > 0 ? `      volumes = [\n${volumeLines}\n      ];\n` : ""}    };`;
}

function renderHardware(plan: BuildPlan): string {
  const luksDevices = plan.partitions
    .filter((p) => p.encrypted)
    .map((p, i) => `    "luks-${p.name}" = { device = "/dev/disk/by-partlabel/${p.name}"; preLVM = true; allowDiscards = true; }; # idx ${i}`)
    .join("\n");

  const fsEntries = plan.partitions
    .map((p) =>
      `  fileSystems.${nixString(p.mountPoint)} = {
    device = "/dev/mapper/luks-${p.name}";
    fsType = ${nixString(p.fs)};
  };`,
    )
    .join("\n");

  return `{ config, lib, pkgs, modulesPath, ... }:
{
  imports = [ ];

  boot.initrd.luks.devices = {
${luksDevices}
  };

${fsEntries}

  swapDevices = [ ];

  hardware = {
    cpu.amd.updateMicrocode = lib.mkDefault config.hardware.enableRedistributableFirmware;
    cpu.intel.updateMicrocode = lib.mkDefault config.hardware.enableRedistributableFirmware;
    enableRedistributableFirmware = true;
  };

  nixpkgs.hostPlatform = lib.mkDefault "x86_64-linux";
}
`;
}

function nixString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$")}"`;
}

function nixIdent(name: string): string {
  // Identifiers in attribute sets need quoting if they contain non-ident chars.
  if (/^[a-zA-Z_][a-zA-Z0-9_'-]*$/.test(name)) return name;
  return nixString(name);
}

/** Files added by NixOS emission, suitable for ConfigFile-style writes. */
export function nixosConfigFiles(plan: BuildPlan): { path: string; content: string; mode?: number }[] {
  const files = renderNixosFiles(plan);
  return [
    { path: "/etc/nixos/flake.nix", content: files.flake },
    { path: "/etc/nixos/configuration.nix", content: files.configuration },
    { path: "/etc/nixos/containers.nix", content: files.containers },
    { path: "/etc/nixos/hardware-configuration.nix", content: files.hardware },
  ];
}

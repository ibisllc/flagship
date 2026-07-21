export interface OpaqueDeviceSnapshot {
  deviceId: string;
  platform: string;
  addedAt: number;
}

export async function computeDevicesEtag(devices: OpaqueDeviceSnapshot[]): Promise<string> {
  const stable = devices.map((device) => ({
    deviceId: device.deviceId,
    platform: device.platform,
    addedAt: device.addedAt,
  }));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(stable)));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
  return `W/"${hex}"`;
}

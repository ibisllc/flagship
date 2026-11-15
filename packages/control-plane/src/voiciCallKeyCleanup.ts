import type { DeviceCapabilityGrantStorage, VoiciCallStorage } from "@flagship/storage";

/**
 * A device whose grant was revoked loses its call-key binding (release-manager call, docs/voici-calls.md "Owner
 * decisions, 2026-11-15 (second round)"): every path that revokes a device grant calls this with the devices it
 * touched. A device that still holds another active grant (a graceful re-pair re-signs it) keeps its binding.
 */
export async function dropVoiciCallKeysOfRevokedDevices(
  deps: { grants: Pick<DeviceCapabilityGrantStorage, "listForUser">; callKeys?: Pick<VoiciCallStorage, "deleteCallKeyForDevice"> },
  username: string,
  deviceIds: readonly string[],
): Promise<void> {
  if (!deps.callKeys || deviceIds.length === 0) return;
  const user = username.toLowerCase();
  const live = new Set((await deps.grants.listForUser(user)).filter((g) => g.revokedAt === null).map((g) => g.deviceId.toLowerCase()));
  for (const id of new Set(deviceIds.map((d) => d.toLowerCase()))) {
    if (!live.has(id)) await deps.callKeys.deleteCallKeyForDevice(user, id);
  }
}

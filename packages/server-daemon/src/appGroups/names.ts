/**
 * Names of an app group's members (docs/app-groups.md). The main process is
 * `flagship-<serviceId>`, as for every app; a component is
 * `flagship-<serviceId>.<component>`. A service id never contains a dot
 * (`<creator>-<slug>`, both [a-z0-9-]), so the first dot always separates the
 * owning app from its component, and every member resolves to its app for
 * egress approvals, the database route and backups.
 */
export const COMPONENT_SEPARATOR = ".";

const COMPONENT_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function componentContainerName(serviceId: string, component: string): string {
  if (serviceId.includes(COMPONENT_SEPARATOR)) throw new Error(`not a service id: ${JSON.stringify(serviceId)}`);
  if (!COMPONENT_RE.test(component)) throw new Error(`not a component name: ${JSON.stringify(component)}`);
  return `flagship-${serviceId}${COMPONENT_SEPARATOR}${component}`;
}

/** The app a member id (`<serviceId>` or `<serviceId>.<component>`) belongs to. */
export function owningServiceId(memberId: string): string {
  const i = memberId.indexOf(COMPONENT_SEPARATOR);
  return i < 0 ? memberId : memberId.slice(0, i);
}

/** `FLAGSHIP_COMPONENT_<NAME>` for a component name. */
export function componentEnvName(component: string): string {
  return `FLAGSHIP_COMPONENT_${component.toUpperCase().replace(/-/g, "_")}`;
}

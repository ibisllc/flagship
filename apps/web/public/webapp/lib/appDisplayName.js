// The name an app is shown under. The box sends a `name` only on some rows (a copy still underway);
// otherwise the name comes from the slug, a DNS label, so "chess-club" reads "Chess Club". Mirrors iOS
// and Android AppDisplayName.

/** "chess-club" → "Chess Club"; "my_app-2" → "My App 2"; a slug with no words is shown as it is. */
export function appNameFromSlug(slug) {
  const s = String(slug ?? "");
  const words = s.split(/[-_]/).filter(Boolean).map((w) => {
    const [first, ...rest] = w;
    return first.toUpperCase() + rest.join("");
  });
  return words.length ? words.join(" ") : s;
}

/** `<account>--<slug>` → the slug's name; an id without `--` is taken as the slug. */
export function appNameFromServiceId(serviceId) {
  const id = String(serviceId ?? "");
  const at = id.lastIndexOf("--");
  return appNameFromSlug(at >= 0 ? id.slice(at + 2) : id);
}

/** The box's own `name` when it sends one, else the slug (or the id's slug) as words. */
export function appDisplayName(app) {
  const name = typeof app?.name === "string" ? app.name.trim() : "";
  if (name) return name;
  if (typeof app?.slug === "string" && app.slug) return appNameFromSlug(app.slug);
  return appNameFromServiceId(app?.serviceId ?? "");
}

/** The name an access request or draft is shown under. The box's `appName` is often just the slug
 *  (older boxes send nothing better), so an empty one, or one equal to the slug of `serviceId`, reads
 *  as the slug in words; anything else is the box's real display name and is kept. */
export function accessRequestAppName(serviceId, appName) {
  const id = String(serviceId ?? "");
  const at = id.lastIndexOf("--");
  const slug = at >= 0 ? id.slice(at + 2) : id;
  const name = typeof appName === "string" ? appName.trim() : "";
  if (!name || name === slug) return appNameFromServiceId(id);
  return name;
}

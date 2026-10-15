/**
 * An in-app destination as an https app link: `https://<apex>/app/<route>`.
 * The phone apps claim `/app/*` and route it like their old `flagship://<route>`
 * links; without the app the site shows its "get the app" page there.
 */
export function appRouteLink(
  route: string,
  query: Record<string, string> = {},
  apex = "flagshipserver.com",
): string {
  const q = new URLSearchParams(query).toString();
  return `https://${apex}/app/${route}${q ? `?${q}` : ""}`;
}

/**
 * The recipe's outbound proxy siblings (docs/outbound-proxy.md): the
 * owner-signed `outboundProxy` order and, only when the owner typed them into
 * the recipe, its `outboundProxyCredentials`. Unsigned siblings, passed
 * through to install-blob.json as JSON strings; the box verifies the order.
 * Pure (no node imports) so the preseed engine bundle can use it.
 */
export function readProxySiblings(parsed: Record<string, unknown>): {
  outboundProxy?: string;
  outboundProxyCredentials?: string;
} {
  const asStr = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : v && typeof v === "object" ? JSON.stringify(v) : undefined;
  const outboundProxy = asStr(parsed.outboundProxy);
  const outboundProxyCredentials = outboundProxy ? asStr(parsed.outboundProxyCredentials) : undefined;
  return {
    ...(outboundProxy ? { outboundProxy } : {}),
    ...(outboundProxyCredentials ? { outboundProxyCredentials } : {}),
  };
}

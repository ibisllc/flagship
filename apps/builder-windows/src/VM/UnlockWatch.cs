using System;
using System.Threading;
using System.Threading.Tasks;

namespace Flagship.Builder.VM;

/// <summary>
/// Waits for a sealed guest to come up after its owner approved the unlock.
/// With an order serial the proof is the box's own signed health report from
/// `.com` (received after THIS boot began, daemon active, relay tunnel up).
/// The server's public name is never looked up in that case: it does not
/// exist until the box registers it, and a lookup before then is cached as
/// NXDOMAIN by home routers for the zone's negative TTL (30 minutes seen on a
/// Windows PC on 2026-10-18), leaving a healthy box stuck on "Waiting for you
/// to unlock". Only a server without a serial falls back to fetching its name
/// (TLS ends on the box, so any HTTP response proves the unlock). Mirrors
/// the Mac and Linux Studio; pinned by vm-core-vectors.json "bootEvidence".
/// </summary>
public static class UnlockWatch
{
    /// <summary>Returns true once the guest is proven up; false when cancelled.</summary>
    public static async Task<bool> RunAsync(
        string serverDomain,
        string? healthUrl,
        DateTimeOffset poweredOnAt,
        Func<DateTimeOffset> clock,
        Func<string, CancellationToken, Task<string?>> fetchHealth,
        Func<string, CancellationToken, Task<bool>> probeName,
        TimeSpan interval,
        CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                if (healthUrl is not null)
                {
                    var body = await fetchHealth(healthUrl, ct);
                    if (body is not null
                        && VMServerHealth.FromOrderHealth(body, serverDomain) is { } health
                        && health.ProvesBoxIsUp(poweredOnAt, clock()))
                        return true;
                }
                else if (await probeName($"https://{serverDomain}/", ct))
                {
                    return true;
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return false;
            }
            catch
            {
                // Not up yet or .com unreachable: keep waiting.
            }
            try { await Task.Delay(interval, ct); }
            catch (OperationCanceledException) { return false; }
        }
        return false;
    }
}

using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Xunit;
using Flagship.Builder.VM;

namespace Flagship.Builder.Tests;

/// <summary>
/// A hosted server's name must not be looked up before the box has reported in:
/// the name does not exist until the box registers it, and routers cache the
/// NXDOMAIN for the zone's negative TTL (30 minutes seen on Windows
/// 2026-10-18), which left Studio on "Waiting for you to unlock" for a
/// healthy server.
/// </summary>
public sealed class UnlockWatchTests
{
    private const string Domain = "home.u-x.flagship.services";
    private const string HealthUrl = "https://flagshipserver.com/api/order/AB12cd34ef56/health";
    private static readonly DateTimeOffset PoweredOn = DateTimeOffset.FromUnixTimeMilliseconds(1_800_000_000_000);

    private static string Body(long receivedAtMs, long uptimeS, string daemon = "active", bool tunnel = true) =>
        "{\"serverDomain\":\"" + Domain + "\",\"health\":{\"v\":1,\"uptimeS\":" + uptimeS +
        ",\"memTotalMB\":3900,\"memAvailMB\":800,\"oomKills\":0,\"daemon\":{\"state\":\"" + daemon +
        "\",\"restarts\":0,\"lastExit\":0},\"tunnel\":" + (tunnel ? "true" : "false") +
        ",\"diskUsedPct\":5,\"receivedAt\":" + receivedAtMs + "}}";

    [Fact]
    public async Task NoNameLookupHappensBeforeOrAfterTheFirstHealthReport()
    {
        var now = PoweredOn.AddSeconds(5);
        var polls = new List<string>();
        var looked = new List<string>();
        string? current = null;
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));

        var task = UnlockWatch.RunAsync(
            Domain, HealthUrl, PoweredOn, () => now,
            fetchHealth: (url, _) =>
            {
                polls.Add(url);
                if (polls.Count == 3)
                {
                    // The box finally reports in, 50 s into this boot.
                    now = PoweredOn.AddSeconds(50);
                    current = Body(now.ToUnixTimeMilliseconds() - 1_000, 40);
                }
                return Task.FromResult(current);
            },
            probeName: (url, _) => { looked.Add(url); return Task.FromResult(true); },
            interval: TimeSpan.FromMilliseconds(5), ct: cts.Token);

        Assert.True(await task);
        Assert.True(polls.Count >= 3);
        Assert.All(polls, u => Assert.Equal(HealthUrl, u));
        Assert.Empty(looked);
    }

    [Fact]
    public async Task AReportFromThePreviousBootOrAnUnreadyDaemonDoesNotCount()
    {
        var now = PoweredOn.AddSeconds(30);
        var bodies = new Queue<string?>(new string?[]
        {
            Body(PoweredOn.ToUnixTimeMilliseconds() - 10_000, 3_000),
            Body(now.ToUnixTimeMilliseconds(), 20, daemon: "activating"),
            Body(now.ToUnixTimeMilliseconds(), 20, tunnel: false),
            null,
        });
        var looked = 0;
        using var cts = new CancellationTokenSource();
        var attempts = 0;

        var task = UnlockWatch.RunAsync(
            Domain, HealthUrl, PoweredOn, () => now,
            fetchHealth: (_, _) =>
            {
                attempts++;
                if (bodies.Count == 0) { cts.Cancel(); return Task.FromResult<string?>(null); }
                return Task.FromResult(bodies.Dequeue());
            },
            probeName: (_, _) => { looked++; return Task.FromResult(true); },
            interval: TimeSpan.FromMilliseconds(5), ct: cts.Token);

        Assert.False(await task);
        Assert.True(attempts >= 4);
        Assert.Equal(0, looked);
    }

    [Fact]
    public async Task AServerWithoutAnOrderSerialFallsBackToItsName()
    {
        var urls = new List<string>();
        var fetchedHealth = 0;
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));

        var unlocked = await UnlockWatch.RunAsync(
            Domain, healthUrl: null, PoweredOn, () => PoweredOn,
            fetchHealth: (_, _) => { fetchedHealth++; return Task.FromResult<string?>(null); },
            probeName: (url, _) => { urls.Add(url); return Task.FromResult(urls.Count >= 2); },
            interval: TimeSpan.FromMilliseconds(5), ct: cts.Token);

        Assert.True(unlocked);
        Assert.Equal(0, fetchedHealth);
        Assert.Equal($"https://{Domain}/", urls[0]);
    }
}

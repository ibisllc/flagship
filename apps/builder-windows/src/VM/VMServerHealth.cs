using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Flagship.Builder.VM;

public sealed record HealthVerdict(bool Ok, IReadOnlyList<string> Lines);

/// <summary>
/// A hosted server's own health report, read from `.com` by the order that
/// created it (`GET /api/order/&lt;serial&gt;/health`, control-plane
/// serverHealth.ts). The account's server list needs a read token Studio
/// doesn't hold; the order serial is a capability it does. The guest signs
/// these numbers once a minute from a timer that keeps running when the
/// daemon doesn't, so Studio can say why a server went quiet. Mirrors the
/// Mac's VMServerHealth.swift; the shared vm-core-vectors.json "serverHealth"
/// section pins the copy on all three ports.
/// </summary>
public sealed record VMServerHealth(
    long UptimeS,
    long MemTotalMB,
    long MemAvailMB,
    long OomKills,
    string DaemonState,
    long DaemonRestarts,
    long DaemonLastExit,
    bool Tunnel,
    long DiskUsedPct,
    long ReceivedAtMs)
{
    private static readonly Regex Serial = new("^[A-Za-z0-9_-]{8,64}$", RegexOptions.CultureInvariant);

    public static string? OrderHealthUrl(string? serial)
        => serial is not null && Serial.IsMatch(serial)
            ? $"https://{Environment.GetEnvironmentVariable("FLAGSHIP_CONTROL_HOST") ?? "flagshipserver.com"}/api/order/{serial}/health"
            : null;

    /// <summary>The report out of an order-health response; null when the
    /// response names another server or its box doesn't report yet.</summary>
    public static VMServerHealth? FromOrderHealth(string body, string serverDomain)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("serverDomain", out var domain)
                || domain.ValueKind != JsonValueKind.String
                || !string.Equals(domain.GetString(), serverDomain, StringComparison.OrdinalIgnoreCase)
                || !root.TryGetProperty("health", out var h)
                || h.ValueKind != JsonValueKind.Object
                || !h.TryGetProperty("daemon", out var daemon)
                || daemon.ValueKind != JsonValueKind.Object
                || !daemon.TryGetProperty("state", out var state)
                || state.ValueKind != JsonValueKind.String
                || !h.TryGetProperty("tunnel", out var tunnel)
                || tunnel.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                return null;
            return new VMServerHealth(
                Int(h, "uptimeS"), Int(h, "memTotalMB"), Int(h, "memAvailMB"), Int(h, "oomKills"),
                state.GetString()!, Int(daemon, "restarts"), Int(daemon, "lastExit"),
                tunnel.GetBoolean(), Int(h, "diskUsedPct"), Int(h, "receivedAt"));
        }
        catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
        {
            return null;
        }
    }

    private static long Int(JsonElement e, string key)
    {
        var v = e.GetProperty(key);
        if (v.ValueKind != JsonValueKind.Number || !v.TryGetInt64(out var n))
            throw new FormatException(key);
        return n;
    }

    /// <summary>True when this report shows the guest unlocked and serving
    /// after THIS boot began: the daemon is active, the relay tunnel is up,
    /// the report was received after power-on, the guest's uptime fits inside
    /// the time since power-on (+60 s slack, so an earlier boot's report never
    /// counts) and it is under 5 minutes old. Studio takes this, not a fetch
    /// of the server's own name, as the sign a sealed guest came up (see
    /// UnlockWatch). Pinned by vm-core-vectors.json "bootEvidence".</summary>
    public bool ProvesBoxIsUp(DateTimeOffset poweredOnAt, DateTimeOffset now)
    {
        var poweredOnMs = poweredOnAt.ToUnixTimeMilliseconds();
        var nowMs = now.ToUnixTimeMilliseconds();
        return DaemonState == "active"
            && Tunnel
            && ReceivedAtMs >= poweredOnMs
            && UptimeS * 1000 <= (nowMs - poweredOnMs) + 60_000
            && nowMs - ReceivedAtMs < 300_000;
    }

    public HealthVerdict Verdict(DateTimeOffset now)
    {
        var staleMin = (now.ToUnixTimeMilliseconds() - ReceivedAtMs) / 60_000;
        if (staleMin >= 5)
            return new HealthVerdict(false, new[] { $"No health report for {staleMin} min. The server itself may be off or frozen." });
        var lines = new List<string>();
        if (OomKills > 0)
            lines.Add($"Ran out of memory {OomKills}× since it started ({MemAvailMB} MB free of {MemTotalMB} MB now).");
        if (DaemonState != "active")
            lines.Add($"The server software isn't running ({DaemonState}; restarted {DaemonRestarts}×, last exit code {DaemonLastExit}).");
        else if (DaemonRestarts >= 3)
            lines.Add($"The server software restarted {DaemonRestarts}× since it started (last exit code {DaemonLastExit}).");
        if (!Tunnel) lines.Add("Can't reach the Flagship relay.");
        if (DiskUsedPct >= 90) lines.Add($"Disk is {DiskUsedPct}% full.");
        if (lines.Count > 0) return new HealthVerdict(false, lines);
        return new HealthVerdict(true, new[]
        {
            $"Healthy · {MemAvailMB} MB free of {MemTotalMB} MB · disk {DiskUsedPct}% · up {Uptime(UptimeS)}",
        });
    }

    public static string Uptime(long s)
    {
        long d = s / 86_400, h = (s % 86_400) / 3_600, m = (s % 3_600) / 60;
        if (d >= 1) return $"{d}d {h}h";
        if (h >= 1) return $"{h}h {m}m";
        return $"{m}m";
    }
}

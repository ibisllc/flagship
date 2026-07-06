using System;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Flagship.Burner.VM;

/// <summary>
/// Minimal QMP (QEMU Machine Protocol) client over loopback TCP: capability
/// negotiation + the two commands the appliance needs (system_powerdown for a
/// clean ACPI shutdown the guest daemon can flush on, quit as the hard stop).
/// Line-delimited JSON; deliberately tiny — the lifecycle brain lives in the
/// pure layer, not here.
/// </summary>
public sealed class QmpClient : IAsyncDisposable
{
    private readonly TcpClient _tcp = new();
    private StreamReader? _reader;
    private StreamWriter? _writer;

    public async Task ConnectAsync(int port, CancellationToken cancellation = default)
    {
        await _tcp.ConnectAsync("127.0.0.1", port, cancellation);
        var stream = _tcp.GetStream();
        _reader = new StreamReader(stream, Encoding.UTF8);
        _writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true };
        // Server greets with {"QMP":{...}}; we must ack before any command.
        var greeting = await ReadObjectAsync(cancellation)
            ?? throw new IOException("QMP: connection closed before greeting.");
        if (!greeting.RootElement.TryGetProperty("QMP", out _))
            throw new IOException("QMP: unexpected greeting.");
        greeting.Dispose();
        await ExecuteAsync("qmp_capabilities", cancellation);
    }

    /// <summary>Ask the guest to power down cleanly (ACPI button). The guest
    /// OS decides when to actually stop; watch the process exit for the result.</summary>
    public Task SystemPowerdownAsync(CancellationToken cancellation = default)
        => ExecuteAsync("system_powerdown", cancellation);

    /// <summary>Hard stop: terminate the emulator immediately.</summary>
    public Task QuitAsync(CancellationToken cancellation = default)
        => ExecuteAsync("quit", cancellation);

    private async Task ExecuteAsync(string command, CancellationToken cancellation)
    {
        if (_writer is null) throw new InvalidOperationException("QMP: not connected.");
        await _writer.WriteAsync($"{{\"execute\":\"{command}\"}}\n");
        // Read until the matching "return" (skipping async events); QMP
        // returns errors as {"error":{...}}.
        while (true)
        {
            using var obj = await ReadObjectAsync(cancellation);
            if (obj is null) throw new IOException($"QMP: connection closed during '{command}'.");
            if (obj.RootElement.TryGetProperty("return", out _)) return;
            if (obj.RootElement.TryGetProperty("error", out var err))
                throw new IOException($"QMP '{command}' failed: {err.GetRawText()}");
            // else: an async event — skip.
        }
    }

    private async Task<JsonDocument?> ReadObjectAsync(CancellationToken cancellation)
    {
        if (_reader is null) throw new InvalidOperationException("QMP: not connected.");
        while (true)
        {
            var line = await _reader.ReadLineAsync(cancellation);
            if (line is null) return null;
            if (string.IsNullOrWhiteSpace(line)) continue;
            try { return JsonDocument.Parse(line); }
            catch (JsonException) { /* tolerate noise */ }
        }
    }

    public ValueTask DisposeAsync()
    {
        try { _tcp.Dispose(); } catch { }
        return ValueTask.CompletedTask;
    }
}

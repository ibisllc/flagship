using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Flagship.Builder;

public enum PairingStage { Qr, Confirm, AwaitingAuthorization }

/// <summary>
/// One phone-pairing milestone, parsed from a `FLAGSHIP_PAIR <json>` line the
/// `flagship-build pair --emit-events` subprocess prints. Mirrors the shared
/// PairEvent union in packages/flagship-builder/src/pair.ts.
/// </summary>
public sealed record PairEvent
{
    public required string Event { get; init; }
    // ready
    public string? HumanCode { get; init; }
    public string? QrTerminal { get; init; }
    public string? Payload { get; init; }
    public bool DebugRequested { get; init; }
    // phone-connected
    public string? Sas { get; init; }
    // delivered / done
    public string? ServerDomain { get; init; }
    // done
    public string? RecipePath { get; init; }
    public bool DebugGranted { get; init; }
    // error
    public string? Message { get; init; }
}

/// <summary>
/// Pure parser for the subprocess's structured stdout. Kept separate from the
/// process plumbing so it's unit-testable. A line that isn't a well-formed
/// `FLAGSHIP_PAIR <json>` returns null (ordinary human log line).
/// </summary>
public static class PairEventParser
{
    public const string Prefix = "FLAGSHIP_PAIR ";

    public static PairEvent? TryParse(string line)
    {
        if (line is null) return null;
        var trimmed = line.TrimStart();
        if (!trimmed.StartsWith(Prefix, StringComparison.Ordinal)) return null;
        var json = trimmed[Prefix.Length..];
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            if (!root.TryGetProperty("event", out var ev) || ev.ValueKind != JsonValueKind.String)
                return null;
            string? Str(string name) =>
                root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            bool Bool(string name) =>
                root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;
            return new PairEvent
            {
                Event = ev.GetString()!,
                HumanCode = Str("humanCode"),
                QrTerminal = Str("qrTerminal"),
                Payload = Str("payload"),
                DebugRequested = Bool("debugRequested"),
                Sas = Str("sas"),
                ServerDomain = Str("serverDomain"),
                RecipePath = Str("recipePath"),
                DebugGranted = Bool("debugGranted"),
                Message = Str("message"),
            };
        }
        catch (JsonException)
        {
            return null;
        }
    }
}

/// <summary>
/// Native phone-pairing session using ClientWebSocket and the pinned
/// X25519/HKDF/AES-GCM protocol. Recipes are accepted only after native
/// Ed25519 verification by RecipeLoader.
/// </summary>
public sealed class PairSession : IDisposable
{
    private readonly bool _debug;
    private readonly CancellationTokenSource _cts = new();
    private readonly NativePairingKeyPair _keys;
    private readonly byte[] _codeBytes;
    private System.Net.WebSockets.ClientWebSocket? _socket;

    public event Action<PairEvent>? OnEvent;
    public event Action<LogLine>? OnLog;
    public string RecipeOutPath { get; }
    public string HumanCode { get; }
    public string HumanCodeDisplay => NativePairingCrypto.FormatHumanCode(HumanCode);
    public string SessionId { get; }
    public string QrPayload { get; }

    public PairSession(bool debug, string? outPath = null)
    {
        _debug = debug;
        RecipeOutPath = outPath ?? Path.Combine(Path.GetTempPath(), $"flagship-pair-{Guid.NewGuid():N}.json");
        _keys = NativePairingCrypto.CreateKeyPair();
        _codeBytes = NativePairingCrypto.NewCodeBytes();
        HumanCode = NativePairingCrypto.HumanCode(_codeBytes);
        SessionId = NativePairingCrypto.SessionId(_codeBytes);
        QrPayload = NativePairingCrypto.QrPayload(HumanCode, _keys.PublicKey);
    }

    public async Task RunAsync()
    {
        if (_debug) throw new NotSupportedException("Native debug-consent pairing is not enabled.");


        var host = Environment.GetEnvironmentVariable("FLAGSHIP_CONTROL_HOST") ?? "flagshipserver.com";
        var scheme = Environment.GetEnvironmentVariable("FLAGSHIP_CONTROL_INSECURE") == "1" ? "ws" : "wss";
        var uri = new Uri($"{scheme}://{host}/builder-pipe/{SessionId}?role=builder");

        OnEvent?.Invoke(new PairEvent
        {
            Event = "ready", HumanCode = HumanCode, Payload = QrPayload, DebugRequested = false,
        });

        byte[]? aeadKey = null;
        var helloSent = false;
        var recipeReceived = false;
        _socket = new System.Net.WebSockets.ClientWebSocket();

        try
        {
            await _socket.ConnectAsync(uri, _cts.Token);
            using var pingCts = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token);
            var pingTask = PingAsync(_socket, pingCts.Token);

            while (_socket.State == System.Net.WebSockets.WebSocketState.Open && !_cts.IsCancellationRequested)
            {
                var text = await ReceiveTextAsync(_socket, _cts.Token);
                if (text is null) break;
                using var doc = JsonDocument.Parse(text);
                var root = doc.RootElement;
                if (!root.TryGetProperty("kind", out var kindValue) || kindValue.ValueKind != JsonValueKind.String) continue;
                switch (kindValue.GetString())
                {
                    case "accepted":
                    case "peer-missing":
                    case "pong":
                        break;
                    case "peer-present":
                    case "peer-joined":
                        if (!helloSent)
                        {
                            helloSent = true;
                            await SendAsync(_socket, new
                            {
                                kind = "builder-hello",
                                builderPk = NativePairingCrypto.Base64UrlEncode(_keys.PublicKey),
                            }, _cts.Token);
                        }
                        break;
                    case "peer-gone":
                        if (!recipeReceived)
                        {
                            helloSent = false;
                            if (aeadKey != null) CryptographicOperations.ZeroMemory(aeadKey);
                            aeadKey = null;
                            OnEvent?.Invoke(new PairEvent { Event = "reconnecting" });
                        }
                        break;
                    case "expired":
                        throw new InvalidOperationException("Pairing session timed out.");
                    case "error":
                        var reason = root.TryGetProperty("reason", out var rv) ? rv.ToString() : "unknown";
                        throw new InvalidOperationException($"Relay error: {reason}");
                    case "peer":
                        if (!root.TryGetProperty("frame", out var frame) || frame.ValueKind != JsonValueKind.Object) break;
                        var completed = await HandlePeerFrameAsync(frame, _keys, aeadKey, _socket, _cts.Token);
                        if (completed.NewKey != null)
                        {
                            if (aeadKey != null) CryptographicOperations.ZeroMemory(aeadKey);
                            aeadKey = completed.NewKey;
                        }
                        if (completed.Done)
                        {
                            recipeReceived = true;
                            // SendAsync only queues the receipt locally. Keep the socket alive
                            // briefly so the relay can forward it before we close the session.
                            await Task.Delay(TimeSpan.FromSeconds(10), _cts.Token);
                            pingCts.Cancel();
                            try { await pingTask; } catch (OperationCanceledException) { }
                            return;
                        }
                        break;
                }
            }
            if (!recipeReceived && !_cts.IsCancellationRequested)
                throw new InvalidOperationException("The pairing relay disconnected before delivering a recipe.");
        }
        catch (OperationCanceledException) when (_cts.IsCancellationRequested) { }
        catch (Exception ex)
        {
            OnEvent?.Invoke(new PairEvent { Event = "error", Message = ex.Message });
            OnLog?.Invoke(new LogLine(LogStream.Stderr, $"native pairing failed: {ex.Message}"));
        }
        finally
        {
            if (aeadKey != null) CryptographicOperations.ZeroMemory(aeadKey);
            CryptographicOperations.ZeroMemory(_codeBytes);
            _keys.Dispose();
            if (_socket.State is System.Net.WebSockets.WebSocketState.Open or System.Net.WebSockets.WebSocketState.CloseReceived)
            {
                try { await _socket.CloseAsync(System.Net.WebSockets.WebSocketCloseStatus.NormalClosure, "done", CancellationToken.None); }
                catch { }
            }
            _socket.Dispose();
            _socket = null;
        }
    }

    private async Task<(byte[]? NewKey, bool Done)> HandlePeerFrameAsync(
        JsonElement frame, NativePairingKeyPair keys, byte[]? currentKey,
        System.Net.WebSockets.ClientWebSocket socket, CancellationToken token)
    {
        if (!frame.TryGetProperty("kind", out var kindValue) || kindValue.ValueKind != JsonValueKind.String)
            return (null, false);

        switch (kindValue.GetString())
        {
            case "phone-hello":
                if (!frame.TryGetProperty("phonePk", out var pkValue) || pkValue.ValueKind != JsonValueKind.String)
                    return (null, false);
                var phoneKey = NativePairingCrypto.Base64UrlDecode(pkValue.GetString()!);
                var material = NativePairingCrypto.DeriveSessionMaterial(keys.PrivateKey, phoneKey);
                OnEvent?.Invoke(new PairEvent
                {
                    Event = "phone-connected", Sas = NativePairingCrypto.FormatSas(material.SasCode),
                });
                return (material.AeadKey, false);

            case "confirm-pairing":
                OnEvent?.Invoke(new PairEvent { Event = "paired" });
                return (null, false);

            case "deliver":
                if (currentKey is null) throw new CryptographicException("Recipe arrived before key agreement.");
                if (!frame.TryGetProperty("ciphertext", out var ct) || ct.ValueKind != JsonValueKind.String ||
                    !frame.TryGetProperty("nonce", out var nonce) || nonce.ValueKind != JsonValueKind.String)
                    throw new CryptographicException("Malformed recipe delivery.");
                var plaintext = NativePairingCrypto.OpenDelivered(ct.GetString()!, nonce.GetString()!, currentKey);
                try
                {
                    var verified = RecipeLoader.Load(plaintext);
                    await WriteRecipeAtomicallyAsync(plaintext, token);
                    OnEvent?.Invoke(new PairEvent { Event = "delivered", ServerDomain = verified.ServerDomain });
                    await SendAsync(socket, new { kind = "recipe-accepted" }, token);
                    OnEvent?.Invoke(new PairEvent
                    {
                        Event = "done", RecipePath = RecipeOutPath,
                        ServerDomain = verified.ServerDomain, DebugGranted = false,
                    });
                    return (null, true);
                }
                finally
                {
                    CryptographicOperations.ZeroMemory(plaintext);
                }

            default:
                return (null, false);
        }
    }

    private async Task WriteRecipeAtomicallyAsync(byte[] bytes, CancellationToken token)
    {
        var directory = Path.GetDirectoryName(RecipeOutPath);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
        var temp = RecipeOutPath + $".{Guid.NewGuid():N}.tmp";
        try
        {
            await File.WriteAllBytesAsync(temp, bytes, token);
            File.Move(temp, RecipeOutPath, true);
        }
        finally
        {
            try { if (File.Exists(temp)) File.Delete(temp); } catch { }
        }
    }

    private static async Task PingAsync(System.Net.WebSockets.ClientWebSocket socket, CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            await Task.Delay(TimeSpan.FromSeconds(20), token);
            await SendAsync(socket, new { kind = "ping" }, token);
        }
    }

    private static async Task SendAsync(System.Net.WebSockets.ClientWebSocket socket, object frame, CancellationToken token)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(frame);
        await socket.SendAsync(bytes, System.Net.WebSockets.WebSocketMessageType.Text, true, token);
    }

    private static async Task<string?> ReceiveTextAsync(System.Net.WebSockets.ClientWebSocket socket, CancellationToken token)
    {
        using var stream = new MemoryStream();
        var buffer = new byte[8192];
        System.Net.WebSockets.WebSocketReceiveResult result;
        do
        {
            result = await socket.ReceiveAsync(buffer, token);
            if (result.MessageType == System.Net.WebSockets.WebSocketMessageType.Close) return null;
            if (result.MessageType != System.Net.WebSockets.WebSocketMessageType.Text)
                throw new InvalidOperationException("Relay sent a non-text pairing frame.");
            stream.Write(buffer, 0, result.Count);
            if (stream.Length > 2 * 1024 * 1024)
                throw new InvalidOperationException("Relay pairing frame exceeded the size limit.");
        } while (!result.EndOfMessage);
        return Encoding.UTF8.GetString(stream.GetBuffer(), 0, checked((int)stream.Length));
    }

    public void Cancel()
    {
        try { _cts.Cancel(); } catch { }
        try { _socket?.Abort(); } catch { }
    }

    public void Dispose()
    {
        Cancel();
        _socket?.Dispose();
        _cts.Dispose();
    }
}
import { Socket } from "node:net";
import { FrameReader, PRIVD_PROTOCOL_VERSION, PrivdError, encodeFrame, type PrivdErrorCode, type PrivdResponse } from "./wire.js";

/** A connection to the broker. One request at a time per call; reconnects on demand. */
export class PrivdClient {
  private socket: Socket | null = null;
  private reader = new FrameReader();
  private nextId = 1;
  private pending = new Map<number, (r: PrivdResponse) => void>();
  private connecting: Promise<void> | null = null;

  constructor(private readonly socketPath: string) {}

  private async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const s = new Socket();
      this.reader = new FrameReader();
      s.once("error", (e) => {
        this.connecting = null;
        reject(e);
      });
      s.on("data", (chunk) => {
        try {
          for (const f of this.reader.push(chunk)) {
            const r = f as PrivdResponse;
            const cb = this.pending.get(r.id);
            if (cb) {
              this.pending.delete(r.id);
              cb(r);
            }
          }
        } catch {
          s.destroy();
        }
      });
      s.on("close", () => {
        for (const cb of this.pending.values()) cb({ id: 0, ok: false, code: "failed", message: "the broker connection closed" });
        this.pending.clear();
        this.socket = null;
      });
      s.connect(this.socketPath, async () => {
        this.socket = s;
        this.connecting = null;
        const r = await this.rawCall("hello", { version: PRIVD_PROTOCOL_VERSION });
        if (!r.ok) {
          s.destroy();
          reject(new PrivdError(r.code, r.message));
          return;
        }
        resolve();
      });
    });
    return this.connecting;
  }

  private rawCall(op: string, args: Record<string, unknown>): Promise<PrivdResponse> {
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.pending.set(id, resolve);
      this.socket!.write(encodeFrame({ id, op, args }));
    });
  }

  async call(op: string, args: Record<string, unknown>): Promise<{ stdout?: string; stderr?: string }> {
    await this.connect();
    const r = await this.rawCall(op, args);
    if (!r.ok) throw new PrivdError(r.code as PrivdErrorCode, r.message);
    return r.result;
  }

  power(action: "poweroff" | "reboot"): Promise<unknown> {
    return this.call("power", { action });
  }

  restart(unit: string): Promise<unknown> {
    return this.call("systemd.restart", { unit });
  }

  docker(argv: string[], stdin?: string): Promise<{ stdout?: string; stderr?: string }> {
    return this.call("docker", { argv, ...(stdin !== undefined ? { stdin } : {}) });
  }

  nft(script: string): Promise<unknown> {
    return this.call("nft.apply", { script });
  }

  close(): void {
    this.socket?.destroy();
  }
}

/**
 * A `CommandRunner` for the unprivileged daemon: `docker` goes to the broker, and no other binary
 * is run on its behalf. (The runner shape is the daemon's `serviceRunner.CommandRunner`.)
 */
export function brokerCommandRunner(client: PrivdClient) {
  const guard = (cmd: string) => {
    if (cmd !== "docker") throw new Error(`${cmd} is not available to the unprivileged daemon`);
  };
  return {
    async run(cmd: string, args: string[]): Promise<void> {
      guard(cmd);
      await client.docker(args);
    },
    async capture(cmd: string, args: string[], opts?: { input?: Buffer | string }): Promise<{ stdout: string; stderr: string }> {
      guard(cmd);
      const r = await client.docker(args, opts?.input === undefined ? undefined : String(opts.input));
      return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
  };
}

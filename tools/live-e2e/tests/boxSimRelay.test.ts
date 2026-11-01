// The simulated box of the H6 live groups against the TypeScript hub in process (the relay-conformance rig): its HELLO
// is accepted, a visitor's stream reaches it and reads its label, a held stream is closed when the tunnel goes, and a
// box entitled to the bare account name never gets that route.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockCom, boxIdentity, hex, sleep, startTs, waitFor, type RunningRelayTarget } from "../../relay-conformance/harness.js";
import { RawVisitor, SimBox, simHelloPayload, type SimServer } from "../lib/boxSim.js";

describe("SimBox through the TS relay", () => {
  let com: MockCom;
  let relay: RunningRelayTarget | null = null;
  const sims: SimBox[] = [];

  beforeEach(async () => {
    com = new MockCom();
    await com.start();
    relay = await startTs(com);
    await waitFor(() => com.blessed !== null, 5_000, "the hub blessing request");
  });
  afterEach(async () => {
    for (const s of sims.splice(0)) s.terminate();
    await relay?.kill();
    relay = null;
    await com.stop();
  });

  const setup = (greedy: string[] = []) => {
    const a = com.account("alice");
    const b = boxIdentity(com, a, "home");
    const server: SimServer = { label: "home", fqdn: b.pod, stk: b.stk, stkHex: hex(b.stk.publicKey) };
    const app = `notes.${b.pod}`;
    const connect = async () => {
      const payload = await simHelloPayload({ username: a.username, server, irk: a.irk, canonicals: [app, ...greedy] });
      const s = await SimBox.connect(`ws://127.0.0.1:${relay!.hubPort}/tunnel`, payload, { label: "S", ackMs: 5_000 });
      sims.push(s);
      return s;
    };
    return { server, app, connect, bare: `${a.username}.flagship.services` };
  };

  it("is accepted, answers a visitor with its label, and a held stream ends with the tunnel", async () => {
    const { server, app, connect } = setup();
    const s = await connect();
    expect(s.accepted).toBe(true);
    for (const sni of [server.fqdn, app]) {
      const v = await RawVisitor.open("127.0.0.1", sni, relay!.sniPort);
      expect(await v.firstAnswer(3_000)).toEqual({ label: "S", sni });
      v.end();
    }
    const held = await RawVisitor.open("127.0.0.1", server.fqdn, relay!.sniPort);
    expect((await held.firstAnswer(3_000))?.label).toBe("S");
    s.terminate();
    await Promise.race([held.closed, sleep(5_000)]);
    expect(held.closedAt).not.toBeNull();
  });

  it("never gets the bare account name, even entitled to it", async () => {
    const { bare, connect } = setup([`alice.flagship.services`]);
    const s = await connect();
    if (s.accepted) {
      const v = await RawVisitor.open("127.0.0.1", bare, relay!.sniPort);
      expect(await v.firstAnswer(1_500)).toBeNull();
      v.end();
    } else {
      expect(s.ack?.ok ?? false).toBe(false);
    }
  });
});

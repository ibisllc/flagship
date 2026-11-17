// Drives rust/crates/flagship-turn-lite (examples/turn_harness.rs) with real Chrome WebRTC on both ends:
// a caller with `iceTransportPolicy: "relay"` and our TURN server as its only ICE server (the voi.ci browser), and an
// answerer with no ICE servers whose one host candidate is the TURN server's only permitted peer (the phone's own peer
// connection). Prints ICE/DTLS states and audio bytes on both sides. See README.md.
//
//   node tools/voici-calls-ice/run.mjs [--ip <host ip>] [--seconds 20] [--rate 8000] [--video] [--loopback]
// --loopback: the caller sees the phone's real addresses (relay and peer 127.0.0.1); the harness translates.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const require = createRequire(process.env.PLAYWRIGHT_FROM ? path.join(process.env.PLAYWRIGHT_FROM, "package.json") : path.join(root, "package.json"));
const { chromium } = require("playwright");

const ip = arg("--ip", "127.0.0.1");
const seconds = Number(arg("--seconds", "20"));
const rate = arg("--rate", "8000");
const video = process.argv.includes("--video");
const loopback = process.argv.includes("--loopback");
const extraV6 = process.argv.includes("--v6-candidate");
const port = 3479;
const user = "7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e";
const pass = "5ec75ec75ec75ec75ec75ec75ec75ec7";
const bin = process.env.TURN_HARNESS ?? path.join(process.env.CARGO_TARGET_DIR ?? path.join(root, "rust/target"), "debug/examples/turn_harness");

const turn = spawn(bin, [`${ip}:${port}`, ip, ip, user, pass, rate, ...(loopback ? ["loopback"] : [])], { stdio: ["ignore", "inherit", "pipe"] });
const turnLog = [];
let partial = "";
turn.stderr.on("data", (d) => {
  const lines = (partial + String(d)).split("\n");
  partial = lines.pop() ?? "";
  for (const l of lines) if (l) { turnLog.push(l); if (process.env.VERBOSE) console.error("turn:", l); }
});
await new Promise((r) => setTimeout(r, 300));

const browser = await chromium.launch({ args: ["--disable-features=WebRtcHideLocalIpsWithMdns", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
const page = await browser.newPage();
page.on("console", (m) => console.log("page:", m.text()));
let result;
try {
  result = await page.evaluate(async ({ ip, port, user, pass, seconds, video, loopback, extraV6 }) => {
    const asSeen = (c) => (loopback ? c.replace(ip, "127.0.0.1") : c);
    const log = (...a) => console.log(...a);
    const ac = new AudioContext();
    const tone = () => { const o = ac.createOscillator(); const d = ac.createMediaStreamDestination(); o.connect(d); o.start(); return d.stream.getAudioTracks()[0]; };
    const caller = new RTCPeerConnection({ iceServers: [], iceTransportPolicy: "relay", bundlePolicy: "max-bundle", rtcpMuxPolicy: "require" });
    const phone = new RTCPeerConnection({ iceServers: [], bundlePolicy: "max-bundle", rtcpMuxPolicy: "require" });
    for (const [n, pc] of [["caller", caller], ["phone", phone]]) {
      pc.oniceconnectionstatechange = () => log(`${n} ice ${pc.iceConnectionState}`);
      pc.onconnectionstatechange = () => log(`${n} connection ${pc.connectionState}`);
      pc.onicecandidateerror = (e) => log(`${n} candidate error ${e.errorCode} ${e.errorText} ${e.url}`);
    }
    caller.addTrack(tone());
    phone.addTrack(tone());
    if (video) {
      // A moving canvas stands in for the camera (about:blank has no getUserMedia).
      const cv = document.createElement("canvas");
      cv.width = 320; cv.height = 240;
      const g = cv.getContext("2d");
      setInterval(() => { g.fillStyle = `hsl(${Date.now() % 360} 80% 50%)`; g.fillRect(0, 0, 320, 240); }, 33);
      caller.addTrack(cv.captureStream(30).getVideoTracks()[0]);
      phone.addTransceiver("video", { direction: "sendrecv" });
    }
    // The browser: the offer first, then the TURN server once the answer names it, as packages/flagship-web/src/call.js.
    const offer = await caller.createOffer();
    const phoneCands = [];
    phone.onicecandidate = (e) => { if (e.candidate) phoneCands.push(e.candidate); };
    await phone.setRemoteDescription(offer);
    const answer = await phone.createAnswer();
    await phone.setLocalDescription(answer);
    await new Promise((r) => { if (phone.iceGatheringState === "complete") r(); phone.onicegatheringstatechange = () => phone.iceGatheringState === "complete" && r(); });
    // Like the phone: one UDP host candidate on the TURN server's peer address.
    const keep = phoneCands.filter((c) => c.protocol === "udp" && c.type === "host" && c.address === ip);
    log(`phone candidates: ${phoneCands.map((c) => `${c.type}/${c.protocol}/${c.address}`).join(", ")}; kept ${keep.length}`);
    const sdp = phone.localDescription.sdp.split(/\r\n/).filter((l) => !l.startsWith("a=candidate:") && l !== "a=end-of-candidates");
    const m = sdp.findIndex((l) => l.startsWith("m="));
    const answerSdp = [...sdp.slice(0, m + 1), ...sdp.slice(m + 1)].join("\r\n").replace(/(m=audio[^\r]*\r\n)/, (x) => x);
    const withCands = answerSdp.replace(/(a=mid:0\r\n)/, `$1${[...keep.map((c) => `a=${asSeen(c.candidate)}\r\n`), ...(extraV6 ? ["a=candidate:2 1 udp 2122262783 ::1 56275 typ host generation 0 network-id 2\r\n"] : [])].join("")}`);
    caller.setConfiguration({ iceServers: [{ urls: `turn:${ip}:${port}?transport=tcp`, username: user, credential: pass }], iceTransportPolicy: "relay", bundlePolicy: "max-bundle", rtcpMuxPolicy: "require" });
    caller.onicecandidate = (e) => {
      if (!e.candidate) return;
      log(`caller candidate ${e.candidate.type}/${e.candidate.protocol}/${e.candidate.address}:${e.candidate.port}`);
      const c = loopback ? new RTCIceCandidate({ candidate: e.candidate.candidate.replace("127.0.0.1", ip), sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex }) : e.candidate;
      phone.addIceCandidate(c).catch((x) => log(`phone addIceCandidate failed ${x}`));
    };
    await caller.setLocalDescription(offer);
    await caller.setRemoteDescription({ type: "answer", sdp: withCands });
    await new Promise((r) => setTimeout(r, seconds * 1000));
    const stats = async (pc) => {
      const out = {};
      (await pc.getStats()).forEach((s) => {
        if (s.type === "inbound-rtp") out[`in-${s.kind}`] = s.bytesReceived;
        if (s.type === "outbound-rtp") out[`out-${s.kind}`] = s.bytesSent;
        if (s.type === "transport") out.dtls = s.dtlsState;
        if (s.type === "candidate-pair" && s.nominated) out.pair = `${s.state} req=${s.requestsSent} resp=${s.responsesReceived}`;
      });
      return out;
    };
    return { caller: { ice: caller.iceConnectionState, ...(await stats(caller)) }, phone: { ice: phone.iceConnectionState, ...(await stats(phone)) } };
  }, { ip, port, user, pass, seconds, video, loopback, extraV6 });
} finally {
  await browser.close();
  turn.kill();
}
console.log(JSON.stringify(result, null, 2));
const counts = {};
for (const l of turnLog) { const k = l.replace(/^\[\d+\] /, "").replace(/\d+\.\d+\.\d+\.\d+:\d+/g, "A").replace(/ len=\d+/g, "").replace(/ \(#\d+\)/, "").replace(/conn from A, relay A/, "conn"); counts[k] = (counts[k] ?? 0) + 1; }
console.log("turn log summary:");
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${v}\t${k}`);
const ok = result.caller.ice === "connected" || result.caller.ice === "completed";
const flowing = (result.phone["in-audio"] ?? 0) > 1000 && (result.caller["in-audio"] ?? 0) > 1000;
console.log(ok && flowing ? "PASS: ICE connected and audio flows both ways" : "FAIL");
process.exit(ok && flowing ? 0 : 1);

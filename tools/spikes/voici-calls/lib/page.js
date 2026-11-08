// Spike page: runs in Chromium under Playwright. Every test is a window.* function the orchestrator calls.
const now = () => performance.timeOrigin + performance.now();
const KEY_BYTES = new Uint8Array(32).fill(7); // spike only: the real key comes from the X-Wing exchange
const keyP = crypto.subtle.importKey("raw", KEY_BYTES, "AES-GCM", false, ["encrypt", "decrypt"]);
const nonce = (dir, seq) => { const n = new Uint8Array(12); const v = new DataView(n.buffer); v.setUint32(0, dir); v.setBigUint64(4, BigInt(seq)); return n; };
const aad = (dir, seq) => new TextEncoder().encode(`flagship/spike-call/v1|${dir}|${seq}`);

// Seeded speech-like signal: talk spurts of syllables (voiced harmonics through three formants) and pauses.
function makeSpeech(seconds, sr = 48000, seed = 7) {
  let s = seed; const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  const out = new Float32Array(seconds * sr); const talk = new Uint8Array(seconds * sr);
  let t = 0;
  while (t < out.length) {
    const spurt = Math.floor((1.2 + rnd() * 1.0) * sr), pause = Math.floor((0.5 + rnd() * 0.6) * sr);
    for (let i = 0; i < spurt && t < out.length; i++, t++) {
      const tt = t / sr, f0 = 130 + 35 * Math.sin(2 * Math.PI * 0.7 * tt);
      const env = Math.pow(Math.max(0, Math.sin(2 * Math.PI * 4.3 * tt)), 0.6);
      let v = 0;
      for (let k = 1; k <= 24; k++) {
        const f = k * f0;
        const w = Math.exp(-(((f - 600) / 200) ** 2)) + 0.6 * Math.exp(-(((f - 1700) / 300) ** 2)) + 0.3 * Math.exp(-(((f - 2600) / 400) ** 2));
        v += w * Math.sin(2 * Math.PI * f * tt);
      }
      const fric = (Math.sin(2 * Math.PI * 1.1 * tt) > 0.85 ? (rnd() * 2 - 1) * 0.5 : 0);
      out[t] = 0.25 * env * (v / 3 + fric); talk[t] = 1;
    }
    for (let i = 0; i < pause && t < out.length; i++, t++) { out[t] = (rnd() * 2 - 1) * 0.0005; talk[t] = 0; }
  }
  return { pcm: out, talk };
}

const stats = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), mean = a.reduce((x, y) => x + y, 0) / a.length;
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: a.length, min: s[0], p50: q(0.5), p95: q(0.95), p99: q(0.99), max: s[s.length - 1], mean: +mean.toFixed(2),
    stdev: +Math.sqrt(a.reduce((x, y) => x + (y - mean) ** 2, 0) / a.length).toFixed(2), distinct: new Set(a).size };
};

window.caps = async () => {
  const c = {
    AudioEncoder: typeof AudioEncoder === "function", AudioDecoder: typeof AudioDecoder === "function",
    RTCRtpScriptTransform: typeof RTCRtpScriptTransform === "function",
    createEncodedStreams: typeof RTCRtpSender !== "undefined" && "createEncodedStreams" in RTCRtpSender.prototype,
    WebTransport: typeof WebTransport === "function", userAgent: navigator.userAgent,
  };
  if (c.AudioEncoder) {
    for (const mode of ["constant", "variable"]) {
      const r = await AudioEncoder.isConfigSupported({ codec: "opus", sampleRate: 48000, numberOfChannels: 1, bitrate: 24000, bitrateMode: mode,
        opus: { frameDuration: 20000, complexity: 10, usedtx: false, useinbandfec: false } });
      c[`opus_${mode}`] = r.supported && r.config.bitrateMode === mode;
    }
  }
  c.supportedConstraints = { echoCancellation: !!navigator.mediaDevices.getSupportedConstraints().echoCancellation };
  try {
    const st = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } });
    const tr = st.getAudioTracks()[0];
    c.echoCancellationCapabilities = tr.getCapabilities?.().echoCancellation ?? null;
    c.echoCancellationDefaultSetting = tr.getSettings().echoCancellation;
    try { await tr.applyConstraints({ echoCancellation: { exact: "all" } }); c.echoCancellationAll = tr.getSettings().echoCancellation; }
    catch (e) { c.echoCancellationAll = "refused: " + (e.constraint ?? e.name); }
    tr.stop();
  } catch (e) { c.gum = String(e); }
  return c;
};

// ---------- Option B: WebCodecs Opus ----------
async function encodeOpus(pcm, mode, seconds) {
  const chunks = [];
  const enc = new AudioEncoder({ output: (ch) => { const b = new Uint8Array(ch.byteLength); ch.copyTo(b); chunks.push(b); }, error: (e) => { throw e; } });
  enc.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 1, bitrate: 24000, bitrateMode: mode,
    opus: { frameDuration: 20000, complexity: 10, usedtx: false, useinbandfec: false } });
  const step = 960;
  for (let i = 0; i + step <= Math.min(pcm.length, seconds * 48000); i += step) {
    enc.encode(new AudioData({ format: "f32", sampleRate: 48000, numberOfFrames: step, numberOfChannels: 1, timestamp: (i / 48) * 1000, data: pcm.subarray(i, i + step) }));
  }
  await enc.flush(); enc.close();
  return chunks;
}

window.frameSizesB = async (seconds = 20) => {
  const { pcm, talk } = makeSpeech(seconds);
  const out = {};
  for (const mode of ["constant", "variable"]) {
    const chunks = await encodeOpus(pcm, mode, seconds);
    const talkSizes = [], pauseSizes = [];
    chunks.forEach((c, i) => (talk[i * 960 + 480] ? talkSizes : pauseSizes).push(c.length));
    out[mode] = { all: stats(chunks.map((c) => c.length)), talk: stats(talkSizes), pause: stats(pauseSizes) };
  }
  // decode check: CBR frames decode back to audio
  const chunks = await encodeOpus(pcm, "constant", 2); let decoded = 0;
  const dec = new AudioDecoder({ output: (d) => { decoded += d.numberOfFrames; d.close(); }, error: (e) => { throw e; } });
  dec.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 1 });
  chunks.forEach((c, i) => dec.decode(new EncodedAudioChunk({ type: "key", timestamp: i * 20000, data: c })));
  await dec.flush();
  out.decodedSamples = decoded;
  return out;
};

window.callB = async ({ url, seconds }) => {
  const { pcm } = makeSpeech(10);
  const frames = (await encodeOpus(pcm, "constant", 10)).map((c) => { const p = new Uint8Array(64); p.set(c.subarray(0, 64)); return p; });
  const key = await keyP;
  const ws = new WebSocket(url); ws.binaryType = "arraybuffer";
  const got = []; let bad = 0, droppedAtSender = 0, sent = 0;
  ws.onmessage = async (ev) => {
    const at = now(); const b = new Uint8Array(ev.data); const seq = Number(new DataView(b.buffer).getBigUint64(0));
    try {
      const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce(2, seq), additionalData: aad(2, seq) }, key, b.subarray(8)));
      got.push([seq, new DataView(pt.buffer).getFloat64(0), at]);
    } catch { bad++; }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws error")); });
  const t0 = performance.now(); let seq = 0;
  await new Promise((res) => {
    const tick = async () => {
      const due = Math.floor((performance.now() - t0) / 20);
      while (seq <= due) {
        const s = seq++;
        if (ws.bufferedAmount > 3 * 100) { droppedAtSender++; continue; }
        const pt = new Uint8Array(8 + 64); new DataView(pt.buffer).setFloat64(0, now()); pt.set(frames[s % frames.length], 8);
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce(1, s), additionalData: aad(1, s) }, key, pt));
        const msg = new Uint8Array(8 + ct.length); new DataView(msg.buffer).setBigUint64(0, BigInt(s)); msg.set(ct, 8);
        ws.send(msg); sent++;
      }
      if (performance.now() - t0 < seconds * 1000) setTimeout(tick, 5); else res();
    };
    tick();
  });
  await new Promise((r) => setTimeout(r, 1500));
  ws.close();
  await new Promise((r) => setTimeout(r, 500));
  return { got, sent, droppedAtSender, bad };
};

// ---------- Option A: WebRTC, Opus with SDP options, frames sealed in an encoded transform ----------
function mungeOpus(sdp, { cbr, stripAudioLevel }) {
  let s = sdp;
  const pt = (s.match(/a=rtpmap:(\d+) opus\/48000/) || [])[1];
  if (pt && cbr) s = s.replace(new RegExp(`a=fmtp:${pt} (.*)`), (_m, p) => `a=fmtp:${pt} ${p.replace(/;?(cbr|usedtx|maxaveragebitrate|useinbandfec)=\d+/g, "")};cbr=1;usedtx=0;useinbandfec=0;maxaveragebitrate=24000`);
  if (stripAudioLevel) s = s.split("\r\n").filter((l) => !/a=extmap:\d+ urn:ietf:params:rtp-hdrext:ssrc-audio-level/.test(l)).join("\r\n");
  return s;
}

let speechTrack;
function speechStream() {
  const ctx = new AudioContext({ sampleRate: 48000 });
  const { pcm } = makeSpeech(10);
  const buf = ctx.createBuffer(1, pcm.length, 48000); buf.copyToChannel(pcm, 0);
  const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
  const dst = ctx.createMediaStreamDestination(); src.connect(dst); src.start();
  return dst.stream;
}

function senderTransform(sizes, dirTag) {
  let seq = 0;
  return new TransformStream({
    async transform(frame, ctl) {
      const s = seq++; const data = new Uint8Array(frame.data); sizes.push(data.length);
      const pt = new Uint8Array(8 + data.length); new DataView(pt.buffer).setFloat64(0, now()); pt.set(data, 8);
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce(dirTag, s), additionalData: aad(dirTag, s) }, await keyP, pt));
      const out = new Uint8Array(8 + ct.length); new DataView(out.buffer).setBigUint64(0, BigInt(s)); out.set(ct, 8);
      frame.data = out.buffer; ctl.enqueue(frame);
    },
  });
}
function receiverTransform(got, dirTag, counters) {
  return new TransformStream({
    async transform(frame, ctl) {
      const at = now(); const b = new Uint8Array(frame.data);
      try {
        const seq = Number(new DataView(b.buffer).getBigUint64(0));
        const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce(dirTag, seq), additionalData: aad(dirTag, seq) }, await keyP, b.subarray(8)));
        got.push([seq, new DataView(pt.buffer).getFloat64(0), at]);
        frame.data = pt.slice(8).buffer; ctl.enqueue(frame);
      } catch { counters.bad++; }
    },
  });
}

const A = { pc: null, sizes: [], got: [], counters: { bad: 0 } };
window.aSetup = async ({ iceServers, policy, role, cbr, stripAudioLevel, encrypt = true }) => {
  A.opts = { cbr, stripAudioLevel }; A.sizes = []; A.got = []; A.counters = { bad: 0 }; A.cands = [];
  A.pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: policy, encodedInsertableStreams: encrypt });
  A.pc.onicecandidate = (e) => { if (e.candidate) A.cands.push(e.candidate.toJSON()); };
  const tr = speechStream().getAudioTracks()[0];
  const sender = A.pc.addTrack(tr, new MediaStream([tr]));
  const myDir = role === "caller" ? 1 : 2, theirDir = role === "caller" ? 2 : 1;
  if (encrypt) { const { readable, writable } = sender.createEncodedStreams(); readable.pipeThrough(senderTransform(A.sizes, myDir)).pipeTo(writable); }
  A.pc.ontrack = (e) => {
    if (encrypt) { const { readable, writable } = e.receiver.createEncodedStreams(); readable.pipeThrough(receiverTransform(A.got, theirDir, A.counters)).pipeTo(writable); }
    const el = new Audio(); el.srcObject = e.streams[0] ?? new MediaStream([e.track]); el.play().catch(() => {}); A.el = el;
  };
  return true;
};
window.aOffer = async () => { const o = await A.pc.createOffer(); o.sdp = mungeOpus(o.sdp, A.opts); await A.pc.setLocalDescription(o); await gatherDone(); return A.pc.localDescription.toJSON(); };
window.aAnswer = async (offer) => { await A.pc.setRemoteDescription(offer); const a = await A.pc.createAnswer(); a.sdp = mungeOpus(a.sdp, A.opts); await A.pc.setLocalDescription(a); await gatherDone(); return A.pc.localDescription.toJSON(); };
window.aAccept = async (answer) => { await A.pc.setRemoteDescription(answer); return true; };
async function gatherDone() { if (A.pc.iceGatheringState === "complete") return; await new Promise((r) => { const t = setTimeout(r, 8000); A.pc.addEventListener("icegatheringstatechange", () => { if (A.pc.iceGatheringState === "complete") { clearTimeout(t); r(); } }); }); }
window.aWaitConnected = async (ms = 15000) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (A.pc.connectionState === "connected") return true; if (A.pc.connectionState === "failed") return false; await new Promise((r) => setTimeout(r, 100)); } return A.pc.connectionState; };
window.aStats = async () => {
  const rep = await A.pc.getStats(); const o = { inbound: null, outbound: null, pair: null, transport: null, local: null };
  rep.forEach((s) => {
    if (s.type === "inbound-rtp" && s.kind === "audio") o.inbound = s;
    if (s.type === "outbound-rtp" && s.kind === "audio") o.outbound = s;
    if (s.type === "transport") o.transport = { dtlsCipher: s.dtlsCipher, srtpCipher: s.srtpCipher, tlsVersion: s.tlsVersion, dtlsRole: s.dtlsRole, selectedCandidatePairId: s.selectedCandidatePairId };
  });
  if (o.transport?.selectedCandidatePairId) { const p = rep.get(o.transport.selectedCandidatePairId); o.pair = { currentRoundTripTime: p.currentRoundTripTime, totalRoundTripTime: p.totalRoundTripTime, responsesReceived: p.responsesReceived }; const l = rep.get(p.localCandidateId); o.local = { candidateType: l.candidateType, relayProtocol: l.relayProtocol, protocol: l.protocol }; }
  return o;
};
window.aSdp = () => A.pc.localDescription?.sdp ?? "";
window.aCollect = () => ({ sizes: A.sizes, got: A.got, bad: A.counters.bad, cands: A.cands });
window.aClose = () => { A.pc?.close(); A.el?.pause(); return true; };

// Option A frame-size check without a network: two connections in this page, with or without cbr=1.
window.frameSizesA = async ({ cbr, seconds = 10 }) => {
  const mk = () => new RTCPeerConnection({ encodedInsertableStreams: true });
  const p1 = mk(), p2 = mk(); p1.onicecandidate = (e) => e.candidate && p2.addIceCandidate(e.candidate); p2.onicecandidate = (e) => e.candidate && p1.addIceCandidate(e.candidate);
  const tr = speechStream().getAudioTracks()[0]; const sender = p1.addTrack(tr, new MediaStream([tr]));
  const sizes = []; const { readable, writable } = sender.createEncodedStreams();
  readable.pipeThrough(new TransformStream({ transform(f, c) { sizes.push(f.data.byteLength); c.enqueue(f); } })).pipeTo(writable);
  p2.ontrack = (e) => { const { readable, writable } = e.receiver.createEncodedStreams(); readable.pipeTo(writable); const el = new Audio(); el.srcObject = new MediaStream([e.track]); el.play().catch(() => {}); };
  const o = await p1.createOffer(); o.sdp = mungeOpus(o.sdp, { cbr, stripAudioLevel: true }); await p1.setLocalDescription(o); await p2.setRemoteDescription(o);
  const a = await p2.createAnswer(); a.sdp = mungeOpus(a.sdp, { cbr, stripAudioLevel: true }); await p2.setLocalDescription(a); await p1.setRemoteDescription(a);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const extmapLeft = /ssrc-audio-level/.test(p1.localDescription.sdp);
  p1.close(); p2.close();
  return { cbr, sizes: stats(sizes.slice(25)), audioLevelExtNegotiated: extmapLeft };
};

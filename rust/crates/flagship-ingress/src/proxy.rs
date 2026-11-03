//! The app proxy (G4/R3): after TLS, a request for an app is decided by the daemon over a local
//! socket and then carried here, byte for byte, to the app's container, with bounded buffers,
//! backpressure, streaming responses (SSE), streamed uploads, WebSocket upgrades and deadlines.
//!
//! Authority stays where it is: the daemon decides who the visitor is and whether the request
//! may reach the app (`prepareAppRequest`, gates, API keys, identity signatures in keyd). The
//! ingress enforces the header rules of docs/app-apis.md §5 on its own (every client identity
//! header is dropped whatever the daemon answers, and the daemon may only set `x-flagship-`
//! headers) and dials only inside the app networks it was started with. The decision socket is
//! held open for the life of the proxied connection: the daemon closing it (the app's endpoint
//! was invalidated, a new deploy, an uninstall) closes the connection.
//!
//! Anything the proxy does not handle itself (a head it does not parse as the TS proxy does, a
//! decision other than "proxy", a daemon that does not answer) goes to the daemon's upstream
//! socket exactly as before, so the TS proxy remains the fallback for every request.

use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpStream, UnixStream};

use crate::http::{
    self, ChunkedDecoder, Injection, RequestBody, RequestHead, ResponseBody, Version,
};
use crate::server::Activity;

/// An IPv4 network the proxy may dial (the app bridges).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cidr {
    pub net: u32,
    pub prefix: u8,
}

impl Cidr {
    pub fn parse(s: &str) -> Option<Self> {
        let (ip, len) = s.split_once('/')?;
        let ip: Ipv4Addr = ip.parse().ok()?;
        let prefix: u8 = len.parse().ok()?;
        if prefix > 32 {
            return None;
        }
        let mask = Self::mask(prefix);
        Some(Self {
            net: u32::from(ip) & mask,
            prefix,
        })
    }

    fn mask(prefix: u8) -> u32 {
        if prefix == 0 {
            0
        } else {
            u32::MAX
                .checked_shl(32u32.saturating_sub(u32::from(prefix)))
                .unwrap_or(0)
        }
    }

    pub fn contains(&self, ip: Ipv4Addr) -> bool {
        u32::from(ip) & Self::mask(self.prefix) == self.net
    }

    /// Only private app networks: never loopback, never the whole address space.
    pub fn is_app_network(&self) -> bool {
        let ip = Ipv4Addr::from(self.net);
        self.prefix >= 8 && (ip.is_private() || (self.net >> 22) == (0x6440_0000u32 >> 22))
    }
}

#[derive(Debug, Clone)]
pub struct ProxyConfig {
    /// The daemon's decision socket.
    pub decide: PathBuf,
    /// Where an app may be: the app bridges' subnets.
    pub allow: Vec<Cidr>,
    pub decide_timeout: Duration,
    pub connect_timeout: Duration,
    /// Time for the app's response head, and no byte either way for this long ends the connection.
    pub idle_timeout: Duration,
    pub max_response_head: usize,
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            decide: "/run/flagship-tls/decide.sock".into(),
            allow: Vec::new(),
            decide_timeout: Duration::from_secs(5),
            connect_timeout: Duration::from_secs(3),
            idle_timeout: Duration::from_secs(10 * 60),
            max_response_head: 64 * 1024,
        }
    }
}

/// One request the daemon said may reach the app.
#[derive(Debug)]
pub struct Session {
    pub head: RequestHead,
    pub body: RequestBody,
    pub upgrade: bool,
    pub target: SocketAddrV4,
    pub injection: Injection,
    /// The name the connection was routed by (the TLS SNI): the app's Host, never the client's.
    pub routed_host: String,
    /// Bytes after the head the client already sent.
    pub rest: Vec<u8>,
    /// Held open for the connection's life; its end cancels the connection.
    pub lease: UnixStream,
}

#[derive(Debug)]
pub enum Route {
    /// The daemon's upstream socket handles the connection (the bytes it gets are unchanged).
    Daemon,
    Proxy(Box<Session>),
}

const MAX_DECISION: usize = 64 * 1024;

/// What the daemon is asked: the parsed head (never the body).
pub fn decide_request(sni: &str, head: &RequestHead, upgrade: bool, body: RequestBody) -> Value {
    json!({
        "v": 1,
        "sni": sni,
        "method": head.method,
        "target": head.target,
        "version": head.version.as_str(),
        "headers": head.headers.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>(),
        "upgrade": upgrade,
        "body": match body { RequestBody::None => "none", RequestBody::Length(_) => "length", RequestBody::Chunked => "chunked" },
    })
}

/// The daemon's answer, checked: a proxy target inside the allowed networks and an injection of
/// identity headers only. Anything else is the daemon's to handle.
pub fn parse_decision(v: &Value, allow: &[Cidr]) -> Option<(SocketAddrV4, Injection)> {
    if v.get("action").and_then(Value::as_str) != Some("proxy") {
        return None;
    }
    let host: Ipv4Addr = v.get("host")?.as_str()?.parse().ok()?;
    let port = u16::try_from(v.get("port")?.as_u64()?).ok()?;
    if port == 0 || !allow.iter().any(|c| c.contains(host)) {
        return None;
    }
    let pairs = |key: &str| -> Option<Vec<(String, String)>> {
        match v.get(key) {
            None => Some(Vec::new()),
            Some(Value::Array(items)) => items
                .iter()
                .map(|p| {
                    let a = p.as_array()?;
                    match a.as_slice() {
                        [k, val] => Some((k.as_str()?.to_owned(), val.as_str()?.to_owned())),
                        _ => None,
                    }
                })
                .collect(),
            Some(_) => None,
        }
    };
    let remove = match v.get("remove") {
        None => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|x| x.as_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()?,
        Some(_) => return None,
    };
    let inj = Injection {
        set: pairs("set")?,
        remove,
    };
    inj.validate().ok()?;
    Some((SocketAddrV4::new(host, port), inj))
}

async fn read_line(s: &mut UnixStream, max: usize) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        let n = s.read(&mut buf).await.ok()?;
        if n == 0 {
            return None;
        }
        let got = buf.get(..n)?;
        if let Some(i) = got.iter().position(|&b| b == b'\n') {
            out.extend_from_slice(got.get(..i)?);
            // The daemon sends nothing after its one line; a byte here would be a cancel.
            return if got.len() > i.saturating_add(1) {
                None
            } else {
                Some(out)
            };
        }
        out.extend_from_slice(got);
        if out.len() > max {
            return None;
        }
    }
}

/// Decide where the first request goes. Never fails: every doubt routes to the daemon.
pub async fn route(first: &[u8], sni: &str, cfg: &ProxyConfig) -> Route {
    let Some(end) = http::find_head_end(first) else {
        return Route::Daemon;
    };
    let Ok(head) = http::parse_request_head(first.get(..end).unwrap_or(&[])) else {
        return Route::Daemon;
    };
    let Ok(body) = http::request_body(&head) else {
        return Route::Daemon;
    };
    let upgrade = head.is_websocket_upgrade();
    let ask = async {
        let mut s = UnixStream::connect(&cfg.decide).await.ok()?;
        let mut line = serde_json::to_vec(&decide_request(sni, &head, upgrade, body)).ok()?;
        line.push(b'\n');
        s.write_all(&line).await.ok()?;
        let answer = read_line(&mut s, MAX_DECISION).await?;
        let v: Value = serde_json::from_slice(&answer).ok()?;
        let (target, injection) = parse_decision(&v, &cfg.allow)?;
        Some((s, target, injection))
    };
    match tokio::time::timeout(cfg.decide_timeout, ask).await {
        Ok(Some((lease, target, injection))) => Route::Proxy(Box::new(Session {
            rest: first.get(end.saturating_add(4)..).unwrap_or(&[]).to_vec(),
            head,
            body,
            upgrade,
            target,
            injection,
            routed_host: sni.to_owned(),
            lease,
        })),
        _ => Route::Daemon,
    }
}

const BUF: usize = 64 * 1024;

async fn write_flush<W: AsyncWrite + Unpin>(w: &mut W, b: &[u8]) -> std::io::Result<()> {
    w.write_all(b).await?;
    w.flush().await
}

/// Read the app's final response head (interim 1xx answers other than a wanted 101 are read and
/// dropped, as Node does); returns it with whatever followed it.
async fn read_final_head<R: AsyncRead + Unpin>(
    r: &mut R,
    max: usize,
    want_101: bool,
) -> Option<(http::ResponseHead, Vec<u8>)> {
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut chunk = vec![0u8; 8192];
    loop {
        if let Some(end) = http::find_head_end(&buf) {
            let rest = buf.get(end.saturating_add(4)..)?.to_vec();
            let resp = http::parse_response_head(buf.get(..end)?)?;
            let interim = (100..200).contains(&resp.status) && !(want_101 && resp.status == 101);
            if !interim {
                return Some((resp, rest));
            }
            buf = rest;
            continue;
        }
        if buf.len() > max {
            return None;
        }
        let n = r.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(chunk.get(..n)?);
    }
}

/// Serve one proxied request on `client` (the decrypted TLS stream). Ends when the exchange ends,
/// when nothing moves for the idle timeout, or when the daemon closes the decision socket.
pub async fn run<C>(client: C, s: Session, cfg: &ProxyConfig)
where
    C: AsyncRead + AsyncWrite + Unpin + Send,
{
    let Session {
        head,
        body,
        upgrade,
        target,
        injection,
        routed_host,
        rest,
        mut lease,
    } = s;
    let cancelled = async move {
        let mut b = [0u8; 1];
        let _ = lease.read(&mut b).await;
    };
    let exchange = exchange(
        client,
        head,
        body,
        upgrade,
        target,
        injection,
        &routed_host,
        rest,
        cfg,
    );
    tokio::select! {
        () = exchange => {}
        () = cancelled => {}
    }
}

const BAD_RESPONSE: &str = "bad gateway: the app sent no valid response";

#[allow(clippy::too_many_arguments)]
async fn exchange<C>(
    client: C,
    head: RequestHead,
    body: RequestBody,
    upgrade: bool,
    target: SocketAddrV4,
    injection: Injection,
    routed_host: &str,
    rest: Vec<u8>,
    cfg: &ProxyConfig,
) where
    C: AsyncRead + AsyncWrite + Unpin + Send,
{
    let activity = Activity::new();
    let mut client = activity.track(client);
    let method = head.method.clone();
    let connect = tokio::time::timeout(
        cfg.connect_timeout,
        TcpStream::connect(SocketAddr::V4(target)),
    )
    .await;
    let up = match connect {
        Ok(Ok(u)) => u,
        Ok(Err(e)) => {
            let text = format!("bad gateway: {e}");
            let _ = write_flush(&mut client, &http::plain_response(502, &text, &method, &[])).await;
            let _ = client.shutdown().await;
            return;
        }
        Err(_) => {
            let r = http::plain_response(502, "bad gateway: connect timed out", &method, &[]);
            let _ = write_flush(&mut client, &r).await;
            let _ = client.shutdown().await;
            return;
        }
    };
    let _ = up.set_nodelay(true);
    let mut up = activity.track(up);
    let expects = head
        .get("expect")
        .is_some_and(|e| e.eq_ignore_ascii_case("100-continue"));
    if body != RequestBody::None
        && expects
        && write_flush(&mut client, b"HTTP/1.1 100 Continue\r\n\r\n")
            .await
            .is_err()
    {
        return;
    }
    let headers = http::with_routed_host(
        http::forward_request_headers(&head.headers, &injection, upgrade, body),
        routed_host,
    );
    let wire = http::encode_request_head(&head.method, &head.target, &headers, &target.to_string());
    if write_flush(&mut up, &wire).await.is_err() {
        let r = http::plain_response(
            502,
            "bad gateway: the app closed the connection",
            &method,
            &[],
        );
        let _ = write_flush(&mut client, &r).await;
        return;
    }
    let watchdog = activity.idle(cfg.idle_timeout);
    tokio::pin!(watchdog);
    if upgrade {
        tokio::select! {
            () = upgrade_exchange(client, up, &method, rest, head.version, cfg.max_response_head) => {}
            () = &mut watchdog => {}
        }
        return;
    }
    let (mut cr, mut cw) = tokio::io::split(client);
    let (mut ur, mut uw) = tokio::io::split(up);
    let responded = AtomicBool::new(false);
    let malformed = {
        let upload = async {
            let r = send_body(&mut cr, &mut uw, body, rest).await;
            if r.is_ok() {
                let _ = uw.flush().await;
            }
            r
        };
        let download = async {
            match read_final_head(&mut ur, cfg.max_response_head, false).await {
                Some((resp, after)) => {
                    relay_response(
                        &mut ur,
                        &mut cw,
                        &method,
                        head.version,
                        resp,
                        after,
                        &responded,
                    )
                    .await;
                }
                None => {
                    let r = http::plain_response(502, BAD_RESPONSE, &method, &[]);
                    let _ = write_flush(&mut cw, &r).await;
                    let _ = cw.shutdown().await;
                }
            }
        };
        tokio::pin!(upload);
        tokio::pin!(download);
        let mut upload_done = false;
        loop {
            tokio::select! {
                r = &mut upload, if !upload_done => {
                    upload_done = true;
                    if r.is_err() && !responded.load(Ordering::SeqCst) {
                        break true;
                    }
                }
                () = &mut download => break false,
                () = &mut watchdog => break false,
            }
        }
    };
    if malformed {
        let r = http::plain_response(400, "malformed request body", &method, &[]);
        let _ = write_flush(&mut cw, &r).await;
        let _ = cw.shutdown().await;
    }
}

#[derive(Debug)]
struct Malformed;

/// Stream the request body to the app: exactly the declared length, or a chunked body decoded
/// and re-chunked. Backpressure is the app's: nothing more is read from the client until the
/// last piece was written.
async fn send_body<R, W>(
    client: &mut R,
    up: &mut W,
    body: RequestBody,
    rest: Vec<u8>,
) -> Result<(), Malformed>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    match body {
        RequestBody::None => Ok(()),
        RequestBody::Length(total) => {
            let mut left = total;
            let first_len = usize::try_from(left).map_or(rest.len(), |l| l.min(rest.len()));
            if first_len > 0 {
                up.write_all(rest.get(..first_len).unwrap_or(&[]))
                    .await
                    .map_err(|_| Malformed)?;
                left = left.saturating_sub(first_len as u64);
            }
            let mut buf = vec![0u8; BUF];
            while left > 0 {
                let want = usize::try_from(left).map_or(BUF, |l| l.min(BUF));
                let n = client
                    .read(buf.get_mut(..want).unwrap_or(&mut []))
                    .await
                    .map_err(|_| Malformed)?;
                if n == 0 {
                    return Err(Malformed);
                }
                up.write_all(buf.get(..n).unwrap_or(&[]))
                    .await
                    .map_err(|_| Malformed)?;
                left = left.saturating_sub(n as u64);
            }
            Ok(())
        }
        RequestBody::Chunked => {
            let mut dec = ChunkedDecoder::new();
            let mut pending: Vec<u8> = Vec::new();
            let mut feed = rest;
            let mut buf = vec![0u8; BUF];
            loop {
                pending.clear();
                dec.push(&feed, &mut |d: &[u8]| pending.extend_from_slice(d))
                    .map_err(|_| Malformed)?;
                if !pending.is_empty() {
                    up.write_all(&http::encode_chunk(&pending))
                        .await
                        .map_err(|_| Malformed)?;
                }
                if dec.done() {
                    up.write_all(http::LAST_CHUNK)
                        .await
                        .map_err(|_| Malformed)?;
                    return Ok(());
                }
                let n = client.read(&mut buf).await.map_err(|_| Malformed)?;
                if n == 0 {
                    return Err(Malformed);
                }
                feed = buf.get(..n).unwrap_or(&[]).to_vec();
            }
        }
    }
}

/// Relay the app's response: the head rewritten, then the body as it arrives, flushed per read so
/// an event stream reaches the client event by event.
async fn relay_response<R, W>(
    up: &mut R,
    client: &mut W,
    method: &str,
    client_version: Version,
    resp: http::ResponseHead,
    mut rest: Vec<u8>,
    responded: &AtomicBool,
) where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let Some(framing) = resp.body(method) else {
        let r = http::plain_response(
            502,
            "bad gateway: the app's response framing is invalid",
            method,
            &[],
        );
        let _ = write_flush(client, &r).await;
        let _ = client.shutdown().await;
        return;
    };
    responded.store(true, Ordering::SeqCst);
    let (head, chunked_out) = http::client_response_head(&resp, framing, client_version);
    if write_flush(client, &head).await.is_err() {
        return;
    }
    let mut buf = vec![0u8; BUF];
    let out = |d: &[u8]| -> Vec<u8> {
        if chunked_out {
            http::encode_chunk(d)
        } else {
            d.to_vec()
        }
    };
    match framing {
        ResponseBody::None => {}
        ResponseBody::Length(total) => {
            let mut left = total;
            let take = usize::try_from(left).map_or(rest.len(), |l| l.min(rest.len()));
            if take > 0 {
                if write_flush(client, &out(rest.get(..take).unwrap_or(&[])))
                    .await
                    .is_err()
                {
                    return;
                }
                left = left.saturating_sub(take as u64);
            }
            while left > 0 {
                let want = usize::try_from(left).map_or(BUF, |l| l.min(BUF));
                match up.read(buf.get_mut(..want).unwrap_or(&mut [])).await {
                    // The app ended early: the client sees a cut body, never a complete one.
                    Ok(0) | Err(_) => return,
                    Ok(n) => {
                        if write_flush(client, &out(buf.get(..n).unwrap_or(&[])))
                            .await
                            .is_err()
                        {
                            return;
                        }
                        left = left.saturating_sub(n as u64);
                    }
                }
            }
        }
        ResponseBody::Chunked => {
            let mut dec = ChunkedDecoder::new();
            loop {
                let mut pending = Vec::new();
                if dec
                    .push(&rest, &mut |d: &[u8]| pending.extend_from_slice(d))
                    .is_err()
                {
                    return;
                }
                if !pending.is_empty() && write_flush(client, &out(&pending)).await.is_err() {
                    return;
                }
                if dec.done() {
                    break;
                }
                match up.read(&mut buf).await {
                    Ok(0) | Err(_) => return,
                    Ok(n) => rest = buf.get(..n).unwrap_or(&[]).to_vec(),
                }
            }
        }
        ResponseBody::UntilClose => {
            if !rest.is_empty() && write_flush(client, &out(&rest)).await.is_err() {
                return;
            }
            loop {
                match up.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if write_flush(client, &out(buf.get(..n).unwrap_or(&[])))
                            .await
                            .is_err()
                        {
                            return;
                        }
                    }
                }
            }
        }
    }
    if chunked_out {
        let _ = write_flush(client, http::LAST_CHUNK).await;
    }
    let _ = client.shutdown().await;
}

/// A WebSocket: the app's 101 goes to the client with every header it sent, then bytes flow both
/// ways until either side closes. Any other answer is relayed like a normal response.
async fn upgrade_exchange<C, U>(
    mut client: C,
    mut up: U,
    method: &str,
    early: Vec<u8>,
    version: Version,
    max_head: usize,
) where
    C: AsyncRead + AsyncWrite + Unpin + Send,
    U: AsyncRead + AsyncWrite + Unpin + Send,
{
    let Some((resp, after)) = read_final_head(&mut up, max_head, true).await else {
        let _ = write_flush(
            &mut client,
            &http::plain_response(502, BAD_RESPONSE, method, &[]),
        )
        .await;
        return;
    };
    if resp.status != 101 {
        let responded = AtomicBool::new(false);
        relay_response(
            &mut up,
            &mut client,
            method,
            version,
            resp,
            after,
            &responded,
        )
        .await;
        return;
    }
    if write_flush(&mut client, &http::upgrade_response_head(&resp))
        .await
        .is_err()
    {
        return;
    }
    if !after.is_empty() && write_flush(&mut client, &after).await.is_err() {
        return;
    }
    if !early.is_empty() && write_flush(&mut up, &early).await.is_err() {
        return;
    }
    let _ = tokio::io::copy_bidirectional_with_sizes(&mut client, &mut up, BUF, BUF).await;
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
mod tests {
    use super::*;

    #[test]
    fn cidrs() {
        let c = Cidr::parse("10.89.0.0/24").unwrap();
        assert!(c.contains("10.89.0.7".parse().unwrap()));
        assert!(!c.contains("10.89.1.7".parse().unwrap()));
        assert!(c.is_app_network());
        assert!(!Cidr::parse("127.0.0.0/8").unwrap().is_app_network());
        assert!(!Cidr::parse("0.0.0.0/0").unwrap().is_app_network());
        assert!(!Cidr::parse("8.8.8.0/24").unwrap().is_app_network());
        assert!(Cidr::parse("100.64.0.0/16").unwrap().is_app_network());
        assert!(Cidr::parse("10.0.0.0/33").is_none());
        assert!(Cidr::parse("10.0.0.0").is_none());
    }

    #[test]
    fn decisions_are_checked() {
        let allow = [Cidr::parse("10.89.0.0/24").unwrap()];
        let ok = json!({"action":"proxy","host":"10.89.0.5","port":8080,"set":[["x-flagship-visitor","anonymous"]],"remove":["authorization"]});
        let (t, inj) = parse_decision(&ok, &allow).unwrap();
        assert_eq!(t.to_string(), "10.89.0.5:8080");
        assert_eq!(inj.remove, vec!["authorization".to_owned()]);
        for bad in [
            json!({"action":"daemon"}),
            json!({"action":"proxy","host":"127.0.0.1","port":8080}),
            json!({"action":"proxy","host":"10.89.0.5","port":0}),
            json!({"action":"proxy","host":"10.89.0.5","port":70000}),
            json!({"action":"proxy","host":"10.89.0.5","port":1,"set":[["host","evil"]]}),
            json!({"action":"proxy","host":"10.89.0.5","port":1,"set":[["x-flagship-user","a\nb"]]}),
            json!({"action":"proxy","host":"10.89.0.5","port":1,"set":"x"}),
            json!({"action":"proxy","host":"evil.example","port":1}),
        ] {
            assert!(parse_decision(&bad, &allow).is_none(), "{bad}");
        }
    }
}

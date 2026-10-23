//! Accept, handshake, bound, hand over: the same job as flagship-tlsd's `serve`/`handle`.

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use rustls::crypto::{CryptoProvider, SupportedKxGroup, aws_lc_rs};
use rustls::server::{Acceptor, NoServerSessionStorage, ServerConfig};
use rustls::{ProtocolVersion, version};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::{TcpListener, TcpStream, UnixStream};
use tokio::sync::Semaphore;
use tokio_rustls::LazyConfigAcceptor;

use crate::guard;
use crate::source::{CertSource, Resolver};

/// The only application protocol offered. The daemon's upstream socket feeds a Node HTTP/1.1
/// server, so `h2` is not offered (README, "HTTP/2").
pub const ALPN_HTTP11: &[u8] = b"http/1.1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KxPolicy {
    /// `X25519MLKEM768` whenever the client offers it; classical groups otherwise.
    PreferHybrid,
    /// `X25519MLKEM768` only; a client without it is refused.
    RequireHybrid,
}

#[derive(Debug, Clone)]
pub struct Limits {
    pub max_conns: usize,
    pub handshake_timeout: Duration,
    /// Time from the end of the handshake to the end of the first request head; zero disables
    /// the head guard (flagship-tlsd's plain pipe).
    pub head_timeout: Duration,
    pub max_header_line: usize,
    pub max_header_bytes: usize,
    /// No byte in either direction for this long closes the connection; zero disables.
    pub idle_timeout: Duration,
    pub upstream_connect_timeout: Duration,
    pub drain_timeout: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_conns: 4096,
            handshake_timeout: Duration::from_secs(10),
            head_timeout: Duration::from_secs(20),
            max_header_line: 16 * 1024,
            max_header_bytes: 32 * 1024,
            idle_timeout: Duration::from_secs(15 * 60),
            upstream_connect_timeout: Duration::from_secs(3),
            drain_timeout: Duration::from_secs(10),
        }
    }
}

#[derive(Debug, Clone)]
pub struct IngressConfig {
    pub upstream: PathBuf,
    pub limits: Limits,
    pub kx: KxPolicy,
}

/// One TLS configuration for clients that offer the hybrid group (hybrid only, so the server
/// choice is the hybrid even when the client lists a classical group first) and one for the rest.
#[derive(Debug, Clone)]
pub struct TlsConfigs {
    pub hybrid: Arc<ServerConfig>,
    pub classical: Option<Arc<ServerConfig>>,
}

pub fn hybrid_group() -> &'static dyn SupportedKxGroup {
    aws_lc_rs::kx_group::X25519MLKEM768
}

fn server_config(
    source: &Arc<CertSource>,
    groups: Vec<&'static dyn SupportedKxGroup>,
) -> Result<ServerConfig, rustls::Error> {
    let provider = CryptoProvider {
        kx_groups: groups,
        ..aws_lc_rs::default_provider()
    };
    let mut cfg = ServerConfig::builder_with_provider(Arc::new(provider))
        .with_protocol_versions(&[&version::TLS13, &version::TLS12])?
        .with_no_client_auth()
        .with_cert_resolver(Arc::new(Resolver(Arc::clone(source))));
    cfg.alpn_protocols = vec![ALPN_HTTP11.to_vec()];
    // Every connection is a fresh keyd-signed handshake: no resumption state outlives a key.
    cfg.session_storage = Arc::new(NoServerSessionStorage {});
    cfg.send_tls13_tickets = 0;
    cfg.max_early_data_size = 0;
    Ok(cfg)
}

pub fn tls_configs(source: &Arc<CertSource>, kx: KxPolicy) -> Result<TlsConfigs, rustls::Error> {
    let hybrid = Arc::new(server_config(source, vec![hybrid_group()])?);
    let classical = match kx {
        KxPolicy::RequireHybrid => None,
        KxPolicy::PreferHybrid => Some(Arc::new(server_config(
            source,
            vec![
                aws_lc_rs::kx_group::X25519,
                aws_lc_rs::kx_group::SECP256R1,
                aws_lc_rs::kx_group::SECP384R1,
            ],
        )?)),
    };
    Ok(TlsConfigs { hybrid, classical })
}

/// The line the daemon reads first (`parseFrontendHeader` in tlsUpstream.ts): the same three
/// fields, in flagship-tlsd's order. It comes from the ingress, never from the client.
pub fn header_line(sni: &str, alpn: &str, tls: &str) -> Vec<u8> {
    let q = |s: &str| serde_json::Value::String(s.to_owned()).to_string();
    format!(
        "{{\"sni\":{},\"alpn\":{},\"tls\":{}}}\n",
        q(sni),
        q(alpn),
        q(tls)
    )
    .into_bytes()
}

pub fn tls_version_label(v: Option<ProtocolVersion>) -> &'static str {
    match v {
        Some(ProtocolVersion::TLSv1_3) => "1.3",
        Some(ProtocolVersion::TLSv1_2) => "1.2",
        _ => "?",
    }
}

/// Serve until `shutdown` resolves, then wait up to the drain timeout for open connections.
pub async fn serve(
    listener: TcpListener,
    cfg: Arc<IngressConfig>,
    tls: TlsConfigs,
    shutdown: impl Future<Output = ()>,
) {
    let max = cfg.limits.max_conns.max(1);
    let slots = Arc::new(Semaphore::new(max));
    tokio::pin!(shutdown);
    loop {
        let accepted = tokio::select! {
            () = &mut shutdown => break,
            a = listener.accept() => a,
        };
        let Ok((stream, _)) = accepted else { continue };
        let Ok(permit) = Arc::clone(&slots).try_acquire_owned() else {
            // Over the cap: closed at once, as flagship-tlsd does.
            drop(stream);
            continue;
        };
        let cfg = Arc::clone(&cfg);
        let tls = tls.clone();
        tokio::spawn(async move {
            handle(stream, &cfg, &tls).await;
            drop(permit);
        });
    }
    drop(listener);
    let all = u32::try_from(max).unwrap_or(u32::MAX);
    let _ = tokio::time::timeout(cfg.limits.drain_timeout, slots.acquire_many(all)).await;
}

async fn handle(stream: TcpStream, cfg: &IngressConfig, tls: &TlsConfigs) {
    let _ = stream.set_nodelay(true);
    let lim = &cfg.limits;
    let handshake = async {
        let start = LazyConfigAcceptor::new(Acceptor::default(), stream)
            .await
            .ok()?;
        let hello = start.client_hello();
        hello.server_name()?;
        let offers_hybrid = hello
            .named_groups()
            .is_some_and(|g| g.contains(&hybrid_group().name()));
        let config = if offers_hybrid {
            Arc::clone(&tls.hybrid)
        } else {
            Arc::clone(tls.classical.as_ref()?)
        };
        start.into_stream(config).await.ok()
    };
    let Ok(Some(mut tls_stream)) = tokio::time::timeout(lim.handshake_timeout, handshake).await
    else {
        return;
    };

    let (sni, alpn, version) = {
        let (_, conn) = tls_stream.get_ref();
        let sni = conn.server_name().unwrap_or("").to_ascii_lowercase();
        let alpn = conn
            .alpn_protocol()
            .and_then(|p| std::str::from_utf8(p).ok())
            .unwrap_or("")
            .to_owned();
        (sni, alpn, tls_version_label(conn.protocol_version()))
    };

    let mut first = Vec::new();
    if !lim.head_timeout.is_zero() {
        match tokio::time::timeout(
            lim.head_timeout,
            guard::read_first_head(&mut tls_stream, lim.max_header_line, lim.max_header_bytes),
        )
        .await
        {
            Ok(Ok(bytes)) => first = bytes,
            Ok(Err(e)) => {
                refuse(&mut tls_stream, e.response()).await;
                return;
            }
            Err(_) => {
                refuse(&mut tls_stream, Some(guard::TIMEOUT_RESPONSE)).await;
                return;
            }
        }
    }

    let Ok(Ok(mut up)) = tokio::time::timeout(
        lim.upstream_connect_timeout,
        UnixStream::connect(&cfg.upstream),
    )
    .await
    else {
        return;
    };
    let mut preface = header_line(&sni, &alpn, version);
    preface.extend_from_slice(&first);
    if up.write_all(&preface).await.is_err() {
        return;
    }
    pump(tls_stream, up, lim.idle_timeout).await;
}

async fn refuse<S: AsyncWrite + Unpin>(s: &mut S, response: Option<&[u8]>) {
    if let Some(r) = response {
        let _ = tokio::time::timeout(Duration::from_secs(2), s.write_all(r)).await;
    }
    let _ = tokio::time::timeout(Duration::from_secs(2), s.shutdown()).await;
}

/// Copy both ways, half-closing each side when the other ends (flagship-tlsd's two
/// `io.Copy`s), and close both when nothing moved for `idle`.
async fn pump<A, B>(a: A, b: B, idle: Duration)
where
    A: AsyncRead + AsyncWrite + Unpin,
    B: AsyncRead + AsyncWrite + Unpin,
{
    let epoch = Instant::now();
    let last = Arc::new(AtomicU64::new(0));
    let mut a = Tracked {
        inner: a,
        last: Arc::clone(&last),
        epoch,
    };
    let mut b = Tracked {
        inner: b,
        last: Arc::clone(&last),
        epoch,
    };
    let copy = tokio::io::copy_bidirectional(&mut a, &mut b);
    if idle.is_zero() {
        let _ = copy.await;
        return;
    }
    let watch = async {
        loop {
            let since = Duration::from_millis(last.load(Ordering::Relaxed));
            let quiet = epoch.elapsed().saturating_sub(since);
            if quiet >= idle {
                return;
            }
            tokio::time::sleep(idle.saturating_sub(quiet)).await;
        }
    };
    tokio::select! {
        _ = copy => {}
        () = watch => {}
    }
}

struct Tracked<S> {
    inner: S,
    last: Arc<AtomicU64>,
    epoch: Instant,
}

impl<S> Tracked<S> {
    fn touch(&self) {
        let ms = u64::try_from(self.epoch.elapsed().as_millis()).unwrap_or(u64::MAX);
        self.last.store(ms, Ordering::Relaxed);
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Tracked<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let r = Pin::new(&mut self.inner).poll_read(cx, buf);
        if matches!(r, Poll::Ready(Ok(()))) && buf.filled().len() > before {
            self.touch();
        }
        r
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Tracked<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        data: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let r = Pin::new(&mut self.inner).poll_write(cx, data);
        if matches!(r, Poll::Ready(Ok(n)) if n > 0) {
            self.touch();
        }
        r
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
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
    fn header_line_matches_flagship_tlsd() {
        assert_eq!(
            header_line("chess.home.alice.flagship.services", "http/1.1", "1.3"),
            b"{\"sni\":\"chess.home.alice.flagship.services\",\"alpn\":\"http/1.1\",\"tls\":\"1.3\"}\n".to_vec()
        );
        assert_eq!(
            header_line("a", "", "1.2"),
            b"{\"sni\":\"a\",\"alpn\":\"\",\"tls\":\"1.2\"}\n".to_vec()
        );
        // The longest SNI fits well under the daemon's 2048-byte header cap.
        assert!(header_line(&"a".repeat(253), "http/1.1", "1.3").len() < 2048);
    }
}

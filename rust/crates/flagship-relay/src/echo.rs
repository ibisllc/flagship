//! The relay-address echo (`apps/web/src/lib/addressEcho.ts`): Fly ends TLS on :8444 and puts
//! a PROXY header in front; the answer names the address the connection really arrived at.

use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Semaphore, watch};

const V2_SIGNATURE: [u8; 12] = [
    0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
];
const MAX_HEADER: usize = 536;
pub const HEADER_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_BUFFER: usize = MAX_HEADER + 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxyHeader {
    pub src: String,
    pub dst: String,
    pub src_port: u16,
    pub dst_port: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProxyParse {
    NeedMore,
    /// `header` is `None` for LOCAL / UNKNOWN / unsupported families.
    Done {
        header: Option<ProxyHeader>,
        length: usize,
    },
    Invalid(&'static str),
}

fn be16(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes([
        *b.get(at)?,
        *b.get(at.checked_add(1)?)?,
    ]))
}

/// JS `readUInt16BE(i).toString(16)` joined with `:` (no zero compression), as the TS echo
/// prints IPv6.
fn ipv6_ts(b: &[u8]) -> Option<String> {
    let a: [u8; 16] = b.try_into().ok()?;
    let ip = Ipv6Addr::from(a);
    Some(
        ip.segments()
            .iter()
            .map(|s| format!("{s:x}"))
            .collect::<Vec<_>>()
            .join(":"),
    )
}

pub fn parse_proxy_header(buf: &[u8]) -> ProxyParse {
    if buf.get(..12) == Some(&V2_SIGNATURE[..]) {
        return parse_v2(buf);
    }
    if buf.get(..5) == Some(b"PROXY") {
        return parse_v1(buf);
    }
    if buf.len() < 12 {
        return ProxyParse::NeedMore;
    }
    ProxyParse::Invalid("not a PROXY header")
}

fn parse_v1(buf: &[u8]) -> ProxyParse {
    let Some(end) = buf.windows(2).position(|w| w == b"\r\n") else {
        return if buf.len() > 107 {
            ProxyParse::Invalid("PROXY v1 header too long")
        } else {
            ProxyParse::NeedMore
        };
    };
    let line: String = buf
        .get(..end)
        .unwrap_or_default()
        .iter()
        .map(|&c| char::from(c))
        .collect();
    let parts: Vec<&str> = line.split(' ').collect();
    let length = end.saturating_add(2);
    if parts.get(1) == Some(&"UNKNOWN") {
        return ProxyParse::Done {
            header: None,
            length,
        };
    }
    let fam = parts.get(1).copied();
    if parts.len() != 6 || !(fam == Some("TCP4") || fam == Some("TCP6")) {
        return ProxyParse::Invalid("bad PROXY v1 header");
    }
    // `Number("x")` is NaN in TS and would serialize as null; refuse instead.
    let port = |i: usize| parts.get(i).and_then(|p| p.parse::<u16>().ok());
    let (Some(sp), Some(dp)) = (port(4), port(5)) else {
        return ProxyParse::Invalid("bad PROXY v1 header");
    };
    ProxyParse::Done {
        header: Some(ProxyHeader {
            src: parts.get(2).copied().unwrap_or_default().to_owned(),
            dst: parts.get(3).copied().unwrap_or_default().to_owned(),
            src_port: sp,
            dst_port: dp,
        }),
        length,
    }
}

fn parse_v2(buf: &[u8]) -> ProxyParse {
    let Some(len) = be16(buf, 14) else {
        return ProxyParse::NeedMore;
    };
    let total = 16usize.saturating_add(usize::from(len));
    if total > MAX_HEADER {
        return ProxyParse::Invalid("PROXY v2 header too long");
    }
    let (Some(body), Some(&vc), Some(&fam)) = (buf.get(16..total), buf.get(12), buf.get(13)) else {
        return ProxyParse::NeedMore;
    };
    if vc >> 4 != 2 {
        return ProxyParse::Invalid("bad PROXY v2 version");
    }
    let command = vc & 0x0f;
    let family = fam >> 4;
    if command == 0 {
        return ProxyParse::Done {
            header: None,
            length: total,
        };
    }
    let header = match family {
        1 if body.len() >= 12 => (|| {
            Some(ProxyHeader {
                src: Ipv4Addr::from(<[u8; 4]>::try_from(body.get(0..4)?).ok()?).to_string(),
                dst: Ipv4Addr::from(<[u8; 4]>::try_from(body.get(4..8)?).ok()?).to_string(),
                src_port: be16(body, 8)?,
                dst_port: be16(body, 10)?,
            })
        })(),
        2 if body.len() >= 36 => (|| {
            Some(ProxyHeader {
                src: ipv6_ts(body.get(0..16)?)?,
                dst: ipv6_ts(body.get(16..32)?)?,
                src_port: be16(body, 32)?,
                dst_port: be16(body, 34)?,
            })
        })(),
        _ => None,
    };
    ProxyParse::Done {
        header,
        length: total,
    }
}

pub fn echo_body(h: Option<&ProxyHeader>) -> String {
    let reached = h.map_or("null".to_owned(), |h| crate::json::str_lit(&h.dst));
    let port = h.map_or("null".to_owned(), |h| h.dst_port.to_string());
    format!("{{\"relay\":\"flagship.services\",\"reachedAt\":{reached},\"reachedPort\":{port}}}")
}

pub fn echo_response(h: Option<&ProxyHeader>) -> String {
    let body = echo_body(h);
    format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncache-control: no-store\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn request_complete(b: &[u8]) -> bool {
    b.windows(4).any(|w| w == b"\r\n\r\n") || b.windows(2).any(|w| w == b"\n\n")
}

/// Serve one echo connection; every exit path closes the socket.
pub async fn serve_echo(mut sock: TcpStream) {
    let _ = tokio::time::timeout(HEADER_TIMEOUT, async {
        let mut buf: Vec<u8> = Vec::new();
        let mut header: Option<Option<ProxyHeader>> = None;
        let mut chunk = [0u8; 2048];
        loop {
            let n = match sock.read(&mut chunk).await {
                Ok(0) | Err(_) => return,
                Ok(n) => n,
            };
            buf.extend_from_slice(chunk.get(..n).unwrap_or_default());
            if buf.len() > MAX_BUFFER {
                return;
            }
            if header.is_none() {
                match parse_proxy_header(&buf) {
                    ProxyParse::NeedMore => continue,
                    ProxyParse::Invalid(_) => return,
                    ProxyParse::Done { header: h, length } => {
                        header = Some(h);
                        buf.drain(..length.min(buf.len()));
                    }
                }
            }
            if !request_complete(&buf) {
                continue;
            }
            let resp = echo_response(header.as_ref().and_then(Option::as_ref));
            let _ = sock.write_all(resp.as_bytes()).await;
            let _ = sock.shutdown().await;
            return;
        }
    })
    .await;
}

/// Accept loop; stops when `stop` flips to true. `max_conns` bounds concurrent sockets.
pub async fn run_echo(listener: TcpListener, max_conns: usize, mut stop: watch::Receiver<bool>) {
    let permits = Arc::new(Semaphore::new(max_conns.max(1)));
    loop {
        tokio::select! {
            _ = stop.changed() => return,
            r = listener.accept() => {
                let Ok((sock, _)) = r else { continue };
                let Ok(permit) = permits.clone().try_acquire_owned() else {
                    drop(sock);
                    continue;
                };
                tokio::spawn(async move {
                    serve_echo(sock).await;
                    drop(permit);
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v1_and_v2() {
        let v1 = b"PROXY TCP4 1.2.3.4 149.248.216.86 5555 8444\r\nGET / HTTP/1.1\r\n\r\n";
        let ProxyParse::Done {
            header: Some(h),
            length,
        } = parse_proxy_header(v1)
        else {
            unreachable!()
        };
        assert_eq!(
            (h.dst.as_str(), h.dst_port, length),
            ("149.248.216.86", 8444, 45)
        );
        let mut v2 = V2_SIGNATURE.to_vec();
        v2.extend_from_slice(&[0x21, 0x21, 0, 36]);
        v2.extend_from_slice(&[0; 16]);
        let mut dst = [0u8; 16];
        dst[0] = 0x2a;
        dst[1] = 0x09;
        dst[15] = 1;
        v2.extend_from_slice(&dst);
        v2.extend_from_slice(&[0x15, 0xb3, 0x20, 0xfc]);
        let ProxyParse::Done {
            header: Some(h), ..
        } = parse_proxy_header(&v2)
        else {
            unreachable!()
        };
        assert_eq!(h.dst, "2a09:0:0:0:0:0:0:1");
        assert_eq!(
            parse_proxy_header(b"GET / HTTP/1.1\r\n"),
            ProxyParse::Invalid("not a PROXY header")
        );
        assert_eq!(parse_proxy_header(b"PRO"), ProxyParse::NeedMore);
        assert!(echo_body(None).contains("\"reachedAt\":null"));
    }
}

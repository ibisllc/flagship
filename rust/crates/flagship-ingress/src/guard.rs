//! Bounds on the first request head, checked without interpreting it.
//!
//! The ingress is still a byte pipe: the daemon parses HTTP, and the bytes it receives are
//! exactly the bytes the client sent. This only measures the first head (line lengths, total
//! size, time to the empty line) so a slow or oversize client is dropped before it holds a
//! daemon socket. It decides nothing about routing or identity, so it cannot become a second
//! HTTP interpretation that alters authorization.

use std::fmt;

use tokio::io::{AsyncRead, AsyncReadExt};

#[derive(Debug, PartialEq, Eq)]
pub enum HeadError {
    /// The client closed before sending anything.
    Closed,
    /// The client closed in the middle of the head.
    Truncated,
    LineTooLong,
    HeadTooLarge,
    Io,
}

impl fmt::Display for HeadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Closed => "closed before a request",
            Self::Truncated => "closed inside the request head",
            Self::LineTooLong => "a request head line is too long",
            Self::HeadTooLarge => "the request head is too large",
            Self::Io => "read failed",
        })
    }
}

impl std::error::Error for HeadError {}

impl HeadError {
    /// The response a refused client gets, if any.
    pub fn response(&self) -> Option<&'static [u8]> {
        match self {
            Self::LineTooLong | Self::HeadTooLarge => {
                Some(b"HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
            }
            _ => None,
        }
    }
}

pub const TIMEOUT_RESPONSE: &[u8] =
    b"HTTP/1.1 408 Request Timeout\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

/// Read until the first head ends (an empty line after at least one non-empty one). Returns
/// every byte read, including any that followed the head in the same read.
pub async fn read_first_head<R: AsyncRead + Unpin>(
    r: &mut R,
    max_line: usize,
    max_head: usize,
) -> Result<Vec<u8>, HeadError> {
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    let mut chunk = vec![0u8; 4096];
    let mut line_len: usize = 0;
    let mut head_len: usize = 0;
    let mut seen_line = false;
    loop {
        let n = r.read(&mut chunk).await.map_err(|_| HeadError::Io)?;
        if n == 0 {
            return Err(if buf.is_empty() {
                HeadError::Closed
            } else {
                HeadError::Truncated
            });
        }
        let got = chunk.get(..n).ok_or(HeadError::Io)?;
        buf.extend_from_slice(got);
        for &b in got {
            head_len = head_len.saturating_add(1);
            if head_len > max_head {
                return Err(HeadError::HeadTooLarge);
            }
            match b {
                b'\n' => {
                    if line_len == 0 && seen_line {
                        return Ok(buf);
                    }
                    seen_line |= line_len > 0;
                    line_len = 0;
                }
                b'\r' => {}
                _ => {
                    line_len = line_len.saturating_add(1);
                    if line_len > max_line {
                        return Err(HeadError::LineTooLong);
                    }
                }
            }
        }
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

    async fn run(input: &[u8], line: usize, head: usize) -> Result<Vec<u8>, HeadError> {
        let mut r = input;
        read_first_head(&mut r, line, head).await
    }

    #[tokio::test]
    async fn returns_the_head_and_what_followed_it_verbatim() {
        let req = b"GET / HTTP/1.1\r\nHost: a\r\nX-Flagship-User: forged\r\n\r\nbody";
        assert_eq!(run(req, 100, 1000).await.unwrap(), req.to_vec());
        let lf = b"\r\nGET / HTTP/1.1\nHost: a\n\n";
        assert_eq!(run(lf, 100, 1000).await.unwrap(), lf.to_vec());
    }

    #[tokio::test]
    async fn refuses_long_lines_large_heads_and_truncation() {
        let mut long = b"GET /".to_vec();
        long.extend(std::iter::repeat_n(b'a', 200));
        long.extend_from_slice(b" HTTP/1.1\r\n\r\n");
        assert_eq!(run(&long, 100, 10_000).await, Err(HeadError::LineTooLong));
        let mut many = b"GET / HTTP/1.1\r\n".to_vec();
        for _ in 0..100 {
            many.extend_from_slice(b"X-A: b\r\n");
        }
        many.extend_from_slice(b"\r\n");
        assert_eq!(run(&many, 100, 300).await, Err(HeadError::HeadTooLarge));
        assert_eq!(
            run(b"GET / HTTP/1.1\r\nHost:", 100, 300).await,
            Err(HeadError::Truncated)
        );
        assert_eq!(run(b"", 100, 300).await, Err(HeadError::Closed));
    }
}

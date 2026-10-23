//! HTTP to the boot worker. The trait lets tests drive the flow against an
//! in-process worker; [`UreqTransport`] is the real client (rustls, Mozilla
//! roots baked in or a PEM bundle, no OpenSSL).

use std::time::Duration;

/// The two verbs the box uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    /// `GET` (lease fetch, response poll).
    Get,
    /// `POST` (announce the request).
    Post,
}

impl Method {
    /// The upper-case token signed into the box-auth envelope.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
        }
    }
}

/// A response: status and a bounded body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    /// HTTP status (3xx are returned as-is: redirects are never followed).
    pub status: u16,
    /// Body, at most [`MAX_BODY`] bytes.
    pub body: Vec<u8>,
}

/// Largest body the box reads (a sealed lease or reply is a few hundred bytes).
pub const MAX_BODY: u64 = 64 * 1024;

/// One HTTP exchange. `Err` is a transport failure (curl's `000`).
pub trait Transport {
    /// Send one request with the `Authorization` header and optional JSON body.
    fn send(
        &self,
        method: Method,
        url: &str,
        authorization: &str,
        json_body: Option<&str>,
    ) -> Result<HttpResponse, String>;
}

/// The production client.
#[derive(Debug)]
pub struct UreqTransport {
    agent: ureq::Agent,
}

impl UreqTransport {
    /// `timeout` bounds each whole exchange (curl `--max-time`). `ca_bundle`
    /// replaces the built-in Mozilla roots with a PEM file's certificates.
    pub fn new(
        timeout: Duration,
        ca_bundle: Option<&[u8]>,
        allow_http: bool,
    ) -> Result<Self, String> {
        let mut tls = ureq::tls::TlsConfig::builder();
        if let Some(pem) = ca_bundle {
            let mut certs = Vec::new();
            for item in ureq::tls::parse_pem(pem) {
                if let Ok(ureq::tls::PemItem::Certificate(c)) = item {
                    certs.push(c);
                }
            }
            if certs.is_empty() {
                return Err("the CA bundle holds no certificates".into());
            }
            tls = tls.root_certs(ureq::tls::RootCerts::new_with_certs(&certs));
        }
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            .max_redirects(0)
            .max_redirects_will_error(false)
            .proxy(None)
            .https_only(!allow_http)
            .http_status_as_error(false)
            .user_agent(concat!("flagship-boot/", env!("CARGO_PKG_VERSION")))
            .tls_config(tls.build())
            .build();
        Ok(Self {
            agent: ureq::Agent::new_with_config(config),
        })
    }
}

impl Transport for UreqTransport {
    fn send(
        &self,
        method: Method,
        url: &str,
        authorization: &str,
        json_body: Option<&str>,
    ) -> Result<HttpResponse, String> {
        let result = match (method, json_body) {
            (Method::Get, _) => self
                .agent
                .get(url)
                .header("Authorization", authorization)
                .call(),
            (Method::Post, body) => self
                .agent
                .post(url)
                .header("Authorization", authorization)
                .header("content-type", "application/json")
                .send(body.unwrap_or_default().as_bytes()),
        };
        let mut resp = result.map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        let body = resp
            .body_mut()
            .with_config()
            .limit(MAX_BODY)
            .read_to_vec()
            .map_err(|e| e.to_string())?;
        Ok(HttpResponse { status, body })
    }
}

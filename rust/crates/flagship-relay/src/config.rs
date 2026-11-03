//! The relay process's settings, read from the environment the TypeScript hub reads (`apps/web/src/server.ts`), so a
//! Fly app can switch images without changing its secrets or `fly.toml`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

pub const DEFAULT_COM_BASE_URL: &str = "https://flagshipserver.com";
pub const DEFAULT_APEX: &str = "flagship.services";
pub const DEFAULT_DRAIN_GRACE: Duration = Duration::from_millis(20_000);

#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    /// `HOST`, the address every listener binds.
    pub host: String,
    /// `PORT`: the hub (tunnel WebSocket, health, stats, mailbox route).
    pub hub_port: u16,
    /// `TUNNEL_TCP_PORT`: the SNI passthrough router.
    pub sni_port: u16,
    /// `RELAY_ECHO_PORT`: the PROXY-protocol address echo; off when unset.
    pub echo_port: Option<u16>,
    pub apex: String,
    pub com_base_url: String,
    /// `SERVICES_CONTROL_SECRET`: `.com` blesses only a caller holding it.
    pub control_secret: Option<String>,
    /// `FLAGSHIP_HUB_HOST`: the host the blessing names (default: the apex).
    pub hub_host: String,
    pub hub_key_path: Option<PathBuf>,
    /// `USAGE_REPORT_SECRET`: turns metering, the outbound host list and `/api/stats` on.
    pub usage_secret: Option<String>,
    pub usage_flush: Duration,
    pub over_quota_kbps: Option<String>,
    pub pb_mail: bool,
    pub outbound: bool,
    pub drain_grace: Duration,
    /// `FLAGSHIP_SERVING_REVOCATION_PUB`: `.com`'s revocation key (64 lowercase hex). Set: the serving authority is on
    /// and fails closed (needs `SERVICES_CONTROL_SECRET`).
    pub serving_revocation_pub: Option<String>,
    /// `FLAGSHIP_RELAY_ID`, else `FLY_MACHINE_ID`, else the host name: names this relay on the serving feed.
    pub relay_id: String,
    /// `FLAGSHIP_SERVING_REFUSE_NEW_MS` / `FLAGSHIP_SERVING_CLOSE_ALL_MS` / `FLAGSHIP_SERVING_CHECK_MS`: the lost-contact
    /// thresholds (60 s / 10 min / 5 s). Tests shorten them; production leaves them unset.
    pub serving_refuse_new: Duration,
    pub serving_close_all: Duration,
    pub serving_check: Duration,
    /// `FLAGSHIP_PHONE_ROUTE=off` leaves the bare name closed even with the serving authority on.
    pub phone_route: bool,
    /// `FLAGSHIP_MESH=on` (relay-mesh.md §15.7): the relay mesh. Off (the default) is exactly today's relay.
    pub mesh: Option<MeshSettings>,
    /// `Fly-Client-IP` is the client address only on Fly (relay-mesh.md §6.1): `FLAGSHIP_TRUST_FLY_CLIENT_IP` `1`/`0`
    /// when set, else whether `FLY_APP_NAME` or `FLY_ALLOC_ID` is set.
    pub trust_fly_client_ip: bool,
}

/// The mesh's environment (relay-mesh.md §15.7). `Debug` leaves the key seed out.
#[derive(Clone, PartialEq)]
pub struct MeshSettings {
    /// `FLAGSHIP_RELAY_ID`: required, `^[a-z][a-z0-9-]{1,30}$`.
    pub relay_id: String,
    /// `FLAGSHIP_RELAY_KEY_SEED`: 64 hex, the relay key (it also signs HELLO_ACK `hubSig`).
    pub key_seed: [u8; 32],
    /// `FLAGSHIP_RELAY_KIND`: `full` (default) or `entry`.
    pub kind: flagship_crypto::relay_mesh::RelayKind,
    /// `FLAGSHIP_RELAY_FEED_URL`, default `https://feed.<controlApex>/v1`.
    pub feed_url: String,
    /// `FLAGSHIP_RELAY_LOG_PUB` (the old `FLAGSHIP_SERVING_REVOCATION_PUB` is still read).
    pub log_pub: String,
    /// `FLAGSHIP_RELAY_MAINTAINERS_DIR` (default `.maintainers`): the ca-track mandates and CaEndorsements.
    pub maintainers_dir: PathBuf,
    /// `FLAGSHIP_RELAY_MAINTAINER_PIN`: the pinned ca-track origin mandate hash (default: the baked pin).
    pub maintainer_pin: String,
    /// `FLAGSHIP_MESH_PEER_URLS`: `relayId=url,…`, dial a peer there instead of its direct name.
    pub peer_urls: HashMap<String, String>,
    /// `FLAGSHIP_MESH_PEER_ADDRS`: comma-separated peer addresses always admitted to the reserved handshake pool.
    pub peer_addrs: Vec<String>,
    /// Test-only shortenings: `FLAGSHIP_MESH_FEED_POLL_MS`, `_REBALANCE_MS`, `_MIN_MOVE_MS`, `_ATTACH_TTL_MS`.
    pub feed_poll: Option<Duration>,
    /// `FLAGSHIP_MESH_CAPACITY`: this relay's `load.capacity` (default 10,000).
    pub capacity: Option<u64>,
    pub rebalance: Option<Duration>,
    pub min_move: Option<Duration>,
    pub attach_ttl: Option<Duration>,
    /// `FLAGSHIP_MESH_CLIENT_KEY_BY_PORT=1` (test-only, conformance on loopback): key a visitor by `ip:port`, not ip.
    pub client_key_by_port: bool,
}

impl std::fmt::Debug for MeshSettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MeshSettings")
            .field("relay_id", &self.relay_id)
            .field("kind", &self.kind)
            .field("feed_url", &self.feed_url)
            .finish_non_exhaustive()
    }
}

fn hex32(name: &str, s: &str) -> Result<[u8; 32], String> {
    let s = s.trim().to_ascii_lowercase();
    if s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!("{name} must be 64 hex"));
    }
    let mut out = [0u8; 32];
    for (i, o) in out.iter_mut().enumerate() {
        let at = i.saturating_mul(2);
        *o = u8::from_str_radix(s.get(at..at.saturating_add(2)).unwrap_or("zz"), 16)
            .map_err(|_| format!("{name} must be 64 hex"))?;
    }
    Ok(out)
}

/// `https://feed.<host of .com's base URL>/v1`.
fn default_feed_url(com_base_url: &str) -> String {
    let host = com_base_url
        .split("://")
        .nth(1)
        .unwrap_or(com_base_url)
        .split(['/', ':'])
        .next()
        .unwrap_or_default();
    format!("https://feed.{host}/v1")
}

fn mesh_settings(
    vars: &HashMap<String, String>,
    com_base_url: &str,
) -> Result<Option<MeshSettings>, String> {
    if vars.get("FLAGSHIP_MESH").map(|v| v.trim()) != Some("on") {
        return Ok(None);
    }
    let relay_id =
        nonempty(vars, "FLAGSHIP_RELAY_ID").ok_or("FLAGSHIP_MESH=on needs FLAGSHIP_RELAY_ID")?;
    if !flagship_crypto::relay_mesh::is_relay_id(&relay_id) {
        return Err(format!("FLAGSHIP_RELAY_ID {relay_id:?} is not a relay id"));
    }
    let key_seed = hex32(
        "FLAGSHIP_RELAY_KEY_SEED",
        &nonempty(vars, "FLAGSHIP_RELAY_KEY_SEED")
            .ok_or("FLAGSHIP_MESH=on needs FLAGSHIP_RELAY_KEY_SEED")?,
    )?;
    let log_pub = nonempty(vars, "FLAGSHIP_RELAY_LOG_PUB")
        .or_else(|| nonempty(vars, "FLAGSHIP_SERVING_REVOCATION_PUB"))
        .ok_or("FLAGSHIP_MESH=on needs FLAGSHIP_RELAY_LOG_PUB")?
        .to_ascii_lowercase();
    hex32("FLAGSHIP_RELAY_LOG_PUB", &log_pub)?;
    let kind = flagship_crypto::relay_mesh::RelayKind::parse(
        nonempty(vars, "FLAGSHIP_RELAY_KIND")
            .as_deref()
            .unwrap_or("full"),
    )
    .map_err(|_| "FLAGSHIP_RELAY_KIND must be full or entry".to_owned())?;
    let mut peer_urls = HashMap::new();
    for pair in nonempty(vars, "FLAGSHIP_MESH_PEER_URLS")
        .unwrap_or_default()
        .split(',')
        .filter(|p| !p.trim().is_empty())
    {
        let (id, url) = pair
            .split_once('=')
            .ok_or_else(|| format!("FLAGSHIP_MESH_PEER_URLS entry {pair:?} is not relayId=url"))?;
        peer_urls.insert(id.trim().to_owned(), url.trim().to_owned());
    }
    Ok(Some(MeshSettings {
        relay_id,
        key_seed,
        kind,
        feed_url: nonempty(vars, "FLAGSHIP_RELAY_FEED_URL")
            .unwrap_or_else(|| default_feed_url(com_base_url))
            .trim_end_matches('/')
            .to_owned(),
        log_pub,
        maintainers_dir: nonempty(vars, "FLAGSHIP_RELAY_MAINTAINERS_DIR")
            .map_or_else(|| PathBuf::from(".maintainers"), PathBuf::from),
        maintainer_pin: nonempty(vars, "FLAGSHIP_RELAY_MAINTAINER_PIN")
            .unwrap_or_else(|| crate::mesh::ca::MAINTAINER_PINNED_MANDATE_HASH.to_owned()),
        peer_urls,
        peer_addrs: {
            let mut out = Vec::new();
            for a in nonempty(vars, "FLAGSHIP_MESH_PEER_ADDRS")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|a| !a.is_empty())
            {
                let ip: std::net::IpAddr = a.parse().map_err(|_| {
                    format!("FLAGSHIP_MESH_PEER_ADDRS entry {a:?} is not an IP address")
                })?;
                out.push(ip.to_string());
            }
            out
        },
        feed_poll: millis(vars, "FLAGSHIP_MESH_FEED_POLL_MS").filter(|d| !d.is_zero()),
        capacity: nonempty(vars, "FLAGSHIP_MESH_CAPACITY").and_then(|c| c.parse().ok()),
        rebalance: millis(vars, "FLAGSHIP_MESH_REBALANCE_MS").filter(|d| !d.is_zero()),
        min_move: millis(vars, "FLAGSHIP_MESH_MIN_MOVE_MS"),
        attach_ttl: millis(vars, "FLAGSHIP_MESH_ATTACH_TTL_MS").filter(|d| !d.is_zero()),
        client_key_by_port: vars
            .get("FLAGSHIP_MESH_CLIENT_KEY_BY_PORT")
            .map(|v| v.trim())
            == Some("1"),
    }))
}

fn port(vars: &HashMap<String, String>, name: &str) -> Result<Option<u16>, String> {
    match vars.get(name).map(|s| s.trim()).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(s) => s
            .parse::<u16>()
            .map(Some)
            .map_err(|_| format!("{name} is not a port: {s:?}")),
    }
}

fn millis(vars: &HashMap<String, String>, name: &str) -> Option<Duration> {
    let n: f64 = vars.get(name)?.trim().parse().ok()?;
    (n.is_finite() && n >= 0.0).then(|| Duration::from_millis(n as u64))
}

fn nonempty(vars: &HashMap<String, String>, name: &str) -> Option<String> {
    vars.get(name)
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
}

impl Settings {
    /// # Errors
    /// A port that is not a number, or no `TUNNEL_TCP_PORT` (this process is the data plane, which needs the router).
    pub fn from_vars(vars: &HashMap<String, String>) -> Result<Self, String> {
        let apex =
            nonempty(vars, "FLAGSHIP_SERVICES_APEX").unwrap_or_else(|| DEFAULT_APEX.to_owned());
        Ok(Self {
            host: nonempty(vars, "HOST").unwrap_or_else(|| "0.0.0.0".to_owned()),
            hub_port: port(vars, "PORT")?.unwrap_or(3000),
            sni_port: port(vars, "TUNNEL_TCP_PORT")?.ok_or("TUNNEL_TCP_PORT is required")?,
            echo_port: port(vars, "RELAY_ECHO_PORT")?,
            hub_host: nonempty(vars, "FLAGSHIP_HUB_HOST").unwrap_or_else(|| apex.clone()),
            apex,
            com_base_url: nonempty(vars, "FLAGSHIP_COM_BASE_URL")
                .unwrap_or_else(|| DEFAULT_COM_BASE_URL.to_owned())
                .trim_end_matches('/')
                .to_owned(),
            control_secret: nonempty(vars, "SERVICES_CONTROL_SECRET"),
            hub_key_path: nonempty(vars, "FLAGSHIP_HUB_KEY_PATH").map(PathBuf::from),
            usage_secret: nonempty(vars, "USAGE_REPORT_SECRET"),
            usage_flush: millis(vars, "USAGE_FLUSH_MS")
                .filter(|d| !d.is_zero())
                .unwrap_or(Duration::from_secs(60)),
            over_quota_kbps: nonempty(vars, "FLAGSHIP_OVER_QUOTA_KBPS"),
            pb_mail: vars.get("FLAGSHIP_PB_MAIL").map(String::as_str) != Some("off"),
            outbound: vars.get("FLAGSHIP_OUTBOUND_RELAY").map(String::as_str) != Some("off"),
            drain_grace: millis(vars, "FLAGSHIP_DRAIN_GRACE_MS").unwrap_or(DEFAULT_DRAIN_GRACE),
            serving_revocation_pub: match nonempty(vars, "FLAGSHIP_SERVING_REVOCATION_PUB") {
                None => None,
                Some(k) => {
                    let k = k.to_ascii_lowercase();
                    if k.len() != 64 || !k.bytes().all(|b| b.is_ascii_hexdigit()) {
                        return Err("FLAGSHIP_SERVING_REVOCATION_PUB must be 64 hex".into());
                    }
                    // A mesh relay reads the log key under its old name too, and never calls `.com`'s feed.
                    let mesh = vars.get("FLAGSHIP_MESH").map(|v| v.trim()) == Some("on");
                    if !mesh && nonempty(vars, "SERVICES_CONTROL_SECRET").is_none() {
                        return Err("FLAGSHIP_SERVING_REVOCATION_PUB is set but SERVICES_CONTROL_SECRET is not: the serving feed cannot authenticate".into());
                    }
                    Some(k)
                }
            },
            relay_id: nonempty(vars, "FLAGSHIP_RELAY_ID")
                .or_else(|| nonempty(vars, "FLY_MACHINE_ID"))
                .or_else(|| nonempty(vars, "HOSTNAME"))
                .unwrap_or_else(|| "flagship-relay".to_owned()),
            serving_refuse_new: millis(vars, "FLAGSHIP_SERVING_REFUSE_NEW_MS")
                .unwrap_or(Duration::from_secs(60)),
            serving_close_all: millis(vars, "FLAGSHIP_SERVING_CLOSE_ALL_MS")
                .unwrap_or(Duration::from_secs(600)),
            serving_check: millis(vars, "FLAGSHIP_SERVING_CHECK_MS")
                .filter(|d| !d.is_zero())
                .unwrap_or(Duration::from_secs(5)),
            phone_route: vars.get("FLAGSHIP_PHONE_ROUTE").map(String::as_str) != Some("off"),
            trust_fly_client_ip: match vars.get("FLAGSHIP_TRUST_FLY_CLIENT_IP").map(|v| v.trim()) {
                Some("1") => true,
                Some("0") => false,
                _ => {
                    nonempty(vars, "FLY_APP_NAME").is_some()
                        || nonempty(vars, "FLY_ALLOC_ID").is_some()
                }
            },
            mesh: mesh_settings(
                vars,
                &nonempty(vars, "FLAGSHIP_COM_BASE_URL")
                    .unwrap_or_else(|| DEFAULT_COM_BASE_URL.to_owned()),
            )?,
        })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn vars(kv: &[(&str, &str)]) -> HashMap<String, String> {
        kv.iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn the_fly_environment_gives_the_production_settings() {
        let s = Settings::from_vars(&vars(&[
            ("PORT", "3000"),
            ("TUNNEL_TCP_PORT", "8443"),
            ("RELAY_ECHO_PORT", "3001"),
            ("USAGE_REPORT_SECRET", "u"),
        ]))
        .unwrap();
        assert_eq!(
            (s.hub_port, s.sni_port, s.echo_port),
            (3000, 8443, Some(3001))
        );
        assert_eq!(
            (
                s.apex.as_str(),
                s.hub_host.as_str(),
                s.com_base_url.as_str()
            ),
            (
                "flagship.services",
                "flagship.services",
                "https://flagshipserver.com"
            )
        );
        assert_eq!(s.host, "0.0.0.0");
        assert!(s.pb_mail && s.outbound && s.usage_secret.as_deref() == Some("u"));
        assert_eq!(
            (s.usage_flush, s.drain_grace),
            (Duration::from_secs(60), Duration::from_millis(20_000))
        );
    }

    #[test]
    fn the_gym_apex_and_switches_are_honoured() {
        let s = Settings::from_vars(&vars(&[
            ("TUNNEL_TCP_PORT", "8443"),
            ("FLAGSHIP_SERVICES_APEX", "gym.flagship.services"),
            ("FLAGSHIP_COM_BASE_URL", "https://gym.flagshipserver.com/"),
            ("FLAGSHIP_PB_MAIL", "off"),
            ("FLAGSHIP_OUTBOUND_RELAY", "off"),
            ("FLAGSHIP_DRAIN_GRACE_MS", "5000"),
            ("USAGE_FLUSH_MS", "0"),
            ("FLAGSHIP_HUB_KEY_PATH", "/data/hub.key"),
        ]))
        .unwrap();
        assert_eq!(
            (
                s.apex.as_str(),
                s.hub_host.as_str(),
                s.com_base_url.as_str()
            ),
            (
                "gym.flagship.services",
                "gym.flagship.services",
                "https://gym.flagshipserver.com"
            )
        );
        assert!(!s.pb_mail && !s.outbound);
        assert_eq!(
            (s.drain_grace, s.usage_flush),
            (Duration::from_secs(5), Duration::from_secs(60)),
            "zero flush means the default"
        );
        assert_eq!(s.hub_key_path, Some(PathBuf::from("/data/hub.key")));
        assert_eq!(s.echo_port, None);
    }

    #[test]
    fn the_mesh_is_off_unless_asked_and_then_needs_its_keys() {
        let base = [("TUNNEL_TCP_PORT", "8443")];
        assert!(Settings::from_vars(&vars(&base)).unwrap().mesh.is_none());
        let seed = "0b".repeat(32);
        let log = "ed".repeat(32);
        let on = |extra: &[(&'static str, &'static str)]| {
            let mut v = vec![("TUNNEL_TCP_PORT", "8443"), ("FLAGSHIP_MESH", "on")];
            v.extend_from_slice(extra);
            v
        };
        assert!(
            Settings::from_vars(&vars(&on(&[])))
                .unwrap_err()
                .contains("FLAGSHIP_RELAY_ID")
        );
        let seed_s: &'static str = Box::leak(seed.into_boxed_str());
        let log_s: &'static str = Box::leak(log.into_boxed_str());
        let s = Settings::from_vars(&vars(&on(&[
            ("FLAGSHIP_RELAY_ID", "iad1"),
            ("FLAGSHIP_RELAY_KEY_SEED", seed_s),
            ("FLAGSHIP_SERVING_REVOCATION_PUB", log_s),
            ("FLAGSHIP_MESH_PEER_URLS", "ams1=ws://127.0.0.1:1/mesh"),
        ])))
        .unwrap();
        let m = s.mesh.unwrap();
        assert_eq!(m.feed_url, "https://feed.flagshipserver.com/v1");
        assert_eq!(m.kind, flagship_crypto::relay_mesh::RelayKind::Full);
        assert_eq!(m.key_seed, [0x0b; 32]);
        assert_eq!(
            m.peer_urls.get("ams1").map(String::as_str),
            Some("ws://127.0.0.1:1/mesh")
        );
        assert!(
            !format!("{m:?}").contains("0b0b"),
            "the seed never reaches logs"
        );
        assert!(
            Settings::from_vars(&vars(&on(&[
                ("FLAGSHIP_RELAY_ID", "1bad"),
                ("FLAGSHIP_RELAY_KEY_SEED", seed_s),
                ("FLAGSHIP_RELAY_LOG_PUB", log_s),
            ])))
            .is_err()
        );
    }

    #[test]
    fn a_missing_router_port_or_a_bad_port_is_refused() {
        assert!(
            Settings::from_vars(&vars(&[]))
                .unwrap_err()
                .contains("TUNNEL_TCP_PORT is required")
        );
        assert!(Settings::from_vars(&vars(&[("TUNNEL_TCP_PORT", "http")])).is_err());
        assert!(
            Settings::from_vars(&vars(&[("TUNNEL_TCP_PORT", "8443"), ("PORT", "99999")])).is_err()
        );
    }
}

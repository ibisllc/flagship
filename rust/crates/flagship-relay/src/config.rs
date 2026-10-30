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

//! One JSON line per decision: what was asked and how it ended, never bodies or secrets. An
//! audit failure never blocks power-off or a revocation the box needs (privd's rule).

use serde_json::{Map, Value};
use std::fs::OpenOptions;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Default)]
pub struct Audit {
    path: Option<PathBuf>,
    lock: Mutex<()>,
}

impl Audit {
    pub fn new(path: Option<PathBuf>) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
        }
    }

    pub fn record(&self, fields: Map<String, Value>) {
        let Some(path) = &self.path else { return };
        let t = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let mut line = Map::new();
        line.insert(
            "t".to_owned(),
            Value::from(u64::try_from(t).unwrap_or(u64::MAX)),
        );
        line.extend(fields);
        let Ok(mut text) = serde_json::to_string(&Value::Object(line)) else {
            return;
        };
        text.push('\n');
        let _guard = self.lock.lock();
        if let Ok(mut f) = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o640)
            .open(path)
        {
            let _ = f.write_all(text.as_bytes());
        }
    }
}

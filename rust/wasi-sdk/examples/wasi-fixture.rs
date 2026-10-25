//! The WASI fixture app the box's tests and the live gym install: a small
//! notes app in the http-proxy world that keeps its data in `/data`, plus
//! routes that misbehave on purpose (`/spin`, `/grow`) so the limits can be
//! seen from outside. It imports no host calls.

use flagship_wasi_sdk::{Request, Response, json_string};
use std::io::Write;

fn data(name: &str) -> String {
    let dir = std::env::var("FLAGSHIP_FILES_DIR").unwrap_or_else(|_| "/data".into());
    format!("{dir}/{name}")
}

fn main() {
    let req = Request::from_env();
    let v = req.visitor();
    let resp = match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/healthz") => Response::text(200, "ok\n"),
        ("GET", "/") => {
            let notes = std::fs::read_to_string(data("notes.txt")).unwrap_or_default();
            Response::text(
                200,
                format!("flagship wasi fixture\nvisitor: {}\n{notes}", v.kind),
            )
        }
        ("GET", "/notes") => Response::text(
            200,
            std::fs::read_to_string(data("notes.txt")).unwrap_or_default(),
        ),
        ("POST", "/notes") => {
            let line = String::from_utf8_lossy(&req.body).replace('\n', " ");
            let written = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(data("notes.txt"))
                .and_then(|mut f| writeln!(f, "{line}"));
            match written {
                Ok(()) => Response::redirect("/"),
                Err(e) => Response::text(507, format!("could not save: {e}\n")),
            }
        }
        ("GET", "/count") => {
            let n: u64 = std::fs::read_to_string(data("count"))
                .ok()
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or(0)
                + 1;
            match std::fs::write(data("count"), n.to_string()) {
                Ok(()) => Response::text(200, format!("{n}\n")),
                Err(e) => Response::text(507, format!("could not save: {e}\n")),
            }
        }
        ("GET", "/whoami") => Response::json(
            200,
            format!(
                r#"{{"visitor":{},"user":{},"role":{}}}"#,
                json_string(&v.kind),
                v.user
                    .as_deref()
                    .map(json_string)
                    .unwrap_or_else(|| "null".into()),
                v.role
                    .as_deref()
                    .map(json_string)
                    .unwrap_or_else(|| "null".into()),
            ),
        ),
        ("GET", "/env") => Response::json(
            200,
            format!(
                r#"{{"appId":{},"filesDir":{},"pgUrlSet":{}}}"#,
                json_string(&std::env::var("FLAGSHIP_APP_ID").unwrap_or_default()),
                json_string(&std::env::var("FLAGSHIP_FILES_DIR").unwrap_or_default()),
                std::env::var("FLAGSHIP_PG_URL").is_ok(),
            ),
        ),
        ("GET", "/spin") => {
            let mut n: u64 = 0;
            loop {
                n = std::hint::black_box(n.wrapping_add(1));
            }
        }
        ("GET", "/grow") => {
            let mut held: Vec<Vec<u8>> = Vec::new();
            loop {
                let mut chunk = vec![0u8; 1 << 20];
                chunk[0] = 1;
                held.push(std::hint::black_box(chunk));
            }
        }
        _ => Response::text(404, "not found\n"),
    };
    resp.send();
}

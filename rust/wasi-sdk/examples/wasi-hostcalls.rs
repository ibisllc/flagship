//! A WASI app that uses the capability SDK: `/fetch?url=` goes out through
//! the box (`network.egress`), `/db?sql=` runs on the app's own database
//! (`data.stores.postgres`). Installed without those capabilities, the box
//! refuses the module before it runs.

use flagship_wasi_sdk::{Request, Response, host};

fn answer(r: Result<String, host::HostError>) -> Response {
    match r {
        Ok(body) => Response::json(200, body),
        Err(e) => {
            let status = if e.status == host::status::DENIED {
                403
            } else {
                502
            };
            Response::json(
                status,
                if e.body.is_empty() {
                    format!(r#"{{"status":{}}}"#, e.status)
                } else {
                    e.body
                },
            )
        }
    }
}

fn main() {
    let req = Request::from_env();
    let resp = match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/healthz") => Response::text(200, "ok\n"),
        ("GET", "/fetch") => match req.query_param("url") {
            Some(url) => answer(host::http_fetch("GET", &url, None)),
            None => Response::text(400, "url?\n"),
        },
        ("GET", "/db") => match req.query_param("sql") {
            Some(sql) => answer(host::db_query(&sql, &[])),
            None => Response::text(400, "sql?\n"),
        },
        ("POST", "/db") => answer(host::db_query(&String::from_utf8_lossy(&req.body), &[])),
        _ => Response::text(404, "not found\n"),
    };
    resp.send();
}

//! Real-hardware numerical acceptance (§9.4). These run only on a box with
//! the device, the pinned runtime and the digest-pinned check images; on
//! every other machine each test prints why it was skipped and passes. A
//! skip is never a qualification: the receipts in the runbooks are.
//!
//! ```text
//! FLAGSHIP_GPU_HW=1 \
//! FLAGSHIP_GPU_PODMAN=/usr/bin/podman \
//! FLAGSHIP_GPU_VECTOR_ADD_IMAGE=registry/vector-add@sha256:... \
//! FLAGSHIP_GPU_TORCH_IMAGE=registry/torch-check@sha256:... \
//! cargo test -p flagship-gpu --test hardware -- --nocapture
//! ```
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::Path;
use std::time::Duration;

use flagship_gpu::catalog::is_pinned_reference;
use flagship_gpu::numerics::{MlpReport, VectorAddReport, verify_mlp, verify_vector_add};
use flagship_gpu::provider::run_fixed;

fn skip(why: &str) {
    let mut e = std::io::stderr().lock();
    let _ = std::io::Write::write_fmt(
        &mut e,
        format_args!("SKIPPED (no qualified hardware here): {why}\n"),
    );
}

/// What a real NVIDIA run needs, or why it can't run here.
fn nvidia() -> Result<(String, String), String> {
    if std::env::var("FLAGSHIP_GPU_HW").as_deref() != Ok("1") {
        return Err("FLAGSHIP_GPU_HW=1 is not set".into());
    }
    if !Path::new("/dev/nvidiactl").exists() {
        return Err("no NVIDIA device: /dev/nvidiactl is absent".into());
    }
    let podman = std::env::var("FLAGSHIP_GPU_PODMAN")
        .map_err(|_| "FLAGSHIP_GPU_PODMAN is not set".to_owned())?;
    if !Path::new(&podman).is_absolute() {
        return Err("FLAGSHIP_GPU_PODMAN must be an absolute path".into());
    }
    let cdi = std::fs::read_to_string("/var/run/cdi/nvidia_com_gpu.json")
        .map_err(|_| "no CDI spec written by flagship-gpud".to_owned())?;
    if !cdi.contains("\"nvidia.com/gpu\"") {
        return Err("the CDI spec is not NVIDIA's".into());
    }
    Ok((podman, cdi))
}

fn run_image(podman: &str, image_var: &str) -> Result<String, String> {
    let image = std::env::var(image_var).map_err(|_| format!("{image_var} is not set"))?;
    let id = image.strip_prefix("sha256:").unwrap_or(&image);
    let local_id = id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit());
    if !is_pinned_reference(&image) && !local_id {
        return Err(format!(
            "{image_var} must be name@sha256:<digest> or a local image id"
        ));
    }
    let args: Vec<String> = [
        "run",
        "--rm",
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--runtime=runsc-nvproxy",
        "--device",
        "nvidia.com/gpu=0",
        &image,
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    match run_fixed(Path::new(podman), &args, Duration::from_secs(600)) {
        Ok((true, out)) => Ok(out),
        Ok((false, _)) => Err("the check image failed".into()),
        Err(e) => Err(format!("podman did not run: {e:?}")),
    }
}

#[test]
fn cuda_vector_add_matches_bit_for_bit() {
    let (podman, _) = match nvidia() {
        Ok(x) => x,
        Err(why) => return skip(&why),
    };
    let out = run_image(&podman, "FLAGSHIP_GPU_VECTOR_ADD_IMAGE").unwrap();
    let r: VectorAddReport = serde_json::from_str(out.trim()).unwrap();
    verify_vector_add(&r, "cuda").unwrap();
}

#[test]
fn pytorch_inference_matches_the_fixture() {
    let (podman, _) = match nvidia() {
        Ok(x) => x,
        Err(why) => return skip(&why),
    };
    let out = run_image(&podman, "FLAGSHIP_GPU_TORCH_IMAGE").unwrap();
    let r: MlpReport = serde_json::from_str(out.trim()).unwrap();
    verify_mlp(&r, "cuda").unwrap();
}

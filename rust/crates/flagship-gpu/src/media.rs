//! Headless graphics and video jobs (§9.5): what each needs approved, and
//! how its output is checked against known fixtures. Render, encode and
//! decode are separate permissions; a compute approval never covers them.
//! There is no display capture, remote input or streaming here: a job reads
//! files and writes files.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::device::Capability;

pub const MAX_DIMENSION: u32 = 4096;
pub const MAX_FRAMES: u32 = 600;
/// A rendered pixel channel further than this from the fixture counts as a
/// mismatch (drivers differ in rasterisation and dithering by a few steps).
pub const CHANNEL_TOLERANCE: u8 = 8;
/// At most this fraction of channels may mismatch (triangle edges).
pub const MAX_MISMATCH_FRACTION: f64 = 0.01;
pub const MAX_MEAN_ABS_ERROR: f64 = 2.0;
/// Decoded video must be at least this close to the source.
pub const MIN_PSNR_DB: f64 = 30.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GraphicsApi {
    Egl,
    #[serde(rename = "opengl")]
    OpenGl,
    Vulkan,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Codec {
    H264,
    Hevc,
    Av1,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VideoOp {
    Encode,
    Decode,
    /// Encode the fixture, then decode it again.
    RoundTrip,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderSpec {
    pub api: GraphicsApi,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscodeSpec {
    pub codec: Codec,
    pub op: VideoOp,
    pub width: u32,
    pub height: u32,
    pub frames: u32,
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum MediaError {
    #[error("{0}")]
    Shape(&'static str),
    #[error("output is not a valid {0}")]
    Format(&'static str),
    #[error("output does not match the fixture: {0}")]
    Mismatch(String),
}

fn dims_ok(w: u32, h: u32) -> bool {
    (2..=MAX_DIMENSION).contains(&w) && (2..=MAX_DIMENSION).contains(&h)
}

impl RenderSpec {
    pub fn required(&self) -> BTreeSet<Capability> {
        BTreeSet::from([Capability::Graphics])
    }

    pub fn check(&self) -> Result<(), MediaError> {
        if !dims_ok(self.width, self.height) {
            return Err(MediaError::Shape("render size must be 2 to 4096 pixels"));
        }
        Ok(())
    }
}

impl TranscodeSpec {
    pub fn required(&self) -> BTreeSet<Capability> {
        match self.op {
            VideoOp::Encode => BTreeSet::from([Capability::VideoEncode]),
            VideoOp::Decode => BTreeSet::from([Capability::VideoDecode]),
            VideoOp::RoundTrip => {
                BTreeSet::from([Capability::VideoEncode, Capability::VideoDecode])
            }
        }
    }

    pub fn check(&self) -> Result<(), MediaError> {
        if !dims_ok(self.width, self.height)
            || !self.width.is_multiple_of(2)
            || !self.height.is_multiple_of(2)
        {
            return Err(MediaError::Shape(
                "video size must be even and 2 to 4096 pixels",
            ));
        }
        if self.frames == 0 || self.frames > MAX_FRAMES {
            return Err(MediaError::Shape("a transcode job has 1 to 600 frames"));
        }
        Ok(())
    }
}

fn scale(v: u64, max: u64) -> u8 {
    let max = max.max(1);
    u8::try_from(v.saturating_mul(255).checked_div(max).unwrap_or(0)).unwrap_or(u8::MAX)
}

fn edge(ax: i64, ay: i64, bx: i64, by: i64, px: i64, py: i64) -> i64 {
    bx.saturating_sub(ax)
        .saturating_mul(py.saturating_sub(ay))
        .saturating_sub(by.saturating_sub(ay).saturating_mul(px.saturating_sub(ax)))
}

/// The test scene (`flagship-test-scene/v1`), drawn in software: a red/green
/// gradient on blue 64, and a white triangle sampled at pixel centres
/// (coordinates doubled so centres are integers). The render-check image
/// draws the same scene through the GPU API under test; this is its fixture.
pub fn reference_scene(width: u32, height: u32) -> Vec<u8> {
    let (w, h) = (u64::from(width), u64::from(height));
    let (w2, h2) = (
        i64::from(width).saturating_mul(2),
        i64::from(height).saturating_mul(2),
    );
    let tri = [
        (w2 / 2, h2 / 8),
        (w2 / 8, h2.saturating_mul(7) / 8),
        (w2.saturating_mul(7) / 8, h2.saturating_mul(7) / 8),
    ];
    let mut out =
        Vec::with_capacity(usize::try_from(w.saturating_mul(h).saturating_mul(3)).unwrap_or(0));
    for y in 0..h {
        for x in 0..w {
            let px = i64::try_from(x)
                .unwrap_or(0)
                .saturating_mul(2)
                .saturating_add(1);
            let py = i64::try_from(y)
                .unwrap_or(0)
                .saturating_mul(2)
                .saturating_add(1);
            let [(ax, ay), (bx, by), (cx, cy)] = tri;
            let e0 = edge(ax, ay, bx, by, px, py);
            let e1 = edge(bx, by, cx, cy, px, py);
            let e2 = edge(cx, cy, ax, ay, px, py);
            let inside = (e0 >= 0 && e1 >= 0 && e2 >= 0) || (e0 <= 0 && e1 <= 0 && e2 <= 0);
            if inside {
                out.extend_from_slice(&[255, 255, 255]);
            } else {
                out.extend_from_slice(&[
                    scale(x, w.saturating_sub(1)),
                    scale(y, h.saturating_sub(1)),
                    64,
                ]);
            }
        }
    }
    out
}

pub fn encode_ppm(width: u32, height: u32, rgb: &[u8]) -> Vec<u8> {
    let mut out = format!("P6\n{width} {height}\n255\n").into_bytes();
    out.extend_from_slice(rgb);
    out
}

/// Binary PPM (P6, maxval 255) with no comments, within the size limits.
pub fn parse_ppm(bytes: &[u8]) -> Result<(u32, u32, &[u8]), MediaError> {
    let bad = MediaError::Format("P6 image");
    let mut fields = Vec::with_capacity(4);
    let mut pos = 0usize;
    while fields.len() < 4 {
        while bytes.get(pos).is_some_and(u8::is_ascii_whitespace) {
            pos = pos.saturating_add(1);
        }
        let start = pos;
        while bytes.get(pos).is_some_and(|b| !b.is_ascii_whitespace()) {
            pos = pos.saturating_add(1);
        }
        if start == pos || pos.saturating_sub(start) > 8 {
            return Err(bad);
        }
        fields.push(
            bytes
                .get(start..pos)
                .ok_or(MediaError::Format("P6 image"))?,
        );
    }
    pos = pos.saturating_add(1);
    let text =
        |i: usize| -> Option<&str> { fields.get(i).and_then(|f| std::str::from_utf8(f).ok()) };
    if text(0) != Some("P6") || text(3) != Some("255") {
        return Err(bad);
    }
    let w: u32 = text(1)
        .and_then(|s| s.parse().ok())
        .ok_or(MediaError::Format("P6 image"))?;
    let h: u32 = text(2)
        .and_then(|s| s.parse().ok())
        .ok_or(MediaError::Format("P6 image"))?;
    if !dims_ok(w, h) {
        return Err(bad);
    }
    let n = usize::try_from(u64::from(w).saturating_mul(u64::from(h)).saturating_mul(3))
        .map_err(|_| MediaError::Format("P6 image"))?;
    let data = bytes.get(pos..).ok_or(MediaError::Format("P6 image"))?;
    if data.len() != n {
        return Err(bad);
    }
    Ok((w, h, data))
}

#[derive(Clone, Debug, PartialEq)]
pub struct RenderVerdict {
    pub mean_abs_error: f64,
    pub mismatched_fraction: f64,
}

/// Compare a job's PPM output with the reference scene of the same size.
pub fn verify_render(spec: &RenderSpec, output: &[u8]) -> Result<RenderVerdict, MediaError> {
    let (w, h, got) = parse_ppm(output)?;
    if w != spec.width || h != spec.height {
        return Err(MediaError::Mismatch(format!(
            "rendered {w}x{h}, asked for {}x{}",
            spec.width, spec.height
        )));
    }
    let want = reference_scene(w, h);
    let mut sum = 0u64;
    let mut mismatched = 0u64;
    for (a, b) in want.iter().zip(got.iter()) {
        let d = a.abs_diff(*b);
        sum = sum.saturating_add(u64::from(d));
        if d > CHANNEL_TOLERANCE {
            mismatched = mismatched.saturating_add(1);
        }
    }
    let n = want.len().max(1) as f64;
    let v = RenderVerdict {
        mean_abs_error: sum as f64 / n,
        mismatched_fraction: mismatched as f64 / n,
    };
    if v.mean_abs_error > MAX_MEAN_ABS_ERROR || v.mismatched_fraction > MAX_MISMATCH_FRACTION {
        return Err(MediaError::Mismatch(format!(
            "mean error {:.2}, {:.2}% of channels off",
            v.mean_abs_error,
            v.mismatched_fraction * 100.0
        )));
    }
    Ok(v)
}

fn frame_len(w: u32, h: u32) -> usize {
    let luma = u64::from(w).saturating_mul(u64::from(h));
    usize::try_from(luma.saturating_add(luma / 2)).unwrap_or(usize::MAX)
}

/// The source clip (`flagship-test-clip/v1`): raw planar YUV 4:2:0 frames of
/// a diagonal luma ramp moving one step a frame, with flat chroma.
pub fn reference_clip(width: u32, height: u32, frames: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(
        frame_len(width, height).saturating_mul(usize::try_from(frames).unwrap_or(0)),
    );
    for f in 0..frames {
        for y in 0..height {
            for x in 0..width {
                let v = x.saturating_add(y).saturating_add(f.saturating_mul(4)) % 220;
                out.push(u8::try_from(v.saturating_add(16)).unwrap_or(235));
            }
        }
        let chroma = usize::try_from(u64::from(width / 2).saturating_mul(u64::from(height / 2)))
            .unwrap_or(0);
        out.extend(std::iter::repeat_n(112u8, chroma));
        out.extend(std::iter::repeat_n(144u8, chroma));
    }
    out
}

/// PSNR in dB over every plane of two equally sized YUV 4:2:0 clips.
pub fn psnr(a: &[u8], b: &[u8]) -> Option<f64> {
    if a.len() != b.len() || a.is_empty() {
        return None;
    }
    let mut se = 0u64;
    for (x, y) in a.iter().zip(b.iter()) {
        let d = u64::from(x.abs_diff(*y));
        se = se.saturating_add(d.saturating_mul(d));
    }
    if se == 0 {
        return Some(f64::INFINITY);
    }
    let mse = se as f64 / a.len() as f64;
    Some(10.0 * ((255.0 * 255.0) / mse).log10())
}

/// A decoded clip must have the source's size and be within [`MIN_PSNR_DB`].
pub fn verify_transcode(spec: &TranscodeSpec, decoded: &[u8]) -> Result<f64, MediaError> {
    let want = reference_clip(spec.width, spec.height, spec.frames);
    if decoded.len() != want.len() {
        return Err(MediaError::Mismatch(format!(
            "decoded {} bytes, the clip has {}",
            decoded.len(),
            want.len()
        )));
    }
    let p = psnr(&want, decoded).ok_or(MediaError::Format("YUV 4:2:0 clip"))?;
    if p < MIN_PSNR_DB {
        return Err(MediaError::Mismatch(format!(
            "PSNR {p:.1} dB is under {MIN_PSNR_DB} dB"
        )));
    }
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scene_is_deterministic_and_has_a_triangle() {
        let a = reference_scene(64, 48);
        assert_eq!(a, reference_scene(64, 48));
        assert_eq!(a.len(), 64 * 48 * 3);
        let centre = (24 * 64 + 32) * 3;
        assert_eq!(a.get(centre..centre + 3), Some(&[255u8, 255, 255][..]));
        assert_eq!(a.get(0..3), Some(&[0u8, 0, 64][..]));
    }

    #[test]
    fn ppm_round_trip_and_garbage() {
        let rgb = reference_scene(8, 8);
        let ppm = encode_ppm(8, 8, &rgb);
        let (w, h, d) = parse_ppm(&ppm).unwrap_or((0, 0, &[]));
        assert_eq!((w, h, d), (8, 8, &rgb[..]));
        assert!(parse_ppm(b"P5\n8 8\n255\n").is_err());
        assert!(parse_ppm(b"P6\n99999 8\n255\n").is_err());
        assert!(parse_ppm(ppm.split_last().map_or(&[][..], |(_, r)| r)).is_err());
    }
}

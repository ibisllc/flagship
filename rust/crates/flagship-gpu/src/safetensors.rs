//! The only checkpoint and weight format a GPU job may hand back
//! (§9.5: "framework checkpoints are untrusted artifacts; prohibit
//! arbitrary host-code deserialization"). safetensors is an 8-byte
//! little-endian header length, a JSON header naming each tensor's dtype,
//! shape and byte range, then the raw bytes. Parsing it runs no code.
//! Pickle-based files (`torch.save`, `.pt`, `.pkl`, zip archives holding a
//! `data.pkl`) are refused outright.

use std::collections::BTreeMap;

use serde_json::{Map, Value};

pub const MAX_HEADER_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_TENSORS: usize = 100_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Dtype {
    F64,
    F32,
    F16,
    Bf16,
    I64,
    I32,
    I16,
    I8,
    U8,
    Bool,
}

impl Dtype {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "F64" => Self::F64,
            "F32" => Self::F32,
            "F16" => Self::F16,
            "BF16" => Self::Bf16,
            "I64" => Self::I64,
            "I32" => Self::I32,
            "I16" => Self::I16,
            "I8" => Self::I8,
            "U8" => Self::U8,
            "BOOL" => Self::Bool,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::F64 => "F64",
            Self::F32 => "F32",
            Self::F16 => "F16",
            Self::Bf16 => "BF16",
            Self::I64 => "I64",
            Self::I32 => "I32",
            Self::I16 => "I16",
            Self::I8 => "I8",
            Self::U8 => "U8",
            Self::Bool => "BOOL",
        }
    }

    pub fn size(self) -> u64 {
        match self {
            Self::F64 | Self::I64 => 8,
            Self::F32 | Self::I32 => 4,
            Self::F16 | Self::Bf16 | Self::I16 => 2,
            Self::I8 | Self::U8 | Self::Bool => 1,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TensorInfo {
    pub dtype: Dtype,
    pub shape: Vec<u64>,
    pub begin: u64,
    pub end: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SafeTensors<'a> {
    pub tensors: BTreeMap<String, TensorInfo>,
    pub metadata: BTreeMap<String, String>,
    data: &'a [u8],
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum FormatError {
    #[error(
        "a pickle-based checkpoint runs code when loaded and is refused; save weights as safetensors"
    )]
    Pickle,
    #[error("not a safetensors file: {0}")]
    Invalid(&'static str),
}

/// A file that would execute code when a framework loads it.
pub fn is_pickle_based(bytes: &[u8]) -> bool {
    let pickle = bytes.first() == Some(&0x80) && bytes.get(1).is_some_and(|v| (2..=5).contains(v));
    let zip = bytes.starts_with(b"PK\x03\x04");
    pickle || zip
}

impl<'a> SafeTensors<'a> {
    pub fn parse(bytes: &'a [u8]) -> Result<Self, FormatError> {
        if is_pickle_based(bytes) {
            return Err(FormatError::Pickle);
        }
        let bad = FormatError::Invalid;
        let len_bytes: [u8; 8] = bytes
            .get(..8)
            .and_then(|b| b.try_into().ok())
            .ok_or(bad("too short"))?;
        let header_len = u64::from_le_bytes(len_bytes);
        if header_len == 0 || header_len > MAX_HEADER_BYTES {
            return Err(bad("header length"));
        }
        let header_end =
            usize::try_from(header_len.saturating_add(8)).map_err(|_| bad("header length"))?;
        let header = bytes.get(8..header_end).ok_or(bad("header past the end"))?;
        let data = bytes.get(header_end..).ok_or(bad("header past the end"))?;
        let v: Value = serde_json::from_slice(header).map_err(|_| bad("header is not JSON"))?;
        let obj: &Map<String, Value> = v.as_object().ok_or(bad("header is not an object"))?;
        if obj.len() > MAX_TENSORS {
            return Err(bad("too many tensors"));
        }
        let mut tensors = BTreeMap::new();
        let mut metadata = BTreeMap::new();
        for (name, t) in obj {
            if name.is_empty() || name.chars().any(char::is_control) {
                return Err(bad("tensor name"));
            }
            if name == "__metadata__" {
                for (k, v) in t.as_object().ok_or(bad("metadata"))? {
                    metadata.insert(
                        k.clone(),
                        v.as_str().ok_or(bad("metadata value"))?.to_owned(),
                    );
                }
                continue;
            }
            let t = t.as_object().ok_or(bad("tensor entry"))?;
            if t.keys()
                .any(|k| !matches!(k.as_str(), "dtype" | "shape" | "data_offsets"))
            {
                return Err(bad("unknown tensor field"));
            }
            let dtype = t
                .get("dtype")
                .and_then(Value::as_str)
                .and_then(Dtype::parse)
                .ok_or(bad("dtype"))?;
            let shape: Vec<u64> = t
                .get("shape")
                .and_then(Value::as_array)
                .ok_or(bad("shape"))?
                .iter()
                .map(|d| d.as_u64().ok_or(bad("shape")))
                .collect::<Result<_, _>>()?;
            let offs = t
                .get("data_offsets")
                .and_then(Value::as_array)
                .ok_or(bad("data_offsets"))?;
            let (Some(begin), Some(end), 2) = (
                offs.first().and_then(Value::as_u64),
                offs.get(1).and_then(Value::as_u64),
                offs.len(),
            ) else {
                return Err(bad("data_offsets"));
            };
            let elems = shape
                .iter()
                .try_fold(1u64, |a, d| a.checked_mul(*d))
                .ok_or(bad("shape overflows"))?;
            let want = elems
                .checked_mul(dtype.size())
                .ok_or(bad("shape overflows"))?;
            if end < begin || end.saturating_sub(begin) != want {
                return Err(bad("byte range does not match the shape"));
            }
            tensors.insert(
                name.clone(),
                TensorInfo {
                    dtype,
                    shape,
                    begin,
                    end,
                },
            );
        }
        let mut ranges: Vec<(u64, u64)> = tensors.values().map(|t| (t.begin, t.end)).collect();
        ranges.sort_unstable();
        let mut at = 0u64;
        for (b, e) in ranges {
            if b != at {
                return Err(bad("tensors overlap or leave gaps"));
            }
            at = e;
        }
        if at != u64::try_from(data.len()).unwrap_or(u64::MAX) {
            return Err(bad("data length does not match the tensors"));
        }
        Ok(Self {
            tensors,
            metadata,
            data,
        })
    }

    pub fn bytes(&self, name: &str) -> Option<&'a [u8]> {
        let t = self.tensors.get(name)?;
        self.data
            .get(usize::try_from(t.begin).ok()?..usize::try_from(t.end).ok()?)
    }

    /// An F64 tensor's values.
    pub fn f64s(&self, name: &str) -> Option<Vec<f64>> {
        if self.tensors.get(name)?.dtype != Dtype::F64 {
            return None;
        }
        Some(
            self.bytes(name)?
                .as_chunks::<8>()
                .0
                .iter()
                .map(|c| f64::from_le_bytes(*c))
                .collect(),
        )
    }
}

/// Serialise F64 tensors (name, shape, values) with optional metadata.
pub fn write_f64(
    tensors: &[(&str, Vec<u64>, &[f64])],
    metadata: &BTreeMap<String, String>,
) -> Vec<u8> {
    let mut header = Map::new();
    if !metadata.is_empty() {
        header.insert(
            "__metadata__".into(),
            Value::Object(
                metadata
                    .iter()
                    .map(|(k, v)| (k.clone(), Value::String(v.clone())))
                    .collect(),
            ),
        );
    }
    let mut data = Vec::new();
    for (name, shape, values) in tensors {
        let begin = data.len() as u64;
        for v in *values {
            data.extend_from_slice(&v.to_le_bytes());
        }
        header.insert(
            (*name).to_owned(),
            serde_json::json!({
                "dtype": "F64",
                "shape": shape,
                "data_offsets": [begin, data.len() as u64],
            }),
        );
    }
    let h = Value::Object(header).to_string().into_bytes();
    let mut out = (h.len() as u64).to_le_bytes().to_vec();
    out.extend_from_slice(&h);
    out.extend_from_slice(&data);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_refusals() {
        let w = [1.5f64, -2.0, 3.25];
        let b = [0.5f64];
        let file = write_f64(&[("w", vec![3], &w), ("b", vec![1], &b)], &BTreeMap::new());
        let st = SafeTensors::parse(&file);
        assert_eq!(st.as_ref().ok().and_then(|s| s.f64s("w")), Some(w.to_vec()));
        assert_eq!(
            SafeTensors::parse(b"\x80\x04\x95").err(),
            Some(FormatError::Pickle)
        );
        assert_eq!(
            SafeTensors::parse(b"PK\x03\x04rest").err(),
            Some(FormatError::Pickle)
        );
        let mut cut = file.clone();
        cut.pop();
        assert!(SafeTensors::parse(&cut).is_err());
        let mut huge = file.clone();
        if let Some(h) = huge.get_mut(..8) {
            h.copy_from_slice(&u64::MAX.to_le_bytes());
        }
        assert!(SafeTensors::parse(&huge).is_err());
    }
}

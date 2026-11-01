#![no_main]
#![forbid(unsafe_code)]
//! The archive check: never panics, under both profiles; `check_copy` reaches the same verdict as
//! `check` and, on acceptance, the copy is what was read plus one zero block; tight limits bound it.
use std::io::Write;
use std::sync::{Arc, Mutex};

use flagship_broker::tarcheck::{Limits, Profile, check, check_copy};
use libfuzzer_sys::fuzz_target;

#[derive(Clone, Default)]
struct Sink(Arc<Mutex<Vec<u8>>>);
impl Write for Sink {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .map_err(|_| std::io::Error::other("poisoned"))?
            .extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fuzz_target!(|data: &[u8]| {
    let tight = Limits {
        max_entries: 8,
        max_entry_bytes: 4096,
        max_total_bytes: 16 * 1024,
        max_name_bytes: 256,
        max_pax_bytes: 1024,
        max_name_total_bytes: 2048,
    };
    for profile in [Profile::Volume, Profile::Archive] {
        for limits in [Limits::default(), tight] {
            let plain = check(data, profile, &limits);
            let sink = Sink::default();
            let copied = check_copy(data, Box::new(sink.clone()), profile, &limits);
            assert_eq!(plain, copied, "check and check_copy disagree");
            if let Ok(s) = plain {
                assert!(s.entries <= limits.max_entries);
                assert!(s.bytes <= limits.max_total_bytes);
                let out = sink.0.lock().expect("sink").clone();
                assert!(
                    out.len() >= 512 && out.len() <= data.len() + 512,
                    "copy length"
                );
                assert!(out.ends_with(&[0u8; 512]), "copy ends with a zero block");
                assert_eq!(
                    &out[..out.len() - 512],
                    &data[..out.len() - 512],
                    "copy is what was read"
                );
            }
        }
    }
});

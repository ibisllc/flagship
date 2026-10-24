//! The persisted time floor (`/boot/flagship-time-floor`): the boot clock never reads earlier
//! than the daemon's last authenticated time, so a clock set back cannot revive an expired lease.
#![allow(clippy::unwrap_used, clippy::arithmetic_side_effects)]

use flagship_boot::unlock::flow::Clock;
use flagship_boot::unlock::read_time_floor;
use flagship_boot::unlock::system::SystemClock;

fn floor_file(contents: &[u8]) -> (tempfile_dir::Dir, std::path::PathBuf) {
    let d = tempfile_dir::Dir::new();
    let p = d.path().join("flagship-time-floor");
    std::fs::write(&p, contents).unwrap();
    (d, p)
}

mod tempfile_dir {
    pub struct Dir(std::path::PathBuf);
    impl Dir {
        pub fn new() -> Self {
            let mut p = std::env::temp_dir();
            let n: u64 = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
                .try_into()
                .unwrap();
            p.push(format!("flagship-floor-{}-{n}", std::process::id()));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        pub fn path(&self) -> &std::path::Path {
            &self.0
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

#[test]
fn reads_a_well_formed_floor_and_ignores_anything_else() {
    let (_d, p) = floor_file(b"4102444800000\n");
    assert_eq!(read_time_floor(&p), Some(4_102_444_800_000));
    for bad in [
        &b""[..],
        b"\n",
        b"-1",
        b"12a",
        b" 12",
        b"12345678901234567",
        b"1.5",
    ] {
        let (_d, p) = floor_file(bad);
        assert_eq!(read_time_floor(&p), None, "{bad:?}");
    }
    assert_eq!(
        read_time_floor(std::path::Path::new("/nonexistent/flagship-time-floor")),
        None
    );
}

#[test]
fn the_clock_never_reads_earlier_than_the_floor() {
    let far = 4_102_444_800_000u64; // 2100-01-01
    let c = SystemClock::new().with_floor(far);
    assert!(c.now_ms() >= far);
    assert!(c.now_secs() >= far / 1000);
    let plain = SystemClock::new().with_floor(1);
    assert!(plain.now_ms() < far);
}

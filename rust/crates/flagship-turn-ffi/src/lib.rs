//! C and JNI exports of [`flagship_turn_lite`] for the phone apps (include/flagship_turn.h). Each export is a thin
//! shell over [`session::Session`]; a handle is a boxed session owned by the caller until it frees it.

pub mod session;

use std::ptr;
use std::slice;

use session::Session;

/// A result buffer handed to C; freed by [`flagship_turn_buf_free`].
#[repr(C)]
#[derive(Debug)]
pub struct FlagshipTurnBuf {
    pub ptr: *mut u8,
    pub len: usize,
    pub cap: usize,
}

fn to_buf(v: Vec<u8>) -> FlagshipTurnBuf {
    let mut v = std::mem::ManuallyDrop::new(v);
    FlagshipTurnBuf {
        ptr: v.as_mut_ptr(),
        len: v.len(),
        cap: v.capacity(),
    }
}

/// # Safety
/// `data` must point to `len` readable bytes, or `len` must be 0.
unsafe fn bytes<'a>(data: *const u8, len: usize) -> &'a [u8] {
    if data.is_null() || len == 0 {
        &[]
    } else {
        // SAFETY: the caller promises `len` readable bytes at `data`.
        unsafe { slice::from_raw_parts(data, len) }
    }
}

/// # Safety
/// `config` must point to `config_len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn flagship_turn_new(config: *const u8, config_len: usize) -> *mut Session {
    // SAFETY: forwarded from the caller.
    let cfg = unsafe { bytes(config, config_len) };
    Session::from_config(cfg).map_or(ptr::null_mut(), |s| Box::into_raw(Box::new(s)))
}

/// # Safety
/// `turn` must come from [`flagship_turn_new`] and not be used again.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn flagship_turn_free(turn: *mut Session) {
    if !turn.is_null() {
        // SAFETY: the caller hands back the box it got from flagship_turn_new.
        drop(unsafe { Box::from_raw(turn) });
    }
}

/// # Safety
/// `turn` must be a live handle used from one thread at a time; `data` must point to `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn flagship_turn_client_bytes(
    turn: *mut Session,
    data: *const u8,
    len: usize,
    now_ms: u64,
) -> FlagshipTurnBuf {
    // SAFETY: the caller promises a live, unshared handle.
    let Some(s) = (unsafe { turn.as_mut() }) else {
        return to_buf(session::encode(session::NOT_TURN, &[], &[]));
    };
    // SAFETY: forwarded from the caller.
    to_buf(s.client_bytes(unsafe { bytes(data, len) }, now_ms))
}

/// # Safety
/// As [`flagship_turn_client_bytes`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn flagship_turn_peer_datagram(
    turn: *mut Session,
    peer_port: u16,
    data: *const u8,
    len: usize,
    now_ms: u64,
) -> FlagshipTurnBuf {
    // SAFETY: the caller promises a live, unshared handle.
    let Some(s) = (unsafe { turn.as_mut() }) else {
        return to_buf(session::encode(session::OK, &[], &[]));
    };
    // SAFETY: forwarded from the caller.
    to_buf(s.peer_datagram(peer_port, unsafe { bytes(data, len) }, now_ms))
}

/// # Safety
/// `turn` must be a live handle or null.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn flagship_turn_is_allocated(turn: *const Session, now_ms: u64) -> i32 {
    // SAFETY: the caller promises a live handle or null.
    i32::from(unsafe { turn.as_ref() }.is_some_and(|s| s.is_allocated(now_ms)))
}

/// # Safety
/// `buf` must come from this library and not be freed twice.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn flagship_turn_buf_free(buf: FlagshipTurnBuf) {
    if !buf.ptr.is_null() {
        // SAFETY: rebuilds the Vec to_buf gave away, with its own length and capacity.
        drop(unsafe { Vec::from_raw_parts(buf.ptr, buf.len, buf.cap) });
    }
}

/// JNI exports for `com.flagshipserver.app.calls.TurnResponder` (Android).
pub mod jni {
    use super::Session;
    use jni_sys::{JNIEnv, jbyteArray, jclass, jint, jlong, jsize};
    use std::ptr;

    /// # Safety
    /// `env` must be the current thread's JNIEnv and `array` a live local reference to a byte[] or null.
    unsafe fn read(env: *mut JNIEnv, array: jbyteArray) -> Option<Vec<u8>> {
        if array.is_null() {
            return Some(Vec::new());
        }
        // SAFETY: a JNIEnv from the JVM always carries its function table.
        let f = unsafe { &**env };
        // SAFETY: valid env and array, per the caller.
        let len = unsafe { (f.GetArrayLength?)(env, array) };
        let n = usize::try_from(len).ok()?;
        let mut out = vec![0u8; n];
        // SAFETY: `out` holds `len` bytes.
        unsafe { (f.GetByteArrayRegion?)(env, array, 0, len, out.as_mut_ptr().cast()) };
        // SAFETY: as above.
        if unsafe { (f.ExceptionCheck?)(env) } != 0 {
            return None;
        }
        Some(out)
    }

    /// # Safety
    /// `env` must be the current thread's JNIEnv.
    unsafe fn write(env: *mut JNIEnv, bytes: &[u8]) -> jbyteArray {
        let Ok(len) = jsize::try_from(bytes.len()) else {
            return ptr::null_mut();
        };
        // SAFETY: a JNIEnv from the JVM always carries its function table.
        let f = unsafe { &**env };
        let (Some(new), Some(set)) = (f.NewByteArray, f.SetByteArrayRegion) else {
            return ptr::null_mut();
        };
        // SAFETY: valid env, per the caller.
        let array = unsafe { new(env, len) };
        if !array.is_null() {
            // SAFETY: `array` has `len` elements.
            unsafe { set(env, array, 0, len, bytes.as_ptr().cast()) };
        }
        array
    }

    /// # Safety
    /// Called by the JVM with valid arguments.
    #[unsafe(no_mangle)]
    pub unsafe extern "system" fn Java_com_flagshipserver_app_calls_TurnResponder_nativeNew(
        env: *mut JNIEnv,
        _class: jclass,
        config: jbyteArray,
    ) -> jlong {
        // SAFETY: called by the JVM.
        let Some(cfg) = (unsafe { read(env, config) }) else {
            return 0;
        };
        Session::from_config(&cfg).map_or(0, |s| Box::into_raw(Box::new(s)) as jlong)
    }

    /// # Safety
    /// `handle` must come from nativeNew and not be used again.
    #[unsafe(no_mangle)]
    pub unsafe extern "system" fn Java_com_flagshipserver_app_calls_TurnResponder_nativeFree(
        _env: *mut JNIEnv,
        _class: jclass,
        handle: jlong,
    ) {
        if handle != 0 {
            // SAFETY: the Kotlin side frees each handle once.
            drop(unsafe { Box::from_raw(handle as *mut Session) });
        }
    }

    /// # Safety
    /// `handle` must be live and used from one thread at a time.
    #[unsafe(no_mangle)]
    pub unsafe extern "system" fn Java_com_flagshipserver_app_calls_TurnResponder_nativeClientBytes(
        env: *mut JNIEnv,
        _class: jclass,
        handle: jlong,
        data: jbyteArray,
        now_ms: jlong,
    ) -> jbyteArray {
        // SAFETY: the Kotlin side passes a live handle under its lock.
        let Some(s) = (unsafe { (handle as *mut Session).as_mut() }) else {
            return ptr::null_mut();
        };
        // SAFETY: called by the JVM.
        let Some(d) = (unsafe { read(env, data) }) else {
            return ptr::null_mut();
        };
        let out = s.client_bytes(&d, u64::try_from(now_ms).unwrap_or(0));
        // SAFETY: called by the JVM.
        unsafe { write(env, &out) }
    }

    /// # Safety
    /// As nativeClientBytes.
    #[unsafe(no_mangle)]
    pub unsafe extern "system" fn Java_com_flagshipserver_app_calls_TurnResponder_nativePeerDatagram(
        env: *mut JNIEnv,
        _class: jclass,
        handle: jlong,
        port: jint,
        data: jbyteArray,
        now_ms: jlong,
    ) -> jbyteArray {
        // SAFETY: the Kotlin side passes a live handle under its lock.
        let Some(s) = (unsafe { (handle as *mut Session).as_mut() }) else {
            return ptr::null_mut();
        };
        let Ok(port) = u16::try_from(port) else {
            return ptr::null_mut();
        };
        // SAFETY: called by the JVM.
        let Some(d) = (unsafe { read(env, data) }) else {
            return ptr::null_mut();
        };
        let out = s.peer_datagram(port, &d, u64::try_from(now_ms).unwrap_or(0));
        // SAFETY: called by the JVM.
        unsafe { write(env, &out) }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn the_c_exports_round_trip_a_buffer_and_refuse_a_bad_config() {
        let cfg = b"r\nu\np\nn\n127.0.0.1:50000\n127.0.0.1\n8000";
        // SAFETY: valid pointers and lengths throughout.
        unsafe {
            assert!(flagship_turn_new(b"x".as_ptr(), 1).is_null());
            let t = flagship_turn_new(cfg.as_ptr(), cfg.len());
            assert!(!t.is_null());
            let buf = flagship_turn_client_bytes(t, b"PUT".as_ptr(), 3, 1);
            assert_eq!(*buf.ptr, session::NOT_TURN);
            flagship_turn_buf_free(buf);
            let buf = flagship_turn_peer_datagram(t, 4000, b"x".as_ptr(), 1, 1);
            assert_eq!(buf.len, 7);
            flagship_turn_buf_free(buf);
            assert_eq!(flagship_turn_is_allocated(t, 1), 0);
            flagship_turn_free(t);
        }
    }
}

/*
 *  Flagship addition to the WebRTC Android SDK (tools/libwebrtc in the Flagship repository).
 *  Upstream's FrameEncryptor / FrameDecryptor take a native pointer only; this pairs them with a Java delegate, so
 *  app code seals and opens every encoded frame (docs/voici-calls.md §3).
 */

package org.webrtc;

import androidx.annotation.Nullable;
import org.jni_zero.NativeMethods;

public class FlagshipFrameCrypto {
  /** Called on WebRTC's encoder and decoder threads. Null drops the frame; it is never sent or decoded. */
  public interface Delegate {
    @Nullable
    byte[] seal(boolean video, byte[] frame);

    @Nullable
    byte[] open(boolean video, byte[] sealed);
  }

  private volatile @Nullable Delegate delegate;
  private long nativeEncryptor;
  private long nativeDecryptor;

  public FlagshipFrameCrypto(Delegate delegate) {
    this.delegate = delegate;
    nativeEncryptor = FlagshipFrameCryptoJni.get().createEncryptor(this);
    nativeDecryptor = FlagshipFrameCryptoJni.get().createDecryptor(this);
  }

  /** Every frame this sender sends goes through {@link Delegate#seal}. */
  public synchronized void attach(RtpSender sender) {
    final long encryptor = nativeEncryptor;
    if (encryptor != 0) {
      sender.setFrameEncryptor(() -> encryptor);
    }
  }

  /** Every frame this receiver gets goes through {@link Delegate#open} before the decoder. */
  public synchronized void attach(RtpReceiver receiver) {
    final long decryptor = nativeDecryptor;
    if (decryptor != 0) {
      receiver.setFrameDecryptor(() -> decryptor);
    }
  }

  /** Drops the delegate (every later frame is dropped) and this object's own native references. */
  public synchronized void dispose() {
    delegate = null;
    if (nativeEncryptor != 0) {
      JniCommon.nativeReleaseRef(nativeEncryptor);
      nativeEncryptor = 0;
    }
    if (nativeDecryptor != 0) {
      JniCommon.nativeReleaseRef(nativeDecryptor);
      nativeDecryptor = 0;
    }
  }

  @CalledByNative
  @Nullable
  byte[] seal(boolean video, byte[] frame) {
    Delegate d = delegate;
    if (d == null) {
      return null;
    }
    try {
      return d.seal(video, frame);
    } catch (Throwable t) {
      return null;
    }
  }

  @CalledByNative
  @Nullable
  byte[] open(boolean video, byte[] sealed) {
    Delegate d = delegate;
    if (d == null) {
      return null;
    }
    try {
      return d.open(video, sealed);
    } catch (Throwable t) {
      return null;
    }
  }

  @NativeMethods
  interface Natives {
    long createEncryptor(FlagshipFrameCrypto crypto);

    long createDecryptor(FlagshipFrameCrypto crypto);
  }
}

/*
 *  Flagship addition to the WebRTC Android SDK (tools/libwebrtc in the Flagship repository).
 */

#include <jni.h>

#include <cstddef>
#include <cstdint>
#include <span>
#include <vector>

#include "api/crypto/frame_decryptor_interface.h"
#include "api/crypto/frame_encryptor_interface.h"
#include "api/make_ref_counted.h"
#include "api/media_types.h"
#include "sdk/android/generated_peerconnection_jni/FlagshipFrameCrypto_jni.h"
#include "sdk/android/native_api/jni/java_types.h"
#include "sdk/android/native_api/jni/scoped_java_ref.h"
#include "sdk/android/src/jni/jni_helpers.h"
#include "third_party/jni_zero/jni_zero.h"

namespace webrtc {
namespace jni {

namespace {

// A video frame is padded to a power-of-two bucket (at least 1 KiB) of its sealed size, so the sealed frame is
// below twice the frame plus its fixed overhead; an audio frame is always 88 bytes.
size_t MaxSealedSize(size_t frame_size) {
  return 2 * (frame_size + 64) + 1024;
}

ScopedJavaLocalRef<jbyteArray> ToJava(JNIEnv* env,
                                      std::span<const uint8_t> bytes) {
  ScopedJavaLocalRef<jbyteArray> array = ScopedJavaLocalRef<jbyteArray>::Adopt(
      env, env->NewByteArray(static_cast<jsize>(bytes.size())));
  env->SetByteArrayRegion(array.obj(), 0, static_cast<jsize>(bytes.size()),
                          reinterpret_cast<const jbyte*>(bytes.data()));
  return array;
}

bool FromJava(JNIEnv* env,
              const ScopedJavaLocalRef<jbyteArray>& array,
              std::span<uint8_t> out,
              size_t* written) {
  if (env->ExceptionCheck()) {
    env->ExceptionClear();
    return false;
  }
  if (array.is_null()) {
    return false;
  }
  jsize length = env->GetArrayLength(array.obj());
  if (length < 0 || static_cast<size_t>(length) > out.size()) {
    return false;
  }
  env->GetByteArrayRegion(array.obj(), 0, length,
                          reinterpret_cast<jbyte*>(out.data()));
  *written = static_cast<size_t>(length);
  return true;
}

class FlagshipFrameEncryptor : public FrameEncryptorInterface {
 public:
  FlagshipFrameEncryptor(JNIEnv* env, const jni_zero::JavaRef<jobject>& crypto)
      : crypto_(env, crypto) {}

  int Encrypt(MediaType media_type,
              uint32_t ssrc,
              std::span<const uint8_t> additional_data,
              std::span<const uint8_t> frame,
              std::span<uint8_t> encrypted_frame,
              size_t* bytes_written) override {
    JNIEnv* env = AttachCurrentThreadIfNeeded();
    ScopedJavaLocalRef<jbyteArray> sealed = Java_FlagshipFrameCrypto_seal(
        env, crypto_, media_type == MediaType::VIDEO, ToJava(env, frame));
    return FromJava(env, sealed, encrypted_frame, bytes_written) ? 0 : 1;
  }

  size_t GetMaxCiphertextByteSize(MediaType media_type,
                                  size_t frame_size) override {
    return MaxSealedSize(frame_size);
  }

 private:
  const ScopedJavaGlobalRef<jobject> crypto_;
};

class FlagshipFrameDecryptor : public FrameDecryptorInterface {
 public:
  FlagshipFrameDecryptor(JNIEnv* env, const jni_zero::JavaRef<jobject>& crypto)
      : crypto_(env, crypto) {}

  Result Decrypt(MediaType media_type,
                 const std::vector<uint32_t>& csrcs,
                 std::span<const uint8_t> additional_data,
                 std::span<const uint8_t> encrypted_frame,
                 std::span<uint8_t> frame) override {
    JNIEnv* env = AttachCurrentThreadIfNeeded();
    ScopedJavaLocalRef<jbyteArray> opened = Java_FlagshipFrameCrypto_open(
        env, crypto_, media_type == MediaType::VIDEO,
        ToJava(env, encrypted_frame));
    size_t written = 0;
    if (!FromJava(env, opened, frame, &written)) {
      return Result(Status::kFailedToDecrypt, 0);
    }
    return Result(Status::kOk, written);
  }

  size_t GetMaxPlaintextByteSize(MediaType media_type,
                                 size_t encrypted_frame_size) override {
    return encrypted_frame_size;
  }

 private:
  const ScopedJavaGlobalRef<jobject> crypto_;
};

}  // namespace

static jlong JNI_FlagshipFrameCrypto_CreateEncryptor(
    JNIEnv* env,
    const jni_zero::JavaRef<jobject>& crypto) {
  return jlongFromPointer(
      make_ref_counted<FlagshipFrameEncryptor>(env, crypto).release());
}

static jlong JNI_FlagshipFrameCrypto_CreateDecryptor(
    JNIEnv* env,
    const jni_zero::JavaRef<jobject>& crypto) {
  return jlongFromPointer(
      make_ref_counted<FlagshipFrameDecryptor>(env, crypto).release());
}

}  // namespace jni
}  // namespace webrtc

DEFINE_JNI(FlagshipFrameCrypto)

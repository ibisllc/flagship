/*
 *  Flagship addition to the WebRTC Objective-C SDK (tools/libwebrtc in the Flagship repository).
 */

#import "RTCFlagshipFrameCrypto.h"

#import "RTCRtpReceiver+Private.h"
#import "RTCRtpSender+Private.h"

#include <cstring>
#include <span>
#include <vector>

#include "api/crypto/frame_decryptor_interface.h"
#include "api/crypto/frame_encryptor_interface.h"
#include "api/make_ref_counted.h"
#include "api/media_types.h"

@interface RTC_OBJC_TYPE (RTCFlagshipFrameCrypto)
()
    @property(atomic, strong, nullable) id<RTC_OBJC_TYPE(RTCFlagshipFrameCryptoDelegate)> delegate;
@end

namespace {

// A video frame is padded to a power-of-two bucket (at least 1 KiB) of its sealed size, so the sealed frame is
// below twice the frame plus its fixed overhead; an audio frame is always 88 bytes.
size_t MaxSealedSize(size_t frame_size) {
  return 2 * (frame_size + 64) + 1024;
}

class FlagshipFrameEncryptor : public webrtc::FrameEncryptorInterface {
 public:
  explicit FlagshipFrameEncryptor(RTC_OBJC_TYPE(RTCFlagshipFrameCrypto) * owner)
      : owner_(owner) {}

  int Encrypt(webrtc::MediaType media_type,
              uint32_t ssrc,
              std::span<const uint8_t> additional_data,
              std::span<const uint8_t> frame,
              std::span<uint8_t> encrypted_frame,
              size_t* bytes_written) override {
    @autoreleasepool {
      id<RTC_OBJC_TYPE(RTCFlagshipFrameCryptoDelegate)> delegate = owner_.delegate;
      if (delegate == nil) {
        return 1;
      }
      NSData* in = [NSData dataWithBytes:frame.data() length:frame.size()];
      NSData* out = [delegate sealFrame:in
                                  video:media_type == webrtc::MediaType::VIDEO];
      if (out == nil || out.length > encrypted_frame.size()) {
        return 1;
      }
      memcpy(encrypted_frame.data(), out.bytes, out.length);
      *bytes_written = out.length;
      return 0;
    }
  }

  size_t GetMaxCiphertextByteSize(webrtc::MediaType media_type,
                                  size_t frame_size) override {
    return MaxSealedSize(frame_size);
  }

 private:
  RTC_OBJC_TYPE(RTCFlagshipFrameCrypto) * owner_;
};

class FlagshipFrameDecryptor : public webrtc::FrameDecryptorInterface {
 public:
  explicit FlagshipFrameDecryptor(RTC_OBJC_TYPE(RTCFlagshipFrameCrypto) * owner)
      : owner_(owner) {}

  Result Decrypt(webrtc::MediaType media_type,
                 const std::vector<uint32_t>& csrcs,
                 std::span<const uint8_t> additional_data,
                 std::span<const uint8_t> encrypted_frame,
                 std::span<uint8_t> frame) override {
    @autoreleasepool {
      id<RTC_OBJC_TYPE(RTCFlagshipFrameCryptoDelegate)> delegate = owner_.delegate;
      if (delegate == nil) {
        return Result(Status::kFailedToDecrypt, 0);
      }
      NSData* in = [NSData dataWithBytes:encrypted_frame.data()
                                  length:encrypted_frame.size()];
      NSData* out = [delegate openFrame:in
                                  video:media_type == webrtc::MediaType::VIDEO];
      if (out == nil || out.length > frame.size()) {
        return Result(Status::kFailedToDecrypt, 0);
      }
      memcpy(frame.data(), out.bytes, out.length);
      return Result(Status::kOk, out.length);
    }
  }

  size_t GetMaxPlaintextByteSize(webrtc::MediaType media_type,
                                 size_t encrypted_frame_size) override {
    return encrypted_frame_size;
  }

 private:
  RTC_OBJC_TYPE(RTCFlagshipFrameCrypto) * owner_;
};

}  // namespace

@implementation RTC_OBJC_TYPE (RTCFlagshipFrameCrypto)

@synthesize delegate = _delegate;

- (instancetype)initWithDelegate:
    (id<RTC_OBJC_TYPE(RTCFlagshipFrameCryptoDelegate)>)delegate {
  self = [super init];
  if (self) {
    _delegate = delegate;
  }
  return self;
}

- (void)attachToSender:(RTC_OBJC_TYPE(RTCRtpSender) *)sender {
  sender.nativeRtpSender->SetFrameEncryptor(
      webrtc::make_ref_counted<FlagshipFrameEncryptor>(self));
}

- (void)attachToReceiver:(RTC_OBJC_TYPE(RTCRtpReceiver) *)receiver {
  receiver.nativeRtpReceiver->SetFrameDecryptor(
      webrtc::make_ref_counted<FlagshipFrameDecryptor>(self));
}

- (void)detach {
  self.delegate = nil;
}

@end

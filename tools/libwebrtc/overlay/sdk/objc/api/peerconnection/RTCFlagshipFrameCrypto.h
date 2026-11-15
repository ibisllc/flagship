/*
 *  Flagship addition to the WebRTC Objective-C SDK (tools/libwebrtc in the Flagship repository).
 *  Upstream exposes FrameEncryptorInterface / FrameDecryptorInterface only in C++; this pairs them with an
 *  Objective-C delegate, so app code seals and opens every encoded frame (docs/voici-calls.md §3).
 */

#import <Foundation/Foundation.h>

#import "sdk/objc/base/RTCMacros.h"

@class RTC_OBJC_TYPE(RTCRtpSender);
@class RTC_OBJC_TYPE(RTCRtpReceiver);

NS_ASSUME_NONNULL_BEGIN

/** Called on WebRTC's encoder and decoder threads. Nil drops the frame; it is never sent or decoded. */
RTC_OBJC_EXPORT
@protocol RTC_OBJC_TYPE (RTCFlagshipFrameCryptoDelegate)<NSObject>

- (nullable NSData *)sealFrame:(NSData *)frame video:(BOOL)video;
- (nullable NSData *)openFrame:(NSData *)frame video:(BOOL)video;

@end

RTC_OBJC_EXPORT
@interface RTC_OBJC_TYPE (RTCFlagshipFrameCrypto) : NSObject

- (instancetype)init NS_UNAVAILABLE;
- (instancetype)initWithDelegate:
    (id<RTC_OBJC_TYPE(RTCFlagshipFrameCryptoDelegate)>)delegate
    NS_DESIGNATED_INITIALIZER;

/** Every frame this sender sends goes through -sealFrame:video:. */
- (void)attachToSender:(RTC_OBJC_TYPE(RTCRtpSender) *)sender;
/** Every frame this receiver gets goes through -openFrame:video: before the decoder. */
- (void)attachToReceiver:(RTC_OBJC_TYPE(RTCRtpReceiver) *)receiver;
/** Drops the delegate: from now on every frame is dropped. */
- (void)detach;

@end

NS_ASSUME_NONNULL_END

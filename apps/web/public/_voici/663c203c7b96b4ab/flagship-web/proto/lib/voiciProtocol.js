// voi.ci pages and Messages for the webapp: the one module the rest of the webapp imports
// (docs/voici-and-messages.md, release 0.3 H11). Browser port of the TypeScript reference in packages/protocol/src
// (webEnvelope.ts, webDelegation.ts, messagesAttestation.ts, voiciText.ts, voiciPseudonymName.ts, voiciPage.ts,
// voiciMessages.ts, the hybrid seal of pqHybrid.ts and the phoneWebCheck section of phoneRoute.ts), with the same
// names, reproducing the shared vectors (packages/protocol/test-vectors/voici/ and messages/) byte for byte; replayed
// by apps/web/tests/voiciProtocol.test.ts. Pure functions, synchronous, Uint8Array in and out, hex lowercase. Crypto
// comes from vendor/noble-post-quantum/pq-seal.js (scripts/build-webapp-pq-vendor.mjs).
//
// Not here on purpose: issuing attestations and anything to do with Flagship's offline abuse key (the webapp checks
// an attestation's tag hash only), and the thread-fetch signature (voi.ci's, made with WebCrypto there).
//
// Exported API (by source file):
//   voiciCore.js     hex, hexToBytes, isLowerHex, sha256Hex, b64Encode, b64Decode, canonicalJson, canonicalJsonBytes,
//                    ed25519PublicKey, ed25519SignHex, ed25519VerifyHex, p256VerifyP1363, p256SignHex,
//                    TAG_WEB_ENVELOPE, WEB_ENVELOPE_MAX_BYTES, WEB_ENVELOPE_MAX_BODY_BYTES, canonicalWebEnvelope,
//                    parseWebEnvelope, signWebEnvelopeEd25519, signWebEnvelopeP256, verifyWebEnvelopeSignature,
//                    PqHybridError, SUITE_HYBRID_SEAL_V1, TAG_HYBRID_SEAL_V1, TAG_ENVELOPE_V2, HYBRID_SEAL_*,
//                    validatePurposeTag, encodeEnvelopeHeader, decodeEnvelopeHeader, decodeEnvelope, pqKeyId,
//                    parseHybridSealPublicKey, hybridSealKeygen, hybridSealKdfInfo, hybridSealWithRandomness,
//                    hybridSeal, hybridOpen
//   voiciText.js     VOICI_TEXT_RULES, checkVoiciText, prepareVoiciText, VOICI_LINK_URL_MAX, checkVoiciLinkUrl,
//                    voiciUrlHost, findVoiciLinks, VOICI_LINK_SITES, voiciLinkSite, voiciPseudonymCode,
//                    voiciPseudonymName
//   voiciPage.js     TAG_VOICI_PAGE, TAG_VOICI_PIECE_UPLOAD, VOICI_* caps, VOICI_THEMES,
//                    isVoiciJpeg, voiciJpegHasMetadata, parseVoiciProfile, parseVoiciProfilePiece, parseVoiciPost,
//                    parseVoiciChunkPiece, voiciCardRole, canonicalVoiciPageIndex, signVoiciPageIndex,
//                    parseVoiciPageIndex, checkVoiciPageIndex, checkVoiciPublish, voiciPieceRefsOk,
//                    canonicalVoiciPieceUpload, signVoiciPieceUpload, verifyVoiciPieceUpload, chunkVoiciPosts,
//                    mergeVoiciPage
//   voiciMessages.js the TAG_* constants, deriveVoiciInboxKey, deriveVoiciOwnerSignKey, deriveMessagesSecret,
//                    deriveMessagesPseudonymKey, deriveMessagesThreadKey, deriveVoiciDraftsKey,
//                    deriveMessagesStateKey, voiciConv, sealVoiciBody, parseVoiciSealedBody, openVoiciBody,
//                    canonical/sign/parseVoiciThreadStatement, canonical/sign/parse/checkWebDelegation,
//                    canonical/sign/verify/parseWebDelegationRevoke, canonical/sign/verifyMessagesKeyAttestationRequest,
//                    canonicalMessagesKeyAttestation, parseMessagesKeyAttestation, messagesAttestationHash,
//                    checkMessagesKeyAttestation, checkVoiciMessage, checkVoiciReply, checkVoiciDraft,
//                    canonical/sign/verifyVoiciAck, canonical/sign/verify/parseVoiciBlock, parseVoiciDraftOp,
//                    sealVoiciDraft, parseVoiciDraftBody, openVoiciDraft, emptyMessagesState, parseMessagesState,
//                    mergeMessagesState, sealMessagesState, openMessagesState, VOICI_REPORT_REASONS,
//                    canonicalVoiciReport, signVoiciMessageReport, verifyVoiciMessageReport,
//                    verifyVoiciPageReportSignature, parseVoiciSignInRequest, checkVoiciSignInAnswer,
//                    PHONE_WEB_ORIGINS(_GYM), PHONE_* constants, phoneWebCheck, parsePhoneLiveAnswer

export * from "./voiciCore.js";
export * from "./voiciText.js";
export * from "./voiciPage.js";
export * from "./voiciMessages.js";

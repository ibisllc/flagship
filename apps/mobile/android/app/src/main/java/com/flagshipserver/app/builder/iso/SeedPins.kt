package com.flagshipserver.app.builder.iso

/**
 * The USB boot seeds this app trusts, by SHA-256 (docs/iso-seed-and-on-device-burn.md): the seed's
 * stub preseed runs as root in the installer before any recipe check, so the app does not take
 * `.com`'s word for which image to write. iso-seed.yml's SEED_SHA256 is the reference build; a test
 * (scripts/iso-seed-pins.test.ts) keeps this list equal to it.
 */
object SeedPins {
    val SHA256: Set<String> = setOf("54be17b43ddafa10e2112b2e5966835f12aaff39a50d21415f942e06a7ae7f19")
}

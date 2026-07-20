// The now-available GENERATION + VOLUME half of the on-device recipe injection
// (OTG-BUILDER-NOTES.md §3(b)/§5): chain the canonical preseed generator
// ([PreseedEngine], Rhino) → the FLAGSHIP FAT volume builder ([FatVolume]) to
// produce the FAT image that a pre-remastered Debian base reads at boot.
//
// This is the security-correct path (the preseed text comes from the SINGLE
// shared generator, byte-identical to Node + JSC — never a Kotlin
// re-implementation of the signed bootstrap), and it is fully unit-testable.
//
// What it does NOT do — and why VerbatimInjector stays the default in the burn
// flow (BuilderOnDeviceViewModel / IsoInjector): the USB *placement* of this FAT
// volume next to the base image still needs (a) an owner build-pipeline
// pre-remastered base ISO whose bootloader cmdline references the FLAGSHIP
// preseed label, and (b) a physical OTG drive to validate the boot. Both are
// out of scope here (OTG-BUILDER-NOTES.md §5 items 1 + 3). Until they land, this
// is the generation half — proven by tests — gated on the base-ISO contract.

package com.flagshipserver.app.builder.iso

object PreseedFatInjector {
    /**
     * Build the FLAGSHIP FAT volume bytes carrying the per-burn `preseed.cfg`
     * generated from [recipeJson] (a phone-signed recipe; the signature is
     * already verified natively) + [burnOptsJson]
     * (`{encryptRoot?,wifiSSID?,wifiPassword?,…}`, default `"{}"`).
     */
    fun buildPreseedVolume(
        engine: PreseedEngine,
        recipeJson: String,
        burnOptsJson: String = "{}",
    ): ByteArray {
        val preseed = engine.buildPreseedFromRecipe(recipeJson, burnOptsJson)
        return FatVolume.buildPreseedVolume(preseed)
    }
}

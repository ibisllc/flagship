// The real replacement for VerbatimInjector: the seed-and-append burn
// (docs/iso-seed-and-on-device-burn.md, "option 4" — QEMU-validated). The stick
// gets the pre-baked SEED ISO written verbatim from LBA 0 (isohybrid MBR/GPT
// ride along, INCLUDING an empty, GPT-registered FLAGSHIP FAT16 partition the
// seed build pre-declared). Then — via the InjectedImage.placement hook the
// caller runs on the same USB handle — that already-registered region is
// OVERWRITTEN with a FLAGSHIP-labeled FAT16 volume carrying the per-recipe
// preseed.cfg. NO partition-table surgery: no MBR splice, no GPT CRC recompute.
// No ISO remaster on-device.
//
// The preseed TEXT is NOT generated here. It comes from [PreseedSource], which
// MUST resolve to the single shared generator (packages/flagship-burner
// buildDebianPreseed, run via PreseedEngine/Rhino) — never a Kotlin
// re-implementation of the signed bootstrap path — and the recipe's phone
// signature MUST already be verified before we lay the preseed down (the trust
// model: docs/iso-seed-and-on-device-burn.md §"Trust model").

package com.flagshipserver.app.burner.iso

import java.io.File
import java.io.RandomAccessFile

/**
 * Supplies the per-recipe `preseed.cfg` for the on-device burn. Implementations
 * MUST return the output of the shared generator for the (already
 * signature-verified) recipe; see [AssetPreseedSource] for the production wiring
 * that runs the canonical bundle from app assets.
 *
 * This is a deliberate seam: the security-critical bytes stay owned by the shared
 * generator, and a null/failing source fails the burn loudly rather than writing
 * an un-provisioning stick.
 */
fun interface PreseedSource {
    /** The full shared-generator `preseed.cfg` for [recipe] / [recipeJson]. */
    fun preseedFor(recipe: ParsedRecipe, recipeJson: String): String
}

class SeedInjector(
    private val preseedSource: PreseedSource,
    private val log: (String) -> Unit = {},
) : IsoInjector {

    override fun inject(baseIso: File, recipe: ParsedRecipe, recipeJson: String): InjectedImage {
        // Fail LOUDLY if the preseed can't be produced — never fall through to a
        // verbatim (non-provisioning) write.
        val preseed = try {
            preseedSource.preseedFor(recipe, recipeJson)
        } catch (t: Throwable) {
            throw IllegalStateException(
                "couldn't generate the preseed for ${recipe.serverDomain}: ${t.message}", t,
            )
        }
        if (preseed.isBlank()) {
            throw IllegalStateException("the preseed generator returned no text for ${recipe.serverDomain}")
        }
        // TODO(docs/iso-seed-and-on-device-burn.md §"Trust model"): before laying
        //  it down, verify the preseed embeds THIS recipe's phone signature
        //  (recipe.blobSignatureHex) so a hostile PreseedSource can't swap in a
        //  different box's signed InstallBlob. Today the preseed is generated
        //  in-process from the exact recipeJson we hold (verified natively
        //  upstream), so the embedding holds by construction; the explicit check
        //  is the belt-and-braces to add when PreseedSource can be remote.

        val fatVolume = FatVolume.buildPreseedVolume(preseed)
        val seedBytes = baseIso.length()
        log(
            "SeedInjector: seed ${seedBytes} B verbatim + ${fatVolume.size} B FLAGSHIP volume " +
                "for ${recipe.serverDomain} (serial=${recipe.serial}).",
        )

        val stream = baseIso.inputStream().buffered(1 shl 20)
        val placement = SeedPlacement { writer, capacity ->
            // Locate the pre-declared FLAGSHIP region by reading the GPT off the
            // seed bytes (byte-identical to the just-written stick).
            val region = RandomAccessFile(baseIso, "r").use { raf ->
                GptReader.findFlagshipRegion(
                    { offset, length ->
                        val buf = ByteArray(length)
                        raf.seek(offset)
                        raf.readFully(buf)
                        buf
                    },
                    deviceBlockSize = capacity.blockSize,
                )
            }
            if (fatVolume.size.toLong() > region.sizeBytes) {
                throw IllegalStateException(
                    "FLAGSHIP volume (${fatVolume.size} B) is larger than the pre-declared region (${region.sizeBytes} B)",
                )
            }
            require(region.sizeBytes <= Int.MAX_VALUE) { "FLAGSHIP region too large to buffer (${region.sizeBytes} B)" }
            // GPT offsets are 512-byte LBA units; convert to device blocks. The
            // seed build MiB-aligns the region, so this divides cleanly (guarded
            // by GptReader too).
            val startLba = region.offsetBytes / capacity.blockSize
            // Zero-pad the FAT volume to the full region so the leftover of the
            // seed's empty partition is deterministically blank.
            val fullRegion = ByteArray(region.sizeBytes.toInt())
            fatVolume.copyInto(fullRegion)
            writer.writeSectors(fullRegion, startLba, capacity.blockSize)
            log(
                "SeedInjector: overwrote FLAGSHIP region at byte ${region.offsetBytes} " +
                    "(LBA $startLba, ${region.sizeBytes} B) with the preseed FAT volume.",
            )
        }

        return InjectedImage(
            stream = stream,
            totalBytes = seedBytes,
            recipeEmbedded = true,
            closeable = AutoCloseable { stream.close() },
            placement = placement,
        )
    }
}

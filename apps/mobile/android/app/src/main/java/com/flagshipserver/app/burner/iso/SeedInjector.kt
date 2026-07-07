// The real replacement for VerbatimInjector: the seed-and-append burn
// (docs/iso-seed-and-on-device-burn.md). The stick gets the pre-baked SEED ISO
// written verbatim from LBA 0 (isohybrid MBR/GPT ride along), then — via the
// InjectedImage.placement hook the caller runs on the same USB handle — a
// FLAGSHIP-labeled FAT16 volume carrying the per-recipe preseed.cfg is laid down
// in free space past the ISO image and one MBR partition entry is spliced in.
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
            val place = PartitionTable.placeFatVolume(
                seedImageBytes = seedBytes,
                fatVolumeBytes = fatVolume.size,
                blockSize = capacity.blockSize,
                lastLba = capacity.lastLba,
            )
            // 1. Lay the FAT volume in free space past the ISO image.
            writer.writeSectors(fatVolume, place.startLba, capacity.blockSize)
            // 2. Read LBA 0, splice the FLAGSHIP entry into slot 3, write it back.
            //    Read a whole block (>= 512) so bytes past the MBR are preserved.
            val block = writer.readSectors(startLba = 0, count = 1, blockSize = capacity.blockSize)
            val mbr = block.copyOfRange(0, PartitionTable.MBR_SIZE)
            val entry = PartitionTable.partitionEntry(place, PartitionTable.TYPE_FAT16_LBA)
            PartitionTable.spliceEntry(mbr, slotIndex = 3, entry = entry).copyInto(block, 0)
            writer.writeSectors(block, startLba = 0, blockSize = capacity.blockSize)
            log("SeedInjector: placed FLAGSHIP at LBA ${place.startLba} (${place.sectorCount} blocks) + patched MBR.")
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

// The "remaster" seam: turn the base ISO + the phone-signed recipe into the
// image that actually gets written to the USB stick.
//
// On the desktop this is the xorriso step that bakes preseed.cfg into the ISO
// and patches the bootloader cmdline. On Android there is no xorriso and no
// feasible pure-Kotlin ISO9660 rewriter in one pass (see OTG-BURNER-NOTES.md
// §3). This interface is the seam where the real recipe-embedding will land.
//
// The default [VerbatimInjector] streams the base image through UNCHANGED so the
// download → verify → USB-write pipeline is fully real + testable end to end.
// It does NOT yet embed the recipe — a stick burned with it boots STOCK Debian,
// not an auto-provisioned Flagship box. Turning the seam on is a bounded
// follow-up (OTG-BURNER-NOTES.md §5).

package com.flagshipserver.app.burner.iso

import com.flagshipserver.app.burner.usb.MassStorageWriter
import com.flagshipserver.app.burner.usb.ScsiCommands
import java.io.File
import java.io.InputStream

/**
 * Post-write step for the seed-and-append model: after [InjectedImage.stream] is
 * written verbatim from LBA 0, OVERWRITE the seed's pre-declared, GPT-registered
 * FLAGSHIP region with the per-recipe FAT volume (docs/iso-seed-and-on-device-
 * burn.md, "option 4"). No MBR/GPT edits — the region is already in the GPT. The
 * verbatim path leaves this null. Runs on the same open USB handle the caller
 * already holds.
 */
fun interface SeedPlacement {
    fun place(writer: MassStorageWriter, capacity: ScsiCommands.Capacity)
}

/** The image to write + how big it is, ready for the raw USB write. */
data class InjectedImage(
    val stream: InputStream,
    val totalBytes: Long,
    /** True once the recipe is actually embedded (the burned stick auto-provisions). */
    val recipeEmbedded: Boolean,
    /** Closed by the caller after the write completes. */
    val closeable: AutoCloseable,
    /**
     * Optional post-write step run AFTER the verbatim stream is written — the
     * seam that lets the single-stream contract also express "stream, then append
     * the FAT volume + patch the MBR". Null for a pure verbatim write.
     */
    val placement: SeedPlacement? = null,
)

interface IsoInjector {
    /**
     * Produce the writable image from [baseIso] + [recipe]. The returned stream
     * is the caller's to consume + close.
     */
    fun inject(baseIso: File, recipe: ParsedRecipe, recipeJson: String): InjectedImage
}

/**
 * Pass-through injector: writes the base ISO verbatim. The recipe is parsed +
 * validated (so the seam is wired and the UI can show what's being burned) but
 * NOT embedded into the image yet. See OTG-BURNER-NOTES.md §3/§5.
 */
class VerbatimInjector(
    private val log: (String) -> Unit = {},
) : IsoInjector {
    override fun inject(baseIso: File, recipe: ParsedRecipe, recipeJson: String): InjectedImage {
        // TODO(otg-burner): embed the recipe as preseed.cfg per OTG-BURNER-NOTES.md
        //  §3(b). The FAT-volume primitive is DONE + tested —
        //  `FatVolume.buildPreseedVolume(text)` lays an already-generated preseed.cfg
        //  onto a FLAGSHIP-labeled FAT16 volume. What remains (owner/infra/hardware,
        //  not pure code here):
        //   1. a server-served pre-remastered base whose bootloader cmdline already
        //      references the FLAGSHIP preseed label (the build-pipeline artifact);
        //   2. the preseed TEXT for Android — it MUST come from the shared generator
        //      (packages/flagship-burner buildDebianPreseed), e.g. via a small server
        //      endpoint, NOT a Kotlin re-implementation of the signed bootstrap path;
        //   3. placing the FAT volume next to the base image (appended partition /
        //      pre-allocated region per the base-ISO contract) + a physical OTG drive
        //      to validate the boot. Until all three land this stays verbatim.
        log(
            "VerbatimInjector: writing base ISO UNCHANGED for ${recipe.serverDomain} " +
                "(serial=${recipe.serial}). Recipe is NOT yet embedded — the stick will boot " +
                "stock Debian, not an auto-provisioned box. See OTG-BURNER-NOTES.md.",
        )
        val stream = baseIso.inputStream().buffered(1 shl 20)
        return InjectedImage(
            stream = stream,
            totalBytes = baseIso.length(),
            recipeEmbedded = false,
            closeable = AutoCloseable { stream.close() },
        )
    }
}

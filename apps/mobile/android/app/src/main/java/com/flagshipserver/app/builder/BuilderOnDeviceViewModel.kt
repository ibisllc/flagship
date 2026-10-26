// Orchestrates the on-device USB-OTG burn: detect drive → permission →
// download+verify base ISO → inject recipe (seam) → raw-write over USB MSC.
//
// All hardware touchpoints go through UsbHost / MassStorageWriter (both behind
// testable seams); this VM is the state machine the Compose screen renders.

package com.flagshipserver.app.builder

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import android.app.Application
import android.hardware.usb.UsbManager
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.flagshipserver.app.builder.iso.IsoBaseCache
import com.flagshipserver.app.builder.iso.IsoInjector
import com.flagshipserver.app.builder.iso.IsoManifestClient
import com.flagshipserver.app.builder.iso.OkHttpBuilderHttp
import com.flagshipserver.app.builder.iso.ParsedRecipe
import com.flagshipserver.app.builder.iso.PreseedEngine
import com.flagshipserver.app.builder.iso.PreseedSource
import com.flagshipserver.app.builder.iso.RecipeParse
import com.flagshipserver.app.builder.iso.SeedInjector
import com.flagshipserver.app.builder.iso.SeedSource
import com.flagshipserver.app.builder.usb.MassStorageWriter
import com.flagshipserver.app.builder.usb.UsbHost
import com.flagshipserver.app.builder.usb.UsbMassStorageDevice
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

class BuilderOnDeviceViewModel(
    app: Application,
    private val recipeJson: String,
    private val injector: IsoInjector = SeedInjector(AssetPreseedSource(app)),
) : AndroidViewModel(app) {

    enum class Phase { Idle, NoUsb, NeedPermission, Ready, Downloading, Verifying, Injecting, Writing, Finalizing, Done, Error }

    data class State(
        val phase: Phase = Phase.Idle,
        /** 0..1 within the active long phase (download / write). */
        val progress: Double = 0.0,
        val statusLine: String = "",
        val devices: List<UsbMassStorageDevice> = emptyList(),
        val selected: UsbMassStorageDevice? = null,
        val recipe: ParsedRecipe? = null,
        val recipeEmbedded: Boolean = false,
        val error: String? = null,
        val bytesWritten: Long = 0,
        /** Dev-only: a locally-picked seed replacing the manifest download; null = managed. */
        val localSeedLabel: String? = null,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    private val usb: UsbManager = UsbHost.manager(app)

    /** Debuggable build ⇒ dev affordances (local seed) are permitted. */
    val devUnlocked: Boolean =
        (app.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0

    private var localSeedUri: String? = null

    /**
     * Dev-only: burn from a locally-supplied seed (a `content://` URI or a file
     * path) instead of the manifest download, so a hardware tester can `adb push`
     * a seed and burn with no hosting. Ignored on a non-debuggable build.
     */
    fun setLocalSeed(uri: String?, label: String?) {
        if (!devUnlocked) return
        localSeedUri = uri
        _state.value = _state.value.copy(localSeedLabel = if (uri.isNullOrBlank()) null else (label ?: uri))
    }

    init {
        // Parse the recipe up front so the UI can show what it's about to burn,
        // and a malformed recipe fails fast.
        val parsed = runCatching { RecipeParse.parse(recipeJson) }
        if (parsed.isFailure) {
            _state.value = _state.value.copy(
                phase = Phase.Error,
                error = FSStrings.get(R.string.couldnt_read_the_recipe, parsed.exceptionOrNull()?.message),
            )
        } else {
            val r = parsed.getOrThrow()
            _state.value = _state.value.copy(recipe = r)
            if (r.expired) {
                _state.value = _state.value.copy(
                    phase = Phase.Error,
                    error = FSStrings.get(R.string.this_recipe_has_expired_create_the),
                )
            } else {
                refreshDevices()
            }
        }
    }

    /** Re-scan attached USB mass-storage devices. */
    fun refreshDevices() {
        if (_state.value.phase == Phase.Error) return
        val devices = UsbHost.enumerate(usb)
        val selected = _state.value.selected?.let { prev ->
            devices.firstOrNull { it.device.deviceId == prev.device.deviceId }
        } ?: devices.firstOrNull()
        val phase = when {
            devices.isEmpty() -> Phase.NoUsb
            selected != null && !UsbHost.hasPermission(usb, selected.device) -> Phase.NeedPermission
            else -> Phase.Ready
        }
        _state.value = _state.value.copy(devices = devices, selected = selected, phase = phase, error = null)
    }

    fun select(device: UsbMassStorageDevice) {
        val phase = if (UsbHost.hasPermission(usb, device.device)) Phase.Ready else Phase.NeedPermission
        _state.value = _state.value.copy(selected = device, phase = phase)
    }

    /** Call after the system permission dialog resolves. */
    fun onPermissionResult() = refreshDevices()

    /**
     * Run the whole burn for the currently-selected device. Idempotent guard:
     * ignores re-entry while a long phase is running.
     */
    fun startBurn() {
        val s = _state.value
        val target = s.selected ?: return
        val recipe = s.recipe ?: return
        if (s.phase in setOf(Phase.Downloading, Phase.Verifying, Phase.Injecting, Phase.Writing, Phase.Finalizing)) return
        if (!UsbHost.hasPermission(usb, target.device)) {
            _state.value = s.copy(phase = Phase.NeedPermission)
            return
        }

        viewModelScope.launch {
            try {
                // 1. Obtain the seed ISO: a dev-only local file, or the
                //    manifest-driven, sha-pinned download (production default).
                set(Phase.Downloading, status = FSStrings.get(R.string.preparing_the_operating_system_image))
                val baseIso = when (val source = SeedSource.resolve(localSeedUri, devUnlocked)) {
                    is SeedSource.LocalFile -> withContext(Dispatchers.IO) { copyLocalSeed(source.uri) }
                    SeedSource.Managed -> {
                        val cache = IsoBaseCache(
                            client = IsoManifestClient(OkHttpBuilderHttp()),
                            http = OkHttpBuilderHttp(),
                            cacheDir = File(getApplication<Application>().cacheDir, "flagship-builder"),
                            builderVersion = builderVersion(),
                            pinnedSha256 = com.flagshipserver.app.builder.iso.SeedPins.SHA256,
                        )
                        withContext(Dispatchers.IO) {
                            cache.ensure { phase ->
                                when (phase) {
                                    is IsoBaseCache.Phase.Inspected ->
                                        set(Phase.Downloading, status = FSStrings.get(R.string.checking_cached_image))
                                    is IsoBaseCache.Phase.Downloading ->
                                        set(Phase.Downloading, progress = phase.progress, status = FSStrings.get(R.string.downloading_the_operating_system))
                                    is IsoBaseCache.Phase.Ready ->
                                        set(Phase.Verifying, progress = 1.0, status = if (phase.fromCache) FSStrings.get(R.string.using_verified_cached_image) else FSStrings.get(R.string.image_verified))
                                }
                            }
                        }
                    }
                }

                // 2. Inject the recipe (seam — verbatim for now).
                set(Phase.Injecting, status = FSStrings.get(R.string.preparing_the_install_image))
                val injected = withContext(Dispatchers.IO) { injector.inject(baseIso, recipe, recipeJson) }
                _state.value = _state.value.copy(recipeEmbedded = injected.recipeEmbedded)

                // 3. Raw-write over USB Mass Storage.
                val open = withContext(Dispatchers.IO) { UsbHost.open(usb, target) }
                    ?: throw RuntimeException(FSStrings.get(R.string.couldnt_open_the_usb_drive_reconnect))
                try {
                    val written = withContext(Dispatchers.IO) {
                        val writer = MassStorageWriter(open.transport)
                        val cap = writer.readCapacity()
                        if (injected.totalBytes > cap.totalBytes) {
                            throw RuntimeException(
                                "The drive (${human(cap.totalBytes)}) is too small for the image (${human(injected.totalBytes)}).",
                            )
                        }
                        set(Phase.Writing, status = FSStrings.get(R.string.writing_to_the_usb_drive_do))
                        val n = injected.stream.use { stream ->
                            writer.writeImage(stream, injected.totalBytes, cap.blockSize) { w ->
                                val frac = if (injected.totalBytes > 0) w.toDouble() / injected.totalBytes else 0.0
                                set(Phase.Writing, progress = frac, status = FSStrings.get(R.string.writing_to_the_usb_drive_do), bytes = w)
                            }
                        }
                        // Seed-and-append: overwrite the seed's pre-declared FLAGSHIP region.
                        injected.placement?.let { placement ->
                            set(Phase.Finalizing, status = FSStrings.get(R.string.finalizing_the_install_image_do_not))
                            placement.place(writer, cap)
                        }
                        n
                    }
                    injected.closeable.close()
                    val note = if (injected.recipeEmbedded) {
                        FSStrings.get(R.string.done_unplug_the_drive_put_it)
                    } else {
                        FSStrings.get(R.string.wrote_the_base_image_note_the, human(written))
                    }
                    _state.value = _state.value.copy(phase = Phase.Done, progress = 1.0, statusLine = note, bytesWritten = written)
                } finally {
                    open.close()
                }
            } catch (e: Throwable) {
                _state.value = _state.value.copy(phase = Phase.Error, error = e.message ?: e.toString())
            }
        }
    }

    private fun set(phase: Phase, progress: Double? = null, status: String? = null, bytes: Long? = null) {
        val cur = _state.value
        _state.value = cur.copy(
            phase = phase,
            progress = progress ?: cur.progress,
            statusLine = status ?: cur.statusLine,
            bytesWritten = bytes ?: cur.bytesWritten,
        )
    }

    /**
     * Copy a dev-supplied seed ([uri]: a `content://` URI or a file path) into a
     * private cache file the injector + writer can stream + memory-map. Reports
     * progress on the Downloading/Verifying phases like the managed path.
     */
    private fun copyLocalSeed(uri: String): File {
        set(Phase.Downloading, status = FSStrings.get(R.string.reading_the_local_seed_image))
        val app = getApplication<Application>()
        val dir = File(app.cacheDir, "flagship-builder").apply { mkdirs() }
        val out = File(dir, "local-seed.iso")
        val input = if (uri.startsWith("content://")) {
            app.contentResolver.openInputStream(android.net.Uri.parse(uri))
                ?: throw RuntimeException(FSStrings.get(R.string.couldnt_open_the_local_seed_at, uri))
        } else {
            File(uri.removePrefix("file://")).inputStream()
        }
        input.use { ins -> out.outputStream().use { os -> ins.copyTo(os, 1 shl 20) } }
        if (out.length() == 0L) throw RuntimeException(FSStrings.get(R.string.the_local_seed_at_is_empty, uri))
        set(Phase.Verifying, progress = 1.0, status = FSStrings.get(R.string.using_local_seed_image, human(out.length())))
        return out
    }

    private fun builderVersion(): String =
        runCatching {
            val pm = getApplication<Application>().packageManager
            val pkg = getApplication<Application>().packageName
            @Suppress("DEPRECATION")
            pm.getPackageInfo(pkg, 0).versionName ?: "dev"
        }.getOrDefault("dev")

    companion object {
        fun human(bytes: Long): String {
            if (bytes < 1024) return "$bytes B"
            val units = arrayOf("KB", "MB", "GB", "TB")
            var v = bytes.toDouble() / 1024
            var i = 0
            while (v >= 1024 && i < units.size - 1) { v /= 1024; i++ }
            return String.format("%.1f %s", v, units[i])
        }
    }
}

/**
 * Production [PreseedSource]: runs the SINGLE shared generator (the canonical
 * bundle in app assets, via Rhino) for the already-signature-verified recipe.
 * The engine is loaded lazily on first burn so an asset problem surfaces as a
 * loud burn-time failure, never a silent verbatim write.
 */
class AssetPreseedSource(
    context: android.content.Context,
    private val burnOptsJson: String = "{}",
) : PreseedSource {
    private val appContext = context.applicationContext
    private val engine by lazy { PreseedEngine.fromAssets(appContext) }

    override fun preseedFor(recipe: ParsedRecipe, recipeJson: String): String =
        engine.buildPreseedFromRecipe(recipeJson, burnOptsJson)
}

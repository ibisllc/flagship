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
import com.flagshipserver.app.builder.iso.RecipeParse
import com.flagshipserver.app.builder.iso.VerbatimInjector
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
    private val injector: IsoInjector = VerbatimInjector(),
) : AndroidViewModel(app) {

    enum class Phase { Idle, NoUsb, NeedPermission, Ready, Downloading, Verifying, Injecting, Writing, Done, Error }

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
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    private val usb: UsbManager = UsbHost.manager(app)

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
        if (s.phase in setOf(Phase.Downloading, Phase.Verifying, Phase.Injecting, Phase.Writing)) return
        if (!UsbHost.hasPermission(usb, target.device)) {
            _state.value = s.copy(phase = Phase.NeedPermission)
            return
        }

        viewModelScope.launch {
            try {
                // 1. Download + verify the base ISO (manifest-driven).
                val cache = IsoBaseCache(
                    client = IsoManifestClient(OkHttpBuilderHttp()),
                    http = OkHttpBuilderHttp(),
                    cacheDir = File(getApplication<Application>().cacheDir, "flagship-builder"),
                    builderVersion = builderVersion(),
                )
                set(Phase.Downloading, status = FSStrings.get(R.string.preparing_the_operating_system_image))
                val baseIso = withContext(Dispatchers.IO) {
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
                        injected.stream.use { stream ->
                            writer.writeImage(stream, injected.totalBytes, cap.blockSize) { w ->
                                val frac = if (injected.totalBytes > 0) w.toDouble() / injected.totalBytes else 0.0
                                set(Phase.Writing, progress = frac, status = FSStrings.get(R.string.writing_to_the_usb_drive_do), bytes = w)
                            }
                        }
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

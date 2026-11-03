// The USB/ISO installer stops before erasing anything when it can't tell which disk to install on
// (B2 #9, packages/flagship-builder/src/preseed.ts resolveTargetDisk) and posts one of four English
// sentences as the `error` detail on the install timeline. This turns them into the app's own words
// plus the way out: make the installer again naming the disk. Shared cases:
// test-vectors/install-disk-stop.json (iOS ProvisionProgress / InstallDiskStop is the reference).

package com.flagshipserver.app.core

import com.flagshipserver.app.R

sealed class InstallDiskStop {
    abstract val kind: String
    protected abstract fun headline(): String

    data class Several(val count: String, val sizes: String) : InstallDiskStop() {
        override val kind get() = "several"
        override fun headline() = FSStrings.get(R.string.install_disk_stop_several, count, sizes)
    }

    data object NoDisk : InstallDiskStop() {
        override val kind get() = "none"
        override fun headline() = FSStrings.get(R.string.install_disk_stop_none)
    }

    data class Missing(val pin: String) : InstallDiskStop() {
        override val kind get() = "missing"
        override fun headline() = FSStrings.get(R.string.install_disk_stop_missing, pin)
    }

    data class Ambiguous(val pin: String) : InstallDiskStop() {
        override val kind get() = "ambiguous"
        override fun headline() = FSStrings.get(R.string.install_disk_stop_ambiguous, pin)
    }

    /** The sentence and the re-burn advice, as the timeline shows them. */
    fun text(): String = headline() + " " + advice

    companion object {
        private val SEVERAL = Regex("""^This machine has (\d+) disks that could be erased \((.*)\)\. Nothing was erased\.""")
        private val NONE = Regex("""^This machine has no fixed disk of 8 GB or more to install on\. Nothing was erased\.""")
        private val MISSING = Regex("""^The disk this installer was made for \((.+)\) is not in this machine\. Nothing was erased\.""")
        private val AMBIGUOUS = Regex("""^The disk this installer was made for \((.+)\) matches more than one disk\. Nothing was erased\.""")

        val advice: String get() = FSStrings.get(R.string.install_disk_stop_advice)

        /** The installer's stop, from the raw timeline detail; null for any other failure. */
        fun parse(detail: String?): InstallDiskStop? {
            val t = detail?.trim().orEmpty()
            if (t.isEmpty()) return null
            SEVERAL.find(t)?.let { return Several(it.groupValues[1], it.groupValues[2]) }
            if (NONE.containsMatchIn(t)) return NoDisk
            MISSING.find(t)?.let { return Missing(it.groupValues[1]) }
            AMBIGUOUS.find(t)?.let { return Ambiguous(it.groupValues[1]) }
            return null
        }

        /** Whether a shown failure text is a disk stop (re-burning resumes the same order). */
        fun isStopText(step: String?): Boolean = step != null && step.endsWith(advice)

        /**
         * The setup-stopped card's text: [intro], the step, then [cancelOrContact], except after a disk
         * stop, whose advice (make the installer again) is the way on and needs no new order.
         */
        fun setupStoppedExplanation(intro: String, step: String?, cancelOrContact: String): String {
            fun sentence(s: String) = if (s.endsWith(".")) s else "$s."
            val parts = mutableListOf(sentence(intro))
            step?.trim()?.takeIf { it.isNotEmpty() }?.let { parts += sentence(it) }
            if (!isStopText(step?.trim())) parts += cancelOrContact
            return parts.joinToString(" ")
        }
    }
}

package com.flagshipserver.app.ui.screens

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.R

/**
 * What About shows for the build: the one product version every Flagship
 * surface shares (release/version.json), then the store's version code, e.g.
 * "Flagship 0.2 Beta (build 9)".
 */
internal fun productAboutLine(versionName: String, label: String, versionCode: Int): String =
    FSStrings.get(R.string.flagship_build, versionName, label, versionCode)

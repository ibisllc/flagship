// Flagship for Wear OS: the twin of the Apple Watch app. Server status, boxes
// waiting for a boot approval (Approve asks the phone, which signs), recent
// security events, a tile and a complication. Same applicationId and signing
// key as the phone app, which the Wearable Data Layer requires.
//
// minSdk 33 = Wear OS 4 (Android 13), the same floor as the phone app
// (AGENTS.md's minimum-OS rule: Wear OS 3 watches that can't take Wear OS 4
// are out of security support). Re-check on each toolchain update.

import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// One product version for every Flagship surface lives in release/version.json
// (scripts/check-versions.mjs fails on drift). The store's versionCode only
// ever climbs; versionName is the product version, About adds the label.
val releaseVersion = (groovy.json.JsonSlurper().parse(rootProject.file("../../../release/version.json")) as Map<*, *>)

val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore/keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "com.flagshipserver.wear"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.flagshipserver.app"
        minSdk = 33
        targetSdk = 36
        // Play needs every APK/bundle of one app to have its own version code:
        // the watch build is the phone's plus 1,000,000.
        versionCode = 1_000_000 + (releaseVersion["androidVersionCode"] as Number).toInt()
        versionName = releaseVersion["product"] as String
    }

    // Languages come from i18n/locales.json: English plus every language marked "ga" (see app/build.gradle.kts).
    androidResources {
        localeFilters += run {
            val all = groovy.json.JsonSlurper().parse(rootProject.file("../../../i18n/locales.json")) as Map<*, *>
            (all["locales"] as List<*>).map { it as Map<*, *> }
                .filter { it["code"] == all["source"] || it["status"] == "ga" }
                .map { (it["androidId"] ?: it["code"]) as String }
        }
    }

    signingConfigs {
        if (keystoreProps.containsKey("storeFile")) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    testOptions {
        unitTests.all { test ->
            test.systemProperty("fs.test.strings", file("src/main/res/values/strings.xml").absolutePath)
        }
    }

    buildFeatures { compose = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    // The watch app's screens run under Robolectric (wear/src/test): the
    // phone emulator can't hold the watch build (same applicationId).
    testOptions { unitTests.isIncludeAndroidResources = true }
}

dependencies {
    implementation(project(":companion"))

    val composeBom = platform("androidx.compose:compose-bom:2024.10.00")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.core:core-ktx:1.13.1")
    // Wear Compose 1.4 pairs with the Compose 1.7 BOM.
    implementation("androidx.wear.compose:compose-material:1.4.1")
    implementation("androidx.wear.compose:compose-foundation:1.4.1")
    implementation("androidx.wear.compose:compose-navigation:1.4.1")

    implementation("com.google.android.gms:play-services-wearable:19.0.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.9.0")

    implementation("androidx.wear.tiles:tiles:1.4.1")
    implementation("androidx.wear.protolayout:protolayout:1.2.1")
    implementation("androidx.concurrent:concurrent-futures:1.2.0")
    implementation("androidx.wear.watchface:watchface-complications-data-source-ktx:1.2.1")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
    testImplementation("org.robolectric:robolectric:4.13")
    testImplementation("androidx.test:core:1.6.1")
    testImplementation("androidx.compose.ui:ui-test-junit4")
    testImplementation("androidx.compose.ui:ui-test-manifest")
    // The test host activity the Compose rule launches (debug builds only).
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}

// Flagship for Wear OS: the twin of the Apple Watch app. Server status, boxes
// waiting for a boot approval (Approve asks the phone, which signs), recent
// security events, a tile and a complication. Same applicationId and signing
// key as the phone app, which the Wearable Data Layer requires.
//
// minSdk 30 = Wear OS 3, the oldest Wear OS still supported (AGENTS.md's
// minimum-OS rule; Wear OS 2 watches no longer get updates). Re-check on each
// toolchain update.

import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore/keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "com.flagshipserver.wear"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.flagshipserver.app"
        minSdk = 30
        targetSdk = 36
        // Play needs every APK/bundle of one app to have its own version code:
        // the watch build is the phone's plus 1,000,000.
        versionCode = 1_000_008
        versionName = "0.0.8"
        resourceConfigurations += setOf("en")
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

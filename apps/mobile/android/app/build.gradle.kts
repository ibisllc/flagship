import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("com.google.devtools.ksp")
    id("com.google.gms.google-services")
}

// Read the signing keystore credentials from a gitignored file so we
// can produce signed APKs locally without leaking secrets into the
// repo. The release variant falls back to debug signing if the file
// isn't present (so a fresh checkout still builds).
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore/keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "com.flagshipserver.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.flagshipserver.app"
        minSdk = 28
        targetSdk = 35
        versionCode = 5
        versionName = "0.0.5"
        vectorDrawables { useSupportLibrary = true }
        // Keep APK lean (English only); reproducible-build prerequisite.
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
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    buildFeatures {
        compose = true
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
        }
        // Compose ui-test-manifest only ships in the debug variant, so
        // the release unit-test pass can't launch the Robolectric host
        // Activity. Debug coverage is sufficient for the JVM matrix —
        // anything release-specific runs in the AGP-generated release
        // smoke task.
        unitTests.all { test ->
            if (test.name == "testReleaseUnitTest") {
                // ui-test-manifest only ships in the debug variant, so
                // every Compose UI test that calls createComposeRule
                // needs to skip the release pass.
                test.exclude("**/HomeScreenComposeTest*")
                test.exclude("**/AddServerChooserComposeTest*")
                test.exclude("**/ProvidersComposeTest*")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.10.00")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.window:window:1.3.0")
    implementation("androidx.window:window-core:1.3.0")
    implementation("androidx.compose.material3:material3-window-size-class:1.3.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.navigation:navigation-compose:2.8.4")

    // Compose
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.runtime:runtime-livedata")
    implementation("androidx.compose.ui:ui-text-google-fonts")

    // Biometric + StrongBox
    implementation("androidx.biometric:biometric:1.2.0-alpha05")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // Cryptography
    implementation("com.google.crypto.tink:tink-android:1.13.0")

    // Networking
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")
    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("com.squareup.retrofit2:converter-kotlinx-serialization:2.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")

    // Camera + QR
    implementation("androidx.camera:camera-core:1.3.4")
    implementation("androidx.camera:camera-camera2:1.3.4")
    implementation("androidx.camera:camera-lifecycle:1.3.4")
    implementation("androidx.camera:camera-view:1.3.4")
    implementation("com.google.mlkit:barcode-scanning:17.3.0")

    // Image loading (marketplace screenshots)
    implementation("io.coil-kt:coil-compose:2.7.0")

    // Charts for ServerDetail metrics — CPU/mem/disk/net time series.
    implementation("com.patrykandpatrick.vico:compose:1.16.1")
    implementation("com.patrykandpatrick.vico:compose-m3:1.16.1")

    // Push notifications. firebase-bom 34.x folded the -ktx artifacts
    // into the main artifact; firebase-messaging now ships Kotlin
    // extensions inline (release notes: 2024-12-09 BoM 33.7+).
    implementation(platform("com.google.firebase:firebase-bom:34.13.0"))
    implementation("com.google.firebase:firebase-messaging")

    // Block Store (for cloud-recovery wrapped UMK)
    implementation("com.google.android.gms:play-services-auth-blockstore:16.4.0")

    // CredentialManager (passkey-PRF cloud recovery)
    implementation("androidx.credentials:credentials:1.3.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.3.0")

    // kotlinx.coroutines-play-services for Task.await()
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.9.0")

    // Tests
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("org.robolectric:robolectric:4.13")
    testImplementation("androidx.test:core:1.6.1")
    testImplementation("androidx.compose.ui:ui-test-junit4")
    testImplementation("androidx.compose.ui:ui-test-manifest")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}

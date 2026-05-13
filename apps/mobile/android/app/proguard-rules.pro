# ── kotlinx.serialization ───────────────────────────────────────────
# The compiler plugin generates a `$serializer` companion for every
# @Serializable; R8 needs to keep both the class and its companion so
# reflection-based polymorphic lookups work.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt

# Keep generated serializer classes (the convention is class$$serializer
# OR a companion object on the data class).
-keep,includedescriptorclasses class com.flagshipserver.app.**$$serializer { *; }
-keepclassmembers class com.flagshipserver.app.** {
    *** Companion;
}
-keepclasseswithmembers class com.flagshipserver.app.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# kotlinx.serialization core (third-party stdlib pieces R8 sometimes
# strips because they look reflective).
-keep,includedescriptorclasses class kotlinx.serialization.** { *; }
-keepclassmembers class kotlinx.serialization.** { *; }

# ── OkHttp + Okio ───────────────────────────────────────────────────
# OkHttp's TLS layer reflects against platform names that R8 chases
# back into Conscrypt; the well-known consumer rules are these.
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# ── Tink crypto ─────────────────────────────────────────────────────
-keep class com.google.crypto.tink.** { *; }
-dontwarn com.google.crypto.tink.**

# ── MLKit barcode scanning ──────────────────────────────────────────
-keep class com.google.mlkit.** { *; }
-keep class com.google.android.gms.vision.** { *; }
-dontwarn com.google.mlkit.**

# ── Firebase / FCM ──────────────────────────────────────────────────
-keep class com.google.firebase.** { *; }
-keep class com.google.android.gms.** { *; }
-dontwarn com.google.firebase.**
-dontwarn com.google.android.gms.**

# ── CameraX + ML processing ─────────────────────────────────────────
-dontwarn androidx.camera.**

# ── Compose / Material3 ─────────────────────────────────────────────
# Stable APIs Compose's runtime keeps for itself; R8 occasionally
# trims tooling annotations that survive in release without these.
-dontwarn androidx.compose.**

# ── Coroutines ──────────────────────────────────────────────────────
-dontwarn kotlinx.coroutines.debug.**
-keepclassmembers class kotlinx.coroutines.** {
    volatile <fields>;
}

# ── Our own surfaces ────────────────────────────────────────────────
# Hold the FCM service + MainActivity entry points so the manifest's
# class names always resolve.
-keep class com.flagshipserver.app.MainActivity { *; }
-keep class com.flagshipserver.app.push.FlagshipFcmService { *; }

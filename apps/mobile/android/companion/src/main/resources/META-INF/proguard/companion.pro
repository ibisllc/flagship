# Keep the wire types' generated serializers in every app that shrinks this
# module (the phone app and the Wear OS app).
-keepattributes *Annotation*, InnerClasses
-keep,includedescriptorclasses class com.flagshipserver.companion.**$$serializer { *; }
-keepclassmembers class com.flagshipserver.companion.** {
    *** Companion;
}
-keepclasseswithmembers class com.flagshipserver.companion.** {
    kotlinx.serialization.KSerializer serializer(...);
}

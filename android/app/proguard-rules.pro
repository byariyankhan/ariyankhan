# android-browser-helper reaches its activity and service by name from the manifest, so R8 must not rename or
# remove either of them. Everything else in this app is those two classes' dependencies.
-keep class com.google.androidbrowserhelper.trusted.** { *; }

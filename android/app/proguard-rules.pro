# Nothing to add.
#
# The manifest names one class, MainActivity, and AGP's own generated rules keep anything the manifest names.
# The AndroidX libraries ship their own consumer rules. There is no reflection here, no JavaScript bridge, and
# no library reached by string — the android-browser-helper keep rule that used to live here went with the
# Trusted Web Activity it was protecting.
#
# If a bridge is added later it will need a rule: an object passed to addJavascriptInterface is reached by name
# from JavaScript, which R8 cannot see. WebViewCompat.addWebMessageListener, which is what should be used
# instead and for origin-scoping reasons rather than this one, needs nothing.

# Puzzle – Train Your Brain, on Android

The Play Store app is the game at `https://ariyankhan.com/puzzle/`, running in a **WebView this project
owns**. One activity, one window, no browser chrome, and no second copy of the game to keep in step.

It was a **Trusted Web Activity** until September 2026, which was the right shape while the app earned
nothing. What changed is below, because it is the only interesting decision in this directory.

## Why the window moved into the app

A Trusted Web Activity hands the URL to Chrome. Chrome draws the game, and the app is a shortcut with an
icon. That costs nothing and it is genuinely fast — until you try to be paid.

**AdMob will not serve an H5 game unless your app owns the WebView it runs in.** The integration is
`MobileAds.registerWebView(webView, ...)`, plus a manifest `INTEGRATION_MANAGER` of `"webview"`; in a Trusted
Web Activity there is no WebView instance to pass, because the renderer belongs to Chrome. And AdMob is not
optional: AdSense's own behavioural policy says *"Google ads may not be integrated into a software application
(does not apply to AdMob) of any kind"*, and Google's H5 Games Ads guide says that when the game is designed
to be embedded in an app you own, *"the only way to do this in a high-performing and policy compliant way is
to use this AdMob support for mobile apps"*.

Play Billing points the same way. It is reachable from a Trusted Web Activity through the Digital Goods API,
but the Billing Library version underneath it is android-browser-helper's to keep current, and Play's
deadlines are not negotiable — Billing Library 8 has been required of new apps and updates since 31 August
2026. Native, it is this project's dependency and this project's problem.

So: the game stays a web game, and the frame around it becomes ours.

## What this bought, and what it cost

Kept, exactly as before:

* every fix shipped to the site is in the app the same hour, with no store review
* one set of tests, which is the set that already exists
* one board generator — which matters more than it sounds, because the boards are generated from a fixed
  seed, and a second implementation would have to agree with the first bit for bit or two players in a gold
  match would be handed different boards

Gained:

* AdMob, and with it the only policy-clean way to show advertisements in the app
* Play Billing natively, on a library version under our control
* Firebase Cloud Messaging, whose permission dialog names *Puzzle* rather than naming the origin

Lost, and these are real:

* **Google sign-in does not work in a WebView.** Google blocks its OAuth endpoint in embedded WebViews and
  answers `disallowed_useragent`; spoofing the agent string to get around it breaks its terms. The game
  detects the shell and says so instead of drawing a button that leads nowhere. It comes back natively through
  Credential Manager, which needs an Android OAuth client ID.
* **The Push API does not exist in a WebView.** Service workers run; `PushManager` is absent. The
  notification switch hides itself in the app until Firebase Cloud Messaging replaces it, and
  `POST_NOTIFICATIONS` has been removed from the manifest in the meantime, because a permission the app cannot
  use has no business on a store listing.
* One more surface to keep: an old System WebView on a cheap phone is a thing that can now break the game, and
  Chrome updating itself is no longer the whole story.

## The parts

| file | what it is |
|---|---|
| `app/src/main/java/.../MainActivity.java` | the shell: the WebView, its settings, the splash, insets, back, and the URL policy |
| `app/src/main/res/layout/activity_main.xml` | three layers — padded content, the offline screen, the splash over both |
| `app/src/main/res/values/strings.xml` | the URL the app opens, the host it will keep in its own window, the offline copy |
| `app/src/main/res/values/colors.xml` | the game's paper and ink; deliberately no `values-night` |
| `app/src/main/res/values/themes.xml` | light always, because the game is |
| `app/build.gradle` | the app id, the versions, and two AndroidX libraries |
| `../.well-known/assetlinks.json` | what makes an invitation link open the app (see below) |

There is **no JavaScript bridge yet**, and nothing needs one: the game learns it is in the app from a
`PuzzleApp/1` suffix on the user agent. When sign-in arrives the bridge should be
`WebViewCompat.addWebMessageListener` with origin rules and not `addJavascriptInterface`, because the latter
injects into every frame including the advertisements' iframes, and the bridge will be carrying purchases.

## Digital Asset Links — what it is still for

`https://ariyankhan.com/.well-known/assetlinks.json` carries the SHA-256 of the certificates the app is
signed with, and `node games/build-assetlinks.mjs <fingerprints…>` regenerates it.

**It no longer has anything to do with an address bar** — there is no browser in the app to show one. What it
still does is verify the deep link: `autoVerify="true"` on the intent filter makes Android check that file, and
that is what sends an invitation link to the app instead of to the browser. Play App Signing issues three
certificates and all three fingerprints are in the file; the deployment certificate is the one that signs what
a phone actually installs.

## Android 16 (API 36), and what it changes

Play has required API 36 of new apps and of every update since 31 August 2026, so `compileSdk` and `targetSdk`
are both 36, which pins the toolchain: AGP 8.13.2, Gradle 8.14.3, JDK 17+.

**Fixed orientation is ignored at 600dp and over.** Under `targetSdk 36` Android throws away
`android:screenOrientation` and friends on any display whose smallest width is 600dp — a tablet, or an open
foldable. **Games are the documented exception**, so `android:appCategory="game"` on `<application>` is what
keeps the portrait lock working; it is not decoration. And the lock is not the only line of defence:
`css/puzzle.css` counter-rotates the board when the window arrives sideways, so the game stays upright even
where the manifest is overruled — today when a user picks the per-app override, and wholesale later if Google
retires the exception the way it has said it will retire
`PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY` at API 37.

**Edge-to-edge is mandatory.** `windowOptOutEdgeToEdgeEnforcement` is deprecated and does nothing. Under the
Trusted Web Activity this needed no thought, because the window was Chrome's. Now it is ours:
`MainActivity` reads the system-bar, display-cutout and IME insets and pads `#content` by them, while `#root`
stays the game's paper — so what shows behind the clock is the same cream as the game, which is how the old
`STATUS_BAR_COLOR` result is reproduced. The bars are told to use dark icons, always, because the game is
light whatever the phone's dark mode says.

**Predictive back is on by default**, and `onBackPressed()` is not called. The shell uses
`OnBackPressedDispatcher` with `android:enableOnBackInvokedCallback="true"`, and the callback is only enabled
while `WebView.canGoBack()` is true. That last detail is the point: with nothing left to go back to the
callback switches itself off, the press reaches the system, and Android animates the app closing instead of it
vanishing.

**`configChanges` is load-bearing.** Without it a rotation, a font-size change or a foldable opening destroys
the activity, and a rebuilt WebView starts the page again — `saveState()` restores a URL and a history list,
never the running JavaScript, so a player would lose the board they were halfway through.

## Keys

**No keystore is in this repository and none should ever be.** Play App Signing holds the app signing key. The
upload key lives on Ariyan's machine (or as a CI secret); `./gradlew bundleRelease` produces an *unsigned*
bundle here, and the signing happens where the key is.

## Building

```bash
export ANDROID_HOME=/path/to/android-sdk   # needs platforms;android-36 and build-tools;36.0.0
cd android && ./gradlew assembleDebug       # app/build/outputs/apk/debug/app-debug.apk, installable
cd android && ./gradlew bundleRelease       # app/build/outputs/bundle/release/app-release.aab
```

The debug APK is about 2.5 MB, nearly all of it AndroidX. There is no native code in it, so the **16 KB
page-size requirement** is satisfied by having nothing to align.

`bundleRelease` is **unsigned**, which is what you want for looking at the app and not what Play accepts. Four
environment variables turn the same command into a signed one, and they are the only way a key ever reaches
this build:

```bash
PUZZLE_KEYSTORE=/path/to/puzzle-upload.jks \
PUZZLE_KEYSTORE_PASSWORD=... PUZZLE_KEY_ALIAS=puzzle-upload PUZZLE_KEY_PASSWORD=... \
PUZZLE_VERSION_CODE=6 PUZZLE_VERSION_NAME=1.1.0 \
  ./gradlew bundleRelease
```

`PUZZLE_VERSION_CODE` matters more than it looks: **Play refuses a versionCode it has already seen**, and 1
through 5 are spent. A build with the variable unset stays at 1 on purpose — usable, and obviously not
uploadable.

## Building it in CI instead

`.github/workflows/android-build.yml` does all of the above on a runner: it installs SDK 36, takes the version
from the run number so it can never repeat, signs with a key held in four repository secrets, checks the result
really is signed, and hands back the bundle as an artifact. The keystore is written to the runner's temporary
directory and deleted in a step that runs even when the build fails.

It does not upload to Play. That would need a service account with release rights — a second key to look
after, to save one drag and drop.

## What is not here yet

In the order it is meant to arrive:

1. **Native Google sign-in.** Credential Manager takes an ID token, the bridge hands it to the page, the page
   posts it to the `/auth/google` endpoint that already exists. Needs an Android OAuth client ID, and the
   server has to accept it as a second audience beside the web client.
2. **AdMob.** `registerWebView`, an interstitial and a rewarded ad unit, and the two
   `data-admob-*-slot` attributes on the Ad Placement API tag the game already loads.
3. **Play Billing.** Consumable products for hints and lifelines, verified server-side, acknowledged inside
   three days or Play refunds them, and clawed back through the Voided Purchases API when somebody refunds a
   purchase they have already spent.
4. **Firebase Cloud Messaging**, and `POST_NOTIFICATIONS` back in the manifest with it.

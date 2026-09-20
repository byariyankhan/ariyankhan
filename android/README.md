# Puzzle – Train Your Brain, on Android

This is a **Trusted Web Activity**: the Play Store app is the game at
`https://ariyankhan.com/puzzle/`, running in the phone's own Chrome engine with no
address bar, no browser chrome and no second copy of the game to keep in step.

## Why this and not a rewrite

The game is a web game. A TWA runs **the same code on the same engine at the same
speed** — there is no WebView-in-an-app penalty and no JavaScript bridge, because
there is nothing to bridge to. A native rewrite would mean a second board
generator, a second economy client, a second socket layer and a second set of
bugs, and it would not draw a single arrow faster: what renders the board is
Chrome either way.

What that buys, concretely:

* every fix shipped to the site is on Android the same hour, with no store review
* one set of tests, which is the set that already exists
* the Play listing, Play billing and Play's own install flows still work

What it costs: the device needs Chrome (or any browser supporting TWAs) — on
effectively every phone that matters it is there. Where it is not, the app falls
back to a Custom Tab, which still works and merely shows the address bar.

## The parts

| file | what it is |
|---|---|
| `app/src/main/AndroidManifest.xml` | one activity, `LauncherActivity` from android-browser-helper |
| `app/src/main/res/values/strings.xml` | the URL the app opens, and the host it is trusted on |
| `app/src/main/res/values/colors.xml` | the splash and system-bar colours, matched to the game |
| `app/build.gradle` | the app id, versions, and the one dependency |
| `../.well-known/assetlinks.json` | what makes the address bar disappear (see below) |

## Digital Asset Links — the one thing that must match

A TWA only drops the address bar when the **site** says it trusts the **app**.
That is `https://ariyankhan.com/.well-known/assetlinks.json`, and it has to carry
the SHA-256 of the certificate the app is actually signed with.

With Play App Signing — which is what this uses — Google holds that certificate,
so the fingerprint is not knowable until the first bundle has been uploaded:

1. build the bundle, upload it to the **internal testing** track
2. Play Console → *Test and release* → *Setup* → *App signing*
3. copy **SHA-256 certificate fingerprint** under *App signing key certificate*
4. `node games/build-assetlinks.mjs <that fingerprint>` and deploy the site
5. install from the internal track and check the address bar is gone

Until step 4 lands, the app runs with the address bar showing. Nothing else
breaks.

## Android 16 (API 36), and what it changes

Google Play has required **API 36 of new apps and of every update since 31 August
2026**. An upload targeting 35 is rejected, so `compileSdk` and `targetSdk` are
both 36, which pins the toolchain: AGP 8.13.2, Gradle 8.14.3, JDK 17+, and
android-browser-helper 2.7.3 (2.5.0 predates the Android 16 window).

Three of Android 16's behaviour changes land on an app shaped like this one:

**Fixed orientation is ignored at 600dp and over.** Under `targetSdk 36` Android
throws away `android:screenOrientation`, `resizableActivity`, `minAspectRatio`,
`maxAspectRatio` and `setRequestedOrientation()` on any display whose smallest
width is 600dp — a tablet, or a foldable once it is open. **Games are the
documented exception**, so `android:appCategory="game"` on `<application>` is what
keeps the portrait lock working; it is not decoration. And the lock is not the
only line of defence: `css/puzzle.css` counter-rotates the board when the window
arrives sideways, so the game stays upright even where the manifest is overruled.
That happens today when a user picks the per-app override in device settings. It
may happen wholesale later: Google's documented escape hatch for non-games, the
`PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY` property, is stated to stop
working at API 37, and while the games exception carries no announced end date,
the direction of travel is plainly towards adaptive windows. The CSS is what makes
that a non-event for us rather than a rewrite.

**Edge-to-edge is mandatory.** `windowOptOutEdgeToEdgeEnforcement` is deprecated
and does nothing on Android 16. There is no opt-out and nothing to do here: the
window belongs to Chrome, the game's own layout is already inset-aware through
`env(safe-area-inset-*)`, and the splash is a single colour that reaches the
edges by construction.

**Predictive back is on by default.** `onBackPressed()` is not called and
`KEYCODE_BACK` is not dispatched. Nothing in this project implements either —
`LauncherActivity` launches and finishes, and back inside the game is Chrome's —
so there is no migration, which is exactly why the library floor matters.

## Keys

**No keystore is in this repository and none should ever be.** Play App Signing
holds the app signing key. The upload key lives on Ariyan's machine (or as a CI
secret); `./gradlew bundleRelease` produces an *unsigned* bundle here, and the
signing happens where the key is.

## Building

```bash
export ANDROID_HOME=/path/to/android-sdk   # needs platforms;android-36 and build-tools;36.0.0
cd android && ./gradlew bundleRelease       # app/build/outputs/bundle/release/app-release.aab
```

The bundle is about 900 KB, nearly all of it android-browser-helper's dex and the
launcher icons. There is no native code in it, so the **16 KB page-size
requirement** that applies to apps targeting Android 15 and up is satisfied by
having nothing to align.

That build is **unsigned**, which is what you want for looking at the app and not
what Play accepts. Four environment variables turn the same command into a signed
one, and they are the only way a key ever reaches this build:

```bash
PUZZLE_KEYSTORE=/path/to/puzzle-upload.jks \
PUZZLE_KEYSTORE_PASSWORD=... PUZZLE_KEY_ALIAS=puzzle-upload PUZZLE_KEY_PASSWORD=... \
PUZZLE_VERSION_CODE=3 PUZZLE_VERSION_NAME=1.0.2 \
  ./gradlew bundleRelease
```

`PUZZLE_VERSION_CODE` matters more than it looks: **Play refuses a versionCode it
has already seen**, and 1 went with the first internal-track upload. A build with
the variable unset stays at 1 on purpose — usable, and obviously not uploadable.

## Building it in CI instead

`.github/workflows/android-build.yml` does all of the above on a runner: it
installs SDK 36, takes the version from the run number so it can never repeat,
signs with a key held in four repository secrets, checks the result really is
signed, and hands back the bundle as an artifact. The keystore is written to the
runner's temporary directory and deleted in a step that runs even when the build
fails.

It does not upload to Play. That would need a service account with release
rights — a second key to look after, to save one drag and drop.

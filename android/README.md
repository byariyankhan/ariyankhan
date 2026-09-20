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

## Keys

**No keystore is in this repository and none should ever be.** Play App Signing
holds the app signing key. The upload key lives on Ariyan's machine (or as a CI
secret); `./gradlew bundleRelease` produces an *unsigned* bundle here, and the
signing happens where the key is.

## Building

```bash
export ANDROID_HOME=/path/to/android-sdk
cd android && ./gradlew bundleRelease     # app/build/outputs/bundle/release/
```

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
  answers `disallowed_useragent`; spoofing the agent string to get around it breaks its terms. Paid for with
  the bridge and Credential Manager below, plus an Android OAuth client ID per signing certificate — which is
  a thing that can be forgotten, and whose symptom looks nothing like its cause.
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
| `app/build.gradle` | the app id, the versions, and the libraries |
| `../.well-known/assetlinks.json` | what makes an invitation link open the app (see below) |

## The bridge

`window.PuzzleShell` in the page, put there by `WebViewCompat.addWebMessageListener` with an origin rule of
`https://ariyankhan.com`. Deliberately **not** `addJavascriptInterface`: that injects the object into every
frame in the WebView, including the advertisements' iframes once they arrive, and this bridge carries a
sign-in token today and a purchase later.

The protocol is one string in, one JSON object out:

| the page posts | the shell replies |
|---|---|
| `hello` | `{"ok":true,"signIn":true}` |
| `signIn` | `{"ok":true,"idToken":"…"}` or `{"ok":false,"error":"cancelled"\|"no_account"\|"unavailable"\|"failed"}` |

Where `WebViewFeature.WEB_MESSAGE_LISTENER` is missing — a System WebView older than about 2021 — no bridge is
installed, nothing throws, and the page goes on saying sign-in is not in the app, which is then true.

The game still learns it is *in* the app from a `PuzzleApp/1` suffix on the user agent, because that is true
before the page has loaded and true even where the bridge is not.

## Sign-in

Google blocks its OAuth endpoint in embedded WebViews and answers `disallowed_useragent`, so the token is
fetched natively with Credential Manager and handed to the page.

The part worth knowing: `GetGoogleIdOption.setServerClientId` is given the **web** client ID, which makes that
the *audience* of the ID token that comes back — and the audience is exactly what the server compares against
its own `GOOGLE_CLIENT_ID` (`games/puzzle/backend/src/auth.ts`). So the app signs in through the endpoint the
browser already uses, with the same kind of token, and **the server needed no change at all**.

The Android OAuth client IDs are not in this repository and are not referenced by any code. They exist in the
same Cloud project (`arrow-atlas-508819`) so that Google can check the package name and signing certificate of
whatever is asking. One is needed per package-and-fingerprint pair:

| package | fingerprint |
|---|---|
| `com.ariyankhan.puzzle` | the upload key's SHA-1 |
| `com.ariyankhan.puzzle` | the Play App Signing key's SHA-1 |
| `com.ariyankhan.puzzle.debug` | whichever debug keystore built the test APK |

Miss one and sign-in fails for builds signed that way and only those, which is a confusing thing to debug: the
symptom is a credential error, not a rejection from our server.

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
`OnBackPressedDispatcher` with `android:enableOnBackInvokedCallback="true"`. **Back belongs to the page:** the
game has no history for the WebView to walk (it routes with `replaceState`, and a sheet is an element that is
shown), so a press is sent down the bridge as `{"event":"back"}` and the page closes what it has open one layer
at a time — the open question, the Home page, a sheet, the board with its "Leave this board?" — and, with
nothing left open, posts `leave`, on which the activity calls `moveTaskToBack(true)`. The page hands the shell
its reply channel by saying `hello` as it loads (`page`, renewed on every message and dropped when a new
document starts). The callback is enabled while there is a page to ask, history to walk or a fullscreen video
to close (`refreshBack()`); with none of those it switches itself off, the press reaches the system, and
Android animates the app closing instead of it vanishing. The bridge also answers `share <text>` with the
phone's own share sheet. `ours()` keeps only the game's own path in the WebView; the rest of the site — the
privacy policy, the terms, the contact page, which carry the site's AdSense tag — opens in the browser.

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

## AdMob

Three things in `MainActivity`, and two manifest meta-data entries the SDK reads at startup: `APPLICATION_ID`,
and `INTEGRATION_MANAGER` set to `webview` — the second is what tells AdMob this is an H5 integration and not
a native one.

The three, in the order Google's own example sets them:

```java
h5 = new H5AdsWebViewClient(this, web);
web.setWebViewClient(h5);
h5.setDelegateWebViewClient(new Client(back));
MobileAds.registerWebView(web);
```

**`H5AdsWebViewClient` is the one that was missing**, and it is not decoration. `registerWebView` says *this
WebView belongs to this app*; the client is what intercepts the ad requests the page makes and turns them
into advertisements. With only the first of the two, the page asks and nothing answers. Ours is the delegate
behind it: the library's base class overrides every `WebViewClient` callback and forwards what it does not
handle itself, so the URL policy, the splash, the offline check and the back button all still see everything
they saw before. It is one per WebView, and `clearAdObjects()` goes with the WebView it was built for.

Nothing in this app draws an advertisement. The game's own Ad Placement API tag still asks for the breaks;
what the registration changes is who answers — AdMob's demand rather than AdSense's, which is the only
arrangement Google's H5 guide calls policy compliant for a game embedded in an app you own. The ad unit ids
travel the other way, from `meta[name=puzzle-ads]` in the page onto that tag as `data-admob-rewarded-slot`,
and only when the page can see it is in the app. There is one unit, the rewarded one: nothing in this game
shows an advertisement of its own accord, so there is no interstitial slot.

**`APPLICATION_ID` is the real one now** — `ca-app-pub-1570944160084395~8956379298`, in `strings.xml` — and it
is not optional: the SDK throws on launch if it is missing or malformed, by design. It is not a secret; it is
in the manifest of every copy of the app on every phone. What it does need is care while testing: clicking an
advertisement of your own is invalid traffic and invalid traffic costs the account, so put the phone in
AdMob → Settings → Test devices first and the same real ids serve test creatives.

### Seeing an advertisement before there are any

Settings, seven taps on the build line at the foot, and a **Developer** group appears with the advertising
mode: **Default**, **Test**, **Live** — stored on that device and nowhere else. Default means the page decides,
which is what every other phone does; it is there so that opening the group to look at it does not change
anything, and so there is a way back from the other two.

It exists because of a gap that only showed up once the app was real. The mode could be forced with an
`?ads=test` URL parameter, gated on localhost or a flag set by hand; the app has no address bar to type a
parameter into and no console to set a flag from, so on a phone there was no way at all to watch the
advertisement path — not today, and not on the morning approval lands.

- **Test** is the stand-in panel: the offer, the wait, the reward, the refusals, with nothing asked of any
  network — and nothing asked of the server either, so the gold it talks about is talked about rather than
  paid. It is how the flow gets judged before a network will answer at all. It proves our screens; it proves
  nothing whatever about the library, because it never loads it.
- **Mock** is `data-adbreak-test="on"` on the script tag — Google's own documented test mode. The real
  library loads, the real `adBreak` runs, `beforeReward` and `adViewed` and `adBreakDone` are the library's
  own, and no request leaves the phone. It is the only way to watch the *integration* work before there is
  any demand to fill it. It refuses roughly every other break on purpose, which is the point: a flow that
  only works when an advertisement is there is a flow that has not been tested.
- **Live** asks for the real thing on that one device, which is what turns approval day into a check rather
  than a leap: flip it here, watch one, then flip `data-give` for everybody. Put the phone in AdMob →
  Settings → Test devices first; clicking a real advertisement of your own is invalid traffic.

Seven taps rather than a URL on purpose. A link can be sent to somebody; a gesture on a line at the foot of
Settings cannot.

Under the modes is **Last advertisement**, which is the whole of the reporting: whether the library ever said
it was ready, what the last break was asked for, what came back, and — the part that was being thrown away —
the library's own word for why. `adBreakDone` is handed a `placementInfo` whose `breakStatus` is one of ten
documented values, and `noAdPreloaded`, `frequencyCapped`, `timeout` and `error` are four quite different
problems that all used to read as "no advertisement was available". A phone has no console; a value that is
only ever logged is a value nobody will ever read.

### Is the connection actually there?

Google publishes a page that answers exactly that, and the developer group has a button for it:
**Check the ad connection**, which loads

    https://google.github.io/webview-ads/test/#api-for-ads-tests

into this WebView. Green bars mean the page really is joined to the Mobile Ads SDK, so anything still missing
is on the account side — an approval not granted, an app not reviewed — and no amount of changing this code
will help. Red means the fault is here and waiting will never fix it. There is no other way to tell those two
apart from a phone, which is why it is a button rather than a note in this file.

It is loaded rather than opened in a browser on purpose: a browser tab is not this WebView, and this WebView
is the thing being asked about. Back returns to the game.

### What the app does around an advertisement

Three things in `MainActivity`, none of which draw anything, all of which decide whether a real advertisement
behaves:

- **It stops when the app does.** `onPause` calls `web.onPause()` and `pauseTimers()`, `onResume` undoes both.
  Without it a rewarded video keeps playing to a phone nobody is looking at, which is what a player who takes
  a call halfway through an advertisement would have heard.
- **A link that is not a web page leaves the app.** A great many creatives click through with an `intent:`
  URI, and a WebView loads exactly nothing from one: the click is lost and the advertiser got no visit for
  what they paid. Any scheme this WebView cannot draw — `intent:`, `market:`, `tel:`, `mailto:` — is handed to
  the phone, from an advertisement's own iframe as much as from the main frame. What comes back from
  `Intent.parseUri` is stripped of its component and selector and required to be `BROWSABLE` before it is
  started, because the URI came from somebody else's frame; `browser_fallback_url` is honoured when nothing
  handles it, and the Play page for the named package after that.
- **Only a finger can do it.** `hasGesture()` gates that hand-off. Script can start a navigation as easily as
  a tap can, and a creative that fired one on load would put the Play Store in front of a player who touched
  nothing.

### What the SDK changes about the Play listing

It merges these into the manifest whether or not an advertisement is ever shown:

```
com.google.android.gms.permission.AD_ID
android.permission.ACCESS_ADSERVICES_AD_ID
android.permission.ACCESS_ADSERVICES_ATTRIBUTION
android.permission.ACCESS_ADSERVICES_TOPICS
android.permission.ACCESS_NETWORK_STATE
android.permission.FOREGROUND_SERVICE
android.permission.WAKE_LOCK
```

`AD_ID` is the one that matters. The **Advertising ID** declaration under App content, and the advertising id
row in **Data safety**, were both answered *no* when this app had no advertising SDK in it. With one, both
answers are yes, and an upload that says otherwise is a false declaration.

## Notifications

An invitation, and the league paying out — the same two things the web sends, and nothing else. The web's go
through the browser's push service; a WebView has no such thing, so the app's go through **Firebase Cloud
Messaging**: the server sends one message per phone to Google, Google wakes `PuzzleMessagingService`, and the
service draws it. What the server sends is data (a title, a body, a path into the game, a tag), never a
ready-made notification, so it looks the same whether the game was open or the phone was in a pocket. A tap
opens the game at the room, or at the league table, through the same activity a link in a chat reaches.

It is **off until the player turns it on**, in Settings, with the switch the browser shows in the same place.
Turning it on is the one moment the app asks Android for `POST_NOTIFICATIONS` (13 and up), fetches the phone's
registration token from Firebase, and hands it to the page over the bridge (`pushOn`); the page posts it to
the account with `POST /push/token`, and posts it again on every open so the row follows whoever is signed in.
Off deletes the token on the phone and the row on the server, and so does signing out. Nothing is asked on the
way in, and Firebase is not spoken to at all — auto-init is off in the manifest — until the switch is.

Two files make it work, and neither is in this repository:

1. **`android/app/google-services.json`**, from the Firebase console: *Add app → Android*, package name
   `com.ariyankhan.puzzle`, then download the file. It tells the library which Firebase project it belongs to.
   Google's own position is that it is not a secret — it is inside every APK that uses it — so it can simply be
   committed at that path. If you would rather not, put its base64 (`base64 -w0 google-services.json`) in the
   repository secret `GOOGLE_SERVICES_JSON_B64` and `android-build.yml` writes it onto the runner instead.
   Without it the app still builds, because the Firebase plugin is applied only when the file is there, and
   the switch stays hidden: the app answers the page's `pushState` with `available: false`. The debug build
   carries the suffix `.debug` on its package name, so for a debug APK to receive anything the Firebase
   project needs a second Android app registered as `com.ariyankhan.puzzle.debug`, in the same file.

2. **The service account**, for the server: Firebase console → *Project settings → Service accounts →
   Generate new private key*. That JSON file **is** a secret — it signs the requests the server makes to Google
   in the project's name — and it never goes in git. Paste the whole file into the repository secret
   `PUZZLE_FCM_SERVICE_ACCOUNT` and run the `fcm-key` mode of *Puzzle ops* with `confirm=DEPLOY`: it carries
   the file to the VPS on the connection's own stdin (never a command line), writes it base64 into the
   project's `.env` as `PUZZLE_FCM_SERVICE_ACCOUNT`, passes it through the compose file, recreates the API,
   and checks that `/api/puzzle/v1/push/key` now answers `"app": true`. Until it has run, the server answers
   `push_off` to every token and the app's switch is not offered.

The server side is `games/puzzle/backend/src/fcm.ts`: a JWT signed with the account's key, traded for an
access token, and one `POST` per phone to FCM's HTTP v1 endpoint — no Firebase SDK on the server, because it
would be a hundred dependencies for four requests. A token Google reports as `UNREGISTERED` (the app
uninstalled, the token rotated away) is deleted the moment it does.

## What is not here yet

In the order it is meant to arrive:

1. **The real ad ids**, and H5 Games Ads approved for the domain so `data-give` can go from `free` to `ad`.
2. **Play Billing.** Consumable products for hints and lifelines, verified server-side, acknowledged inside
   three days or Play refunds them, and clawed back through the Voided Purchases API when somebody refunds a
   purchase they have already spent.
3. **The two Firebase files** described above, without which the notifications built here reach nobody.

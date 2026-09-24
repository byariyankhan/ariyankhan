package com.ariyankhan.puzzle;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.res.Resources;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebChromeClient;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.browser.customtabs.CustomTabsClient;
import androidx.browser.customtabs.CustomTabsIntent;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.credentials.exceptions.NoCredentialException;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.google.android.gms.ads.MobileAds;
import com.google.android.gms.ads.h5.H5AdsWebViewClient;
import com.google.android.libraries.identity.googleid.GetGoogleIdOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

import org.json.JSONException;
import org.json.JSONObject;

import java.net.URISyntaxException;
import java.util.Collections;
import java.util.Locale;

/**
 * The game, in a window this app owns.
 *
 * <p>This used to be a Trusted Web Activity: one line of manifest handed the URL to Chrome and Chrome did
 * everything. It cost nothing and it was the right shape until the money arrived. AdMob will not serve an H5
 * game unless the app owns the WebView it runs in — {@code MobileAds.registerWebView()} takes a WebView
 * instance, and in a Trusted Web Activity there is no such instance to hand it, because the renderer belongs
 * to Chrome. Play Billing has the same shape: the native library is under our control here and, through the
 * Digital Goods API, was under android-browser-helper's there. So the window moves into the app.
 *
 * <p>What has <em>not</em> moved is the game. It is still the same URL, still served from the same origin,
 * still updated by deploying the website. This class is a frame around it and deliberately knows nothing
 * about arrows, gold or boards.
 */
public final class MainActivity extends ComponentActivity {

    private WebView web;
    private View offline;
    /**
     * Whether the page has put something on the screen, or never will (an error, a page of our own choosing):
     * the splash stays until it has. Read by the splash on every frame it holds, so it only ever turns true.
     */
    private boolean pageShown;
    /** Longer than any page takes to paint on a connection worth the name; the splash never outstays it. */
    private static final long SPLASH_MAX_MS = 4000;
    /** True while the WebView is showing a page this app sent it to on purpose, rather than the game. */
    private boolean away;
    /** The advertising library's WebViewClient. Ours is the delegate behind it. One per WebView, always. */
    private H5AdsWebViewClient h5;

    /** The view a fullscreen video hands us, and the callback that takes it back. Null when none is up. */
    private View fullscreen;
    private WebChromeClient.CustomViewCallback fullscreenDone;
    private OnBackPressedCallback back;

    /** Asks for POST_NOTIFICATIONS on Android 13 and up. Registered in onCreate, which is the one rule it has. */
    private ActivityResultLauncher<String> askToNotify;
    /** The page's pushOn, waiting on the permission dialog. One at a time, which is all a switch can be. */
    private JavaScriptReplyProxy notifyWaiting;
    /**
     * A way to speak to the page unasked. The bridge is request and reply, so the page introduces itself
     * with a hello as it loads and this is the reply channel it handed over; Back goes down it. Null until
     * the page has spoken, and stale after a navigation, which is why every message renews it.
     */
    private JavaScriptReplyProxy page;

    @Override
    protected void onCreate(@Nullable Bundle state) {
        // Before super.onCreate, which is the library's one rule: it swaps the splash theme the manifest starts
        // this activity in (Theme.App.Starting) for the one it runs in (Theme.App, its postSplashScreenTheme).
        SplashScreen splash = SplashScreen.installSplashScreen(this);
        super.onCreate(state);
        setContentView(R.layout.activity_main);
        // The splash stays until the page has painted, and the page's first frame is the same brain in the same
        // place (the web opening, puzzle/index.html), so the moment one hands over to the other cannot be seen.
        // It used to be an ImageView of our own over the WebView, faded out at the first frame -- and on
        // Android 12 and up, where the system draws a splash of its own first whatever the app does, that made
        // two splashes with two different brains. The condition is asked on every frame the splash holds;
        // everything that ends the wait sets it (releaseSplash), and nothing waits longer than SPLASH_MAX_MS.
        splash.setKeepOnScreenCondition(() -> !pageShown);
        new Handler(Looper.getMainLooper()).postDelayed(this::releaseSplash, SPLASH_MAX_MS);

        web = findViewById(R.id.web);
        offline = findViewById(R.id.offline);
        // Whatever is behind the page before it paints is the colour the splash was just drawn in.
        applyStartColour();

        // The page gets the whole window, bars included, which is what the Trusted Web Activity did and what
        // the page is already written for: its viewport is viewport-fit=cover and css/puzzle.css pads by
        // env(safe-area-inset-*) on all four edges.
        //
        // The first version of this shell padded the WebView by those same insets instead, and the result was
        // the gap counted twice — once by Android and once by the page — which is what put the League chip a
        // finger's width below where it belongs. One owner of the inset, and it is the page.
        //
        // It also means html{background:var(--bg)} is what paints behind the clock, so the bars follow the
        // player's chosen theme rather than being stuck on the cream of the default one.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        // The offline screen is the one piece of native UI here, so it is the one thing that has to keep
        // itself clear of the bars.
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.offline), (v, insets) -> {
            Insets bars = insets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return insets;
        });

        // The notification channels exist from the first launch, so that Android's own settings page for the
        // app lists them, and so a test message sent from the Firebase console lands in one of them.
        PuzzleMessagingService.ensureChannels(this);
        // The permission dialog's answer comes back here. Registered before the activity is started, which is
        // the one rule registerForActivityResult has; used from the bridge's pushOn, below.
        askToNotify = registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
            JavaScriptReplyProxy waiting = notifyWaiting;
            notifyWaiting = null;
            if (waiting == null) return;
            if (granted) fetchToken(waiting);
            else answer(waiting, fail("denied"));
        });

        configure(web);
        findViewById(R.id.retry).setOnClickListener(v -> {
            offline.setVisibility(View.GONE);
            web.reload();
        });

        // Back goes to the page. The game has no history for the WebView to walk -- it routes with
        // replaceState, and its sheets are elements that are shown -- so Back is handed over the bridge and
        // the page closes what it has open, one layer at a time; when nothing is open it says "leave" and
        // the app steps into the background (see the bridge below). The callback is enabled while there is
        // a page to ask or history to walk, which leaves the last press to the system: that is what lets
        // Android 16's predictive back animate the app closing instead of it vanishing.
        back = new OnBackPressedCallback(false) {
            @Override public void handleOnBackPressed() {
                // A fullscreen advertisement is the thing back should close, and it is the one state where
                // there is nothing in the WebView's history to go back to — so it has to be asked about
                // first, or back would leave the app with an advertisement still on the screen.
                if (fullscreen != null) { hideFullscreen(); return; }
                if (page != null) { answer(page, event("back")); return; }
                if (web.canGoBack()) web.goBack();
            }
        };
        getOnBackPressedDispatcher().addCallback(this, back);
        // The advertising library's own WebViewClient goes on the outside, and ours is the delegate it hands
        // everything else to.
        //
        // This is not decoration. Google's example for an H5 game inside an app does two things, and until
        // now this app did one: it registered the WebView with the SDK but never installed
        // H5AdsWebViewClient, which is what actually intercepts the ad requests the page makes and turns
        // them into ads. Registration alone says "this WebView belongs to this app"; this is the part that
        // carries the advertisement.
        //
        // The order is the documented one — set it as the client, then give it the delegate, then register.
        h5 = new H5AdsWebViewClient(this, web);
        web.setWebViewClient(h5);
        h5.setDelegateWebViewClient(new Client(back));
        web.setWebChromeClient(new Chrome());

        installBridge(web);
        registerForAds(web);

        if (state == null) web.loadUrl(target(getIntent()));
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Let the page run again before anything is asked of it.
        web.onResume();
        // A theme picked in Settings changes the page's theme-color without a navigation, so the bars would
        // keep the old contrast until something asked again. Leaving the app and coming back asks again.
        //
        // Not on the first resume, though: that one runs while the page is still on its way, and asking a
        // WebView with nothing in it what colour it is gets an empty answer.
        if (web.getUrl() != null) readThemeColour();
    }

    /**
     * Put the page to sleep while the app is not the thing on screen.
     *
     * <p>A WebView left alone carries on: animations keep drawing and, the reason this matters, a video keeps
     * playing. Without this, a player who takes a call halfway through a rewarded advertisement leaves it
     * talking out of a phone they are no longer looking at.
     *
     * <p><b>onPause only.</b> pauseTimers was here for one build and had to go, because it is not this
     * WebView's clock it stops — it is every WebView in the process, and the advertisement the SDK shows is
     * drawn in a WebView of its own, in an activity of its own, which by definition comes to the front at the
     * exact moment this one is told to pause. So the app would pause the very advertisement it had just
     * asked for: the countdown stopped, the close button never arrived, and the player was left holding a
     * screen that could not be got rid of. onPause is per-WebView and does the job that was wanted.
     */
    @Override
    protected void onPause() {
        // A theme chosen in Settings changes nothing native until something asks. Leaving is the last chance to
        // ask before the next launch, whose splash should already be in that theme.
        if (web.getUrl() != null) readThemeColour();
        // Before super, so nothing is still drawing or sounding by the time the activity is told it is gone.
        web.onPause();
        // The session cookie reaches the disk when the WebView gets round to it, which is not before a player
        // who signs in and swipes the app away within seconds has lost it. Now is when it gets round to it.
        CookieManager.getInstance().flush();
        super.onPause();
    }

    /**
     * What colour the page says it is, and therefore whether the clock and the battery should be drawn dark
     * or light. The page keeps its meta[name=theme-color] in step with the chosen theme — paper and mint are
     * light, night is nearly black — which is the same signal Chrome used to read when this was a Trusted Web
     * Activity.
     */
    private void readThemeColour() {
        web.evaluateJavascript(
                "(document.querySelector('meta[name=\"theme-color\"]')||{}).content||''",
                value -> {
                    // evaluateJavascript hands back a JSON string, quotes and all — and hands back "" when
                    // there is no page yet, or no meta in it, or the page is an error page. Color.parseColor
                    // answers an empty string with StringIndexOutOfBoundsException rather than the
                    // IllegalArgumentException its name suggests, which is how a cosmetic touch like this one
                    // managed to kill the app on launch. So the string is checked before it is parsed, and
                    // anything unparseable afterwards is still caught: the bars keeping the wrong contrast is
                    // a blemish, and nothing here is worth more than the app staying up.
                    String hex = value == null ? "" : value.replace("\"", "").trim();
                    if (hex.length() < 4 || hex.charAt(0) != '#') return;
                    try {
                        int colour = Color.parseColor(hex);
                        // Rec. 601 luma, the same rule a browser uses to decide bar contrast.
                        double luma = (0.299 * Color.red(colour)
                                + 0.587 * Color.green(colour)
                                + 0.114 * Color.blue(colour)) / 255.0;
                        boolean light = luma > 0.6;
                        findViewById(R.id.root).setBackgroundColor(colour);
                        web.setBackgroundColor(colour);
                        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView())
                                .setAppearanceLightStatusBars(light);
                        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView())
                                .setAppearanceLightNavigationBars(light);
                        rememberTheme(hex);
                    } catch (RuntimeException notAColour) {
                        // Leave the bars as they are.
                    }
                });
    }

    /** The game's three themes, by the theme-color the page sets for each (applyTheme in js/puzzle.js). */
    @Nullable
    private static String themeOf(String hex) {
        switch (hex.toUpperCase(Locale.ROOT)) {
            case "#F4EDE0": return "paper";
            case "#0E0E10": return "night";
            case "#E6F2EC": return "mint";
            default: return null;
        }
    }

    private SharedPreferences shellPrefs() {
        return getSharedPreferences("shell", MODE_PRIVATE);
    }

    /**
     * Keep the player's theme for the next launch, and on Android 13 and up tell the system to draw that launch's
     * splash in it. Android keeps the choice itself (by the style's name, so it survives an update), which is
     * the point: the splash is drawn before any of this code runs. Asked only when the theme has changed, or
     * when nothing is remembered yet -- a fresh install, or cleared data, which the system's copy may outlive.
     */
    private void rememberTheme(String hex) {
        String theme = themeOf(hex);
        if (theme == null) return;
        SharedPreferences prefs = shellPrefs();
        if (theme.equals(prefs.getString("theme", null))) return;
        prefs.edit().putString("theme", theme).apply();
        if (Build.VERSION.SDK_INT < 33) return;
        int style = "night".equals(theme) ? R.style.Theme_App_Starting_Night
                : "mint".equals(theme) ? R.style.Theme_App_Starting_Mint
                : Resources.ID_NULL;   // paper: the manifest's own, Theme.App.Starting
        try {
            getSplashScreen().setSplashScreenTheme(style);
        } catch (RuntimeException notToday) {
            // The splash stays as it was. The page copes with a paper one (it starts on paper and fades).
        }
    }

    /**
     * The colour this launch's splash was drawn in: the remembered theme where the system was told to use it
     * (Android 13 and up), paper everywhere else. It goes behind the page, so a gap before the first frame --
     * or a reload -- is never a flash of anything else, and it decides whether the bar icons start dark or
     * light. The page's theme-color takes over once it has loaded (readThemeColour).
     */
    private void applyStartColour() {
        String theme = Build.VERSION.SDK_INT >= 33 ? shellPrefs().getString("theme", "paper") : "paper";
        int colour = ContextCompat.getColor(this, "night".equals(theme) ? R.color.paper_night
                : "mint".equals(theme) ? R.color.paper_mint : R.color.paper);
        findViewById(R.id.root).setBackgroundColor(colour);
        web.setBackgroundColor(colour);
        boolean light = !"night".equals(theme);
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView()).setAppearanceLightStatusBars(light);
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView()).setAppearanceLightNavigationBars(light);
    }

    /** A link to the game, tapped anywhere on the phone, arrives here rather than in the browser. */
    @Override
    protected void onNewIntent(@NonNull Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String url = deepLink(intent);
        if (url != null) web.loadUrl(url);
    }

    /** The WebView keeps its page, its history and the game's state across a rotation or a theme change. */
    @Override
    protected void onSaveInstanceState(@NonNull Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onRestoreInstanceState(@NonNull Bundle in) {
        super.onRestoreInstanceState(in);
        if (web.restoreState(in) == null) web.loadUrl(target(getIntent()));
    }

    @Override
    protected void onDestroy() {
        // Any advertisement the library is still holding goes before the WebView it was drawn in does.
        if (isFinishing() && h5 != null) h5.clearAdObjects();
        // Music and the match socket should stop with the app, not carry on in a detached renderer.
        if (isFinishing()) web.destroy();
        super.onDestroy();
    }

    private void configure(WebView v) {
        WebSettings s = v.getSettings();
        s.setJavaScriptEnabled(true);
        // The game keeps progress, the chosen theme and the sound settings here, and its service worker is
        // what makes a second launch work with no network at all.
        s.setDomStorageEnabled(true);
        // An advertisement is a video that has to start without a second tap, once the player has already
        // asked for it. This is also the WebView's whole autoplay policy, Web Audio included: with it off, the
        // page's AudioContext runs from the first frame with no tap, which is what lets the opening's typing be
        // heard as the app opens. (The game's music still starts with a board, because the game waits for one,
        // not because the WebView would stop it.)
        s.setMediaPlaybackRequiresUserGesture(false);
        // Nothing in this app reads or writes local files, so neither should the page.
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        // window.open becomes an ordinary navigation, which means it passes through the URL policy below
        // instead of silently opening a second window nobody manages.
        s.setSupportMultipleWindows(false);
        // AdMob's WebView integration requires these, and they are set now rather than with the ad code so
        // that what gets tested on a device is the configuration that ships.
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(v, true);
        // How the game and the server know they are in the app rather than in a browser tab. There is no
        // JavaScript bridge yet — nothing needs one until sign-in — and a suffix on the agent string cannot
        // be reached by a third-party frame the way an injected object can.
        // A debug build says so, and that word is what lets the page open its developer settings: the seven
        // taps on the build line do nothing in the release build or on the site, where anybody could tap them.
        //
        // The number is the shell's build. 2 is the one whose splash is Android's own, holds until the page has
        // painted and, on Android 13 and up, is drawn in the player's theme, so the page starts its opening in
        // that theme rather than on paper (the inline script at the top of puzzle/index.html). Any
        // PuzzleApp/<n> is the app to the page (shell.on in js/puzzle.js).
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        s.setUserAgentString(s.getUserAgentString() + " PuzzleApp/2" + (debuggable ? " debug" : ""));
    }

    /** Where to open: a link if we were started by one, the game's own front door otherwise. */
    private String target(@Nullable Intent intent) {
        String link = deepLink(intent);
        return link != null ? link : getString(R.string.launch_url);
    }

    @Nullable
    private String deepLink(@Nullable Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return null;
        Uri data = intent.getData();
        if (data == null) return null;
        String handoff = handoffLink(data);
        if (handoff != null) return handoff;
        return ours(data) ? data.toString() : null;
    }

    /**
     * The browser handing a sign-in back: {@code puzzle://signin?code=…} becomes the game's own URL with
     * {@code #handoff=<code>}, which the page trades, together with the nonce it kept, for a session. The code
     * is checked for shape only; whether it is worth anything is the server's to say. Loading the game's URL
     * with a new fragment is a hash change to a page already showing, and a fresh load otherwise.
     */
    @Nullable
    private String handoffLink(Uri data) {
        if (!"puzzle".equalsIgnoreCase(data.getScheme()) || !"signin".equalsIgnoreCase(data.getHost())) return null;
        String code = data.getQueryParameter("code");
        if (code == null || !code.matches("[a-f0-9]{64}")) return null;
        return getString(R.string.launch_url) + "#handoff=" + code;
    }

    /**
     * Whether a page belongs in this window. Only the game's own origin does; everything else — the privacy
     * policy is a page, a YouTube link is an app, a mailto: is a mail client — is Android's business, and
     * handing it over is also what keeps Google's sign-in out of a WebView it refuses to run in.
     */
    /**
     * Whether this WebView is the thing that should answer a URL, judged by its scheme alone.
     *
     * <p>http and https are the web. about, data and blob are the page talking to itself. javascript: is the
     * page running its own code, and file: is refused by the settings above rather than here. Everything
     * else — intent:, market:, tel:, sms:, mailto:, whatever an advertiser has registered — belongs to some
     * other app, and this one hands it over.
     */
    private static boolean renderable(Uri u) {
        String scheme = u.getScheme();
        if (scheme == null) return true;   // relative to a page we are already showing
        switch (scheme.toLowerCase(Locale.ROOT)) {
            case "http":
            case "https":
            case "about":
            case "data":
            case "blob":
            case "javascript":
            case "file":
                return true;
            default:
                return false;
        }
    }

    /**
     * Ours is the game: https, our host, and the game's own path. The rest of the site -- the privacy policy,
     * the terms, the contact page -- is the site, and it opens in the browser: those pages carry the site's
     * AdSense tag, which may not be shown inside an app, and they are not what a player pressing Back expects
     * to be standing in.
     */
    private boolean ours(Uri u) {
        if (!"https".equalsIgnoreCase(u.getScheme()) || !getString(R.string.host).equalsIgnoreCase(u.getHost())) return false;
        String path = u.getPath();
        return path == null || path.isEmpty() || path.equals("/puzzle") || path.equals("/puzzle/") || path.equals("/puzzle/index.html");
    }

    /**
     * Hand a link that is not ours to whatever on the phone wants it.
     *
     * <p>Most are https and go to the browser. Advertisements are the exception that made this function grow:
     * a great many creatives link out with an {@code intent:} URI — the scheme Chrome defined for "open this
     * in the app if it is installed, and this web page if it is not" — and ACTION_VIEW on one of those is
     * handled by nothing at all. The click did nothing, silently, which for a paid advertisement is the worst
     * of both: the impression was served and the advertiser got no visit.
     *
     * <p>Parsing an intent: URI that came from somebody else's iframe needs care, because the URI can name
     * any component it likes and this app would be the one starting it. So three things are taken away from
     * whatever comes back before it is started: the explicit component, the selector, and any granted URI
     * permissions. What is left can only be resolved the ordinary way, by an intent filter that asked to be
     * BROWSABLE — the same bar a link in the browser has to clear.
     */
    private void openOutside(Uri u) {
        if ("intent".equalsIgnoreCase(u.getScheme())) { openIntentUri(u); return; }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (ActivityNotFoundException nothingHandlesIt) {
            // A phone with no browser and no mail client is not a state worth a dialog about.
        }
    }

    private void openIntentUri(Uri u) {
        Intent wanted;
        try {
            wanted = Intent.parseUri(u.toString(), Intent.URI_INTENT_SCHEME);
        } catch (URISyntaxException notAnIntent) {
            return;
        }
        // The fallback the creative itself named, read before the intent is stripped of its extras' meaning.
        String fallback = wanted.getStringExtra("browser_fallback_url");

        wanted.setComponent(null);
        wanted.setSelector(null);
        wanted.addCategory(Intent.CATEGORY_BROWSABLE);
        wanted.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            startActivity(wanted);
            return;
        } catch (ActivityNotFoundException | SecurityException appIsNotInstalled) {
            // Fall through: the point of the fallback is that this is expected, not exceptional.
        }

        if (fallback != null && !fallback.isEmpty()) {
            Uri page = Uri.parse(fallback);
            // A fallback is a web page. Anything else — another intent: URI, a file — is not followed.
            if ("http".equalsIgnoreCase(page.getScheme()) || "https".equalsIgnoreCase(page.getScheme())) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, page).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                    return;
                } catch (ActivityNotFoundException noBrowser) {
                    return;
                }
            }
            return;
        }

        // No fallback, but the URI named a package: the store page for it is the honest last answer.
        String pkg = wanted.getPackage();
        if (pkg == null || pkg.isEmpty()) return;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + pkg))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (ActivityNotFoundException noStore) {
            // A phone with no Play Store. Nothing more to try.
        }
    }

    /** The splash may go: the page has painted, or is not going to (see pageShown). Only ever on the main thread. */
    private void releaseSplash() {
        pageShown = true;
    }

    /**
     * Hand the WebView to the Mobile Ads SDK.
     *
     * <p>This one call is the reason the app stopped being a Trusted Web Activity. AdMob will not serve an H5
     * game unless the app owns the WebView it runs in, and owning it means being able to pass the instance to
     * {@code registerWebView}. There was no instance to pass when the renderer belonged to Chrome.
     *
     * <p>Nothing here draws an advertisement. The game's own AdSense tag still asks for the breaks; what the
     * registration changes is where the answer comes from — AdMob's demand rather than AdSense's — which is
     * the only arrangement Google's own H5 guide calls policy compliant for a game inside an app you own.
     *
     * <p>The SDK is initialised on a background thread because its first call does disk and network work and
     * would otherwise be done on the way to the first frame. Registration is not: it has to be on the main
     * thread, and it has to be before the page that will ask for an advertisement has loaded.
     */
    private void registerForAds(WebView v) {
        try {
            MobileAds.registerWebView(v);
            new Thread(() -> {
                try {
                    MobileAds.initialize(this, status -> { });
                } catch (RuntimeException noPlayServices) {
                    // A phone without Play services shows no advertisements. It still plays the game.
                }
            }, "ads-init").start();
        } catch (RuntimeException notToday) {
            // Whatever went wrong here, it is not worth a game that will not open.
        }
    }

    /**
     * What a video does when it asks for the whole screen.
     *
     * <p>Without a WebChromeClient the request is simply dropped: the page thinks it went fullscreen, the
     * WebView draws nothing, and a rewarded video advertisement — the one thing this app exists to be paid
     * for — is a black rectangle. The view arrives here instead, goes over everything else in the window,
     * and comes back out the same way.
     */
    private final class Chrome extends WebChromeClient {
        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (fullscreen != null) { callback.onCustomViewHidden(); return; }   // one at a time
            fullscreen = view;
            fullscreenDone = callback;
            ((FrameLayout) findViewById(R.id.root)).addView(view, new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
            findViewById(R.id.content).setVisibility(View.GONE);
            // Back belongs to the advertisement while it is up, whatever the page's history says.
            if (back != null) back.setEnabled(true);
        }

        @Override
        public void onHideCustomView() {
            hideFullscreen();
        }
    }

    private void hideFullscreen() {
        if (fullscreen == null) return;
        ((FrameLayout) findViewById(R.id.root)).removeView(fullscreen);
        fullscreen = null;
        findViewById(R.id.content).setVisibility(View.VISIBLE);
        if (fullscreenDone != null) {
            try {
                fullscreenDone.onCustomViewHidden();
            } catch (RuntimeException alreadyGone) {
                // The player left while it was up. There is nothing to hand back to.
            }
            fullscreenDone = null;
        }
        refreshBack();
    }

    /** Back has somewhere to go while there is a page to ask, history to walk or a video to close. */
    private void refreshBack() {
        if (back != null) back.setEnabled(fullscreen != null || page != null || web.canGoBack());
    }
    /** The document the page channel belongs to, without its fragment: a new one means a new page to hear from. */
    private String pageDoc = "";

    // ── The bridge ────────────────────────────────────────────────────────────────────────────────────
    //
    // window.PuzzleShell in the page, with postMessage and onmessage. Deliberately not
    // addJavascriptInterface: that injects the object into every frame in the WebView, including the
    // advertisements' iframes once they arrive, and this bridge is going to be carrying a sign-in token today
    // and a purchase later. addWebMessageListener takes origin rules, so only our own page ever sees it.
    //
    // Where the feature is missing — a System WebView older than about 2021 — no bridge is installed, nothing
    // throws, and the page keeps saying sign-in is not in the app yet, which is then true.

    private void installBridge(WebView v) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        WebViewCompat.addWebMessageListener(v, "PuzzleShell",
                Collections.singleton("https://" + getString(R.string.host)),
                (view, message, sourceOrigin, isMainFrame, reply) -> {
                    if (!isMainFrame) return;
                    String cmd = message.getData();
                    if (cmd == null) return;
                    page = reply;                         // whichever it was, the page is here and this reaches it
                    refreshBack();
                    if ("signIn".equals(cmd)) signIn(reply);
                    else if ("leave".equals(cmd)) { answer(reply, ok("left", true)); moveTaskToBack(true); }
                    else if (cmd.startsWith("share ")) share(reply, cmd.substring(6));
                    else if ("adTest".equals(cmd)) adSelfTest(reply);
                    else if ("pushState".equals(cmd)) pushState(reply);
                    else if ("pushOn".equals(cmd)) pushOn(reply);
                    else if ("pushOff".equals(cmd)) pushOff(reply);
                    else if ("hello".equals(cmd)) answer(reply, hello());
                    else if (cmd.startsWith("open ")) openInBrowser(reply, cmd.substring(5));
                });
    }

    /**
     * Ask Google for an ID token, natively, and hand it to the page.
     *
     * <p>The page cannot do this itself: Google blocks its OAuth endpoint in an embedded WebView and answers
     * disallowed_useragent. What comes back here is the same shape of thing the browser's own sign-in returns
     * — an ID token whose audience is the web client — so the page posts it to the endpoint it always used and
     * the server checks it the way it always did.
     */
    private void signIn(JavaScriptReplyProxy reply) {
        GetCredentialRequest request;
        try {
            request = new GetCredentialRequest.Builder()
                    .addCredentialOption(new GetGoogleIdOption.Builder()
                            // Show every account on the phone, not only ones that have used this app before:
                            // the first sign-in is the one that matters and it has no history to filter by.
                            .setFilterByAuthorizedAccounts(false)
                            .setServerClientId(getString(R.string.google_web_client_id))
                            .setAutoSelectEnabled(false)
                            .build())
                    .build();
        } catch (RuntimeException wrongShape) {
            answer(reply, fail("failed"));
            return;
        }
        try {
            CredentialManager.create(this).getCredentialAsync(
                    this, request, null, Runnable::run,
                    new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                        @Override public void onResult(GetCredentialResponse response) {
                            String token = tokenOf(response);
                            answer(reply, token == null ? fail("failed") : ok("idToken", token));
                        }

                        @Override public void onError(GetCredentialException e) {
                            String code = e instanceof GetCredentialCancellationException ? "cancelled"
                                    : e instanceof NoCredentialException ? "no_account"
                                    : "failed";
                            JSONObject out = fail(code);
                            try {
                                // What Credential Manager actually said, for the page's console; and the
                                // certificate this build is signed with. "No credentials available" is what
                                // Google answers both when the phone has no Google account and when this
                                // package-and-certificate pair is not an OAuth client in the Cloud project,
                                // and only the fingerprint tells those two apart.
                                String msg = e.getType() + ": " + e.getMessage();
                                out.put("detail", msg.length() > 200 ? msg.substring(0, 200) : msg);
                                String cert = "cancelled".equals(code) ? null : signerSha1();
                                if (cert != null) out.put("cert", cert);
                            } catch (JSONException impossible) {
                                // literal keys, string values
                            }
                            answer(reply, out);
                        }
                    });
        } catch (RuntimeException noPlayServices) {
            // A phone without Play services cannot do this at all, and saying so beats hanging.
            answer(reply, fail("unavailable"));
        }
    }

    /**
     * Open a page of the game in the phone's browser, as a Custom Tab.
     *
     * <p>This is the sign-in for when the native one cannot work: Google answers "no credentials" to a build
     * whose certificate it has not been told about, and it says the same thing to a phone with no account, so
     * the page does not try to tell them apart — it asks for the browser, where Google's own button runs, and
     * the browser hands the account back through {@code puzzle://signin} (see {@link #handoffLink}).
     *
     * <p>Only the game's own origin, over https: the page asks for a tab of itself and nothing else. The
     * browser is named explicitly, because a plain ACTION_VIEW on {@code /puzzle/} would resolve to the one
     * app whose manifest claims that path — this one — and the page would open in the WebView it is trying
     * to leave.
     */
    private void openInBrowser(JavaScriptReplyProxy reply, String raw) {
        Uri u = Uri.parse(raw == null ? "" : raw.trim());
        if (!"https".equalsIgnoreCase(u.getScheme()) || !getString(R.string.host).equalsIgnoreCase(u.getHost())) {
            answer(reply, fail("refused"));
            return;
        }
        String browser = null;
        try { browser = CustomTabsClient.getPackageName(this, null); } catch (RuntimeException cannotAsk) { /* below */ }
        if (browser == null || browser.equals(getPackageName())) browser = defaultBrowser();
        if (browser != null) {
            try {
                CustomTabsIntent tab = new CustomTabsIntent.Builder().setShowTitle(false).build();
                tab.intent.setPackage(browser);
                tab.launchUrl(this, u);
                answer(reply, ok("opened", true));
                return;
            } catch (RuntimeException notAsATab) {
                // A browser with no Custom Tabs service still opens a plain link.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u).setPackage(browser).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                    answer(reply, ok("opened", true));
                    return;
                } catch (RuntimeException notEvenThat) {
                    // the chooser, below
                }
            }
        }
        // No browser could be named: let the phone offer whatever opens https, with this app left out of the
        // list, or the link would come straight back to the WebView it is trying to leave.
        try {
            Intent view = new Intent(Intent.ACTION_VIEW, u);
            Intent chooser = Intent.createChooser(view, null);
            if (Build.VERSION.SDK_INT >= 24) {
                chooser.putExtra(Intent.EXTRA_EXCLUDE_COMPONENTS, new android.content.ComponentName[] { new android.content.ComponentName(this, MainActivity.class) });
            }
            startActivity(chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            answer(reply, ok("opened", true));
        } catch (RuntimeException nothingOpens) {
            answer(reply, fail("no_browser"));
        }
    }

    /**
     * Whatever opens https on this phone, unless that is us: the default handler first, then any browser at
     * all, Chrome preferred, because it is the one whose Custom Tabs behave the same everywhere.
     */
    @Nullable
    private String defaultBrowser() {
        Intent probe = new Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com/")).addCategory(Intent.CATEGORY_BROWSABLE);
        PackageManager pm = getPackageManager();
        try {
            android.content.pm.ResolveInfo r = pm.resolveActivity(probe, PackageManager.MATCH_DEFAULT_ONLY);
            if (r != null && r.activityInfo != null && !getPackageName().equals(r.activityInfo.packageName)
                    && !"android".equals(r.activityInfo.packageName)) return r.activityInfo.packageName;
            String any = null;
            for (android.content.pm.ResolveInfo ri : pm.queryIntentActivities(probe, Build.VERSION.SDK_INT >= 23 ? PackageManager.MATCH_ALL : 0)) {
                if (ri.activityInfo == null) continue;
                String pkg = ri.activityInfo.packageName;
                if (getPackageName().equals(pkg)) continue;
                if ("com.android.chrome".equals(pkg)) return pkg;
                if (any == null) any = pkg;
            }
            return any;
        } catch (RuntimeException cannotAsk) {
            return null;
        }
    }

    /**
     * The SHA-1 of the certificate this build is signed with, written the way Google Cloud's OAuth client
     * form wants it. Null when it cannot be read, which is not something the page has to handle.
     */
    @SuppressWarnings("deprecation")
    private String signerSha1() {
        try {
            android.content.pm.Signature[] sigs;
            if (Build.VERSION.SDK_INT >= 28) {
                android.content.pm.PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
                sigs = pi.signingInfo == null ? null : pi.signingInfo.getApkContentsSigners();
            } else {
                sigs = getPackageManager().getPackageInfo(getPackageName(), PackageManager.GET_SIGNATURES).signatures;
            }
            if (sigs == null || sigs.length == 0) return null;
            byte[] d = java.security.MessageDigest.getInstance("SHA-1").digest(sigs[0].toByteArray());
            StringBuilder sb = new StringBuilder();
            for (byte b : d) {
                if (sb.length() > 0) sb.append(':');
                sb.append(String.format("%02X", b));
            }
            return sb.toString();
        } catch (Exception cannot) {
            return null;
        }
    }

    private static String tokenOf(GetCredentialResponse response) {
        try {
            if (!(response.getCredential() instanceof CustomCredential)) return null;
            CustomCredential c = (CustomCredential) response.getCredential();
            if (!GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(c.getType())) return null;
            return GoogleIdTokenCredential.createFrom(c.getData()).getIdToken();
        } catch (RuntimeException notOne) {
            return null;
        }
    }

    /**
     * Load Google's own page for checking that this WebView is joined to the Mobile Ads SDK.
     *
     * <p>It is the only way, from a phone, to tell two quite different problems apart. Green bars mean
     * {@link MobileAds#registerWebView} worked and the page really is talking to the SDK, so anything still
     * missing is on the account side — an approval not yet granted, an app not yet reviewed — and no amount
     * of changing this code will help. Red means the fault is here, and waiting will never fix it.
     *
     * <p>It is reached only from the developer group in Settings, which takes seven taps to reveal, and the
     * page is loaded rather than opened in a browser on purpose: a browser tab is not this WebView, and this
     * WebView is the thing being asked about. Back returns to the game, because the game is still in the
     * WebView's history behind it.
     */
    private void adSelfTest(JavaScriptReplyProxy reply) {
        answer(reply, ok("opened", true));
        new Handler(Looper.getMainLooper()).post(() -> {
            away = true;
            web.loadUrl("https://google.github.io/webview-ads/test/#api-for-ads-tests");
        });
    }

    // ── Notifications ─────────────────────────────────────────────────────────────────────────────────
    //
    // A WebView has no Push API, so the page cannot subscribe the way a browser does. What a phone has is
    // Firebase Cloud Messaging, and what FCM hands an app is one string, the registration token, which is the
    // address the server sends to. Three commands carry it. pushState says what this phone already has; pushOn
    // asks Android for permission (once, on 13 and up) and Firebase for the token, and hands it over; pushOff
    // lets the token go. The page posts the token to the account -- nothing here talks to our server.
    //
    // Every one of them answers "unavailable" honestly when the app was built without google-services.json,
    // because there is then no Firebase project for the library to belong to. See android/README.md.

    /** What the bridge's hello says this build can do. The page shows or hides its switches by it. */
    /** Something the app says unasked: {"event": name}. The page tells it apart from a reply by the key. */
    private static JSONObject event(String name) {
        JSONObject o = new JSONObject();
        try {
            o.put("event", name);
        } catch (JSONException impossible) {
            // A literal key and a string.
        }
        return o;
    }

    /** The phone's own share sheet, for a result or an invitation: what navigator.share is in a browser. */
    private void share(JavaScriptReplyProxy reply, String text) {
        try {
            Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text);
            startActivity(Intent.createChooser(send, null));
            answer(reply, ok("shared", true));
        } catch (RuntimeException nothingToShareWith) {
            answer(reply, fail("no_share"));
        }
    }

    private JSONObject hello() {
        JSONObject o = ok("signIn", true);
        try {
            o.put("push", firebaseReady());
            o.put("open", true);   // this build can open the browser for a sign-in
        } catch (JSONException impossible) {
            // A literal key and a boolean.
        }
        return o;
    }

    private boolean firebaseReady() {
        try {
            return !FirebaseApp.getApps(this).isEmpty();
        } catch (RuntimeException notEvenThat) {
            return false;
        }
    }

    private SharedPreferences pushPrefs() {
        return PuzzleMessagingService.prefs(this);
    }

    private boolean notifyGranted() {
        return Build.VERSION.SDK_INT < 33
                || ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                        == PackageManager.PERMISSION_GRANTED;
    }

    private void pushState(JavaScriptReplyProxy reply) {
        JSONObject o = ok("available", firebaseReady());
        try {
            o.put("granted", notifyGranted());
            o.put("enabled", PuzzleMessagingService.canPost(this));
            o.put("on", pushPrefs().getBoolean(PuzzleMessagingService.PREF_ON, false));
            o.put("token", pushPrefs().getString(PuzzleMessagingService.PREF_TOKEN, ""));
        } catch (JSONException impossible) {
            // Literal keys; booleans and a string.
        }
        answer(reply, o);
    }

    private void pushOn(JavaScriptReplyProxy reply) {
        if (!firebaseReady()) { answer(reply, fail("unavailable")); return; }
        if (!notifyGranted()) {
            if (notifyWaiting != null) { answer(reply, fail("busy")); return; }
            notifyWaiting = reply;
            // On the main thread, whichever thread the bridge delivered the ask on: a dialog is a view.
            new Handler(Looper.getMainLooper()).post(() -> {
                try {
                    askToNotify.launch(Manifest.permission.POST_NOTIFICATIONS);
                } catch (RuntimeException couldNotAsk) {
                    notifyWaiting = null;
                    answer(reply, fail("failed"));
                }
            });
            return;
        }
        fetchToken(reply);
    }

    /** The token from Firebase, minted if this phone has none yet, and remembered so pushState can say so. */
    private void fetchToken(JavaScriptReplyProxy reply) {
        try {
            FirebaseMessaging fm = FirebaseMessaging.getInstance();
            // Auto-init is off in the manifest, so the library mints and refreshes tokens only for a phone
            // whose player has turned the switch on. A player who never does never has Firebase spoken to.
            fm.setAutoInitEnabled(true);
            fm.getToken().addOnCompleteListener(task -> {
                String token = task.isSuccessful() ? task.getResult() : null;
                if (token == null || token.isEmpty()) { answer(reply, fail("failed")); return; }
                pushPrefs().edit()
                        .putString(PuzzleMessagingService.PREF_TOKEN, token)
                        .putBoolean(PuzzleMessagingService.PREF_ON, true)
                        .apply();
                answer(reply, ok("token", token));
            });
        } catch (RuntimeException noFirebase) {
            answer(reply, fail("unavailable"));
        }
    }

    /**
     * Off means off on this phone: the switch, and the token Firebase would have delivered to. The old token
     * goes back to the page so it can drop the server's row; the library is told to stop minting new ones.
     */
    private void pushOff(JavaScriptReplyProxy reply) {
        SharedPreferences p = pushPrefs();
        boolean was = p.getBoolean(PuzzleMessagingService.PREF_ON, false);
        String token = p.getString(PuzzleMessagingService.PREF_TOKEN, "");
        p.edit().putBoolean(PuzzleMessagingService.PREF_ON, false).remove(PuzzleMessagingService.PREF_TOKEN).apply();
        if (was && firebaseReady()) {
            try {
                FirebaseMessaging fm = FirebaseMessaging.getInstance();
                fm.setAutoInitEnabled(false);
                fm.deleteToken();
            } catch (RuntimeException alreadyGone) {
                // Forgotten here either way; Firebase reports it dead the first time it is sent to.
            }
        }
        answer(reply, ok("token", was ? token : ""));
    }

    private static JSONObject ok(String key, Object value) {
        return body(true, key, value);
    }

    private static JSONObject fail(String error) {
        return body(false, "error", error);
    }

    /** Built rather than concatenated, so a token can never carry a quote into the page's JSON.parse. */
    private static JSONObject body(boolean ok, String key, Object value) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", ok);
            if (key != null) o.put(key, value);
        } catch (JSONException impossible) {
            // The keys are literals; the values are a boolean and a string.
        }
        return o;
    }

    /**
     * Reply on the main thread, because the credential callback does not arrive on it, and swallow whatever
     * a reply to a page that has since navigated away throws. Nothing here is worth an app.
     */
    private void answer(JavaScriptReplyProxy reply, JSONObject body) {
        String json = body.toString();
        new Handler(Looper.getMainLooper()).post(() -> {
            try {
                reply.postMessage(json);
            } catch (RuntimeException pageIsGone) {
                // The player closed the sheet, or the page reloaded. There is nobody to tell.
            }
        });
    }

    private final class Client extends WebViewClient {

        private final OnBackPressedCallback back;

        Client(OnBackPressedCallback back) {
            this.back = back;
        }

        @Override
        public boolean shouldOverrideUrlLoading(@NonNull WebView v, @NonNull WebResourceRequest r) {
            // A scheme this WebView cannot draw is nobody's navigation — it is a request for something else
            // on the phone, and that is as true inside an advertisement's iframe as it is in the main frame.
            // intent:, market:, tel:, mailto: are how a creative links out to the thing it is selling. Left
            // to the WebView they load nothing at all and the click is lost, which is the one outcome that
            // costs the advertiser and us both.
            //
            // With one condition: somebody has to have touched the screen. A navigation to another app is
            // started by script as easily as by a finger, and a creative that fires one on load would put
            // the Play Store in front of a player who tapped nothing. hasGesture is the same test Chrome
            // applies before it follows one of these, and a request without one is dropped rather than
            // handed on — dropped quietly, because the page did not ask the player anything to begin with.
            if (!renderable(r.getUrl())) {
                if (r.hasGesture()) openOutside(r.getUrl());
                return true;
            }
            // Everything else in a sub-frame is left alone. An advertisement is an iframe on somebody else's
            // origin, and a policy that sent every foreign frame to the browser would send the ads there too.
            if (!r.isForMainFrame()) return false;
            if (ours(r.getUrl())) return false;
            openOutside(r.getUrl());
            return true;
        }

        /**
         * The first frame the page actually paints — the honest moment to take the splash away. It arrives
         * while the splash is still holding every frame back: in a WebView the page's frame is ready (the
         * compositor has it) before it is drawn, and this is called then, not after.
         */
        @Override
        public void onPageCommitVisible(@NonNull WebView v, @NonNull String url) {
            releaseSplash();
        }

        @Override
        public void doUpdateVisitedHistory(@NonNull WebView v, @NonNull String url, boolean reload) {
            // A hash change is the same page routing; anything else is a new document, whose own hello will
            // hand over a channel of its own. The old one would only throw.
            String doc = url.replaceFirst("#.*$", "");
            if (!doc.equals(pageDoc)) { pageDoc = doc; page = null; }
            refreshBack();
        }

        /**
         * Ask the page whether it is the game.
         *
         * <p>onReceivedError is not enough on its own, which a phone proved: with the service worker in
         * control, a failed load comes back as the worker's fetch handler rejecting, the WebView paints its
         * own "Web page not available" over everything, and what the client is told about it is not
         * dependable. So rather than trusting a callback, this looks for something only the game has. It
         * catches the WebView's error page, a worker that rejected, and a page served from somewhere
         * unexpected, and because it runs on every finished load it puts the game back by itself the moment
         * one succeeds.
         */
        @Override
        public void onPageFinished(@NonNull WebView v, @NonNull String url) {
            // A page we asked for ourselves is not an outage, whatever is on it. The check below looks for
            // something only the game has, so without this the developer's own diagnostic page would be
            // covered by "you are offline" — which is both wrong and the exact opposite of a diagnostic.
            Uri here = Uri.parse(url == null ? "" : url);
            if (away && ours(here)) away = false;
            if (away) { releaseSplash(); offline.setVisibility(View.GONE); return; }
            v.evaluateJavascript("!!document.getElementById('aaPlay')", value -> {
                boolean isTheGame = "true".equals(value);
                releaseSplash();
                offline.setVisibility(isTheGame ? View.GONE : View.VISIBLE);
                if (isTheGame) readThemeColour();
            });
        }

        /** The fast path: say so before the error page has even finished drawing. onPageFinished decides. */
        @Override
        public void onReceivedError(@NonNull WebView v, @NonNull WebResourceRequest r,
                                    @NonNull WebResourceError e) {
            if (!r.isForMainFrame()) return;
            // The splash has to go too, or the failure hides behind it and the app looks hung.
            releaseSplash();
            offline.setVisibility(View.VISIBLE);
        }
    }
}

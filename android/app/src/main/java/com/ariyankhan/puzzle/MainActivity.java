package com.ariyankhan.puzzle;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
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
import android.widget.ImageView;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.graphics.Insets;
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
import com.google.android.libraries.identity.googleid.GetGoogleIdOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;

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
    private ImageView splash;
    private boolean splashGone;

    /** The view a fullscreen video hands us, and the callback that takes it back. Null when none is up. */
    private View fullscreen;
    private WebChromeClient.CustomViewCallback fullscreenDone;
    private OnBackPressedCallback back;

    @Override
    protected void onCreate(@Nullable Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_main);

        web = findViewById(R.id.web);
        offline = findViewById(R.id.offline);
        splash = findViewById(R.id.splash);

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

        configure(web);
        findViewById(R.id.retry).setOnClickListener(v -> {
            offline.setVisibility(View.GONE);
            web.reload();
        });

        // Back walks the game's own history first. The callback starts disabled and is only switched on while
        // there is something to go back to, which leaves the last press to the system: that is what lets
        // Android 16's predictive back animate the app closing instead of it vanishing.
        back = new OnBackPressedCallback(false) {
            @Override public void handleOnBackPressed() {
                // A fullscreen advertisement is the thing back should close, and it is the one state where
                // there is nothing in the WebView's history to go back to — so it has to be asked about
                // first, or back would leave the app with an advertisement still on the screen.
                if (fullscreen != null) { hideFullscreen(); return; }
                if (web.canGoBack()) web.goBack();
            }
        };
        getOnBackPressedDispatcher().addCallback(this, back);
        web.setWebViewClient(new Client(back));
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
        web.resumeTimers();
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
     * <p>A WebView left alone carries on: animations keep drawing, timers keep firing, and — the reason this
     * matters now — a video keeps playing. An advertisement is a video. Without this, a player who takes a
     * call or goes to another app halfway through a rewarded advertisement leaves it talking out of a phone
     * they are no longer looking at, which is the kind of thing people uninstall an app over and Play takes
     * complaints about.
     *
     * <p>onPause stops this WebView's own work; pauseTimers stops the JavaScript clock, which is process-wide
     * and would be rude if this app had a second WebView. It has one.
     */
    @Override
    protected void onPause() {
        // Before super, so nothing is still drawing or sounding by the time the activity is told it is gone.
        web.onPause();
        web.pauseTimers();
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
                        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView())
                                .setAppearanceLightStatusBars(light);
                        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView())
                                .setAppearanceLightNavigationBars(light);
                    } catch (RuntimeException notAColour) {
                        // Leave the bars as they are.
                    }
                });
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
        // asked for it. The game's own music still waits for a gesture, because the browser's autoplay rules
        // for audio are separate from this flag.
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
        s.setUserAgentString(s.getUserAgentString() + " PuzzleApp/1");
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
        return data != null && ours(data) ? data.toString() : null;
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

    private boolean ours(Uri u) {
        return "https".equalsIgnoreCase(u.getScheme())
                && getString(R.string.host).equalsIgnoreCase(u.getHost());
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

    private void hideSplash() {
        if (splashGone) return;
        splashGone = true;
        // The same 240ms the Trusted Web Activity faded over, so the way in looks no different than before.
        splash.animate().alpha(0f).setDuration(240)
                .withEndAction(() -> splash.setVisibility(View.GONE)).start();
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
     * for — is a black rectangle. The view arrives here instead, goes over everything including the splash,
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
        if (back != null) back.setEnabled(web.canGoBack());
    }

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
                    if ("signIn".equals(cmd)) signIn(reply);
                    else if ("hello".equals(cmd)) answer(reply, ok("signIn", true));
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
                            answer(reply, fail(
                                    e instanceof GetCredentialCancellationException ? "cancelled"
                                            : e instanceof NoCredentialException ? "no_account"
                                            : "failed"));
                        }
                    });
        } catch (RuntimeException noPlayServices) {
            // A phone without Play services cannot do this at all, and saying so beats hanging.
            answer(reply, fail("unavailable"));
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

        /** The first frame the page actually paints — the honest moment to take the splash away. */
        @Override
        public void onPageCommitVisible(@NonNull WebView v, @NonNull String url) {
            hideSplash();
        }

        @Override
        public void doUpdateVisitedHistory(@NonNull WebView v, @NonNull String url, boolean reload) {
            back.setEnabled(v.canGoBack());
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
            v.evaluateJavascript("!!document.getElementById('aaPlay')", value -> {
                boolean isTheGame = "true".equals(value);
                hideSplash();
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
            hideSplash();
            offline.setVisibility(View.VISIBLE);
        }
    }
}

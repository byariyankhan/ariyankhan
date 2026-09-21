package com.ariyankhan.puzzle;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ImageView;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;

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
        OnBackPressedCallback back = new OnBackPressedCallback(false) {
            @Override public void handleOnBackPressed() {
                if (web.canGoBack()) web.goBack();
            }
        };
        getOnBackPressedDispatcher().addCallback(this, back);
        web.setWebViewClient(new Client(back));

        if (state == null) web.loadUrl(target(getIntent()));
    }

    @Override
    protected void onResume() {
        super.onResume();
        // A theme picked in Settings changes the page's theme-color without a navigation, so the bars would
        // keep the old contrast until something asked again. Leaving the app and coming back asks again.
        readThemeColour();
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
                    // evaluateJavascript hands back a JSON string, quotes and all.
                    String hex = value == null ? "" : value.replace("\"", "").trim();
                    int colour;
                    try {
                        colour = Color.parseColor(hex);
                    } catch (IllegalArgumentException notAColour) {
                        return;
                    }
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
    private boolean ours(Uri u) {
        return "https".equalsIgnoreCase(u.getScheme())
                && getString(R.string.host).equalsIgnoreCase(u.getHost());
    }

    private void openOutside(Uri u) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (ActivityNotFoundException nothingHandlesIt) {
            // A phone with no browser and no mail client is not a state worth a dialog about.
        }
    }

    private void hideSplash() {
        if (splashGone) return;
        splashGone = true;
        // The same 240ms the Trusted Web Activity faded over, so the way in looks no different than before.
        splash.animate().alpha(0f).setDuration(240)
                .withEndAction(() -> splash.setVisibility(View.GONE)).start();
    }

    private final class Client extends WebViewClient {

        private final OnBackPressedCallback back;

        Client(OnBackPressedCallback back) {
            this.back = back;
        }

        @Override
        public boolean shouldOverrideUrlLoading(@NonNull WebView v, @NonNull WebResourceRequest r) {
            // Sub-frames are left alone. An advertisement is an iframe on somebody else's origin, and a
            // policy that sent every foreign frame to the browser would send the ads there too.
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

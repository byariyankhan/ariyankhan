<?php
declare(strict_types=1);

/*
|--------------------------------------------------------------------------
| Ariyan Khan — YouTube Channel Smart Opener
|--------------------------------------------------------------------------
|
| Public URL:
| https://youtube.ariyankhan.com
|
| YouTube channel:
| https://www.youtube.com/@ariyankhan
|
*/

/*
|--------------------------------------------------------------------------
| Configuration
|--------------------------------------------------------------------------
*/

$channelHandle = '@ariyankhan';
$channelId = 'UCBDRhWxsMMcgS4TAPeRlrQw';
$channelUrl = 'https://www.youtube.com/' . $channelHandle;
$channelIdUrl = 'https://www.youtube.com/channel/' . $channelId;
$videoId = '2z_qrG-5Gz8';
$videoStartSeconds = 2;
$videoStart = $videoStartSeconds . 's';
$youtubeVideoUrl = 'https://www.youtube.com/watch?v=' . $videoId . '&t=' . $videoStart;
$youtubeVideoPlainUrl = 'https://www.youtube.com/watch?v=' . $videoId;
$smartLinkUrl = 'https://youtube.ariyankhan.com/spain';
$socialFallbackUrl = $smartLinkUrl . '?fallback=1';
$thumbnailPath = '/assets/spain-thumbnail.png';
$thumbnailUrl = 'https://youtube.ariyankhan.com' . $thumbnailPath;
$mainWebsiteUrl = 'https://ariyankhan.com/';
$videoTitle = 'Why 70% of Spain Is Empty Now?';
$seoTitle = $videoTitle . ' | Ariyan Khan';
$profileDescription = 'Ariyan Khan makes documentary-style videos about geography, history, culture, and economy.';
$seoDescription = 'Watch Ariyan Khan\'s Spain video: why 70% of Spain is empty now, explained through geography, history, population, culture, and economy.';
$structuredData = [
    [
        '@context' => 'https://schema.org',
        '@type' => 'VideoObject',
        '@id' => $smartLinkUrl . '#video',
        'name' => $videoTitle,
        'description' => $seoDescription,
        'thumbnailUrl' => [
            $thumbnailUrl,
        ],
        'url' => $smartLinkUrl,
        'contentUrl' => $youtubeVideoPlainUrl,
        'embedUrl' => 'https://www.youtube.com/embed/' . $videoId,
        'inLanguage' => 'en',
        'publisher' => [
            '@type' => 'Person',
            'name' => 'Ariyan Khan',
            'url' => $mainWebsiteUrl,
            'sameAs' => [
                $channelUrl,
                $channelIdUrl,
            ],
        ],
        'about' => [
            'Spain',
            'Spain population',
            'Empty Spain',
            'Geography',
            'History',
            'Culture',
            'Economy',
        ],
        'potentialAction' => [
            '@type' => 'WatchAction',
            'target' => $youtubeVideoUrl,
        ],
    ],
    [
        '@context' => 'https://schema.org',
        '@type' => 'ProfilePage',
        '@id' => 'https://youtube.ariyankhan.com/#profile',
        'url' => 'https://youtube.ariyankhan.com/',
        'name' => 'Ariyan Khan on YouTube',
        'description' => $profileDescription,
        'mainEntity' => [
            '@type' => 'Person',
            '@id' => 'https://youtube.ariyankhan.com/#ariyan-khan',
            'name' => 'Ariyan Khan',
            'url' => $mainWebsiteUrl,
            'description' => $profileDescription,
            'sameAs' => [
                $mainWebsiteUrl,
                $channelUrl,
                $channelIdUrl,
            ],
            'knowsAbout' => [
                'Geography',
                'History',
                'Culture',
                'Economy',
                'Documentary videos',
                'Spain',
            ],
        ],
    ],
    [
        '@context' => 'https://schema.org',
        '@type' => 'BreadcrumbList',
        '@id' => $smartLinkUrl . '#breadcrumb',
        'itemListElement' => [
            [
                '@type' => 'ListItem',
                'position' => 1,
                'name' => 'Ariyan Khan',
                'item' => 'https://youtube.ariyankhan.com/',
            ],
            [
                '@type' => 'ListItem',
                'position' => 2,
                'name' => 'Spain',
                'item' => $smartLinkUrl,
            ],
        ],
    ],
];

/*
|--------------------------------------------------------------------------
| Android YouTube Intent
|--------------------------------------------------------------------------
|
| App installed:
| Opens the official YouTube Android app.
|
| App not installed:
| Opens the YouTube channel in the browser.
|
*/

$androidIntent =
    'intent://www.youtube.com/watch?v=' . $videoId . '&t=' . $videoStart .
    '#Intent;' .
    'scheme=https;' .
    'package=com.google.android.youtube;' .
    'action=android.intent.action.VIEW;' .
    'category=android.intent.category.BROWSABLE;' .
    'S.browser_fallback_url=' . rawurlencode($youtubeVideoUrl) . ';' .
    'end;';

$androidIntentNoFallback =
    'intent://www.youtube.com/watch?v=' . $videoId . '&t=' . $videoStart .
    '#Intent;' .
    'scheme=https;' .
    'package=com.google.android.youtube;' .
    'action=android.intent.action.VIEW;' .
    'category=android.intent.category.BROWSABLE;' .
    'end;';

$androidOpenInAppStyleIntent =
    'intent://www.youtube.com/watch?v=' . $videoId . '&t=' . $videoStart .
    '#Intent;' .
    'scheme=https;' .
    'S.browser_fallback_url=' . rawurlencode($socialFallbackUrl) . ';' .
    'end;';

$iosAppUrls = [
    'youtube://watch?v=' . $videoId . '&t=' . $videoStart,
    'vnd.youtube://watch?v=' . $videoId . '&t=' . $videoStart,
    $youtubeVideoUrl,
];

/*
|--------------------------------------------------------------------------
| First-party analytics endpoint
|--------------------------------------------------------------------------
|
| JavaScript sends tiny same-origin beacons for page view, attempts,
| failures, and fallback clicks. If logging is unavailable, the page
| still works normally.
|
*/

if (isset($_GET['__smart_event'])) {
    $eventName = preg_replace(
        '/[^a-z0-9_-]/i',
        '',
        (string) $_GET['__smart_event']
    );

    if ($eventName === '') {
        $eventName = 'unknown';
    }

    $analyticsLog = dirname(__DIR__) . '/tmp/youtube-smart-link-events.jsonl';

    $analyticsEvent = [
        'time' => gmdate('c'),
        'event' => $eventName,
        'platform' => substr((string) ($_GET['platform'] ?? ''), 0, 32),
        'source' => substr((string) ($_GET['source'] ?? ''), 0, 64),
        'attempt' => substr((string) ($_GET['attempt'] ?? ''), 0, 32),
        'url' => substr((string) ($_GET['url'] ?? ''), 0, 512),
        'referrer' => substr((string) ($_SERVER['HTTP_REFERER'] ?? ''), 0, 512),
        'user_agent' => substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 300),
        'ip_hash' => hash(
            'sha256',
            ((string) ($_SERVER['REMOTE_ADDR'] ?? '')) .
            '|youtube.ariyankhan.com'
        ),
    ];

    $analyticsDir = dirname($analyticsLog);

    if (is_dir($analyticsDir) && is_writable($analyticsDir)) {
        file_put_contents(
            $analyticsLog,
            json_encode($analyticsEvent, JSON_UNESCAPED_SLASHES) . PHP_EOL,
            FILE_APPEND | LOCK_EX
        );
    }

    header('Content-Type: text/plain; charset=UTF-8');
    header('Cache-Control: no-store, max-age=0');
    http_response_code(204);
    exit;
}

/*
|--------------------------------------------------------------------------
| Security nonce
|--------------------------------------------------------------------------
*/

try {
    $nonce = rtrim(
        strtr(
            base64_encode(random_bytes(18)),
            '+/',
            '-_'
        ),
        '='
    );
} catch (Throwable $exception) {
    $nonce = bin2hex((string) microtime(true));
}

/*
|--------------------------------------------------------------------------
| Security and response headers
|--------------------------------------------------------------------------
*/

header('Content-Type: text/html; charset=UTF-8');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: no-referrer');
header('Permissions-Policy: camera=(), microphone=(), geolocation=()');
header('Cross-Origin-Opener-Policy: same-origin');
header('Cache-Control: no-store, max-age=0');

header(
    "Content-Security-Policy: " .
    "default-src 'none'; " .
    "script-src 'nonce-{$nonce}'; " .
    "style-src 'nonce-{$nonce}'; " .
    "connect-src 'self'; " .
    "img-src 'self' data:; " .
    "base-uri 'none'; " .
    "form-action 'none'; " .
    "frame-ancestors 'none'; " .
    "object-src 'none';"
);

$isHttps =
    isset($_SERVER['HTTPS']) &&
    $_SERVER['HTTPS'] !== '' &&
    strtolower((string) $_SERVER['HTTPS']) !== 'off';

if ($isHttps) {
    header('Strict-Transport-Security: max-age=31536000');
}
?>
<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">

    <meta
        name="viewport"
        content="width=device-width, initial-scale=1, viewport-fit=cover"
    >

    <title><?= htmlspecialchars(
        $seoTitle,
        ENT_QUOTES,
        'UTF-8'
    ) ?></title>

    <meta
        name="description"
        content="<?= htmlspecialchars(
            $seoDescription,
            ENT_QUOTES,
            'UTF-8'
        ) ?>"
    >

    <meta
        name="robots"
        content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1"
    >

    <meta name="author" content="Ariyan Khan">
    <meta
        name="keywords"
        content="Spain, Spain empty, empty Spain, why 70% of Spain is empty, Ariyan Khan Spain, Spain geography, Spain population"
    >
    <meta name="theme-color" content="#0F0F0F">

    <!-- Open Graph preview -->

    <meta property="og:type" content="video.other">

    <meta
        property="og:title"
        content="<?= htmlspecialchars(
            $seoTitle,
            ENT_QUOTES,
            'UTF-8'
        ) ?>"
    >

    <meta
        property="og:description"
        content="<?= htmlspecialchars(
            $seoDescription,
            ENT_QUOTES,
            'UTF-8'
        ) ?>"
    >

    <meta
        property="og:url"
        content="<?= htmlspecialchars(
            $smartLinkUrl,
            ENT_QUOTES,
            'UTF-8'
        ) ?>"
    >

    <meta
        property="og:site_name"
        content="Ariyan Khan"
    >

    <meta
        property="og:image"
        content="<?= htmlspecialchars(
            $thumbnailUrl,
            ENT_QUOTES,
            'UTF-8'
        ) ?>"
    >

    <meta
        property="og:image:secure_url"
        content="<?= htmlspecialchars(
            $thumbnailUrl,
            ENT_QUOTES,
            'UTF-8'
        ) ?>"
    >

    <meta property="og:image:type" content="image/png">
    <meta property="og:image:width" content="1600">
    <meta property="og:image:height" content="900">

    <meta
        property="og:image:alt"
        content="Thumbnail for Ariyan Khan's Spain video: Why 70% of Spain Is Empty Now?"
    >

    <meta
        property="og:video:url"
        content="<?= htmlspecialchars(
            $youtubeVideoUrl,
            ENT_QUOTES,
            'UTF-8'
        ) ?>"
    >

    <!-- X / Twitter preview -->

    <meta name="twitter:card" content="summary_large_image">

    <meta
        name="twitter:title"
        content="<?= htmlspecialchars(
            $seoTitle,
            ENT_QUOTES,
            'UTF-8'
        ) ?>"
    >

    <meta
        name="twitter:description"
        content="<?= htmlspecialchars(
            $seoDescription,
            ENT_QUOTES,
            'UTF-8'
        ) ?>"
    >

    <meta
        name="twitter:image"
        content="<?= htmlspecialchars(
            $thumbnailUrl,
            ENT_QUOTES,
            'UTF-8'
        ) ?>"
    >

    <meta
        name="twitter:image:alt"
        content="Spain map thumbnail for Ariyan Khan's video"
    >

    <link
        rel="canonical"
        href="<?= htmlspecialchars(
            $smartLinkUrl,
            ENT_QUOTES,
            'UTF-8'
        ) ?>"
    >

    <script
        type="application/ld+json"
        nonce="<?= htmlspecialchars(
            $nonce,
            ENT_QUOTES,
            'UTF-8'
        ) ?>"
    ><?= json_encode(
        $structuredData,
        JSON_UNESCAPED_SLASHES |
        JSON_UNESCAPED_UNICODE |
        JSON_PRETTY_PRINT |
        JSON_HEX_TAG |
        JSON_HEX_AMP |
        JSON_HEX_APOS |
        JSON_HEX_QUOT
    ) ?></script>

    <style nonce="<?= htmlspecialchars(
        $nonce,
        ENT_QUOTES,
        'UTF-8'
    ) ?>">
        :root {
            --youtube-red: #FF0000;
            --youtube-red-hover: #CC0000;
            --youtube-background: #0F0F0F;
            --youtube-surface: #212121;
            --youtube-surface-light: #272727;
            --youtube-border: #3F3F3F;
            --youtube-white: #F1F1F1;
            --youtube-muted: #AAAAAA;

            color-scheme: dark;

            font-family:
                Roboto,
                Arial,
                Helvetica,
                sans-serif;
        }

        * {
            box-sizing: border-box;
        }

        html {
            min-height: 100%;
            background: var(--youtube-background);
        }

        body {
            min-height: 100vh;
            min-height: 100svh;

            margin: 0;

            padding:
                max(24px, env(safe-area-inset-top))
                max(20px, env(safe-area-inset-right))
                max(24px, env(safe-area-inset-bottom))
                max(20px, env(safe-area-inset-left));

            display: grid;
            place-items: center;

            overflow-x: hidden;

            background:
                radial-gradient(
                    circle at 50% 25%,
                    rgba(255, 0, 0, 0.13),
                    transparent 36%
                ),
                radial-gradient(
                    circle at 15% 90%,
                    rgba(255, 255, 255, 0.025),
                    transparent 34%
                ),
                var(--youtube-background);

            color: var(--youtube-white);
            text-align: center;
        }

        .page {
            width: 100%;
            max-width: min(430px, calc(100vw - 32px));
            min-width: 0;
        }

        .card {
            position: relative;

            width: 100%;

            padding: 18px 18px 28px;

            overflow: hidden;

            border: 1px solid var(--youtube-border);
            border-radius: 22px;

            background:
                linear-gradient(
                    145deg,
                    rgba(255, 255, 255, 0.025),
                    transparent 45%
                ),
                var(--youtube-surface);

            box-shadow:
                0 30px 90px rgba(0, 0, 0, 0.46);
        }

        .card::before {
            content: "";

            position: absolute;
            top: 0;
            left: 0;

            width: 100%;
            height: 3px;

            background: var(--youtube-red);
        }

        .thumbnail {
            position: relative;

            width: 100%;
            aspect-ratio: 16 / 9;

            margin: 0 0 22px;

            overflow: hidden;

            border-radius: 14px;

            background: #111111;
        }

        .thumbnail img {
            width: 100%;
            height: 100%;

            display: block;

            object-fit: cover;
        }

        .video-play {
            position: absolute;
            left: 50%;
            top: 50%;

            width: 62px;
            height: 44px;

            display: grid;
            place-items: center;

            border-radius: 12px;

            background: rgba(255, 0, 0, 0.92);

            transform: translate(-50%, -50%);
        }

        .video-play svg {
            width: 25px;
            height: 25px;

            margin-left: 3px;

            fill: #FFFFFF;
        }

        .youtube-logo {
            width: 90px;
            height: 64px;

            margin: 0 auto 26px;

            display: grid;
            place-items: center;

            border-radius: 18px;

            background: var(--youtube-red);

            box-shadow:
                0 12px 35px rgba(255, 0, 0, 0.25);
        }

        .youtube-logo svg {
            width: 38px;
            height: 38px;

            margin-left: 4px;

            fill: #FFFFFF;
        }

        h1 {
            margin: 0;

            color: var(--youtube-white);

            font-size: clamp(25px, 6.4vw, 32px);
            font-weight: 700;
            line-height: 1.12;
            letter-spacing: 0;
        }

        .channel-name {
            margin: 10px 0 0;

            color: var(--youtube-white);

            font-size: 17px;
            font-weight: 500;
        }

        .description {
            max-width: 340px;

            margin: 12px auto 24px;

            color: var(--youtube-muted);

            font-size: 15px;
            line-height: 1.6;
        }

        .profile-summary {
            margin: -6px auto 24px;
            max-width: 340px;

            color: #CFCFCF;

            font-size: 13px;
            line-height: 1.55;
        }

        .profile-summary p {
            margin: 0;
        }

        .status {
            min-height: 28px;

            margin-bottom: 24px;

            display: flex;
            align-items: center;
            justify-content: center;
            gap: 11px;

            color: var(--youtube-muted);

            font-size: 14px;
            font-weight: 500;
            line-height: 1.35;
        }

        #status-text {
            min-width: 0;
        }

        .spinner {
            width: 18px;
            height: 18px;

            flex: 0 0 auto;

            border: 2px solid rgba(255, 255, 255, 0.18);
            border-top-color: var(--youtube-red);
            border-radius: 50%;

            animation: spinner-rotation 0.8s linear infinite;
        }

        @keyframes spinner-rotation {
            to {
                transform: rotate(360deg);
            }
        }

        .button {
            width: 100%;
            min-height: 54px;

            padding: 15px 20px;

            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;

            border: 0;
            border-radius: 12px;

            background: var(--youtube-red);
            color: #FFFFFF;

            font: inherit;
            font-size: 16px;
            font-weight: 700;
            line-height: 1.2;
            text-decoration: none;
            overflow: hidden;

            cursor: pointer;

            transition:
                background-color 160ms ease,
                transform 160ms ease,
                box-shadow 160ms ease;
        }

        .button:hover {
            background: var(--youtube-red-hover);

            box-shadow:
                0 10px 28px rgba(255, 0, 0, 0.18);

            transform: translateY(-1px);
        }

        .button:active {
            transform: translateY(1px);
        }

        .button:focus-visible {
            outline: 3px solid rgba(255, 0, 0, 0.35);
            outline-offset: 4px;
        }

        .button svg {
            width: 21px;
            height: 21px;

            flex: 0 0 auto;

            fill: currentColor;
        }

        .fallback {
            margin-top: 14px;

            display: block;

            width: 100%;
            min-height: 48px;

            padding: 13px 18px;

            border: 1px solid var(--youtube-border);
            border-radius: 12px;

            background: var(--youtube-surface-light);
            color: var(--youtube-white);

            font-size: 14px;
            font-weight: 500;
            line-height: 20px;
            text-decoration: none;

            transition:
                background-color 160ms ease,
                border-color 160ms ease;
        }

        .fallback:hover {
            background: #333333;
            border-color: #555555;
        }

        .fallback[hidden] {
            display: none;
        }

        .notice {
            margin: 18px auto 0;
            max-width: 330px;

            color: #858585;

            font-size: 12px;
            line-height: 1.55;
            overflow-wrap: break-word;
        }

        .domain {
            margin-top: 24px;

            color: #717171;

            font-size: 11px;
            font-weight: 500;
            letter-spacing: 0.08em;
            text-transform: uppercase;
        }

        .noscript-message {
            margin: 18px 0 0;

            color: var(--youtube-muted);

            font-size: 13px;
            line-height: 1.5;
        }

        @media (max-width: 480px) {
            body {
                padding-right: 16px;
                padding-left: 16px;
            }

            .page {
                max-width: calc(100vw - 32px);
            }

            .card {
                padding:
                    36px
                    20px
                    26px;

                border-radius: 18px;
            }

            .youtube-logo {
                width: 82px;
                height: 58px;

                border-radius: 16px;
            }
        }

        @media (prefers-reduced-motion: reduce) {
            *,
            *::before,
            *::after {
                scroll-behavior: auto !important;
                animation-duration: 0.01ms !important;
                animation-iteration-count: 1 !important;
                transition-duration: 0.01ms !important;
            }
        }
    </style>
</head>

<body>
    <main class="page">
        <section
            class="card"
            aria-labelledby="page-title"
        >
            <figure class="thumbnail">
                <img
                    src="<?= htmlspecialchars(
                        $thumbnailPath,
                        ENT_QUOTES,
                        'UTF-8'
                    ) ?>"
                    alt="Spain map thumbnail for Why 70% of Spain Is Empty Now?"
                    width="1600"
                    height="900"
                    loading="eager"
                    decoding="async"
                >

                <span
                    class="video-play"
                    aria-hidden="true"
                >
                    <svg
                        viewBox="0 0 24 24"
                        xmlns="http://www.w3.org/2000/svg"
                    >
                        <path d="M8 5.5v13l11-6.5L8 5.5Z"/>
                    </svg>
                </span>
            </figure>

            <h1 id="page-title">
                <?= htmlspecialchars(
                    $videoTitle,
                    ENT_QUOTES,
                    'UTF-8'
                ) ?>
            </h1>

            <p class="channel-name">
                Ariyan Khan
            </p>

            <p class="description">
                Spain geography, population, history,
                culture, and economy explained.
            </p>

            <div
                class="profile-summary"
                aria-label="About Ariyan Khan"
            >
                <p>
                    This video explains why large parts of
                    Spain are sparsely populated and how
                    geography, migration, and history shaped
                    empty Spain.
                </p>
            </div>

            <div
                class="status"
                role="status"
                aria-live="polite"
            >
                <span
                    id="spinner"
                    class="spinner"
                    aria-hidden="true"
                ></span>

                <span id="status-text">
                    Opening the YouTube app…
                </span>
            </div>

            <a
                id="open-youtube"
                class="button"
                href="<?= htmlspecialchars(
                    $youtubeVideoUrl,
                    ENT_QUOTES,
                    'UTF-8'
                ) ?>"
            >
                <svg
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                >
                    <path d="M8 5.5v13l11-6.5L8 5.5Z"/>
                </svg>

                <span>Open Video in YouTube</span>
            </a>

            <a
                id="web-fallback"
                class="fallback"
                href="<?= htmlspecialchars(
                    $youtubeVideoUrl,
                    ENT_QUOTES,
                    'UTF-8'
                ) ?>"
            >
                Open YouTube video
            </a>

            <p class="notice">
                If the app does not open automatically,
                tap the red button.
            </p>

            <p class="domain">
                youtube.ariyankhan.com
            </p>

            <noscript>
                <p class="noscript-message">
                    JavaScript is disabled. Use the button
                    above to open the YouTube video.
                </p>
            </noscript>
        </section>
    </main>

    <script nonce="<?= htmlspecialchars(
        $nonce,
        ENT_QUOTES,
        'UTF-8'
    ) ?>">
        (() => {
            'use strict';

            const channelUrl =
                <?= json_encode(
                    $youtubeVideoUrl,
                    JSON_UNESCAPED_SLASHES |
                    JSON_UNESCAPED_UNICODE |
                    JSON_HEX_TAG |
                    JSON_HEX_AMP |
                    JSON_HEX_APOS |
                    JSON_HEX_QUOT
                ) ?>;

            const androidIntent =
                <?= json_encode(
                    $androidIntent,
                    JSON_UNESCAPED_SLASHES |
                    JSON_UNESCAPED_UNICODE |
                    JSON_HEX_TAG |
                    JSON_HEX_AMP |
                    JSON_HEX_APOS |
                    JSON_HEX_QUOT
                ) ?>;

            const androidIntentNoFallback =
                <?= json_encode(
                    $androidIntentNoFallback,
                    JSON_UNESCAPED_SLASHES |
                    JSON_UNESCAPED_UNICODE |
                    JSON_HEX_TAG |
                    JSON_HEX_AMP |
                    JSON_HEX_APOS |
                    JSON_HEX_QUOT
                ) ?>;

            const androidOpenInAppStyleIntent =
                <?= json_encode(
                    $androidOpenInAppStyleIntent,
                    JSON_UNESCAPED_SLASHES |
                    JSON_UNESCAPED_UNICODE |
                    JSON_HEX_TAG |
                    JSON_HEX_AMP |
                    JSON_HEX_APOS |
                    JSON_HEX_QUOT
                ) ?>;

            const iosAppUrls =
                <?= json_encode(
                    $iosAppUrls,
                    JSON_UNESCAPED_SLASHES |
                    JSON_UNESCAPED_UNICODE |
                    JSON_HEX_TAG |
                    JSON_HEX_AMP |
                    JSON_HEX_APOS |
                    JSON_HEX_QUOT
                ) ?>;

            const userAgent = navigator.userAgent || '';

            const urlParams =
                new URLSearchParams(window.location.search);

            const isPreviewMode =
                urlParams.has('preview');

            const isFallbackMode =
                urlParams.has('fallback');

            const isCrawler =
                /bot|crawler|spider|crawling|slurp|google-inspectiontool|googleother|apis-google|mediapartners-google|bingpreview|facebookexternalhit|facebot|twitterbot|linkedinbot|pinterestbot|telegrambot|discordbot|gptbot|chatgpt-user|oai-searchbot|claudebot|anthropic-ai|perplexitybot|bytespider|ccbot|semrushbot|ahrefsbot/i
                    .test(userAgent);

            const isAndroid =
                /Android/i.test(userAgent);

            const isIOS =
                /iPhone|iPad|iPod/i.test(userAgent) ||
                (
                    navigator.platform === 'MacIntel' &&
                    navigator.maxTouchPoints > 1
                );

            const socialMatch =
                userAgent.match(
                    /FBAN|FBAV|FB_IAB|Instagram|Line|TikTok|Snapchat|Twitter|LinkedInApp|Pinterest|WhatsApp/i
                );

            const source =
                socialMatch ? socialMatch[0] : 'browser';

            const isSocialInAppBrowser =
                source !== 'browser';

            const platform =
                isAndroid ? 'android' : isIOS ? 'ios' : 'desktop';

            const openButton =
                document.getElementById('open-youtube');

            const openButtonLabel =
                openButton.querySelector('span');

            const fallbackButton =
                document.getElementById('web-fallback');

            const statusText =
                document.getElementById('status-text');

            const spinner =
                document.getElementById('spinner');

            const notice =
                document.querySelector('.notice');

            let destination = channelUrl;
            let openingStarted = false;
            let resetTimer = null;
            let iosFallbackTimer = null;
            let initialPageShowHandled = false;

            /*
            |--------------------------------------------------------------------------
            | Analytics
            |--------------------------------------------------------------------------
            */

            function logEvent(eventName, extra = {}) {
                try {
                    const analyticsUrl =
                        new URL(window.location.href);

                    analyticsUrl.search = '';

                    analyticsUrl.searchParams.set(
                        '__smart_event',
                        eventName
                    );

                    analyticsUrl.searchParams.set(
                        'platform',
                        platform
                    );

                    analyticsUrl.searchParams.set(
                        'source',
                        source
                    );

                    analyticsUrl.searchParams.set(
                        'url',
                        window.location.href
                    );

                    Object
                        .entries(extra)
                        .forEach(([key, value]) => {
                            analyticsUrl.searchParams.set(
                                key,
                                String(value)
                            );
                        });

                    if (navigator.sendBeacon) {
                        navigator.sendBeacon(analyticsUrl.toString());
                        return;
                    }

                    fetch(
                        analyticsUrl.toString(),
                        {
                            method: 'POST',
                            keepalive: true,
                            credentials: 'same-origin'
                        }
                    ).catch(() => {});
                } catch (error) {
                    /*
                     * Analytics must never block the smart link.
                     */
                }
            }

            /*
            |--------------------------------------------------------------------------
            | Select the correct destination
            |--------------------------------------------------------------------------
            */

            if (isAndroid) {
                destination =
                    isSocialInAppBrowser
                        ? androidOpenInAppStyleIntent
                        : androidIntent;
            } else if (isIOS) {
                destination = iosAppUrls[0] || channelUrl;
            } else {
                destination = channelUrl;
            }

            statusText.textContent =
                isAndroid || isIOS
                    ? 'Opening the YouTube app...'
                    : 'Opening YouTube...';

            openButton.href = destination;
            fallbackButton.href = channelUrl;

            if (isSocialInAppBrowser) {
                fallbackButton.hidden = true;

                if (openButtonLabel !== null) {
                    openButtonLabel.textContent =
                        'Continue';
                }

                notice.textContent =
                    isFallbackMode
                        ? 'The app did not open automatically. Tap Continue to open this video in the YouTube app.'
                        : 'If a prompt appears, tap Continue. If nothing happens, use the button below.';

                statusText.textContent =
                    isFallbackMode
                        ? 'Tap Continue to open the YouTube app'
                        : 'Opening the YouTube app...';

                spinner.style.animationPlayState =
                    isFallbackMode ? 'paused' : 'running';

                logEvent(
                    isFallbackMode
                        ? 'in_app_browser_hold'
                        : 'in_app_browser_ready_auto'
                );
            }

            /*
            |--------------------------------------------------------------------------
            | Open destination
            |--------------------------------------------------------------------------
            */

            function clearAttemptTimers() {
                if (resetTimer !== null) {
                    window.clearTimeout(resetTimer);
                    resetTimer = null;
                }

                if (iosFallbackTimer !== null) {
                    window.clearTimeout(iosFallbackTimer);
                    iosFallbackTimer = null;
                }
            }

            function resetForRetry(attemptType) {
                if (document.hidden) {
                    return;
                }

                openingStarted = false;

                statusText.textContent =
                    isSocialInAppBrowser
                        ? 'Tap Continue to open the YouTube app'
                        : 'Tap the red button to open YouTube';

                spinner.style.animationPlayState =
                    'paused';

                logEvent(
                    'open_failed',
                    {
                        attempt: attemptType
                    }
                );
            }

            function navigateTo(targetUrl) {
                window.location.href = targetUrl;
            }

            function openIOS(attemptType) {
                const candidates =
                    isSocialInAppBrowser
                        ? iosAppUrls.filter(
                            (candidate) => candidate !== channelUrl
                        )
                        : iosAppUrls.length > 0
                            ? iosAppUrls
                            : [channelUrl];

                if (candidates.length === 0) {
                    if (!isSocialInAppBrowser) {
                        navigateTo(channelUrl);
                    }

                    return;
                }

                const retryDelay =
                    isSocialInAppBrowser
                        ? attemptType === 'manual' ? 850 : 650
                        : attemptType === 'manual' ? 950 : 750;

                const finalResetDelay =
                    isSocialInAppBrowser
                        ? attemptType === 'manual' ? 1100 : 850
                        : attemptType === 'manual' ? 1800 : 1400;

                let candidateIndex = 0;

                function tryNextCandidate() {
                    if (document.hidden) {
                        return;
                    }

                    if (candidateIndex >= candidates.length) {
                        resetTimer = window.setTimeout(
                            () => {
                                resetForRetry(attemptType);
                            },
                            finalResetDelay
                        );

                        return;
                    }

                    const candidate =
                        candidates[candidateIndex];

                    candidateIndex += 1;

                    navigateTo(candidate);

                    if (candidateIndex < candidates.length) {
                        iosFallbackTimer = window.setTimeout(
                            tryNextCandidate,
                            retryDelay
                        );
                    } else {
                        resetTimer = window.setTimeout(
                            () => {
                                resetForRetry(attemptType);
                            },
                            finalResetDelay
                        );
                    }
                }

                tryNextCandidate();
            }

            function openDesktop() {
                if (isSocialInAppBrowser) {
                    resetForRetry('auto');
                    return;
                }

                navigateTo(channelUrl);
            }

            function openDestination(event = null) {
                const attemptType =
                    event !== null ? 'manual' : 'auto';

                if (event !== null) {
                    event.preventDefault();
                }

                if (openingStarted && attemptType !== 'manual') {
                    return;
                }

                clearAttemptTimers();

                openingStarted = true;

                spinner.style.animationPlayState =
                    'running';

                statusText.textContent =
                    isAndroid || isIOS
                        ? 'Opening the YouTube app...'
                        : 'Opening YouTube...';

                logEvent(
                    'open_attempt',
                    {
                        attempt: attemptType
                    }
                );

                if (isIOS) {
                    openIOS(attemptType);
                } else if (!isAndroid) {
                    openDesktop();
                } else {
                    navigateTo(destination);
                }

                /*
                 * Some social-media in-app browsers block automatic
                 * external-app launches. Reset the button so a direct
                 * user tap can try again.
                 */

                if (!isIOS) {
                    resetTimer = window.setTimeout(
                        () => {
                            resetForRetry(attemptType);
                        },
                        isSocialInAppBrowser ? 1100 : 1800
                    );
                }
            }

            /*
            |--------------------------------------------------------------------------
            | Button click
            |--------------------------------------------------------------------------
            */

            openButton.addEventListener(
                'click',
                openDestination
            );

            fallbackButton.addEventListener(
                'click',
                () => {
                    logEvent('web_fallback_click');
                }
            );

            /*
            |--------------------------------------------------------------------------
            | Detect when the YouTube app opens
            |--------------------------------------------------------------------------
            */

            document.addEventListener(
                'visibilitychange',
                () => {
                    if (document.hidden) {
                        statusText.textContent =
                            'YouTube opened';

                        logEvent('app_opened');
                    }
                }
            );

            window.addEventListener(
                'pageshow',
                () => {
                    if (!initialPageShowHandled) {
                        initialPageShowHandled = true;
                        return;
                    }

                    if (!document.hidden) {
                        clearAttemptTimers();

                        openingStarted = false;

                        statusText.textContent =
                            isSocialInAppBrowser
                                ? 'Tap Continue to open the YouTube app'
                                : 'Tap the red button to open YouTube';

                        spinner.style.animationPlayState =
                            isSocialInAppBrowser ? 'paused' : 'running';
                    }
                }
            );

            /*
            |--------------------------------------------------------------------------
            | Automatic opening attempt
            |--------------------------------------------------------------------------
            |
            | Normal browser:
            | Try to open YouTube automatically.
            |
            | Social in-app browser:
            | Try the external app intent once immediately. If the app
            | does not open, keep the user here for a direct button tap.
            |
            */

            logEvent('page_view');

            if (isCrawler) {
                statusText.textContent =
                    'Spain video by Ariyan Khan';

                spinner.style.animationPlayState =
                    'paused';

                logEvent('crawler_view');
            } else if (isPreviewMode) {
                statusText.textContent =
                    'Ready to open YouTube';

                spinner.style.animationPlayState =
                    'paused';

                logEvent('preview_view');
            } else if (isSocialInAppBrowser && !isFallbackMode) {
                statusText.textContent =
                    'Opening the YouTube app...';

                spinner.style.animationPlayState =
                    'running';

                logEvent('in_app_browser_auto_attempt');

                window.setTimeout(
                    () => {
                        openDestination();
                    },
                    120
                );
            } else if (isSocialInAppBrowser) {
                statusText.textContent =
                    'Tap Continue to open the YouTube app';

                spinner.style.animationPlayState =
                    'paused';

                logEvent('in_app_browser_waiting_for_tap');
            } else {
                openDestination();
            }
        })();
    </script>
</body>
</html>

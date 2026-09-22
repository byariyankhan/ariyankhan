package com.ariyankhan.puzzle;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * Where a notification arrives, whether the game is open or not.
 *
 * <p>The web's notifications go through the browser's push service and are drawn by the game's service
 * worker. Neither exists in a WebView, so a phone with the app is reached through Firebase Cloud Messaging
 * instead: the server sends one message per phone to Google, Google wakes this service, and this service
 * draws it. What the server sends is data — a title, a body, a path into the game and a tag — and never a
 * ready-made notification, so that an invitation looks the same whether the game was on screen or the phone
 * was in a pocket. (A "notification" message would be drawn by the library itself while the game is closed
 * and handed to us only while it is open: two different notifications for one invitation.)
 *
 * <p>Two channels, so that Android's own settings can silence one kind and keep the other: invitations, which
 * matter now because the room they are about waits minutes, and the league, which has paid out and can wait
 * until morning. The tag does the job it does on the web — five invitations are one line, not five — because
 * {@code notify(tag, id)} replaces rather than stacks.
 *
 * <p>Nothing here talks to our server. The token this phone is addressed by is fetched by MainActivity's
 * bridge when the player turns the switch on and posted by the page; this class keeps it current when
 * Firebase rotates it, so the next open posts the right one.
 */
public final class PuzzleMessagingService extends FirebaseMessagingService {

    /** The switch and the token, as the page last left them. Read and written by MainActivity's bridge too. */
    static final String PREFS = "push";
    static final String PREF_ON = "on";
    static final String PREF_TOKEN = "token";

    static final String CHANNEL_INVITES = "invites";
    static final String CHANNEL_LEAGUE = "league";

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /**
     * Firebase minted a new token, on its own schedule. Kept, so the page posts it the next time the game
     * opens with the switch on. Until then the server may still be addressing the old one, which Firebase
     * reports as dead the first time it is sent to, and that row goes.
     */
    @Override
    public void onNewToken(@NonNull String token) {
        prefs(this).edit().putString(PREF_TOKEN, token).apply();
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        Map<String, String> data = message.getData();
        String title = data.get("title");
        if (title == null || title.isEmpty()) return;                  // not one of ours
        // The switch is off on this phone. The row that sent this is on its way out — the page drops it the
        // moment the switch goes off — but a message already in flight still arrives, and is not shown.
        if (!prefs(this).getBoolean(PREF_ON, false)) return;
        if (!canPost(this)) return;
        ensureChannels(this);

        boolean invite = !"league".equals(data.get("kind"));
        String tag = data.get("tag");
        if (tag == null || tag.isEmpty()) tag = invite ? "puzzle-invite" : "puzzle-league";
        String body = data.get("body");
        if (body == null) body = "";

        // A tap opens the game at the path the message names — the room, or the league table — through the
        // same activity a link tapped in a chat reaches, so a running game is brought forward, not started
        // twice.
        Intent open = new Intent(Intent.ACTION_VIEW, landing(data.get("url")), this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent tap = PendingIntent.getActivity(this, tag.hashCode(), open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder n = new NotificationCompat.Builder(this, invite ? CHANNEL_INVITES : CHANNEL_LEAGUE)
                .setSmallIcon(R.drawable.ic_stat_puzzle)
                .setColor(ContextCompat.getColor(this, R.color.ink))
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setContentIntent(tap)
                .setAutoCancel(true)
                // Below Android 8 there are no channels, and this is what decides whether it makes a sound.
                .setPriority(invite ? NotificationCompat.PRIORITY_HIGH : NotificationCompat.PRIORITY_DEFAULT)
                .setDefaults(NotificationCompat.DEFAULT_ALL)
                .setCategory(invite ? NotificationCompat.CATEGORY_SOCIAL : NotificationCompat.CATEGORY_STATUS);
        try {
            NotificationManagerCompat.from(this).notify(tag, 1, n.build());
        } catch (SecurityException takenAwayMeanwhile) {
            // The permission went between the check above and this line. Nothing to show, nothing to crash.
        }
    }

    /** Where a tap lands: the game, at the path the message names, on our host and nowhere else. */
    private Uri landing(String url) {
        boolean path = url != null && url.startsWith("/") && !url.startsWith("//");
        return Uri.parse("https://" + getString(R.string.host) + (path ? url : "/puzzle/"));
    }

    /**
     * Whether a notification would be shown at all: the permission, on Android 13 and up, and the app's own
     * switch in the phone's settings on every version. The page's Settings row says "blocked" when this is
     * false with the switch on, because that is a door only the phone's settings can open.
     */
    static boolean canPost(Context c) {
        if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(c, Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) return false;
        return NotificationManagerCompat.from(c).areNotificationsEnabled();
    }

    /** The two channels. Creating one that already exists changes nothing, so this is called freely. */
    static void ensureChannels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel invites = new NotificationChannel(CHANNEL_INVITES,
                c.getString(R.string.notify_invites), NotificationManager.IMPORTANCE_HIGH);
        invites.setDescription(c.getString(R.string.notify_invites_about));
        NotificationChannel league = new NotificationChannel(CHANNEL_LEAGUE,
                c.getString(R.string.notify_league), NotificationManager.IMPORTANCE_DEFAULT);
        league.setDescription(c.getString(R.string.notify_league_about));
        nm.createNotificationChannel(invites);
        nm.createNotificationChannel(league);
    }
}

package com.ariyankhan.puzzle;

import android.app.Application;
import android.content.Intent;
import java.io.PrintWriter;
import java.io.StringWriter;

/**
 * Debug builds only. The app dies before it draws anything, and on a phone with no cable attached there is
 * nowhere the reason can be read from. This catches it and puts it on the screen instead.
 *
 * It lives in src/debug, so it is not in the source set a release build compiles and cannot reach Play.
 */
public class CrashLogApp extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            @Override
            public void uncaughtException(Thread t, Throwable e) {
                StringWriter sw = new StringWriter();
                e.printStackTrace(new PrintWriter(sw));
                try {
                    Intent i = new Intent(CrashLogApp.this, CrashActivity.class);
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
                    i.putExtra("trace", sw.toString());
                    startActivity(i);
                } catch (Throwable ignored) {
                    // If even that fails there is nothing left to try; fall through to the normal handler.
                }
                if (prev != null) prev.uncaughtException(t, e);
                System.exit(2);
            }
        });
    }
}

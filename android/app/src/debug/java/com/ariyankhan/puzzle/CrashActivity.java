package com.ariyankhan.puzzle;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Bundle;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/** Shows what killed the app, big enough to photograph and with a button to copy it. */
public class CrashActivity extends Activity {
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        final String trace = getIntent().getStringExtra("trace");

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(0xFF101010);
        root.setPadding(24, 48, 24, 24);

        TextView title = new TextView(this);
        title.setText("Crash");
        title.setTextColor(0xFFFF6B6B);
        title.setTextSize(22);
        root.addView(title);

        Button copy = new Button(this);
        copy.setText("Copy");
        copy.setOnClickListener(v -> {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            cm.setPrimaryClip(ClipData.newPlainText("trace", trace));
            Toast.makeText(this, "Copied", Toast.LENGTH_SHORT).show();
        });
        root.addView(copy);

        TextView body = new TextView(this);
        body.setText(trace);
        body.setTextColor(0xFFEEEEEE);
        body.setTextSize(11);
        body.setTextIsSelectable(true);
        body.setGravity(Gravity.START);

        ScrollView sv = new ScrollView(this);
        sv.addView(body);
        root.addView(sv);

        setContentView(root);
    }
}

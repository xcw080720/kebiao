package com.xcw.kebiao;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class ReminderReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        if (i == null) return;
        String title = i.getStringExtra("title");
        String body = i.getStringExtra("body");
        int nid = i.getIntExtra("nid", 1);
        String key = i.getStringExtra("key");
        Scheduler.fire(c, title, body, nid);
        Scheduler.drop(c, key);
    }
}

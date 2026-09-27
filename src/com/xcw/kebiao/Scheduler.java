package com.xcw.kebiao;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 提醒调度：JS 那边算好「哪一刻该提醒什么」，这里只负责落地成系统闹钟 + 通知。
 * 这样课表/周次/单双周的算法只有一份（在 JS 里），不会两处打架。
 */
public class Scheduler {

    public static final String CHANNEL = "kebiao_remind";
    public static final String PENDING_FILE = "pending.json";
    private static final int MAX_ALARMS = 120;

    public static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (nm.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, "上课提醒", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("课前提醒");
        ch.enableVibration(true);
        ch.setShowBadge(true);
        nm.createNotificationChannel(ch);
    }

    private static int reqCode(String key) {
        int h = key.hashCode();
        if (h < 0) h = -h;
        return 1000 + (h % 1000000);
    }

    private static PendingIntent pi(Context c, JSONObject it, boolean create) {
        String key = it.optString("key", it.optString("id", "x"));
        int rc = reqCode(key);
        Intent i = new Intent(c, ReminderReceiver.class);
        i.setAction("com.xcw.kebiao.REMIND." + key);
        i.putExtra("title", it.optString("title", "上课提醒"));
        i.putExtra("body", it.optString("body", ""));
        i.putExtra("nid", rc);
        i.putExtra("key", key);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(c, rc, i, flags);
    }

    /** 用新的提醒列表整体替换旧的。 */
    public static int arm(Context c, JSONArray items) {
        ensureChannel(c);
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return 0;

        // 1) 撤掉旧的
        JSONArray old = loadPending(c);
        for (int i = 0; i < old.length(); i++) {
            JSONObject o = old.optJSONObject(i);
            if (o == null) continue;
            try { am.cancel(pi(c, o, false)); } catch (Exception ignore) { }
        }

        // 2) 写新的
        Store.write(c, PENDING_FILE, items.toString());

        // 3) 装新的
        long now = System.currentTimeMillis();
        int n = 0;
        for (int i = 0; i < items.length() && n < MAX_ALARMS; i++) {
            JSONObject o = items.optJSONObject(i);
            if (o == null) continue;
            long at = o.optLong("at", 0);
            if (at <= now + 2000) continue;
            try {
                PendingIntent p = pi(c, o, true);
                if (Build.VERSION.SDK_INT >= 23) {
                    am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, p);
                } else {
                    am.setExact(AlarmManager.RTC_WAKEUP, at, p);
                }
                n++;
            } catch (Exception e) {
                // 精确闹钟被系统拒绝（部分 ROM 的「自启动/后台限制」）-> 退化成普通闹钟
                try {
                    am.set(AlarmManager.RTC_WAKEUP, at, pi(c, o, true));
                    n++;
                } catch (Exception ignore) { }
            }
        }
        return n;
    }

    public static JSONArray loadPending(Context c) {
        String s = Store.read(c, PENDING_FILE);
        if (s == null) return new JSONArray();
        try {
            return new JSONArray(s);
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    /** 开机/更新后重新装上（App 没打开也能提醒）。 */
    public static int armFromStore(Context c) {
        return arm(c, loadPending(c));
    }

    /** 某条已经响过了，从待办列表里摘掉。 */
    public static void drop(Context c, String key) {
        if (key == null) return;
        JSONArray old = loadPending(c);
        JSONArray neu = new JSONArray();
        for (int i = 0; i < old.length(); i++) {
            JSONObject o = old.optJSONObject(i);
            if (o == null) continue;
            String k = o.optString("key", o.optString("id", ""));
            if (!key.equals(k)) neu.put(o);
        }
        Store.write(c, PENDING_FILE, neu.toString());
    }

    public static void fire(Context c, String title, String body, int id) {
        ensureChannel(c);
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        // 没通知权限时 notify() 会静默失败，所以先探一下并留下日志（真机踩过：整条提醒链无声无息）
        if (Build.VERSION.SDK_INT >= 33) {
            try {
                if (c.checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                        != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    android.util.Log.w("kebiao", "notification permission DENIED, skip: " + title);
                    return;
                }
            } catch (Exception ignore) { }
        }
        Intent i = new Intent(c, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getActivity(c, id, i, flags);

        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) b = new Notification.Builder(c, CHANNEL);
        else b = new Notification.Builder(c);

        b.setSmallIcon(android.R.drawable.ic_menu_my_calendar)
                .setContentTitle(title == null ? "上课提醒" : title)
                .setContentText(body == null ? "" : body)
                .setStyle(new Notification.BigTextStyle().bigText(body == null ? "" : body))
                .setAutoCancel(true)
                .setContentIntent(pi)
                .setShowWhen(true)
                .setWhen(System.currentTimeMillis());
        if (Build.VERSION.SDK_INT < 26) {
            b.setDefaults(Notification.DEFAULT_SOUND | Notification.DEFAULT_VIBRATE);
        }
        try {
            nm.notify(id, b.build());
        } catch (Exception ignore) { }
    }
}

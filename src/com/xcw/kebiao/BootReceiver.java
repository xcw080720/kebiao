package com.xcw.kebiao;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** 开机 / 覆盖安装后重新把闹钟装上，不依赖用户先打开 App。 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        try {
            Scheduler.armFromStore(c);
        } catch (Exception ignore) { }
    }
}

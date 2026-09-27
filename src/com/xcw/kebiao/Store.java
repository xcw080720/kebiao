package com.xcw.kebiao;

import android.content.Context;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;

/** 极简键值存储：文件落盘，UTF-8。 */
public class Store {

    public static File file(Context c, String name) {
        return new File(c.getFilesDir(), name);
    }

    public static String read(Context c, String name) {
        try {
            File f = file(c, name);
            if (!f.exists()) return null;
            FileInputStream in = new FileInputStream(f);
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            in.close();
            return new String(bo.toByteArray(), "UTF-8");
        } catch (Exception e) {
            return null;
        }
    }

    public static void write(Context c, String name, String text) {
        try {
            File f = file(c, name);
            File tmp = new File(c.getFilesDir(), name + ".tmp");
            FileOutputStream out = new FileOutputStream(tmp);
            out.write(text.getBytes("UTF-8"));
            out.flush();
            out.close();
            if (f.exists()) f.delete();
            tmp.renameTo(f);
        } catch (Exception e) {
            // 忽略：下次写入再试
        }
    }
}

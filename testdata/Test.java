package com.xcw.kebiao;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;

/** 桌面单测：OfficeParser 只依赖 JDK，可以脱离 Android 直接验证。
 *  用法：java com.xcw.kebiao.Test <输出文件> <输入1> <输入2> ...
 *  自己以 UTF-8 写文件，避免经 PowerShell 管道被按 GBK 二次解码。 */
public class Test {
    public static void main(String[] args) throws Exception {
        File out = new File(args[0]);
        Writer w = new OutputStreamWriter(new FileOutputStream(out), "UTF-8");
        for (int i = 1; i < args.length; i++) {
            File f = new File(args[i]);
            if (!f.exists()) { w.write("MISSING " + args[i] + "\n"); continue; }
            FileInputStream in = new FileInputStream(f);
            OfficeParser.Result r = OfficeParser.extract(in, f.getName());
            String t = r.text == null ? "" : r.text;
            w.write("=== " + f.getName() + "  kind=" + r.kind + "  err=" + r.error + "  len=" + t.length() + "\n");
            w.write(t);
            w.write("\n\n");
        }
        w.close();
        System.out.println("written " + out.getAbsolutePath());
    }
}

package com.xcw.kebiao;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

public class MainActivity extends Activity {

    private static final String TAG = "kebiao";
    private static final int REQ_PICK = 4001;

    private WebView web;
    private String sharedImage;
    private String sharedText;
    private boolean askedNotif = false;

    @Override
    protected void onCreate(Bundle s) {
        super.onCreate(s);
        Scheduler.ensureChannel(this);

        if (Build.VERSION.SDK_INT >= 21) WebView.setWebContentsDebuggingEnabled(true);

        web = new WebView(this);
        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setAllowFileAccess(true);
        ws.setSupportZoom(false);
        ws.setBuiltInZoomControls(false);
        ws.setDisplayZoomControls(false);
        ws.setDefaultTextEncodingName("utf-8");
        ws.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= 21) {
            ws.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        }
        web.setBackgroundColor(0xFF0E1116);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, String url) {
                if (url != null && (url.startsWith("http://") || url.startsWith("https://"))) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                    } catch (Exception ignore) { }
                    return true;
                }
                return false;
            }
        });
        web.setWebChromeClient(new WebChromeClient());
        web.addJavascriptInterface(new Bridge(), "Native");

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF0E1116);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        web.loadUrl("file:///android_asset/www/index.html");

        handleShare(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleShare(intent);
        callJs("window.__onResume && window.__onResume()");
    }

    @Override
    protected void onResume() {
        super.onResume();
        callJs("window.__onResume && window.__onResume()");
        // 通知权限要等窗口拿到焦点之后再问，否则系统会把请求丢掉（真机踩过：权限一直是 denied）
        askNotifyPermission();
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] res) {
        super.onRequestPermissionsResult(req, perms, res);
        if (req == 5001) callJs("window.__onResume && window.__onResume()");
    }

    private boolean notifGranted() {
        try {
            if (Build.VERSION.SDK_INT >= 23) {
                return checkSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED;
            }
        } catch (Throwable ignore) { }
        return true;
    }

    @Override
    public void onBackPressed() {
        // 先问页面：弹层开着吗？开着就让它自己关。
        if (web == null) { super.onBackPressed(); return; }
        web.evaluateJavascript("(window.__back && window.__back()) ? 'true' : 'false'",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if (!"true".equals(value)) {
                            if (web.canGoBack()) web.goBack();
                            else finish();
                        }
                    }
                });
    }

    private void askNotifyPermission() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (askedNotif) return;
        if (notifGranted()) { askedNotif = true; return; }
        askedNotif = true;
        // 延后 600ms：onCreate 阶段窗口还没拿到焦点，requestPermissions 会被系统丢掉
        web.postDelayed(new Runnable() {
            @Override public void run() {
                try {
                    requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 5001);
                } catch (Exception ignore) { }
            }
        }, 600);
    }

    /** 打开系统的「课表 → 通知」设置页（权限被永久拒绝时的兜底路子） */
    private void openNotifSettings() {
        try {
            Intent i;
            if (Build.VERSION.SDK_INT >= 26) {
                i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                i.putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
            } else {
                i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                i.setData(Uri.parse("package:" + getPackageName()));
            }
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Exception e) {
            toastNow("打不开系统设置，手动去：设置 → 通知 → 课表");
        }
    }

    /** 把最近一次 AI 调用的诊断写进 files/ai_last.txt（logcat 抓不到时靠这个） */
    private void writeDiag(String s) {
        try {
            java.io.File f = new java.io.File(getFilesDir(), "ai_last.txt");
            java.io.FileOutputStream fo = new java.io.FileOutputStream(f, false);
            fo.write(("[" + new java.util.Date() + "]\n" + s + "\n").getBytes("UTF-8"));
            fo.close();
        } catch (Throwable ignore) { }
    }

    private void toastNow(final String s) {        runOnUiThread(new Runnable() {
            @Override public void run() {
                try { Toast.makeText(MainActivity.this, s, Toast.LENGTH_LONG).show(); } catch (Exception ignore) { }
            }
        });
    }

    private void callJs(String js) {
        if (web == null) return;
        web.post(new Runnable() {
            @Override public void run() {
                try { web.evaluateJavascript(js, null); } catch (Exception ignore) { }
            }
        });
    }

    private void cb(String fn, String json) {
        final String js = "window." + fn + " && window." + fn + "(" + JSONObject.quote(json) + ")";
        callJs(js);
    }

    // ------------------------------------------------------------ 分享进来的东西

    private void handleShare(Intent it) {
        if (it == null) return;
        String action = it.getAction();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri uri = it.getParcelableExtra(Intent.EXTRA_STREAM);
            String text = it.getStringExtra(Intent.EXTRA_TEXT);
            if (uri != null) {
                String type = it.getType();
                if (type == null) type = getContentResolver().getType(uri);
                if (looksLikeImage(type, nameOf(uri))) {
                    try { sharedImage = imageViaDecode(uri); } catch (Exception e) { sharedImage = null; }
                    if (sharedImage == null) sharedImage = copyToCache(uri, extFromMime(type));
                } else {
                    bridgeReadUri(uri, nameOf(uri));
                }
            }
            if (text != null && text.trim().length() > 0) sharedText = text;
            callJs("window.__onResume && window.__onResume()");
        }
    }

    private String extFromMime(String mime) {
        if (mime == null) return ".png";
        if (mime.contains("jpeg") || mime.contains("jpg")) return ".jpg";
        if (mime.contains("webp")) return ".webp";
        if (mime.contains("gif")) return ".gif";
        if (mime.contains("png")) return ".png";
        return ".png";
    }

    private String copyToCache(Uri uri, String ext) {
        try {
            InputStream in = getContentResolver().openInputStream(uri);
            if (in == null) return null;
            File f = new File(getCacheDir(), "share_" + System.currentTimeMillis() + ext);
            OutputStream out = new FileOutputStream(f);
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            out.close();
            in.close();
            return f.getAbsolutePath();
        } catch (Exception e) {
            Log.w(TAG, "copyToCache failed: " + e);
            return null;
        }
    }

    private String nameOf(Uri uri) {
        String name = null;
        try {
            Cursor c = getContentResolver().query(uri, null, null, null, null);
            if (c != null) {
                int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (c.moveToFirst() && idx >= 0) name = c.getString(idx);
                c.close();
            }
        } catch (Exception ignore) { }
        if (name == null) name = uri.getLastPathSegment();
        if (name == null) name = "file";
        return name;
    }

    private static boolean looksLikeImage(String mime, String name) {
        if (mime != null && mime.startsWith("image/")) return true;
        if (name == null) return false;
        String n = name.toLowerCase();
        String[] exts = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".heic", ".heif", ".avif"};
        for (String e : exts) if (n.endsWith(e)) return true;
        return false;
    }

    /** 直接把图从内容流里解出来，压到最长边 1600 存 JPEG。绕开「先拷成文件再解码」那条路。 */
    private String imageViaDecode(Uri uri) throws Exception {
        InputStream in = getContentResolver().openInputStream(uri);
        if (in == null) throw new Exception("拿不到文件流");
        Bitmap bmp;
        try {
            bmp = BitmapFactory.decodeStream(in);
        } finally {
            try { in.close(); } catch (Exception ignore) { }
        }
        if (bmp == null) throw new Exception("系统解不出这张图");
        int w = bmp.getWidth(), h = bmp.getHeight();
        if (w <= 0 || h <= 0) { bmp.recycle(); throw new Exception("解出来是空的"); }
        int mx = Math.max(w, h);
        Bitmap out = bmp;
        if (mx > 1600) {
            float s = 1600f / mx;
            out = Bitmap.createScaledBitmap(bmp, Math.round(w * s), Math.round(h * s), true);
        }
        File f = new File(getCacheDir(), "img_" + System.currentTimeMillis() + ".jpg");
        FileOutputStream fo = new FileOutputStream(f);
        out.compress(Bitmap.CompressFormat.JPEG, 88, fo);
        fo.close();
        if (out != bmp) out.recycle();
        bmp.recycle();
        Log.i(TAG, "imageViaDecode ok: " + f.getAbsolutePath() + " " + f.length() + "B " + w + "x" + h);
        return f.getAbsolutePath();
    }

    /** 解不出图时，退一步原样拷回来看看：0 字节 / 解不开都能分辨，并把原因带回去。 */
    private String imageViaCopy(Uri uri, String mime, String name, StringBuilder why) {
        String q = copyToCache(uri, extFromMime(mime));
        if (q == null) { why.append("读取失败"); return null; }
        long len = new File(q).length();
        if (len <= 0) { why.append("只读到 0 字节（可能是云盘占位文件或权限受限）"); return null; }
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(q, o);
        if (o.outWidth > 0 && o.outHeight > 0) {
            Log.i(TAG, "imageViaCopy ok: " + q + " " + len + "B " + o.outWidth + "x" + o.outHeight + " " + mime);
            return q;
        }
        why.append("拷回来 ").append(len).append(" 字节，但解不出图（可能是云盘占位文件，或 .heic/.avif 之类）");
        return null;
    }

    private void bridgeReadUri(final Uri uri, final String name) {
        new Thread(new Runnable() {
            @Override public void run() {
                String json;
                try {
                    String type = getContentResolver().getType(uri);
                    if (looksLikeImage(type, name)) {
                        Log.i(TAG, "pick image: name=" + name + " mime=" + type + " uri=" + uri);
                        StringBuilder why = new StringBuilder();
                        String p = null;
                        try { p = imageViaDecode(uri); } catch (Exception e) { why.append(String.valueOf(e.getMessage())); }
                        if (p == null) {
                            if (why.length() > 0) why.append("；");
                            p = imageViaCopy(uri, type, name, why);
                        }
                        JSONObject o = new JSONObject();
                        o.put("ok", p != null);
                        o.put("kind", "image");
                        o.put("name", name);
                        o.put("path", p == null ? "" : p);
                        if (p == null) o.put("error", "图片读不出来（" + name + "：" + why + "）");
                        json = o.toString();
                    } else {
                        InputStream in = getContentResolver().openInputStream(uri);
                        OfficeParser.Result r = OfficeParser.extract(in, name);
                        JSONObject o = new JSONObject();
                        o.put("ok", r.error == null);
                        o.put("kind", r.kind);
                        o.put("name", name);
                        o.put("text", r.text);
                        if (r.error != null) o.put("error", r.error);
                        json = o.toString();
                    }
                } catch (Exception e) {
                    json = "{\"ok\":false,\"error\":" + JSONObject.quote("读取失败：" + e) + "}";
                }
                cb("__onFilePicked", json);
            }
        }).start();
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != REQ_PICK) return;
        if (res != RESULT_OK || data == null || data.getData() == null) {
            cb("__onFilePicked", "{\"ok\":false,\"cancelled\":true}");
            return;
        }
        bridgeReadUri(data.getData(), nameOf(data.getData()));
    }

    // ------------------------------------------------------------ JS 桥

    public class Bridge {

        @JavascriptInterface
        public String load() {
            String s = Store.read(MainActivity.this, "data.json");
            return s == null ? "" : s;
        }

        @JavascriptInterface
        public void save(String json) {
            Store.write(MainActivity.this, "data.json", json == null ? "" : json);
        }

        @JavascriptInterface
        public int reschedule(String json) {
            try {
                return Scheduler.arm(MainActivity.this, new org.json.JSONArray(json));
            } catch (Exception e) {
                Log.w(TAG, "reschedule: " + e);
                return 0;
            }
        }

        @JavascriptInterface
        public void notifyNow(String title, String body) {
            Scheduler.fire(MainActivity.this, title, body, 999001);
        }

        @JavascriptInterface
        public void pickFile() {
            try {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startActivityForResult(i, REQ_PICK);
            } catch (Exception e) {
                toast("打不开文件选择器：" + e);
            }
        }

        @JavascriptInterface
        public String takeShared() {
            JSONObject o = new JSONObject();
            try {
                if (sharedImage != null) {
                    o.put("kind", "image");
                    o.put("path", sharedImage);
                    sharedImage = null;
                } else if (sharedText != null) {
                    o.put("kind", "text");
                    o.put("text", sharedText);
                    sharedText = null;
                } else {
                    return "";
                }
            } catch (Exception e) {
                return "";
            }
            return o.toString();
        }

        @JavascriptInterface
        public void ai(final String reqJson) {
            new Thread(new Runnable() {
                @Override public void run() {
                    String id = "";
                    JSONObject out = new JSONObject();
                    try {
                        JSONObject req = new JSONObject(reqJson);
                        id = req.optString("id", "");
                        String kind = req.optString("kind", "chat");
                        String base = req.optString("baseURL", "");
                        String key = req.optString("apiKey", "");
                        if ("models".equals(kind)) {
                            String m = Ai.listModels(base, key);
                            out.put("ok", true);
                            out.put("text", m);
                        } else {
                            // 空字符串必须当成「没有图」——以前 ""（而不是 null）会让下面的
                            // Ai.chat 走进图片分支，去 decode 一个空路径，于是所有纯文字/文档
                            // 导入都会死在「读不出这张图」上。
                            String imgPath = req.optString("imagePath", "").trim();
                            if (imgPath.length() == 0 || "null".equals(imgPath)) imgPath = null;
                            String txt = Ai.chat(base, key, req.optString("model", ""),
                                    req.optString("system", ""),
                                    req.optString("user", ""),
                                    imgPath);
                            out.put("ok", true);
                            out.put("text", txt);
                        }
                    } catch (Throwable t) {
                        Log.w(TAG, "ai failed: " + t);
                        try {
                            out.put("ok", false);
                            out.put("error", String.valueOf(t.getMessage() == null ? t.toString() : t.getMessage()));
                        } catch (Exception ignore) { }
                    }
                    // 部分国行 ROM（含本机 vivo）抓不到第三方应用的 logcat，只留日志等于没留证据。
                    // 所以每次调用都把诊断落到 files/ai_last.txt，用 run-as 就能读回来。
                    try { writeDiag(Ai.lastDiag); } catch (Throwable ignore) { }
                    try { out.put("id", id); } catch (Exception ignore) { }
                    cb("__onAi", out.toString());
                }
            }).start();
        }

        @JavascriptInterface
        public void toast(String s) {
            final String msg = s;
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    try { Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show(); }
                    catch (Exception ignore) { }
                }
            });
        }

        @JavascriptInterface
        public String info() {
            JSONObject o = new JSONObject();
            try {
                o.put("sdk", Build.VERSION.SDK_INT);
                o.put("device", Build.MANUFACTURER + " " + Build.MODEL);
                o.put("version", "1.0");
                o.put("notifGranted", notifGranted());
            } catch (Exception ignore) { }
            return o.toString();
        }

        /** 再问一次通知权限 */
        @JavascriptInterface
        public void requestNotifPermission() {
            askedNotif = false;
            askNotifyPermission();
        }

        /** 打开系统通知设置页 */
        @JavascriptInterface
        public void openNotifSettings() {
            MainActivity.this.openNotifSettings();
        }

        @JavascriptInterface
        public void log(String s) {
            Log.i(TAG, String.valueOf(s));
        }

        @JavascriptInterface
        public void openUrl(String url) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Exception ignore) { }
        }
    }
}

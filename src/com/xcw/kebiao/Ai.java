package com.xcw.kebiao;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** 和「OpenAI 兼容」的对话接口打交道：文本、图片（vision）、模型列表。 */
public class Ai {

    private static final String TAG = "kebiao";

    public static String normBase(String base) {
        if (base == null) base = "";
        base = base.trim();
        while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        if (base.endsWith("/chat/completions")) base = base.substring(0, base.length() - "/chat/completions".length());
        return base;
    }

    public static class Img {
        public String dataUrl;
        public int bytes;
    }

    /** 读图 -> 压到最长边 1600 + JPEG q85 -> data URL（省流量也省 token） */
    public static Img prepareImage(String path) throws Exception {
        if (path == null || path.length() == 0) throw new Exception("没有拿到图片路径");
        File probe = new File(path);
        long size = probe.exists() ? probe.length() : -1;
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(path, o);
        int scale = 1;
        int mw = o.outWidth, mh = o.outHeight;
        if (mw <= 0 || mh <= 0) {
            throw new Exception("读不出这张图（" + probe.getName() + "，" + size + " 字节，可能格式不支持）");
        }
        while (mw / scale > 1600 || mh / scale > 1600) scale *= 2;
        BitmapFactory.Options o2 = new BitmapFactory.Options();
        o2.inSampleSize = scale;
        Bitmap bmp = BitmapFactory.decodeFile(path, o2);
        if (bmp == null) throw new Exception("图片解码失败");
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        bmp.compress(Bitmap.CompressFormat.JPEG, 85, bo);
        bmp.recycle();
        byte[] raw = bo.toByteArray();
        Img img = new Img();
        img.bytes = raw.length;
        img.dataUrl = "data:image/jpeg;base64," + Base64.encodeToString(raw, Base64.NO_WRAP);
        return img;
    }

    public static String chat(String baseURL, String apiKey, String model,
                              String system, String user, String imagePath) throws Exception {
        String base = normBase(baseURL);
        if (base.length() == 0) throw new Exception("还没填接口地址");
        if (apiKey == null || apiKey.trim().length() == 0) throw new Exception("还没填 API Key");

        JSONObject body = new JSONObject();
        body.put("model", model);
        JSONArray msgs = new JSONArray();
        if (system != null && system.length() > 0) {
            JSONObject sm = new JSONObject();
            sm.put("role", "system");
            sm.put("content", system);
            msgs.put(sm);
        }
        JSONObject um = new JSONObject();
        um.put("role", "user");
        if (imagePath == null) {
            um.put("content", user);
        } else {
            Img img = prepareImage(imagePath);
            JSONArray parts = new JSONArray();
            JSONObject p1 = new JSONObject();
            p1.put("type", "text");
            p1.put("text", user);
            parts.put(p1);
            JSONObject p2 = new JSONObject();
            p2.put("type", "image_url");
            JSONObject iu = new JSONObject();
            iu.put("url", img.dataUrl);
            p2.put("image_url", iu);
            parts.put(p2);
            um.put("content", parts);
        }
        msgs.put(um);
        body.put("messages", msgs);
        body.put("temperature", 0);
        // 不传 max_tokens —— 带推理的模型（reasoner 之类）会把额度全花在思考上，
        // 正文一个字都不剩。服务端默认值（chat 4096 / reasoner 32K）比硬写 8192 安全。

        String head = "model=" + model + " img=" + (imagePath == null ? "no" : "yes")
                + " userChars=" + (user == null ? 0 : user.length());
        Log.i(TAG, "call: " + head);
        lastDiag = "call " + head;

        String resp = post(base + "/chat/completions", apiKey, body.toString());
        Log.i(TAG, "resp head: " + cut(resp, 300));
        String content = pickContent(resp);
        if (content == null) {
            // 空正文：多半是额度被思考吃光。原样再要一次，很多时候第二次就出正文了。
            Log.w(TAG, "empty content, retrying once");
            lastDiag += "\n[1] " + emptyWhy + "\n[1] resp=" + cut(resp, 600);
            resp = post(base + "/chat/completions", apiKey, body.toString());
            content = pickContent(resp);
        }
        if (content == null) {
            lastDiag += "\n[2] " + emptyWhy + "\n[2] resp=" + cut(resp, 600);
            throw new Exception(emptyWhy);
        }
        lastDiag += " ok chars=" + content.length() + "\nresp=" + cut(resp, 600);
        Log.i(TAG, "ok: " + content.length() + " chars");
        return content;
    }

    /** 最近一次调用的诊断文本；失败时由 MainActivity 落盘到 files/ai_last.txt */
    public static String lastDiag = "";
    private static String emptyWhy = "";

    /** 从响应里取正文；取不到返回 null，并把原因写进 emptyWhy */
    private static String pickContent(String resp) throws Exception {
        emptyWhy = "";
        JSONObject j = new JSONObject(resp);
        if (!j.has("choices")) {
            throw new Exception("接口没返回 choices：" + cut(resp, 400));
        }
        JSONArray ch = j.getJSONArray("choices");
        if (ch.length() == 0) throw new Exception("接口返回空结果");
        JSONObject c0 = ch.getJSONObject(0);
        JSONObject m = c0.optJSONObject("message");
        String content = null;
        if (m != null) content = m.optString("content", null);
        if (content == null || content.length() == 0) content = c0.optString("text", "");
        if (content == null) content = "";
        if (content.trim().length() > 0) return content;
        String finish = c0.optString("finish_reason", "");
        String reasoning = (m == null) ? "" : m.optString("reasoning_content", "");
        Log.w(TAG, "empty content, finish=" + finish + " reasoningChars=" + reasoning.length());
        if ("length".equals(finish)) {
            emptyWhy = "模型连着两次都把额度用在思考上了，正文一个字没留下。"
                    + "多半是选了个「带推理」的模型（deepseek-reasoner 之类）——"
                    + "去「设置 → AI 识别」把模型换成 deepseek-chat 就正常了。";
        } else if (reasoning.length() > 0) {
            emptyWhy = "模型只回了思考过程（" + reasoning.length() + " 字），没有正文。"
                    + "多半是这个模型把思考放进了 reasoning_content —— 换一个普通对话模型。";
        } else {
            emptyWhy = "模型回了空内容（finish_reason=" + finish + "）";
        }
        return null;
    }

    public static String listModels(String baseURL, String apiKey) throws Exception {
        String base = normBase(baseURL);
        HttpURLConnection c = (HttpURLConnection) new URL(base + "/models").openConnection();
        c.setRequestMethod("GET");
        c.setConnectTimeout(20000);
        c.setReadTimeout(60000);
        c.setRequestProperty("Authorization", "Bearer " + apiKey);
        c.setRequestProperty("Accept", "application/json");
        int code = c.getResponseCode();
        InputStream is = (code >= 200 && code < 300) ? c.getInputStream() : c.getErrorStream();
        String txt = readAll(is);
        if (code < 200 || code >= 300) throw new Exception("HTTP " + code + "：" + cut(txt, 400));
        JSONObject j = new JSONObject(txt);
        JSONArray data = j.optJSONArray("data");
        if (data == null) return cut(txt, 500);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < data.length(); i++) {
            JSONObject o = data.optJSONObject(i);
            if (o == null) continue;
            String id = o.optString("id", "");
            if (id.length() == 0) continue;
            if (sb.length() > 0) sb.append('\n');
            sb.append(id);
        }
        return sb.toString();
    }

    private static String post(String url, String apiKey, String bodyText) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setConnectTimeout(20000);
        c.setReadTimeout(180000);
        c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        c.setRequestProperty("Authorization", "Bearer " + apiKey);
        c.setRequestProperty("Accept", "application/json");
        byte[] payload = bodyText.getBytes("UTF-8");
        c.setFixedLengthStreamingMode(payload.length);
        OutputStream os = c.getOutputStream();
        os.write(payload);
        os.flush();
        os.close();
        int code = c.getResponseCode();
        InputStream is = (code >= 200 && code < 300) ? c.getInputStream() : c.getErrorStream();
        String txt = readAll(is);
        if (code < 200 || code >= 300) {
            String hint = "";
            if (code == 401) hint = "（Key 不对或没权限）";
            else if (code == 404) hint = "（接口地址不对，检查是不是少了 /v1）";
            else if (code == 429) hint = "（请求太频繁或余额不足）";
            throw new Exception("HTTP " + code + hint + "：" + cut(txt, 500));
        }
        return txt;
    }

    private static String readAll(InputStream is) throws Exception {
        if (is == null) return "";
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) > 0) bo.write(buf, 0, n);
        is.close();
        return new String(bo.toByteArray(), "UTF-8");
    }

    private static String cut(String s, int n) {
        if (s == null) return "";
        return s.length() <= n ? s : s.substring(0, n) + "…";
    }

    // 保留：需要时把文件读成 base64（当前未用到，便于以后接别的接口）
    public static String fileToBase64(String path) throws Exception {
        File f = new File(path);
        byte[] raw = new byte[(int) f.length()];
        FileInputStream in = new FileInputStream(f);
        int off = 0;
        while (off < raw.length) {
            int n = in.read(raw, off, raw.length - off);
            if (n <= 0) break;
            off += n;
        }
        in.close();
        return Base64.encodeToString(raw, Base64.NO_WRAP);
    }
}

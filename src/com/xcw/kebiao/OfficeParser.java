package com.xcw.kebiao;

import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;

/**
 * 零依赖的文档解析：xlsx / docx / csv / txt / md。
 * xlsx、docx 本质是 zip + XML，用 java.util.zip + DOM 就能读，不需要 Apache POI。
 * 输出统一成「带换行和制表符的纯文本」，交给模型做语义抽取。
 */
public class OfficeParser {

    private static final long MAX_ENTRY = 12L * 1024 * 1024;

    public static class Result {
        public String text = "";
        public String kind = "";
        public String error = null;
    }

    public static Result extract(InputStream in, String name) {
        Result r = new Result();
        String lower = name == null ? "" : name.toLowerCase();
        try {
            if (lower.endsWith(".xlsx")) {
                r.kind = "xlsx";
                r.text = readXlsx(in);
            } else if (lower.endsWith(".docx")) {
                r.kind = "docx";
                r.text = readDocx(in);
            } else if (lower.endsWith(".csv") || lower.endsWith(".tsv")) {
                r.kind = "csv";
                r.text = readTextSmart(in);
            } else if (lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".json")) {
                r.kind = "txt";
                r.text = readTextSmart(in);
            } else if (lower.endsWith(".xls")) {
                r.error = "旧版 .xls 二进制格式读不了，请在 WPS/Excel 里另存为 .xlsx 或 .csv 再来。";
            } else if (lower.endsWith(".doc")) {
                r.error = "旧版 .doc 二进制格式读不了，请另存为 .docx 再来。";
            } else if (lower.endsWith(".pdf")) {
                r.error = "PDF 暂不支持直接解析（中文 PDF 多为嵌入字体，取字容易乱码）。请截图发我，或转成 Word/Excel。";
            } else {
                r.error = "不支持的文件类型：" + lower;
            }
        } catch (Exception e) {
            r.error = "解析失败：" + e.getClass().getSimpleName() + " " + String.valueOf(e.getMessage());
        }
        if (r.text == null) r.text = "";
        return r;
    }

    // ------------------------------------------------------------------ 工具

    private static Map<String, byte[]> unzip(InputStream in) throws Exception {
        Map<String, byte[]> out = new HashMap<String, byte[]>();
        ZipInputStream zin = new ZipInputStream(in);
        ZipEntry e;
        byte[] buf = new byte[16384];
        while ((e = zin.getNextEntry()) != null) {
            String n = e.getName();
            if (e.isDirectory()) continue;
            // 图片/媒体这类大条目直接跳过
            if (n.startsWith("word/media/") || n.startsWith("xl/media/") ||
                n.startsWith("word/theme/") || n.startsWith("xl/theme/")) continue;
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            int total = 0;
            int k;
            while ((k = zin.read(buf)) > 0) {
                total += k;
                if (total > MAX_ENTRY) break;
                bo.write(buf, 0, k);
            }
            out.put(n, bo.toByteArray());
        }
        zin.close();
        return out;
    }

    private static Document doc(byte[] xml) throws Exception {
        DocumentBuilderFactory f = DocumentBuilderFactory.newInstance();
        f.setNamespaceAware(true);
        f.setExpandEntityReferences(false);
        DocumentBuilder b = f.newDocumentBuilder();
        return b.parse(new ByteArrayInputStream(xml));
    }

    private static String localName(Node n) {
        String ln = n.getLocalName();
        if (ln != null) return ln;
        String nn = n.getNodeName();
        if (nn == null) return "";
        int i = nn.indexOf(':');
        return i >= 0 ? nn.substring(i + 1) : nn;
    }

    private static List<Element> elementsByLocal(Document d, String name) {
        List<Element> out = new ArrayList<Element>();
        NodeList nl = d.getElementsByTagNameNS("*", name);
        for (int i = 0; i < nl.getLength(); i++) {
            Node n = nl.item(i);
            if (n.getNodeType() == Node.ELEMENT_NODE) out.add((Element) n);
        }
        return out;
    }

    private static List<Element> childrenByLocal(Element parent, String name) {
        List<Element> out = new ArrayList<Element>();
        NodeList nl = parent.getChildNodes();
        for (int i = 0; i < nl.getLength(); i++) {
            Node n = nl.item(i);
            if (n.getNodeType() == Node.ELEMENT_NODE && name.equals(localName(n))) {
                out.add((Element) n);
            }
        }
        return out;
    }

    /** 把 'BC12' 里的列名转成 0 基列号 */
    private static int colIndex(String ref) {
        if (ref == null) return 0;
        int v = 0;
        for (int i = 0; i < ref.length(); i++) {
            char ch = ref.charAt(i);
            if (ch >= 'A' && ch <= 'Z') {
                v = v * 26 + (ch - 'A' + 1);
            } else {
                break;
            }
        }
        return v - 1;
    }

    // ------------------------------------------------------------------ xlsx

    private static String readXlsx(InputStream in) throws Exception {
        Map<String, byte[]> z = unzip(in);

        List<String> shared = new ArrayList<String>();
        byte[] ss = z.get("xl/sharedStrings.xml");
        if (ss != null) {
            Document d = doc(ss);
            for (Element si : elementsByLocal(d, "si")) {
                StringBuilder sb = new StringBuilder();
                collectT(si, sb);
                shared.add(sb.toString());
            }
        }

        String sheetName = null;
        // 优先按 workbook 关系找第一个 sheet
        byte[] wb = z.get("xl/workbook.xml");
        byte[] rels = z.get("xl/_rels/workbook.xml.rels");
        if (wb != null && rels != null) {
            try {
                Document dw = doc(wb);
                List<Element> sheets = elementsByLocal(dw, "sheet");
                if (!sheets.isEmpty()) {
                    String rid = sheets.get(0).getAttribute("r:id");
                    if (rid == null || rid.length() == 0) {
                        rid = sheets.get(0).getAttributeNS(
                                "http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
                    }
                    Document dr = doc(rels);
                    for (Element rel : elementsByLocal(dr, "Relationship")) {
                        if (rid != null && rid.equals(rel.getAttribute("Id"))) {
                            String t = rel.getAttribute("Target");
                            if (t.startsWith("/")) t = t.substring(1);
                            else t = "xl/" + t;
                            sheetName = t.replace("//", "/");
                        }
                    }
                }
            } catch (Exception ignore) { }
        }
        if (sheetName == null || !z.containsKey(sheetName)) {
            sheetName = null;
            for (String k : z.keySet()) {
                if (k.startsWith("xl/worksheets/sheet") && k.endsWith(".xml")) { sheetName = k; break; }
            }
        }
        if (sheetName == null) throw new Exception("工作簿里没找到工作表");

        Document ds = doc(z.get(sheetName));
        List<Element> rowEls = elementsByLocal(ds, "row");

        // 行 -> (列 -> 值)
        Map<Integer, Map<Integer, String>> grid = new HashMap<Integer, Map<Integer, String>>();
        int maxCol = 0;
        int maxRow = 0;
        int autoRow = 0;
        for (Element row : rowEls) {
            String rs = row.getAttribute("r");
            int rIdx;
            try { rIdx = Integer.parseInt(rs) - 1; } catch (Exception ex) { rIdx = autoRow; }
            autoRow = rIdx + 1;
            Map<Integer, String> cells = new HashMap<Integer, String>();
            int autoCol = 0;
            for (Element c : childrenByLocal(row, "c")) {
                String ref = c.getAttribute("r");
                String type = c.getAttribute("t");
                int ci = (ref == null || ref.length() == 0) ? autoCol : colIndex(ref);
                if (ci < 0) ci = autoCol;
                autoCol = ci + 1;
                String val = null;
                if ("inlineStr".equals(type)) {
                    StringBuilder sb = new StringBuilder();
                    collectT(c, sb);
                    val = sb.toString();
                } else {
                    List<Element> vs = childrenByLocal(c, "v");
                    if (!vs.isEmpty()) val = vs.get(0).getTextContent();
                }
                if (val == null) continue;
                if ("s".equals(type)) {
                    try {
                        int idx = Integer.parseInt(val.trim());
                        val = (idx >= 0 && idx < shared.size()) ? shared.get(idx) : "";
                    } catch (Exception ex) { val = ""; }
                }
                if (val.length() == 0) continue;
                cells.put(ci, val.replace("\r", " ").replace("\n", " ").replace("\t", " "));
                if (ci > maxCol) maxCol = ci;
            }
            if (!cells.isEmpty()) {
                grid.put(rIdx, cells);
                if (rIdx > maxRow) maxRow = rIdx;
            }
        }

        // 合并单元格：把左上角的值铺满整个区域（课表里一节课常常横向合并）
        NodeList merges = ds.getElementsByTagNameNS("*", "mergeCell");
        for (int i = 0; i < merges.getLength(); i++) {
            Node n = merges.item(i);
            if (n.getNodeType() != Node.ELEMENT_NODE) continue;
            String ref = ((Element) n).getAttribute("ref");
            if (ref == null || ref.indexOf(':') < 0) continue;
            String[] parts = ref.split(":");
            int c1 = colIndex(parts[0]);
            int c2 = colIndex(parts[1]);
            int r1 = digits(parts[0]);
            int r2 = digits(parts[1]);
            Map<Integer, String> src = grid.get(r1);
            if (src == null) continue;
            String v = src.get(c1);
            if (v == null || v.length() == 0) continue;
            for (int r = r1; r <= r2; r++) {
                Map<Integer, String> rowm = grid.get(r);
                if (rowm == null) { rowm = new HashMap<Integer, String>(); grid.put(r, rowm); }
                for (int cc = c1; cc <= c2; cc++) {
                    if (!rowm.containsKey(cc)) rowm.put(cc, v);
                    if (cc > maxCol) maxCol = cc;
                }
                if (r > maxRow) maxRow = r;
            }
        }

        StringBuilder out = new StringBuilder();
        for (int r = 0; r <= maxRow; r++) {
            Map<Integer, String> rowm = grid.get(r);
            StringBuilder line = new StringBuilder();
            for (int c = 0; c <= maxCol; c++) {
                if (c > 0) line.append('\t');
                String v = rowm == null ? null : rowm.get(c);
                line.append(v == null ? "" : v);
            }
            String s = line.toString();
            if (s.replace("\t", "").trim().length() > 0) out.append(s).append('\n');
        }
        return out.toString();
    }

    private static int digits(String ref) {
        int i = 0;
        while (i < ref.length() && !(ref.charAt(i) >= '0' && ref.charAt(i) <= '9')) i++;
        try { return Integer.parseInt(ref.substring(i)) - 1; } catch (Exception e) { return 0; }
    }

    private static void collectT(Node n, StringBuilder sb) {
        NodeList nl = n.getChildNodes();
        for (int i = 0; i < nl.getLength(); i++) {
            Node c = nl.item(i);
            short t = c.getNodeType();
            if (t == Node.ELEMENT_NODE) {
                if ("t".equals(localName(c))) sb.append(c.getTextContent());
                else collectT(c, sb);
            }
        }
    }

    // ------------------------------------------------------------------ docx

    private static String readDocx(InputStream in) throws Exception {
        Map<String, byte[]> z = unzip(in);
        byte[] xml = z.get("word/document.xml");
        if (xml == null) throw new Exception("不是有效的 docx（缺 word/document.xml）");
        Document d = doc(xml);
        StringBuilder sb = new StringBuilder();
        walkDocx(d.getDocumentElement(), sb);
        return sb.toString();
    }

    private static void walkDocx(Node n, StringBuilder sb) {
        if (n.getNodeType() != Node.ELEMENT_NODE) return;
        String ln = localName(n);
        if ("t".equals(ln)) { sb.append(n.getTextContent()); return; }
        if ("tab".equals(ln)) { sb.append('\t'); return; }
        if ("br".equals(ln) || "cr".equals(ln)) { sb.append('\n'); return; }
        NodeList ch = n.getChildNodes();
        for (int i = 0; i < ch.getLength(); i++) walkDocx(ch.item(i), sb);
        if ("p".equals(ln)) sb.append('\n');
        else if ("tc".equals(ln)) sb.append('\t');
        else if ("tr".equals(ln)) sb.append('\n');
    }

    // ------------------------------------------------------------------ text

    /** 先按 UTF-8 解码，出现替代字符就退回 GBK（国内 WPS 导出的 csv 常见）。 */
    public static String readTextSmart(InputStream in) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        byte[] raw = bo.toByteArray();
        String s = new String(raw, "UTF-8");
        if (s.indexOf('\uFFFD') >= 0) {
            try {
                String g = new String(raw, "GBK");
                if (g.indexOf('\uFFFD') < 0) s = g;
            } catch (Exception ignore) { }
        }
        if (s.startsWith("\uFEFF")) s = s.substring(1);
        return s;
    }
}

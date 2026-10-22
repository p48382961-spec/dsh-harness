package dev.dsh.harness;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Comparator;

/**
 * 诊断回传。
 *
 * 为什么需要它：引擎起不来时，DSH 会把完整诊断写到
 * filesDir/home/.dsh/logs/startup-*.log，那是 App 的私有目录，
 * Termux 里的 shell 读不到（/sdcard 对 Termux 也是拒绝的），logcat 也只给系统日志。
 * 所以由 App 自己把日志 POST 到本机下载服务的 /upload 端点
 * （dsh-dl-server.py 会落到 试玩/dsh-shell-b/logs/），开发侧就能读了。
 */
final class Diag {
    private static final String UPLOAD = "http://127.0.0.1:8099/upload?name=";

    private Diag() {}

    /** 最近一次 startup-*.log 的尾部；没有就返回空串。 */
    static String latestStartupLog(File root) {
        File dir = new File(root, "home/.dsh/logs");
        File[] fs = dir.listFiles((d, n) -> n.startsWith("startup-") && n.endsWith(".log"));
        if (fs == null || fs.length == 0) return "";
        Arrays.sort(fs, Comparator.comparingLong(File::lastModified).reversed());
        return tailOf(fs[0], 800);
    }

    /** 读文件最后 maxLines 行（诊断日志可能几 MB，别整个读进来）。 */
    private static String tailOf(File f, int maxLines) {
        try (InputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            String all = bos.toString(StandardCharsets.UTF_8.name());
            String[] lines = all.split("\n", -1);
            int from = Math.max(0, lines.length - maxLines);
            StringBuilder sb = new StringBuilder();
            sb.append("# ").append(f.getName()).append(" (").append(all.length()).append(" chars, 显示末 ")
              .append(lines.length - from).append(" 行)\n");
            for (int i = from; i < lines.length; i++) sb.append(lines[i]).append('\n');
            return sb.toString();
        } catch (Exception e) {
            return "# 读日志失败: " + e + "\n";
        }
    }

    /** 把一段文本投递到开发机（本机回环）。返回 true 表示服务端收下了。 */
    static boolean upload(String name, String content) {
        try {
            byte[] body = content.getBytes(StandardCharsets.UTF_8);
            HttpURLConnection c = (HttpURLConnection) new URL(
                    UPLOAD + URLEncoder.encode(name, "UTF-8")).openConnection();
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setConnectTimeout(3000);
            c.setReadTimeout(10000);
            c.setFixedLengthStreamingMode(body.length);
            c.setRequestProperty("Content-Type", "text/plain; charset=utf-8");
            try (OutputStream out = c.getOutputStream()) {
                out.write(body);
            }
            int code = c.getResponseCode();
            if (code == 200) return true;
            android.util.Log.w("DSH-B", "上传诊断返回 " + code);
            return false;
        } catch (Exception e) {
            android.util.Log.w("DSH-B", "上传诊断失败", e);
            return false;
        }
    }
}

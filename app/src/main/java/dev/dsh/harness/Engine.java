package dev.dsh.harness;

import android.content.Context;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 引擎进程的唯一持有者（进程内单例）。
 *
 * <p>为什么单独抽出来：保活要求「Activity 死了引擎还活着」—— 由 {@link EngineService}
 * 前台服务持有它，Activity 只当观众。进程、token、日志尾巴都挂在这里的静态字段上，
 * 谁先起来谁拉起，后到的复用。
 */
final class Engine {
    private static final String TAG = "DSH-B";
    private static final long BOOT_TIMEOUT_MS = 90000;
    private static final Pattern TOKEN = Pattern.compile("token=([A-Za-z0-9_-]{20,})");

    /** 进度/日志回调；在后台线程被调用，调用方自己切主线程。 */
    interface Note { void say(String msg); }

    private static Process proc;
    private static String token;
    private static final List<String> tail = new ArrayList<>();
    private static volatile boolean preparing;
    private static volatile String lastError;
    private static File engineLog;

    /** 看门狗把引擎重新拉起来之后要跑的收尾动作（由 MainActivity 注册：刷新页面）。 */
    public static volatile Runnable onRestarted;

    /** 引擎实际用的端口（默认 Build.PORT；要是被陌生实例占着就拿不到 token，只能换一个）。 */
    private static volatile int port = Build.PORT;
    private static File tokenFile;

    static int port() { return port; }

    private Engine() {}

    /** 引擎是否可用：TCP 通 **且** HTTP 真回包（只探端口会把「node 刚绑上端口还在加载」当成好了）。 */
    static boolean isUp() {
        return tcpOk(port) && httpReady();
    }

    static String token() { return token; }

    static List<String> tail() {
        synchronized (tail) { return new ArrayList<>(tail); }
    }

    static String lastError() { return lastError; }

    /**
     * 确保引擎跑起来。<b>幂等</b>：已经在跑就直接返回。
     *
     * @return 本次新起的引擎的 token；若引擎本来就在跑则返回 null（调用方用 cookie 打开首页即可）
     */
    static synchronized String ensure(final Context ctx, final Note note) throws Exception {
        final File root = Rootfs.dir(ctx);
        tokenFile = new File(root, "engine.token");
        engineLog = new File(root, "engine.log");

        if (isUp()) {
            // 引擎还活着（很可能是上一轮 App 进程没了、node 被前台服务留着）：token 在文件里，捡回来。
            if (token == null) token = readToken();
            if (token != null) return token;
            // 端口有人应答但拿不到它的 token（例如换包名前的旧 App 还占着 3082）⇒ 换端口另起一个。
            lastError = "端口 " + port + " 被别的实例占据，换端口重启";
            port = freePort(Build.PORT + 1);
        }
        if (preparing) return null;

        preparing = true;
        lastError = null;
        try {
            flushPrevLog(root);
            killOrphan(ctx, root);

            Rootfs.ensure(ctx, new Rootfs.Progress() {
                @Override public void step(String msg) { if (note != null) note.say(msg); }
                @Override public void bytes(long done, long total) {
                    if (note != null) note.say("下载 " + (done >> 20) + " / " + (total >> 20) + " MB");
                }
            });

            Rootfs.seedWorkspace(root); // 预置默认工作区（幂等）

            File tmp = new File(root, "home/tmp");
            //noinspection ResultOfMethodCallIgnored
            tmp.mkdirs();

            if (note != null) note.say("启动引擎（linker64 + node）…");
            String t = spawn(root, note);
            if (t == null) {
                lastError = "引擎没起来了（90 秒内没拿到 token）";
                return null;
            }
            token = t;
            writeToken(t);
            return t;
        } catch (Throwable e) {
            lastError = String.valueOf(e);
            throw e;
        } finally {
            preparing = false;
        }
    }

    /** 主动停止（通知里的「停止引擎」）。 */
    static void stop() {
        Process p = proc;
        proc = null;
        token = null;
        clearToken();
        if (p != null) {
            p.destroy(); // SIGTERM：DSH 自己会优雅收尾
        }
    }

    /** 一行现状，给心跳上报用（不含 token 全文，只给长度）。 */
    static String statusLine() {
        Process p = proc;
        String t = token;
        return "pid=" + pidOf(p) + " running=" + isRunning() + " up=" + isUp()
                + " tokenLen=" + (t == null ? 0 : t.length());
    }

    static boolean isRunning() {
        Process p = proc;
        if (p == null) return false;
        try {
            p.exitValue();
            return false;
        } catch (IllegalThreadStateException alive) {
            return true;
        }
    }


    // ------------------------------------------------------------ 实例归属

    /**
     * 上一轮被划掉时，node 可能比 App 进程活得久（成了孤儿、还占着端口），
     * 新会话再拉一个就会撞端口/连到旧实例（token 对不上，页面看似正常却发不出消息）。
     * 这里按 pid 文件认领：还活着、且命令行确实是我们的 rootfs，就发 SIGKILL 清掉。
     */
    /** token 落盘：App 进程被杀、node 被前台服务留住时，重开 App 也能捡回同一个 token。 */
    private static void writeToken(String t) {
        if (tokenFile == null) return;
        try {
            java.io.FileOutputStream fos = new java.io.FileOutputStream(tokenFile, false);
            try {
                fos.write((t + "\n").getBytes("UTF-8"));
            } finally {
                fos.close();
            }
        } catch (IOException ignored) {
            // 写不进去只是下次得多重启一次引擎，不影响本次
        }
    }

    private static String readToken() {
        if (tokenFile == null || !tokenFile.isFile()) return null;
        try {
            java.io.BufferedReader r = new java.io.BufferedReader(
                    new java.io.InputStreamReader(new java.io.FileInputStream(tokenFile), "UTF-8"));
            try {
                String line = r.readLine();
                if (line == null) return null;
                line = line.trim();
                return line.isEmpty() ? null : line;
            } finally {
                r.close();
            }
        } catch (IOException e) {
            return null;
        }
    }

    private static void clearToken() {
        if (tokenFile != null && tokenFile.isFile()) {
            //noinspection ResultOfMethodCallIgnored
            tokenFile.delete();
        }
    }

    /** 从 start 往上找一个没人监听的端口。 */
    private static int freePort(int start) {
        for (int p = start; p <= start + 11; p++) {
            if (!tcpOk(p)) return p;
        }
        return start;
    }

    private static void killOrphan(Context ctx, File root) {
        File pf = new File(root, "engine.pid");
        try {
            if (!pf.isFile()) return;
            String txt = new String(java.nio.file.Files.readAllBytes(pf.toPath()),
                    java.nio.charset.StandardCharsets.UTF_8).trim();
            if (txt.isEmpty()) return;
            int pid = Integer.parseInt(txt);
            if (pid == android.os.Process.myPid()) {   // 绝不可能杀自己
                //noinspection ResultOfMethodCallIgnored
                pf.delete();
                return;
            }
            Process cur = proc;
            if (cur != null && pidOf(cur) == pid) return;
            String cmdline = readCmdline(pid);
            if (cmdline == null) {                 // 已经不在了
                //noinspection ResultOfMethodCallIgnored
                pf.delete();
                return;
            }
            if (!cmdline.contains(root.getAbsolutePath())) {  // pid 被复用，不是我们的
                //noinspection ResultOfMethodCallIgnored
                pf.delete();
                return;
            }
            Life.note(ctx, "清理上一轮遗留的引擎 pid=" + pid);
            android.os.Process.sendSignal(pid, 9);
            Thread.sleep(400);
        } catch (Throwable e) {
            Life.note(ctx, "清理遗留引擎失败：" + e);
        }
    }

    private static String readCmdline(int pid) {
        try {
            File f = new File("/proc/" + pid + "/cmdline");
            if (!f.isFile()) return null;
            byte[] b = java.nio.file.Files.readAllBytes(f.toPath());
            if (b.length == 0) return null;
            return new String(b, java.nio.charset.StandardCharsets.UTF_8).replace('\0', ' ');
        } catch (Throwable e) {
            return null;
        }
    }

    private static void writePid(File root, int pid) {
        if (pid <= 0) return;
        try {
            java.nio.file.Files.write(new File(root, "engine.pid").toPath(),
                    String.valueOf(pid).getBytes(java.nio.charset.StandardCharsets.UTF_8));
        } catch (Throwable ignored) {
            // pid 文件只是辅助，写不了不影响启动
        }
    }

    /** Process 没有公开的 pid 取法，反射拿（Android 的 ProcessImpl 一直有 pid 字段）。 */
    static int pidOf(Process p) {
        if (p == null) return -1;
        try {
            java.lang.reflect.Field f = p.getClass().getDeclaredField("pid");
            f.setAccessible(true);
            Object v = f.get(p);
            return v instanceof Integer ? (Integer) v : -1;
        } catch (Throwable e) {
            return -1;
        }
    }

    // ---------------------------------------------------------------- 内部

    private static String spawn(final File root, final Note note) throws IOException {
        File node = new File(root, "usr/bin/node");
        File binJs = new File(root, "usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js");
        if (!node.isFile()) throw new IOException("快照里没有 node: " + node);
        if (!binJs.isFile()) throw new IOException("快照里没有 bin.js: " + binJs);

        List<String> cmd = new ArrayList<>();
        cmd.add("/system/bin/linker64");
        cmd.add(node.getAbsolutePath());
        cmd.add("--expose-internals");
        cmd.add(binJs.getAbsolutePath());
        cmd.add("web");
        cmd.add("--port");
        cmd.add(String.valueOf(port));

        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.redirectErrorStream(true);
        pb.directory(new File(root, "home"));
        pb.environment().put("LD_LIBRARY_PATH", new File(root, "usr/lib").getAbsolutePath());
        pb.environment().put("HOME", new File(root, "home").getAbsolutePath());
        pb.environment().put("DSH_HOME", new File(root, "home/.dsh").getAbsolutePath());
        pb.environment().put("TMPDIR", new File(root, "home/tmp").getAbsolutePath());
        pb.environment().put("PATH",
                new File(root, "usr/bin").getAbsolutePath() + ":/system/bin:/system/xbin");
        pb.environment().put("LANG", "zh_CN.UTF-8");
        // Termux 版 node 的 OpenSSL 是**编译期**写死查询 /data/data/com.termux/files/usr/etc/tls/openssl.cnf
        // 的（二进制里 20 处 com.termux 字样，长度不同没法原地改）。那是别的应用的私有目录，
        // 我们读不到 ⇒ node 一启动就 "OpenSSL configuration error: … Permission denied" 直接退。
        // OpenSSL 认 OPENSSL_CONF 环境变量，指到载荷自己的副本即可。
        pb.environment().put("OPENSSL_CONF", new File(root, "usr/etc/tls/openssl.cnf").getAbsolutePath());
        pb.environment().put("SSL_CERT_FILE", new File(root, "usr/etc/tls/cert.pem").getAbsolutePath());
        pb.environment().put("SSL_CERT_DIR", new File(root, "usr/etc/tls").getAbsolutePath());
        pb.environment().put("TZ", "Asia/Shanghai");
        pb.environment().put("PREFIX", new File(root, "usr").getAbsolutePath());
        pb.environment().put("SHELL", new File(root, "usr/bin/bash").getAbsolutePath());

        proc = pb.start();
        writePid(root, pidOf(proc));
        final BufferedReader out = new BufferedReader(new InputStreamReader(proc.getInputStream()));
        final long deadline = System.currentTimeMillis() + BOOT_TIMEOUT_MS;
        String line;
        String found = null;
        while ((line = out.readLine()) != null) {
            Log.i(TAG, "engine: " + line);
            remember(line);
            if (found == null) {
                Matcher m = TOKEN.matcher(line);
                if (m.find()) {
                    found = m.group(1);
                    if (note != null) note.say("引擎已就绪");
                }
            }
            if (found != null) break;
            if (System.currentTimeMillis() > deadline) {
                if (note != null) note.say("引擎输出超时");
                break;
            }
        }
        watch(out, proc);
        return found;
    }

    /** 拿完 token 后继续消费输出（不读会堵管道，引擎会卡住）。 */
    private static void watch(final BufferedReader out, final Process p) {
        Thread t = new Thread(() -> {
            try {
                String line;
                while ((line = out.readLine()) != null) {
                    Log.i(TAG, "engine: " + line);
                    remember(line);
                }
            } catch (IOException ignored) {
                // 引擎退出时正常
            }
            // 输出流结束 = 引擎走了。记下退出码：137 多半是被系统 SIGKILL，其它值是自己退的。
            int code = -1;
            try {
                code = p.exitValue();
            } catch (IllegalThreadStateException stillAlive) {
                code = -2;
            }
            String when = new java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US)
                    .format(new java.util.Date());
            remember("[engine 退出] code=" + code + " at " + when);
            Log.i(TAG, "engine exit code=" + code);
        }, "engine-watch");
        t.setDaemon(true);
        t.start();
    }

    /** 留最后 12 行给失败页，同时落盘一份（重启后由 flushPrevLog 回传）。 */
    private static void remember(String line) {
        synchronized (tail) {
            tail.add(line);
            while (tail.size() > 12) tail.remove(0);
        }
        if (engineLog == null) return;
        try {
            if (engineLog.length() > 400 * 1024) {
                //noinspection ResultOfMethodCallIgnored
                engineLog.delete();
            }
            java.io.FileOutputStream fos = new java.io.FileOutputStream(engineLog, true);
            try {
                fos.write((line + "\n").getBytes("UTF-8"));
            } finally {
                fos.close();
            }
        } catch (IOException ignored) {
            // 日志落盘失败不影响主流程
        }
    }

    /** 把上一轮留下的 engine.log（末 200 KB）回传到本机下载服务，方便我们看现场。 */
    private static void flushPrevLog(File root) {
        try {
            File log = new File(root, "engine.log");
            if (!log.isFile() || log.length() == 0) return;
            final byte[] buf = new byte[(int) Math.min(log.length(), 200 * 1024)];
            java.io.FileInputStream in = new java.io.FileInputStream(log);
            try {
                int off = 0;
                while (off < buf.length) {
                    int n = in.read(buf, off, buf.length - off);
                    if (n < 0) break;
                    off += n;
                }
            } finally {
                in.close();
            }
            String name = "engine-" + new java.text.SimpleDateFormat("MMdd-HHmmss",
                    java.util.Locale.US).format(new java.util.Date()) + ".log";
            Diag.upload(name, new String(buf, "UTF-8"));
        } catch (Throwable ignored) {
            // 回传失败无所谓
        }
    }

    private static boolean tcpOk(int port) {
        Socket s = new Socket();
        try {
            s.connect(new InetSocketAddress("127.0.0.1", port), 1500);
            return true;
        } catch (IOException e) {
            return false;
        } finally {
            try { s.close(); } catch (IOException ignored) { }
        }
    }

    /** 真回包才算活着：node 会先绑端口再加载模块，只探端口会过早判定。 */
    static boolean httpReady() {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/").openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(1500);
            c.setReadTimeout(2500);
            c.setRequestMethod("GET");
            return c.getResponseCode() > 0;
        } catch (Throwable e) {
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }
}

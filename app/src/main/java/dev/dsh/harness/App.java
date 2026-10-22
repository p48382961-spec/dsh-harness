package dev.dsh.harness;

import android.app.Application;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 崩溃取证：Android 17 上 logcat 只回放系统日志（无 AndroidRuntime/FATAL 行），
 * 所以「点图标直接回弹」这类崩溃在外面完全看不见。这里装一个兜底 handler：
 * 把栈写到 {@code files/crash.log}，再尽量 POST 到本机下载服务；
 * 下次启动时 {@link #flushPending()} 会把上次没送出去的崩溃补传。
 */
public class App extends Application {
    private static final String TAG = "DSH-B";

    @Override
    public void onCreate() {
        super.onCreate();
        Life.note(this, "Application.onCreate v" + name());

        final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, e) -> {
            try {
                String body = "version: " + name() + "\nthread: " + thread.getName()
                        + "\n\n" + Log.getStackTraceString(e);
                appendCrash(body);
                Diag.upload("crash-" + stamp() + ".log", body);
                Life.note(this, "CRASH " + e.getClass().getName() + ": " + e.getMessage());
            } catch (Throwable ignored) {
                // 崩溃处理里再崩就认了
            }
            if (prev != null) prev.uncaughtException(thread, e);
        });

        flushPending();
        immediateReport();
        startLiveUpload();
        startHeartbeat();
        startLifeUpload();
    }

    /**
     * 实时把 engine.log 的新尾巴送出来：进程被划掉时 {@code watch()} 线程会跟着死，
     * 来不及写退出码。有了这个每 45 秒一次的增量回传，node 自己吐的 stderr 不会丢。
     */
    private void startLiveUpload() {
        new Thread(() -> {
            long lastLen = -1;
            while (true) {
                try {
                    Thread.sleep(45000);
                } catch (InterruptedException e) {
                    return;
                }
                try {
                    File log = new File(getFilesDir(), "engine.log");
                    long len = log.isFile() ? log.length() : 0;
                    if (len == 0 || len == lastLen) continue;
                    lastLen = len;
                    Diag.upload("engine-live-" + stamp() + ".log", tail(log, 60));
                } catch (Throwable ignored) {
                    // 下一轮再试
                }
            }
        }, "live-upload").start();
    }

    /** 进程一起来就先报一声：这样即使 4 秒后就被杀，我们也有迹可循。 */
    private void immediateReport() {
        try {
            String ver = "?";
            try {
                ver = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Throwable ignored) {
                // 版本号取不到就写 ?
            }
            String info = "version=" + ver
                    + " snapshot=" + Build.VERSION_SNAPSHOT
                    + "\nmyPid=" + android.os.Process.myPid()
                    + "\nthreads=" + Thread.activeCount()
                    + "\n";
            Diag.upload("boot-" + stamp() + ".log", info);
        } catch (Throwable ignored) {
            // 上报失败不影响启动
        }
    }

    /** life.log 有变化就每 20 秒送一次：生命周期打点比引擎日志更能说明"进程怎么没的"。 */
    private void startLifeUpload() {
        new Thread(() -> {
            long lastLen = -1;
            while (true) {
                try {
                    Thread.sleep(20000);
                } catch (InterruptedException e) {
                    return;
                }
                try {
                    File f = new File(getFilesDir(), "life.log");
                    long len = f.isFile() ? f.length() : 0;
                    if (len == 0 || len == lastLen) continue;
                    lastLen = len;
                    Diag.upload("life-live-" + stamp() + ".log", tail(f, 80));
                } catch (Throwable ignored) {
                    // 下一轮
                }
            }
        }, "life-upload").start();
    }

    /**
     * 心跳：每 60 秒自报一次「App 进程在、引擎在不在、端口通不通、http 应答如何」。
     * 有了它就不用再靠 Termux 侧 curl 猜——两端网络视图不一致时一眼能看出来。
     */
    private void startHeartbeat() {
        new Thread(() -> {
            while (true) {
                try {
                    Thread.sleep(60000);
                } catch (InterruptedException e) {
                    return;
                }
                try {
                    Diag.upload("alive-" + stamp() + ".log",
                            "app=alive\n" + Engine.statusLine() + "\n");
                } catch (Throwable ignored) {
                    // 心跳失败不影响主流程
                }
            }
        }, "heartbeat").start();
    }

    /** 读文件末尾若干行（够看栈就够了）。 */
    private String tail(File f, int lines) {
        try {
            byte[] all = java.nio.file.Files.readAllBytes(f.toPath());
            String s = new String(all, StandardCharsets.UTF_8);
            String[] arr = s.split("\n", -1);
            int from = Math.max(0, arr.length - lines);
            StringBuilder sb = new StringBuilder();
            for (int i = from; i < arr.length; i++) sb.append(arr[i]).append('\n');
            return sb.toString();
        } catch (Throwable e) {
            return "# 读失败: " + e + "\n";
        }
    }

    /** 上次残留的 crash.log（多半是没送出去的那份）补传；life.log 顺手带一份，能看到生命周期。 */
    private void flushPending() {
        new Thread(() -> {
            try {
                File life = new File(getFilesDir(), "life.log");
                if (life.isFile() && life.length() > 0) {
                    String text = new String(java.nio.file.Files.readAllBytes(life.toPath()),
                            StandardCharsets.UTF_8);
                    Diag.upload("life-" + stamp() + ".log", text);
                }
            } catch (Throwable ignored) {
                // 下次再试
            }
        }, "life-flush").start();

        final File f = new File(getFilesDir(), "crash.log");
        if (!f.isFile()) return;
        new Thread(() -> {
            try {
                String text = new String(java.nio.file.Files.readAllBytes(f.toPath()),
                        StandardCharsets.UTF_8);
                if (Diag.upload("crash-prev-" + stamp() + ".log", text)) {
                    //noinspection ResultOfMethodCallIgnored
                    f.delete();
                }
            } catch (Throwable ignored) {
                // 下次再试
            }
        }, "crash-flush").start();
    }

    private void appendCrash(String body) throws IOException {
        File f = new File(getFilesDir(), "crash.log");
        FileOutputStream fos = new FileOutputStream(f, true);
        try {
            fos.write((body + "\n----\n").getBytes(StandardCharsets.UTF_8));
        } finally {
            fos.close();
        }
    }

    private String stamp() {
        return new SimpleDateFormat("MMdd-HHmmss", Locale.US).format(new Date());
    }

    private String name() {
        try {
            android.content.pm.PackageInfo pi = getPackageManager()
                    .getPackageInfo(getPackageName(), 0);
            return Build.VERSION_SNAPSHOT + " / " + pi.versionName + "(" + pi.versionCode + ")";
        } catch (Throwable e) {
            return Build.VERSION_SNAPSHOT;
        }
    }
}

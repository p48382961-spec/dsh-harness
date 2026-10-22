package dev.dsh.harness;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

/**
 * 前台服务：引擎的「看守者」。
 *
 * <p>保活的要害不在定时器，而在<b>归属</b>：进程必须挂在有前台通知的 Service 上，
 * Activity 退出/被回收都不影响它；回到前台再探活复用即可。targetSdk 28 下不需要
 * 声明 FOREGROUND_SERVICE_* 类型，通知也不需要运行时授权。
 */
public class EngineService extends Service {
    private static final String TAG = "DSH-B";
    private static final String CHANNEL = "engine-run";
    private static final int NOTIF_ID = 42;
    static final String ACTION_STOP = "dev.dsh.harness.action.STOP";

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        // 频道建好就不能改级别，所以换了新 id（engine-min）；旧的低优先级频道顺手删掉。
        if (nm.getNotificationChannel("engine") != null) nm.deleteNotificationChannel("engine");
        if (nm.getNotificationChannel("engine-min") != null) nm.deleteNotificationChannel("engine-min");
        if (nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "引擎运行中",
                    NotificationManager.IMPORTANCE_LOW); // LOW：安静（无声/无振动/不进锁屏），但确实是可见的前台服务
        // 别用 IMPORTANCE_MIN：部分版本会把它当成"没有可见通知"，前台服务因此不被计入存活理由，
        // 切后台约 1 分钟后整个进程被系统回收（我们 16:59 就是这样被杀的）。
            ch.setDescription("DSH 引擎（大肥鱼）的前台运行状态");
            ch.setShowBadge(false);
            ch.enableLights(false);
            ch.enableVibration(false);
            ch.setSound(null, null);
            ch.setLockscreenVisibility(Notification.VISIBILITY_SECRET);
            nm.createNotificationChannel(ch);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopped = true;
            Engine.stop();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        lastSpawnHint = System.currentTimeMillis();
        startForegroundSafely("正在唤醒大肥鱼…");
        new Thread(() -> {
            try {
                Engine.ensure(this, this::startForegroundSafely);
                if (Engine.isUp()) {
                    startForegroundSafely("大肥鱼在运行");
                } else {
                    startForegroundSafely("大肥鱼没醒：" + Engine.lastError());
                }
            } catch (Throwable t) {
                Log.e(TAG, "service ensure 失败", t);
                startForegroundSafely("唤醒失败：" + t);
            }
        }, "engine-service").start();

        startSupervisor();

        return START_STICKY; // 被系统杀了希望它回来
    }

    /** startForeground 在坏通知/权限变化时可能抛，服务不能因此崩掉整个进程。 */
    private void startForegroundSafely(String text) {
        try {
            startForeground(NOTIF_ID, notify(text));
        } catch (Throwable e) {
            Log.e(TAG, "startForeground 失败：" + text, e);
            Life.note(this, "startForeground 失败：" + e);
        }
    }

    private Notification notify(String text) {
        Intent open = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent stop = new Intent(this, EngineService.class).setAction(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(this, 1, stop,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);
        b.setContentTitle("DeepSeek Harness")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setOngoing(true)
                .setShowWhen(false)
                .setOnlyAlertOnce(true)
                .setContentIntent(content)
                .setPriority(Notification.PRIORITY_LOW)
                .addAction(new Notification.Action.Builder(
                        android.graphics.drawable.Icon.createWithResource(this, android.R.drawable.ic_menu_close_clear_cancel),
                        "停止引擎", stopPi).build());
        if (Build.VERSION.SDK_INT >= 31) {
            // Android 12+ 允许"延迟展示"：先让系统知道我们是前台服务，通知晚 10 秒再画。
            // 引擎本来就要 8~10 秒启动，多数时候等你看到界面时它已经过去了。
            // 曾经在这里设 FOREGROUND_SERVICE_DEFERRED（延迟 10 秒才画通知），
            // 结果系统在这 10 秒窗口里不认它是前台服务：用户一起手就切走，
            // App 变 cached，Android 的 phantom process killer 直接把 node 子进程收走。
            // 现在显式要求「立刻」生效。
            b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        }
        return b.build();
    }


    /**
     * 看门狗：引擎进程一旦没了就记录并重新拉起。
     * 这是「保活」的第二层 —— 前台服务保的是<b>我们的进程</b>，这里保的是<b>node 进程</b>：
     * 它可能自己退出（配置错、崩溃），也可能被系统在内存吃紧时杀掉，两者都要能自愈。
     */
    private void startSupervisor() {
        if (supervisor != null) return;
        supervisor = new Thread(() -> {
            int quiet = 0;
            while (!stopped) {
                try {
                    Thread.sleep(5000);
                } catch (InterruptedException e) {
                    return;
                }
                if (Engine.isRunning()) {
                    quiet = 0;
                    continue;
                }
                // 刚拉起来还没跑起来的那段时间不算「死了」
                if (System.currentTimeMillis() - lastSpawnHint < 15000) continue;
                quiet++;
                Life.note(this, "看门狗：引擎不在了（第 " + quiet + " 次），重新拉起");
                startForegroundSafely("引擎掉了，正在重新唤醒大肥鱼…");
                try {
                    Engine.ensure(this, this::startForegroundSafely);
                    startForegroundSafely(Engine.isUp() ? "大肥鱼在运行" : "大肥鱼没醒");
                    // 引擎换了新进程（升级/重启之后），页面还连着旧连接 —— 让界面自己重新加载
                    Runnable after = Engine.onRestarted;
                    if (after != null) {
                        try {
                            after.run();
                        } catch (Throwable e) {
                            Log.e(TAG, "重启回调失败", e);
                        }
                    }
                } catch (Throwable e) {
                    Log.e(TAG, "看门狗拉起失败", e);
                    Life.note(this, "看门狗拉起失败：" + e);
                }
                lastSpawnHint = System.currentTimeMillis();
                if (quiet > 20) {
                    Life.note(this, "看门狗：连续 20 次拉不起来，放弃");
                    return;
                }
            }
        }, "supervisor");
        supervisor.setDaemon(true);
        supervisor.start();
    }

    private Thread supervisor;
    private volatile boolean stopped;
    private volatile long lastSpawnHint;

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        Life.note(this, "EngineService.onTaskRemoved");
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        Life.note(this, "EngineService.onDestroy（引擎服务被销毁）");
        stopped = true;
        super.onDestroy();
    }
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}

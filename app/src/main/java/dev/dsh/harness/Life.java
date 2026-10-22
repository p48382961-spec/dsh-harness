package dev.dsh.harness;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;

/**
 * 最便宜的现场记录：一行一条，写到 files/life.log。
 * 用途：出现「点图标直接回弹」这种看不到日志的崩溃时，至少能确认 Activity 走到哪一步。
 */
final class Life {
    private static final String TAG = "DSH-B";

    private Life() {}

    static void note(Context ctx, String msg) {
        Log.i(TAG, msg);
        try {
            File f = new File(ctx.getFilesDir(), "life.log");
            if (f.length() > 64 * 1024) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
            String line = new java.text.SimpleDateFormat("MM-dd HH:mm:ss.SSS", java.util.Locale.US)
                    .format(new java.util.Date()) + " " + msg + "\n";
            FileOutputStream fos = new FileOutputStream(f, true);
            try {
                fos.write(line.getBytes("UTF-8"));
            } finally {
                fos.close();
            }
        } catch (Throwable ignored) {
            // 记日志本身不能影响主流程
        }
    }
}

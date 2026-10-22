package dev.dsh.harness;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import java.io.File;

/**
 * 路线 B 的壳 Activity：只负责「显示」与「进度提示」，引擎交给 {@link EngineService} 前台服务持有。
 *
 * <p>启动链路：启服务 → 服务里 {@link Engine#ensure}（下载载荷 → 解包 → linker64 起 node → 拿 token）
 * → 回到 Activity 带 token 导航（303 换 cookie）→ WebView 出真 DSH 界面。
 *
 * <p>保活语义：Activity 死掉<b>不</b>停引擎；回到前台时探活（TCP + HTTP 真回包），
 * 死了就地重新拉起并直接 loadUrl，不会出现「网页无法打开」的死页。
 */
public class MainActivity extends Activity {
    private static final String TAG = "DSH-B";

    private final Handler ui = new Handler(Looper.getMainLooper());

    private WebView web;
    private WebView popup;
    private FrameLayout host;
    private TextView status;
    private volatile boolean loaded;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        Life.note(this, "MainActivity.onCreate saved=" + (saved != null));
        writeAppVersion();
        askIgnoreBattery();

        // 引擎被看门狗重新拉起（升级完 / 重启脚本踢了它）之后，WebView 还抱着已经断掉的旧连接 ——
        // 这里注册一次性回调，由 EngineService 在拉起成功后调用，直接重新加载首页（cookie 还在）。
        Engine.onRestarted = () -> ui.post(() -> {
            WebView w = web;
            if (w == null) return;
            Life.note(this, "引擎重启完成，重新加载界面");
            String t = Engine.token();
            w.loadUrl("http://127.0.0.1:" + Engine.port() + "/" + (t != null ? "?token=" + t : ""));
        });

        final FrameLayout root = new FrameLayout(this);
        host = root;
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);
        // 关键：WebSettings 默认 setSupportMultipleWindows(false) —— 这时 window.open() 直接被忽略，
        // WebChromeClient.onCreateWindow 根本不会被调用（登录就是这个流程，表现为点完没反应/黑屏）。
        s.setSupportMultipleWindows(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        web.setBackgroundColor(Color.parseColor("#0f1115"));
        web.addJavascriptInterface(new Bridge(), "DSHBridge");
        wireBrowser(root);
        // 侧栏内置浏览器里的下载：WebView 自己不会保存文件，必须给 DownloadListener，
        // 否则点「下载」什么都不会发生（这就是之前"下载没法验证"的原因）。
        web.setDownloadListener((url, ua, cd, mime, len) -> startDownload(url, cd, mime));
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        status = new TextView(this);
        status.setTextColor(Color.parseColor("#9aa4b2"));
        status.setTextSize(12f);
        status.setPadding(28, 18, 28, 30);
        status.setBackgroundColor(Color.parseColor("#E60f1115"));
        status.setText("启动中…");
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.gravity = Gravity.BOTTOM;
        root.addView(status, lp);

        setContentView(root);
        applyFullscreen();
        kick();
    }

    /**
     * 全屏：隐藏状态栏 + 导航栏，内容铺满，边缘上滑临时唤出系统栏（IMMERSIVE_STICKY 会自动再收起）。
     * targetSdk 28，用不着 WindowInsetsController 那套新 API。
     */
    private void applyFullscreen() {
        android.view.Window w = getWindow();
        if (android.os.Build.VERSION.SDK_INT >= 28) {
            android.view.WindowManager.LayoutParams lp = w.getAttributes();
            lp.layoutInDisplayCutoutMode =
                    android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            w.setAttributes(lp);
        }
        w.setStatusBarColor(android.graphics.Color.TRANSPARENT);
        w.setNavigationBarColor(android.graphics.Color.TRANSPARENT);
        hideSystemBars();
    }

    private void hideSystemBars() {
        android.view.View d = getWindow().getDecorView();
        d.setSystemUiVisibility(
                android.view.View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | android.view.View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | android.view.View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | android.view.View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | android.view.View.SYSTEM_UI_FLAG_FULLSCREEN
                        | android.view.View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    @Override
    public void onBackPressed() {
        if (popup != null) {
            closePopup();
            return;
        }
        super.onBackPressed();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // 键盘收起/切回来时系统栏可能又冒出来，重新压下去
        if (hasFocus) hideSystemBars();
    }

    /** 保证服务起来，然后（如果当前没页面）走一次导航。 */
    /**
     * 请求「忽略电池优化」。不申请的话，系统会在切后台约 1 分钟后回收整个进程
     * （连带 node 子进程一起），这是我们反复抓到的那个"起来一会儿就没了"的最后一块拼图。
     * 只在还没被豁免时弹一次。
     */
    private void askIgnoreBattery() {
        try {
            android.os.PowerManager pm = getSystemService(android.os.PowerManager.class);
            if (pm == null || pm.isIgnoringBatteryOptimizations(getPackageName())) return;
            android.content.Intent in = new android.content.Intent(
                    android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            in.setData(android.net.Uri.parse("package:" + getPackageName()));
            in.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(in);
            Life.note(this, "已请求忽略电池优化");
        } catch (Throwable e) {
            Life.note(this, "请求忽略电池优化失败：" + e);
        }
    }

    private void kick() {
        startService(new Intent(this, EngineService.class));
        if (loaded) return;
        new Thread(this::boot, "boot").start();
    }

    private void boot() {
        final File root = Rootfs.dir(this);
        try {
            String token = Engine.ensure(this, msg -> note(msg));

            long deadline = System.currentTimeMillis() + 60000;
            while (!Engine.httpReady() && System.currentTimeMillis() < deadline) {
                try { Thread.sleep(300); } catch (InterruptedException e) { return; }
            }
            if (!Engine.httpReady()) {
                fail(root, "引擎起来了但页面没响应（HTTP 不通）");
                return;
            }

            final String t = Engine.token() != null ? Engine.token() : token;
            final String url = "http://127.0.0.1:" + Engine.port() + "/"
                    + (t != null ? "?token=" + t : "");
            ui.post(() -> {
                WebView w = web;
                if (w == null) {
                    Life.note(this, "boot 完成但 Activity 已销毁，丢弃这次导航");
                    return;
                }
                note("加载界面…");
                w.loadUrl(url);
                loaded = true;
                ui.postDelayed(() -> {
                    if (status != null) status.setVisibility(android.view.View.GONE);
                }, 1500);
            });
        } catch (Throwable e) {
            Log.e(TAG, "boot 失败", e);
            fail(root, "启动失败：" + e);
        }
    }

    /** 失败收口：把引擎 stdout 尾巴 + DSH 自己写的 startup-*.log 回传到本机下载服务。 */
    private void fail(File root, String why) {
        final StringBuilder sb = new StringBuilder(4096);
        sb.append("why: ").append(why).append('\n');
        sb.append("snapshot: ").append(Build.VERSION_SNAPSHOT).append('\n');
        java.util.List<String> tail = Engine.tail();
        sb.append("\n=== engine stdout (last ").append(tail.size()).append(") ===\n");
        sb.append(String.join("\n", tail)).append('\n');
        sb.append("\n=== startup log ===\n").append(Diag.latestStartupLog(root));
        String name = "dshb-" + new java.text.SimpleDateFormat("MMdd-HHmmss",
                java.util.Locale.US).format(new java.util.Date()) + ".log";
        boolean ok = Diag.upload(name, sb.toString());
        note(why + "\n启动日志" + (ok ? "已回传：logs/" + name : "回传失败（下载服务没开？）")
                + "\n最后输出：\n" + String.join("\n", tail));
    }

    /** 把 WebView 触发的下载落到 App 私有 Download 目录（不需要存储权限）。 */
    /** 主 WebView 的行为：本地页面自己渲染，外部链接交给系统浏览器，新窗口单独接住。 */
    private void wireBrowser(final FrameLayout root) {
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, android.webkit.WebResourceRequest req) {
                String u = req.getUrl().toString();
                Life.note(MainActivity.this, "主页面导航 " + u);
                if (isLocal(u)) return false;
                openExternal(u);
                return true;
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                Life.note(MainActivity.this, "页面加载完成 " + url);
                injectProbe(v, url);
            }

            @Override
            public void onReceivedError(WebView v, android.webkit.WebResourceRequest req,
                                        android.webkit.WebResourceError err) {
                if (req == null || !req.isForMainFrame()) return;
                String d = String.valueOf(err.getDescription());
                Life.note(MainActivity.this, "页面加载失败 " + req.getUrl() + " " + d);
                toast("页面加载失败：" + d);
            }
        });

        // DSH 的「登录」是在点击处理里同步 window.open("about:blank") 拿到窗口句柄、
        // 之后再往里导航到 device 授权页的。壳不实现 onCreateWindow 的话这个窗口根本不存在，
        // 点了登录就只剩一个黑屏 —— 这就是 0.7.1 里那个现象。
        web.setWebChromeClient(new android.webkit.WebChromeClient() {
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture,
                                          android.os.Message resultMsg) {
                Life.note(MainActivity.this, "页面请求新窗口 isDialog=" + isDialog);
                final WebView w = new WebView(MainActivity.this);
                WebSettings ps = w.getSettings();
                ps.setJavaScriptEnabled(true);
                ps.setDomStorageEnabled(true);
                ps.setDatabaseEnabled(true);
                ps.setSupportZoom(false);
                ps.setSupportMultipleWindows(true);
                ps.setJavaScriptCanOpenWindowsAutomatically(true);
                w.setBackgroundColor(Color.parseColor("#0f1115"));
                w.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, android.webkit.WebResourceRequest req) {
                        String u = req.getUrl().toString();
                        Life.note(MainActivity.this, "新窗口导航 " + u);
                        if (u.startsWith("about:") || isLocal(u)) return false;
                        // 授权页放系统浏览器里完成（那里有系统账号，也不用我们在壳里造表单）
                        openExternal(u);
                        closePopup();
                        return true;
                    }

                    @Override
                    public void onPageFinished(WebView v, String url) {
                        Life.note(MainActivity.this, "新窗口加载完成 " + url);
                    }
                });
                popup = w;
                root.addView(w, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                // 登录成功后页面会自己 popup.close()；不接 onCloseWindow 的话这个全屏 WebView
                // 会一直盖在最上层 —— 又是一块去不掉的黑屏。
                // （同一个页面在授权页被转交系统浏览器后也会 close，所以两条路都覆盖了。）
                android.webkit.WebView.WebViewTransport t =
                        (android.webkit.WebView.WebViewTransport) resultMsg.obj;
                t.setWebView(w);
                resultMsg.sendToTarget();
                return true;
            }

            @Override
            public void onCloseWindow(WebView window) {
                Life.note(MainActivity.this, "页面关闭新窗口");
                if (window != popup) return;
                closePopup();
            }
        });
    }

    /** 页面 → 壳 的单向日志桥，只用来查问题（不回传任何用户数据）。 */
    public class Bridge {
        @android.webkit.JavascriptInterface
        public void log(String msg) {
            Life.note(MainActivity.this, "JS " + msg);
        }
    }

    /**
     * 在本地页面里装一个探针：把 window.open 的调用与结果（拿到句柄还是 null）写进日志。
     * 登录流程就靠 window.open 开新窗口，黑屏时得知道它到底有没有被调用。
     */
    private void injectProbe(WebView v, String url) {
        if (!url.startsWith("http://127.0.0.1")) return;
        String js = "(function(){if(window.__dshbProbe)return;window.__dshbProbe=1;"
                + "try{var o=window.open;window.open=function(u,n,f){var r=null;try{r=o.call(window,u,n,f)}catch(e){}"
                + "try{DSHBridge.log('window.open('+String(u).slice(0,100)+','+n+') -> '+(r?'句柄':'null'))}catch(e){}"
                + "return r;};}catch(e){try{DSHBridge.log('hook failed '+e)}catch(_){}}"
                + "window.addEventListener('error',function(e){try{DSHBridge.log('js-error '+e.message)}catch(_){}});"
                + "try{DSHBridge.log('探针已装 '+location.pathname)}catch(e){}"
                + "})()";
        v.evaluateJavascript(js, null);
    }

    /**
     * 把外壳版本写到 files/app-version.txt，供载荷里的 dsh-app-release 插件读取
     * （插件查 GitHub Releases 时需要知道「现在装的是哪一版」）。
     */
    private void writeAppVersion() {
        try {
            String version = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            int code = getPackageManager().getPackageInfo(getPackageName(), 0).versionCode;
            java.io.File f = new java.io.File(getFilesDir(), "app-version.txt");
            try (java.io.FileWriter w = new java.io.FileWriter(f, false)) {
                w.write(version + " (" + code + ")\n");
            }
        } catch (Throwable t) {
            Life.note(this, "写 app-version.txt 失败：" + t);
        }
    }

    private static boolean isLocal(String u) {
        return u.startsWith("http://127.0.0.1") || u.startsWith("http://localhost")
                || u.startsWith("file:") || u.startsWith("about:") || u.startsWith("data:")
                || u.startsWith("blob:");
    }

    private void openExternal(String u) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, android.net.Uri.parse(u));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
            Life.note(this, "转交系统浏览器 " + u);
        } catch (Throwable e) {
            Life.note(this, "打不开外部链接：" + u + " " + e);
            toast("这个链接系统里没有能打开的 App：" + u);
        }
    }

    private void closePopup() {
        WebView w = popup;
        popup = null;
        if (w == null) return;
        if (w.getParent() instanceof ViewGroup) ((ViewGroup) w.getParent()).removeView(w);
        w.destroy();
        Life.note(this, "关闭新窗口");
    }

    private void toast(String msg) {
        try {
            android.widget.Toast.makeText(this, msg, android.widget.Toast.LENGTH_LONG).show();
        } catch (Throwable ignored) {
        }
    }

    private void startDownload(final String url, final String contentDisposition, final String mime) {
        final String name = guessName(url, contentDisposition);
        Life.note(this, "下载开始 " + name + " mime=" + mime + " <- " + url);
        showToast("开始下载：" + name);
        if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) {
            showToast("这个地址没法下载：" + url);
            return;
        }
        new Thread(() -> {
            File base = getExternalFilesDir(null);
            File dir = new File(base != null ? base : getFilesDir(), "Download");
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            File out = new File(dir, name);
            File part = new File(dir, name + ".part");
            try (java.io.InputStream in = open(url)) {
                try (java.io.OutputStream os = new java.io.BufferedOutputStream(
                        new java.io.FileOutputStream(part), 256 * 1024)) {
                    byte[] buf = new byte[256 * 1024];
                    long total = 0;
                    long lastNote = 0;
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        os.write(buf, 0, n);
                        total += n;
                        if (total - lastNote >= 4L * 1024 * 1024) {
                            lastNote = total;
                            final long t = total;
                            ui.post(() -> showToast("下载中：" + (t / 1048576) + " MB"));
                        }
                    }
                }
                //noinspection ResultOfMethodCallIgnored
                part.renameTo(out);
                Life.note(this, "下载完成 " + out + " " + out.length() + " B");
                ui.post(() -> showToast("下载完成：" + out.getAbsolutePath()));
            } catch (Throwable e) {
                Life.note(this, "下载失败 " + e);
                ui.post(() -> showToast("下载失败：" + e));
            }
        }, "download").start();
    }

    private java.io.InputStream open(String url) throws java.io.IOException {
        java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setInstanceFollowRedirects(true);
        c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android) DSHShell");
        return c.getInputStream();
    }

    /** 从 Content-Disposition 或 URL 猜文件名（中文名做一次 URL 解码）。 */
    private String guessName(String url, String cd) {
        String name = null;
        if (cd != null) {
            java.util.regex.Matcher m = java.util.regex.Pattern
                    .compile("filename\\*?=(?:UTF-8''|\")?([^\";]+)", java.util.regex.Pattern.CASE_INSENSITIVE)
                    .matcher(cd);
            if (m.find()) name = m.group(1);
        }
        if (name == null || name.trim().isEmpty()) {
            String path = url == null ? "" : url.split("[?#]")[0];
            int slash = path.lastIndexOf('/');
            name = slash >= 0 ? path.substring(slash + 1) : path;
        }
        try {
            name = java.net.URLDecoder.decode(name, "UTF-8");
        } catch (Throwable ignored) {
            // 解不开就原样用
        }
        if (name == null || name.trim().isEmpty()) name = "download.bin";
        return name.replaceAll("[\\\\/:*?\"<>|]", "_");
    }

    private void showToast(String msg) {
        try {
            android.widget.Toast.makeText(this, msg, android.widget.Toast.LENGTH_SHORT).show();
        } catch (Throwable ignored) {
            // 界面没了就只留日志
        }
    }

    private void note(String msg) {
        Log.i(TAG, msg);
        ui.post(() -> {
            if (status != null && !loaded) status.setText(msg);
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 从后台回来：引擎可能已被系统收掉。探一次，死了就地拉起（不再出现死页面）。
        // 注意：探活是 TCP/HTTP，**绝不能**在主线程做（NetworkOnMainThreadException 会直接崩溃回弹）。
        Life.note(this, "onResume loaded=" + loaded);
        if (!loaded) return;
        new Thread(() -> {
            boolean up = Engine.isUp();
            Life.note(this, "onResume 探活 engineUp=" + up);
            if (up) return;
            ui.post(() -> {
                loaded = false;
                if (status != null) status.setVisibility(android.view.View.VISIBLE);
                note("引擎没在跑，正在重新拉起…");
                startService(new Intent(this, EngineService.class));
                new Thread(this::boot, "reboot").start();
            });
        }, "probe").start();
    }

    @Override
    protected void onPause() {
        super.onPause();
        Life.note(this, "MainActivity.onPause");
    }

    @Override
    protected void onStop() {
        super.onStop();
        Life.note(this, "MainActivity.onStop");
    }

    @Override
    protected void onDestroy() {
        Life.note(this, "MainActivity.onDestroy");
        // 注意：**不**停引擎 —— 进程归前台服务，Activity 只是观众。
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}

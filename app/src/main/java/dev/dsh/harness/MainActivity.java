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
    /** 侧栏鱼标（窄轨里那个）在页面里的实测位置，CSS px；由页面 JS 量完回调 Bridge.anchor。 */
    private volatile float anchorCx = -1f;
    private volatile float anchorCy = -1f;
    private volatile float anchorSize = 0f;

    private Splash splash;
    private TextView status;
    /** 交接动画用的独立图层：启动时就建好、常驻，交接时只改变换属性 —— 不增删视图、不触发重排。 */
    private FrameLayout overlay;
    private android.widget.ImageView flyer;
    private android.view.View glow;
    /** 鱼的起始尺寸（dp），overlay 里预先按这个尺寸布局。 */
    private static final float FISH_DP = 88f;
    private volatile boolean loaded;
    /** 页面自愈：失败页/黑屏时后台盯着引擎，一旦健康就自动重载。 */
    private volatile boolean healing;
    private int healRounds;

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
        web.addJavascriptInterface(new ShellBridge(), "DSHShell");
        wireBrowser(root);
        // 侧栏内置浏览器里的下载：WebView 自己不会保存文件，必须给 DownloadListener，
        // 否则点「下载」什么都不会发生（这就是之前"下载没法验证"的原因）。
        web.setDownloadListener((url, ua, cd, mime, len) -> startDownload(url, cd, mime));
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        // WebView 一直可见：让它**在开屏下面**就完成第一次绘制。
        // 之前是交接那一刻才 setVisibility(VISIBLE)，等于把整页首次合成压在动画的第一帧上 —— 那就是那一"卡"。
        web.setVisibility(android.view.View.VISIBLE);

        // 启动屏：冷启动期间（解包 / 起 node / 等 HTTP）不再是一块纯黑
        splash = new Splash(this);
        root.addView(splash, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // 交接图层必须在开屏**之上**：鱼一边飞、开屏背景一边化掉，鱼不能被盖在自己家开屏下面。
        // 预先建好、常驻；交接时只改变换属性（translation/scale/alpha），
        // 不 addView/removeView、不改 LayoutParams —— 否则动画第一帧会夹一次全量重排。
        overlay = new FrameLayout(this);
        overlay.setClickable(false);
        overlay.setFocusable(false);
        flyer = new android.widget.ImageView(this);
        flyer.setVisibility(android.view.View.INVISIBLE);
        flyer.setScaleType(android.widget.ImageView.ScaleType.FIT_CENTER);
        flyer.setImageBitmap(null);
        overlay.addView(flyer, new FrameLayout.LayoutParams(Math.round(dp(FISH_DP)), Math.round(dp(FISH_DP))));
        glow = new android.view.View(this);
        glow.setBackgroundResource(R.drawable.ripple_glow);
        glow.setAlpha(0f);
        glow.setVisibility(android.view.View.INVISIBLE);
        overlay.addView(glow, new FrameLayout.LayoutParams(Math.round(dp(150)), Math.round(dp(150))));
        root.addView(overlay, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

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
                // 页面可能"只画出品牌 logo 就停住"（客户端 bundle 报错 / 引擎刚换过连接），
                // 旧版本只能靠用户划掉重开。这里 15 秒后自检一次：正文几乎是空的就自己重载。
                ui.postDelayed(() -> checkPageAlive(w, url, 0), 15000);
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
        hideSplash(0);
        showFailurePage(why, ok ? name : null, tail);
        startHeal();
    }

    /**
     * 引擎没起来时，WebView 里显示一张能重试的错误页。
     * 以前这里什么都不画，用户看到的就是一块白屏或黑屏闪一下 —— 分不清是"卡住"还是"坏了"。
     */
    private void showFailurePage(final String why, final String logName, final java.util.List<String> tail) {
        ui.post(() -> {
            final WebView w = web;
            if (w == null) return;
            String detail = why == null ? "" : why;
            StringBuilder log = new StringBuilder();
            int from = Math.max(0, tail.size() - 8);
            for (int i = from; i < tail.size(); i++) log.append(tail.get(i)).append('\n');
            String html = "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
                    + "<body style='margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;"
                    + "background:#101114;color:#eceef1;font:15px/1.65 system-ui,-apple-system,sans-serif'>"
                    + "<div style='max-width:440px;width:100%;padding:28px;box-sizing:border-box'>"
                    + "<div style='font-size:34px;line-height:1'>\uD83D\uDC1F</div>"
                    + "<h1 style='font-size:19px;margin:14px 0 10px;font-weight:600'>大肥鱼没醒过来</h1>"
                    + "<p style='margin:0 0 14px;color:#a8adb6;font-size:14px;white-space:pre-wrap'>"
                    + esc(detail) + "</p>"
                    + (log.length() > 0
                        ? "<details style='margin:0 0 16px'><summary style='cursor:pointer;color:#8f959f;font-size:13px'>最后几行输出</summary>"
                          + "<pre style='margin:8px 0 0;padding:10px 12px;border-radius:10px;background:#1b1c20;color:#9aa0a6;"
                          + "font:11px/16px ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-all;max-height:140px;overflow:auto'>"
                          + esc(log.toString()) + "</pre></details>"
                        : "")
                    + (logName != null
                        ? "<p style='margin:0 0 16px;color:#6c727b;font-size:12px'>诊断日志已回传：logs/" + esc(logName) + "</p>"
                        : "")
                    + "<button onclick='DSHShell.retry()' style='width:100%;height:46px;border:0;border-radius:12px;"
                    + "background:#f2f4f7;color:#111;font-size:15px;font-weight:600'>重试</button>"
                    + "<p style='margin:12px 0 0;color:#6c727b;font-size:12px;text-align:center'>还是不行就完全退出 App 再打开</p>"
                    + "</div></body>";
            w.loadDataWithBaseURL("http://127.0.0.1/", html, "text/html", "utf-8", null);
        });
    }

    /**
     * 页面自检：正常情况下 1 秒内 WebView 就有正文；如果 15 秒后正文几乎为空，
     * 说明客户端脚本没起来（表现就是一块黑底 + 一只鲸鱼）。这里最多重载 3 次。
     */
    private void checkPageAlive(final WebView w, final String url, final int round) {
        if (w == null || round >= 3 || !loaded) return;
        try {
            w.evaluateJavascript("(document.body ? (document.body.innerText||'').trim().length : 0)", value -> {
                int len;
                try {
                    len = Integer.parseInt(value == null ? "0" : value.replaceAll("[^0-9]", ""));
                } catch (Throwable e) {
                    len = 0;
                }
                if (len < 40) {
                    Life.note(this, "页面自检：正文只有 " + len + " 字，第 " + (round + 1) + " 次自动重载");
                    note("页面没起来，正在自动重试…");
                    w.loadUrl(url);
                    ui.postDelayed(() -> checkPageAlive(w, url, round + 1), 12000 + round * 4000);
                } else {
                    Life.note(this, "页面自检：正常（正文 " + len + " 字）");
                }
            });
        } catch (Throwable e) {
            Life.note(this, "页面自检异常：" + e);
        }
    }

    /** 失败页上盯着引擎：它要是自己活过来了（看门狗/重启脚本拉起），就把页面换回来。 */
    private void startHeal() {
        if (healing) return;
        healing = true;
        healRounds = 0;
        final Runnable[] step = new Runnable[1];
        step[0] = () -> {
            if (!healing || healRounds >= 20) {
                healing = false;
                return;
            }
            healRounds++;
            new Thread(() -> {
                boolean up = Engine.isUp();
                ui.post(() -> {
                    if (!healing) return;
                    if (up) {
                        WebView w = web;
                        String t = Engine.token();
                        if (w != null) {
                            String u = "http://127.0.0.1:" + Engine.port() + "/" + (t != null ? "?token=" + t : "");
                            Life.note(this, "引擎已恢复，自动回到界面");
                            note("好了，正在回到界面…");
                            healing = false;
                            w.loadUrl(u);
                            loaded = true;
                            ui.postDelayed(() -> checkPageAlive(w, u, 0), 15000);
                            return;
                        }
                    }
                    ui.postDelayed(step[0], 8000);
                });
            }, "heal-probe").start();
        };
        ui.postDelayed(step[0], 8000);
    }

    /** 错误页里的文本要转义，否则日志里的尖括号会把页面吃掉。 */
    private static String esc(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    /** 错误页「重试」按钮的桥。 */
    public class ShellBridge {
        @android.webkit.JavascriptInterface
        public void retry() {
            Life.note(MainActivity.this, "错误页点了重试");
            ui.post(() -> {
                loaded = false;
                note("正在重新唤醒大肥鱼…");
                new Thread(MainActivity.this::boot, "boot-retry").start();
            });
        }
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
                if (looksLikeApk(u)) {
                    Life.note(MainActivity.this, "页面链接是 APK，走 App 内下载");
                    startDownload(u, null, null);
                    return true;
                }
                openExternal(u);
                return true;
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                Life.note(MainActivity.this, "页面加载完成 " + url);
                hideSplash(520);
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
                        if (looksLikeApk(u)) {
                            startDownload(u, null, null);
                            closePopup();
                            return true;
                        }
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

        /**
         * 页面里点「下载更新」时直接调这里。
         * 走导航的话会被 shouldOverrideUrlLoading 当成外部链接丢给浏览器（用户看到的就是「点了没反应」）。
         */
        /**
         * 页面量好鱼标位置后回调这里。单位是 CSS px（在 WebView 里 1 CSS px ≈ 1dp）。
         * 交接动画的落点用它，而不是用我拍脑袋估的 (28,30)。
         */
        @android.webkit.JavascriptInterface
        public void anchor(float cx, float cy, float size) {
            anchorCx = cx;
            anchorCy = cy;
            anchorSize = size;
            Life.note(MainActivity.this, "JS anchor=" + Math.round(cx) + "," + Math.round(cy)
                    + " size=" + Math.round(size));
        }

        @android.webkit.JavascriptInterface
        public void download(String url) {
            if (url == null || url.isEmpty()) return;
            Life.note(MainActivity.this, "JS 请求下载 " + url);
            startDownload(url, null, null);
        }
    }

    /**
     * 在本地页面里装一个探针：把 window.open 的调用与结果（拿到句柄还是 null）写进日志。
     * 登录流程就靠 window.open 开新窗口，黑屏时得知道它到底有没有被调用。
     */
    private void injectProbe(WebView v, String url) {
        if (!url.startsWith("http://127.0.0.1")) return;
        String js = "(function(){"
                // 量侧栏鱼标的位置（窄轨时它在折叠按钮里）。每次页面加载都量一遍，接口幂等。
                + "try{if(!window.__dshbMeasure){window.__dshbMeasure=function(){"
                + "try{var el=document.querySelector('[class*=\"railMark\"] svg')||document.querySelector('[class*=\"railMark\"]')"
                + "||document.querySelector('[class*=\"brandMark\"] svg');"
                + "if(!el)return false;var r=el.getBoundingClientRect();"
                + "if(!(r.width>0)||!(r.height>0))return false;"
                + "DSHBridge.anchor(r.left+r.width/2,r.top+r.height/2,r.width);return true;}catch(e){return false;}};}"
                + "var tries=0;(function tick(){if(window.__dshbMeasure())return;if(++tries<25)setTimeout(tick,200);})();}catch(e){}"
                + "if(window.__dshbProbe)return;window.__dshbProbe=1;"
                + "try{var o=window.open;window.open=function(u,n,f){var r=null;try{r=o.call(window,u,n,f)}catch(e){}"
                + "try{DSHBridge.log('window.open('+String(u).slice(0,100)+','+n+') -> '+(r?'句柄':'null'))}catch(e){}"
                + "return r;};}catch(e){try{DSHBridge.log('hook failed '+e)}catch(_){}}"
                + "window.addEventListener('error',function(e){try{var w=e.filename?String(e.filename).slice(-60):'';"
                + "DSHBridge.log('js-error '+e.message+(w?' @'+w+':'+e.lineno:'')+(e.error&&e.error.stack?' '+String(e.error.stack).split('\\n')[0].slice(0,120):''))}catch(_){}});"
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

    /** 下载链接是不是一个 APK（GitHub release 资产就是 .../<name>.apk）。 */
    private static boolean looksLikeApk(String u) {
        if (u == null) return false;
        String path = u.split("[?#]")[0].toLowerCase();
        return path.endsWith(".apk");
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

    /**
     * 把下载进度推给页面里的 JS（{@code window.__dshDl}），面板据此画进度条。
     * 之前是每 4 MB 弹一个 toast —— 又吵又不精确，0.10.4 换成实时进度条。
     */
    private void dlProgress(String name, long done, long total, String state) {
        final WebView w = web;
        if (w == null) return;
        final String js = "window.__dshDl&&window.__dshDl("
                + jsStr(name) + "," + done + "," + total + "," + jsStr(state) + ")";
        ui.post(() -> {
            WebView v = web;
            if (v != null) v.evaluateJavascript(js, null);
        });
    }

    private static String jsStr(String s) {
        if (s == null) return "null";
        StringBuilder b = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"' || c == '\\') b.append('\\').append(c);
            else if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
            else b.append(c);
        }
        return b.append('"').toString();
    }

    private void startDownload(final String url, final String contentDisposition, final String mime) {
        final String name = guessName(url, contentDisposition);
        Life.note(this, "下载开始 " + name + " mime=" + mime + " <- " + url);
        if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) {
            showToast("这个地址没法下载：" + url);
            return;
        }
        new Thread(() -> {
            final boolean isApk = name.toLowerCase().endsWith(".apk");
            File dir;
            if (isApk) {
                // 安装器要读这个文件：存到缓存目录，由 ApkProvider 以 content:// 提供，
                // 避免 Android 7+ 的 FileUriExposedException。
                dir = new java.io.File(getCacheDir(), "updates");
            } else {
                File base = getExternalFilesDir(null);
                dir = new File(base != null ? base : getFilesDir(), "Download");
            }
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            File out = new File(dir, name);
            File part = new File(dir, name + ".part");
            java.net.HttpURLConnection conn = null;
            try {
                conn = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(60000);
                conn.setInstanceFollowRedirects(true);
                conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android) DSHShell");
                final long expect = Math.max(0L, conn.getContentLengthLong());
                dlProgress(name, 0, expect, "start");
                long total = 0;
                try (java.io.InputStream in = conn.getInputStream();
                     java.io.OutputStream os = new java.io.BufferedOutputStream(
                             new java.io.FileOutputStream(part), 256 * 1024)) {
                    byte[] buf = new byte[256 * 1024];
                    long lastTick = 0;
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        os.write(buf, 0, n);
                        total += n;
                        // 进度实时推给页面（浮动卡片里的进度条），节流到 ~120ms，别把主线程刷爆
                        long now = android.os.SystemClock.elapsedRealtime();
                        if (now - lastTick >= 120) {
                            lastTick = now;
                            dlProgress(name, total, expect, "downloading");
                        }
                    }
                }
                //noinspection ResultOfMethodCallIgnored
                part.renameTo(out);
                Life.note(this, "下载完成 " + out + " " + out.length() + " B");
                if (isApk) {
                    ui.post(() -> installApk(out));
                } else {
                    dlProgress(name, out.length(), out.length(), "done");
                    ui.post(() -> showToast("下载完成：" + out.getAbsolutePath()));
                }
            } catch (Throwable e) {
                Life.note(this, "下载失败 " + e);
                dlProgress(name, 0, 0, "error");
                ui.post(() -> showToast("下载失败：" + e));
            } finally {
                if (conn != null) conn.disconnect();
            }
        }, "download").start();
    }

    private void installApk(File apk) {
        Life.note(this, "准备安装 " + apk.getName() + " " + apk.length() + " B");
        try {
            if (android.os.Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
                showToast("请允许「安装未知应用」后再装");
                try {
                    android.content.Intent settings = new android.content.Intent(
                            android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            android.net.Uri.parse("package:" + getPackageName()));
                    settings.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(settings);
                } catch (Throwable ignored) {
                    // 有的 ROM 没有这个页面，只能靠用户自己去设置里开
                }
                return;
            }
            android.net.Uri uri = android.net.Uri.parse(
                    "content://" + getPackageName() + ".apk/" + apk.getName());
            android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
            showToast("已交给系统安装器");
        } catch (Throwable e) {
            Life.note(this, "安装失败 " + e);
            showToast("安装失败：" + e);
        }
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
            Splash s = splash;
            if (s != null) s.setStatus(msg);
            if (status != null && !loaded) status.setText(msg);
        });
    }

    /**
     * 页面画出来了（或要显示错误页）就交接给界面。
     *
     * <p>不是简单淡出：开屏里的鱼标会"接力"飞到它在应用侧栏里的落点（手机永远是 56px 窄轨，
     * 鱼标中心约 (28dp, 30dp)），同时开屏背景先化掉、页面内容从下方 10dp 淡入上浮。
     * 全程约 520ms；超过 600ms 就会觉得在等。
     */
    private void hideSplash(long delay) {
        final Splash s = splash;
        if (s == null) return;
        ui.postDelayed(() -> {
            WebView w = web;
            if (w != null) {
                // 再等两帧：让页面把"首次绘制 + 合成"做完再开交接。
                // 动画第一帧如果和 WebView 首绘撞在一起，就是肉眼可见的一顿。
                w.postOnAnimation(() -> s.postOnAnimation(() -> playHandoff(s)));
            } else {
                playHandoff(s);
            }
        }, delay);
    }

    private void playHandoff(final Splash s) {
        if (splash != s) return;
        splash = null; // 防重入
        final FrameLayout h = host;
        final android.widget.ImageView fishView = flyer;
        final android.view.View glowView = glow;

        // 页面在交接前就已经在开屏下面画好了（WebView 一直是 VISIBLE），
        // 所以这里**不碰 WebView**：不改 alpha、不改 translation、不改可见性。
        // 任何一帧对 WebView 的重合成都会掉帧，这里是上一版"卡一下"的根源。

        boolean flying = false;
        if (h != null && fishView != null && overlay != null) {
            float[] geo = s.fishCenter(h); // 必须在 beginHandoff 之前取（之后开屏里的鱼会藏起来）
            float size = geo[2] > 0 ? geo[2] : dp(FISH_DP);
            float startCx = geo[0];
            float startCy = geo[1];
            // 落点：优先用页面实测的鱼标位置（CSS px ≈ dp，乘密度换成 px）；
            // 量不到才退回老的估算值 —— 这就是上一版"飞到偏了"的地方。
            final float density = getResources().getDisplayMetrics().density;
            final float targetCx = anchorCx > 0f ? anchorCx * density : dp(28);
            final float targetCy = anchorCy > 0f ? anchorCy * density : dp(30);
            final float aimSize = anchorSize > 0f ? anchorSize * density : dp(24);
            float endScale = aimSize / size;

            // 视图是启动时按 FISH_DP 布局在 overlay 左上角的，这里只算"从布局位置出发要偏移多少"。
            float laidCx = dp(FISH_DP) / 2f;
            float laidCy = dp(FISH_DP) / 2f;
            float baseX = startCx - laidCx;
            float baseY = startCy - laidCy;

            fishView.setImageBitmap(s.fishBitmap());
            fishView.setPivotX(dp(FISH_DP) / 2f);
            fishView.setPivotY(dp(FISH_DP) / 2f);
            fishView.setTranslationX(baseX);
            fishView.setTranslationY(baseY);
            fishView.setScaleX(1f);
            fishView.setScaleY(1f);
            fishView.setRotation(0f);
            fishView.setAlpha(1f);
            fishView.setVisibility(android.view.View.VISIBLE);
            fishView.setLayerType(android.view.View.LAYER_TYPE_HARDWARE, null);

            // 辉光也预先布局在 overlay 里，只用 translation 定位
            if (glowView != null) {
                float g = dp(150) / 2f;
                glowView.setTranslationX(startCx - g);
                glowView.setTranslationY(startCy - g);
                glowView.setScaleX(0.45f);
                glowView.setScaleY(0.45f);
                glowView.setAlpha(0.8f);
                glowView.setVisibility(android.view.View.VISIBLE);
                glowView.setLayerType(android.view.View.LAYER_TYPE_HARDWARE, null);
                glowView.animate()
                        .alpha(0f).scaleX(1.7f).scaleY(1.7f)
                        .setStartDelay(30).setDuration(620)
                        .setInterpolator(new android.view.animation.PathInterpolator(0.05f, 0.7f, 0.1f, 1f))
                        .withEndAction(() -> {
                            glowView.setVisibility(android.view.View.INVISIBLE);
                            glowView.setLayerType(android.view.View.LAYER_TYPE_NONE, null);
                        })
                        .start();
            }

            // 二次贝塞尔：控制点沿位移法线鼓出 0.18×距离，直线看起来像"被吸走"
            final float dx = targetCx - startCx;
            final float dy = targetCy - startCy;
            float dist = (float) Math.hypot(dx, dy);
            if (dist < 1f) dist = 1f;
            final float bend = dist * 0.18f;
            final float cxp = startCx + dx / 2f + (-dy / dist) * bend;
            final float cyp = startCy + dy / 2f + (dx / dist) * bend;

            // 位移与缩放绑在同一个进度上：位置走多远，鱼就缩多小。
            // 曲线缓入缓出（不是 emphasized-decelerate 那种前端极快），820ms 全程可见地在缩。
            final float fStartCx = startCx;
            final float fStartCy = startCy;
            android.animation.ValueAnimator fly = android.animation.ValueAnimator.ofFloat(0f, 1f);
            fly.setStartDelay(30);
            fly.setDuration(820);
            fly.setInterpolator(new android.view.animation.PathInterpolator(0.42f, 0f, 0.18f, 1f));
            fly.addUpdateListener(a -> {
                float t = (Float) a.getAnimatedValue();
                float u = 1f - t;
                float x = u * u * fStartCx + 2f * u * t * cxp + t * t * targetCx;
                float y = u * u * fStartCy + 2f * u * t * cyp + t * t * targetCy;
                fishView.setTranslationX(x - laidCx);
                fishView.setTranslationY(y - laidCy);
                float sc = 1f + (endScale - 1f) * t;
                fishView.setScaleX(sc);
                fishView.setScaleY(sc);
                fishView.setRotation(-8f * (1f - t));
            });
            fly.addListener(new android.animation.AnimatorListenerAdapter() {
                @Override
                public void onAnimationEnd(android.animation.Animator a) {
                    // 落点：先轻轻一涨，再缩一点被"吸进"侧栏，最后淡掉
                    fishView.animate().scaleX(endScale * 1.08f).scaleY(endScale * 1.08f)
                            .setDuration(90)
                            .setInterpolator(new android.view.animation.PathInterpolator(0.2f, 0f, 0f, 1f))
                            .withEndAction(() -> fishView.animate()
                                    .scaleX(endScale * 0.9f).scaleY(endScale * 0.9f).alpha(0f)
                                    .setDuration(180)
                                    .setInterpolator(new android.view.animation.PathInterpolator(0.3f, 0f, 1f, 1f))
                                    .withEndAction(() -> {
                                        fishView.setVisibility(android.view.View.INVISIBLE);
                                        fishView.setLayerType(android.view.View.LAYER_TYPE_NONE, null);
                                    })
                                    .start())
                            .start();
                }
            });
            fly.start();
            flying = true;
        }

        // 开屏分层退场：进度条 → 状态 → 标题 → 背景（细节见 Splash.beginHandoff）
        s.beginHandoff();

        // 开屏 860ms 后撤；鱼在 overlay 里自己飞完自己藏起来
        final boolean hasFlyer = flying;
        ui.postDelayed(() -> {
            if (h != null) h.removeView(s);
            s.stop();
            if (hasFlyer) {
                // 兜底：万一动画被系统掐了，别留一只鱼挂在那儿
                ui.postDelayed(() -> {
                    if (fishView != null && fishView.getVisibility() == android.view.View.VISIBLE) {
                        fishView.setVisibility(android.view.View.INVISIBLE);
                        fishView.setLayerType(android.view.View.LAYER_TYPE_NONE, null);
                    }
                }, 900);
            }
        }, 860);
    }

    private float dp(float v) {
        return v * getResources().getDisplayMetrics().density;
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

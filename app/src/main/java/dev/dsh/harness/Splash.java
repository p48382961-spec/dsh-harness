package dev.dsh.harness;

import android.animation.ObjectAnimator;
import android.animation.TimeInterpolator;
import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.util.AttributeSet;
import android.view.LayoutInflater;
import android.view.View;
import android.view.animation.AccelerateDecelerateInterpolator;
import android.view.animation.PathInterpolator;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.TextView;

/**
 * 启动屏：官方鱼标 + 标题 + 状态文字 + 原生不确定进度条。
 *
 * <p>鱼标画成 Bitmap 再交给 ImageView：VectorDrawable 每次缩放都要重新栅格化，
 * 交接时"飞"的那一段会掉帧；预栅格化之后平移/缩放纯粹是 GPU 合成。
 *
 * <p>交接（{@link #beginHandoff()}）不是整块淡出，而是分层退场：
 * 进度条最先、状态文字其次、标题最后，各自带一点上浮；背景单独一层，最后化掉。
 */
public class Splash extends FrameLayout {
    private final View bg;
    private final View badge;
    private final ImageView fish;
    private final TextView title;
    private final TextView statusView;
    private final CometBar bar;
    private final View glow;

    private String status = "正在启动…";
    private ObjectAnimator floatAnim;
    private ObjectAnimator breathe;
    private boolean stopped;
    private Bitmap fishBitmap;

    public Splash(Context c) {
        this(c, null);
    }

    public Splash(Context c, AttributeSet attrs) {
        super(c, attrs);
        LayoutInflater.from(c).inflate(R.layout.splash, this, true);
        bg = findViewById(R.id.splashBg);
        badge = findViewById(R.id.badge);
        fish = findViewById(R.id.fish);
        title = findViewById(R.id.title);
        statusView = findViewById(R.id.status);
        bar = findViewById(R.id.bar);
        glow = findViewById(R.id.glow);

        fish.setImageBitmap(fishBitmap());
        statusView.setText(status);
        // 前 400ms 不显示状态文字：早期几步会瞬间连跳，闪一下反而显得廉价
        statusView.setAlpha(0f);
        postDelayed(this::revealStatus, 400);

        // 不再做入场淡入：WebView 现在一直在下面准备（交接时不再首次合成），
        // 开屏本身必须第一帧就完全不透明，否则会透出还没准备好的页面。
        setAlpha(1f);
        startLogoAnimation();

        // 标题与加载条也入场，不然画面里只有鱼在动，其它部分像"贴"上去的
        title.setAlpha(0f);
        title.setTranslationY(dp(6));
        title.animate().alpha(1f).translationY(0f).setStartDelay(120).setDuration(420)
                .setInterpolator(new android.view.animation.PathInterpolator(0.05f, 0.7f, 0.1f, 1f))
                .start();
        if (bar != null) {
            bar.setAlpha(0f);
            bar.animate().alpha(1f).setStartDelay(260).setDuration(360).start();
            bar.start();
        }
        // 柔光不做 alpha 呼吸：200dp 的径向渐变每帧改 alpha 都要重新合成一层，
        // 在低端 GPU 上就是可见的抖。要"活"交给鱼自己的浮动，柔光保持静态。
        startFrameStats();
    }

    /** 官方图标（与桌面图标同一份路径）预栅格化成 Bitmap，避免缩放时重新栅格化矢量。 */
    public Bitmap fishBitmap() {
        if (fishBitmap != null) return fishBitmap;
        int size = Math.round(dp(88));
        Bitmap bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bmp);
        Drawable d = getResources().getDrawable(R.drawable.ic_fish, getContext().getTheme());
        d.setBounds(0, 0, size, size);
        d.draw(canvas);
        fishBitmap = bmp;
        return bmp;
    }

    private void startLogoAnimation() {
        floatAnim = ObjectAnimator.ofFloat(badge, View.TRANSLATION_Y, 0f, -dp(5));
        floatAnim.setDuration(2400);
        floatAnim.setRepeatCount(ValueAnimator.INFINITE);
        floatAnim.setRepeatMode(ValueAnimator.REVERSE);
        floatAnim.setInterpolator(new AccelerateDecelerateInterpolator());
        floatAnim.start();
        breathe = ObjectAnimator.ofFloat(badge, View.ALPHA, 1f, 0.86f);
        breathe.setDuration(2400);
        breathe.setRepeatCount(ValueAnimator.INFINITE);
        breathe.setRepeatMode(ValueAnimator.REVERSE);
        breathe.setInterpolator(new AccelerateDecelerateInterpolator());
        breathe.start();
    }

    /** 开屏期间的掉帧统计：拿去和日志对照，别再靠"感觉卡"。 */
    private int frameCount;
    private int jankCount;
    private long frameTotalNs;
    private long lastFrameNs;
    private boolean frameStats;

    private void startFrameStats() {
        frameStats = true;
        lastFrameNs = 0L;
        android.view.Choreographer.getInstance().postFrameCallback(new android.view.Choreographer.FrameCallback() {
            @Override
            public void doFrame(long frameTimeNanos) {
                if (!frameStats || stopped) return;
                if (lastFrameNs > 0L) {
                    long d = frameTimeNanos - lastFrameNs;
                    frameCount++;
                    frameTotalNs += d;
                    if (d > 20_000_000L) jankCount++; // >20ms = 掉了一帧
                }
                lastFrameNs = frameTimeNsSafe(frameTimeNanos);
                android.view.Choreographer.getInstance().postFrameCallback(this);
            }
        });
    }

    private long frameTimeNsSafe(long v) {
        return v;
    }

    /** 交接开始时把统计快照打出去（life.log 会随心跳上传，能远程核对）。 */
    public void logFrameStats() {
        frameStats = false;
        if (frameCount <= 0) {
            dev.dsh.harness.Life.note(getContext(), "开屏帧统计：无数据");
            return;
        }
        long avg = frameTotalNs / frameCount / 1_000_000L;
        dev.dsh.harness.Life.note(getContext(),
                "开屏帧统计：fps≈" + Math.round(1000f / Math.max(1L, avg))
                        + " 平均帧时=" + avg + "ms 掉帧=" + jankCount + "/" + frameCount);
    }

    /** 真实进度（0..1）。目前引擎侧只给得到文字，留着以后接数值。 */
    public void setProgress(float p) {
        if (bar != null) bar.setProgress(p);
    }

    private void revealStatus() {
        TextView v = statusView;
        if (stopped || v == null) return;
        v.setText(status);
        v.animate().alpha(1f).setDuration(200).start();
    }

    /** 更新状态文字（"正在解包 64%" 之类）。 */
    public void setStatus(String msg) {
        if (msg == null || msg.isEmpty() || msg.equals(status) || stopped) return;
        status = msg;
        TextView v = statusView;
        if (v == null) return;
        if (v.getAlpha() < 0.5f) {
            v.setText(status);
            return;
        }
        v.animate().cancel();
        v.animate().alpha(0f).setDuration(90).withEndAction(() -> {
            if (stopped) return;
            TextView now = statusView;
            if (now == null) return;
            now.setText(status);
            now.animate().alpha(1f).setDuration(140).start();
        }).start();
    }

    /** 开屏里鱼的中心位置与宽度（相对 host），交给外面做"接力"。 */
    public float[] fishCenter(View host) {
        int[] fp = new int[2];
        int[] hp = new int[2];
        fish.getLocationInWindow(fp);
        host.getLocationInWindow(hp);
        int w = fish.getWidth();
        return new float[]{fp[0] - hp[0] + w / 2f, fp[1] - hp[1] + w / 2f, w};
    }

    /** 交接退场：鱼交给外面去飞（这里先藏起来，免得出现两只鱼），其它元素分层淡出，背景最后化掉。 */
    public void beginHandoff() {
        if (stopped) return;
        if (floatAnim != null) floatAnim.cancel();
        if (breathe != null) breathe.cancel();
        fish.setVisibility(View.INVISIBLE);
        logFrameStats();

        // 离场用 M3 的 standard-accelerate（越走越快，像被推走）；
        // 背景揭幕用 emphasized-decelerate（开头快、尾巴长，停下来不突兀）。
        TimeInterpolator exit = new PathInterpolator(0.3f, 0f, 1f, 1f);
        TimeInterpolator reveal = new PathInterpolator(0.05f, 0.7f, 0.1f, 1f);

        // 不是单纯淡出：一边淡一边微微放大 + 上浮，三个元素错开，看起来像散开而不是关灯
        if (bar != null) {
            // 只走一个 ViewPropertyAnimator：同一 View 上再调一次 animate() 会把 alpha 动画一起重启
            bar.fadeOut(0, 260);
        }
        disperse(statusView, 70, 320, 1.03f, exit);
        disperse(title, 130, 360, 1.05f, exit);

        // 柔光跟着"散开"：一边放大一边淡掉，像光被页面吸走
        if (glow != null) {
            glow.setLayerType(View.LAYER_TYPE_HARDWARE, null);
            glow.animate().scaleX(1.55f).scaleY(1.55f).alpha(0f)
                    .setStartDelay(40).setDuration(560).setInterpolator(reveal)
                    .withEndAction(() -> {
                        if (glow != null) glow.setLayerType(View.LAYER_TYPE_NONE, null);
                    }).start();
        }

        // 背景是很长的一段交叉淡出（760ms），把页面"揭"出来，而不是一黑变一亮。
        // 用关键帧做两段速度：先快一点让画面"亮起来"，再拖一条长尾巴收尾。
        android.animation.ObjectAnimator bgAnim = android.animation.ObjectAnimator.ofPropertyValuesHolder(
                bg,
                android.animation.PropertyValuesHolder.ofKeyframe(View.ALPHA,
                        android.animation.Keyframe.ofFloat(0f, 1f),
                        android.animation.Keyframe.ofFloat(0.18f, 0.74f),
                        android.animation.Keyframe.ofFloat(0.52f, 0.30f),
                        android.animation.Keyframe.ofFloat(1f, 0f)));
        bgAnim.setStartDelay(60);
        bgAnim.setDuration(760);
        bgAnim.setInterpolator(new android.view.animation.LinearInterpolator());
        // 渐变背景每帧重画一遍很贵；上硬件层后 alpha 变化只是合成，不再重画渐变
        bg.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        bgAnim.addListener(new android.animation.AnimatorListenerAdapter() {
            @Override
            public void onAnimationEnd(android.animation.Animator a) {
                if (bg != null) bg.setLayerType(View.LAYER_TYPE_NONE, null);
            }
        });
        bgAnim.start();
    }

    private void disperse(View v, long delay, long duration, float scale, TimeInterpolator ease) {
        if (v == null) return;
        v.setPivotX(v.getWidth() / 2f);
        v.setPivotY(v.getHeight() / 2f);
        v.animate()
                .alpha(0f)
                .scaleX(scale)
                .scaleY(scale)
                .translationY(-dp(6))
                .setStartDelay(delay)
                .setDuration(duration)
                .setInterpolator(ease)
                .start();
    }

    public void stop() {
        stopped = true;
        if (bar != null) bar.stop();
        frameStats = false;
        if (floatAnim != null) {
            floatAnim.cancel();
            floatAnim = null;
        }
        if (breathe != null) {
            breathe.cancel();
            breathe = null;
        }
    }

    @Override
    protected void onDetachedFromWindow() {
        stop();
        super.onDetachedFromWindow();
    }

    private float dp(float v) {
        return v * getResources().getDisplayMetrics().density;
    }
}

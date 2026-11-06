package dev.dsh.harness;

import android.animation.ObjectAnimator;
import android.animation.ValueAnimator;
import android.content.Context;
import android.util.AttributeSet;
import android.view.LayoutInflater;
import android.view.View;
import android.view.animation.AccelerateDecelerateInterpolator;
import android.widget.FrameLayout;
import android.widget.TextView;

/**
 * 启动屏：官方鱼标 + 标题 + 状态文字 + 原生不确定进度条。
 *
 * <p>第一版是自绘的（手画鲸鱼 + 自绘进度条），鱼形状不像官方、进度条每帧重绘整屏，
 * 盖上 WebView 一起抢 GPU 时会掉帧。现在改成纯原生控件：
 * 鱼标用官方的 {@code FISH_LOGO_PATH}（VectorDrawable），进度条用系统 {@link android.widget.ProgressBar}，
 * 动画交给属性动画（硬件层），启动屏本身只做一次性 inflate，绘制开销接近零。
 */
public class Splash extends FrameLayout {
    private final View badge;
    private final TextView statusView;
    private String status = "正在启动…";
    private ObjectAnimator floatAnim;
    private ObjectAnimator breathe;
    private boolean stopped;

    public Splash(Context c) {
        this(c, null);
    }

    public Splash(Context c, AttributeSet attrs) {
        super(c, attrs);
        LayoutInflater.from(c).inflate(R.layout.splash, this, true);
        badge = findViewById(R.id.badge);
        statusView = findViewById(R.id.status);
        statusView.setText(status);
        // 开屏本身淡入，避免"黑屏突然变成界面"
        setAlpha(0f);
        animate().alpha(1f).setDuration(220).start();
        startLogoAnimation();
    }

    private void startLogoAnimation() {
        // 鱼标轻微上下浮动
        floatAnim = ObjectAnimator.ofFloat(badge, View.TRANSLATION_Y, 0f, -dp(5));
        floatAnim.setDuration(2400);
        floatAnim.setRepeatCount(ValueAnimator.INFINITE);
        floatAnim.setRepeatMode(ValueAnimator.REVERSE);
        floatAnim.setInterpolator(new AccelerateDecelerateInterpolator());
        floatAnim.start();
        // 极轻的呼吸，幅度很小，只为不"死板"
        breathe = ObjectAnimator.ofFloat(badge, View.ALPHA, 1f, 0.86f);
        breathe.setDuration(2400);
        breathe.setRepeatCount(ValueAnimator.INFINITE);
        breathe.setRepeatMode(ValueAnimator.REVERSE);
        breathe.setInterpolator(new AccelerateDecelerateInterpolator());
        breathe.start();
    }

    /** 更新状态文字（"正在解包引擎 64%" 之类）。 */
    public void setStatus(String msg) {
        if (msg == null || msg.isEmpty() || msg.equals(status) || stopped) return;
        status = msg;
        TextView v = statusView;
        if (v == null) return;
        // 文案切换用一次很短的淡入，避免文字"啪"地跳
        v.animate().cancel();
        v.animate().alpha(0f).setDuration(90).withEndAction(() -> {
            if (stopped) return;
            TextView now = statusView;
            if (now == null) return;
            now.setText(status);
            now.animate().alpha(1f).setDuration(140).start();
        }).start();
    }

    /** 淡出结束时调用：停掉动画，别让已移除的视图还在空转。 */
    public void stop() {
        stopped = true;
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

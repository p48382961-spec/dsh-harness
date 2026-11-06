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
import android.view.animation.DecelerateInterpolator;
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
    private final View bar;

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

        fish.setImageBitmap(fishBitmap());
        statusView.setText(status);
        // 前 400ms 不显示状态文字：早期几步会瞬间连跳，闪一下反而显得廉价
        statusView.setAlpha(0f);
        postDelayed(this::revealStatus, 400);

        setAlpha(0f);
        animate().alpha(1f).setDuration(200).start();
        startLogoAnimation();
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

        DecelerateInterpolator ease = new DecelerateInterpolator();
        fadeUp(bar, 0, 160, 10, ease);
        fadeUp(statusView, 60, 200, 8, ease);
        fadeUp(title, 100, 260, 6, ease);
        bg.animate().alpha(0f).setStartDelay(120).setDuration(320).setInterpolator(ease).start();
    }

    private void fadeUp(View v, long delay, long duration, int dyDp, TimeInterpolator ease) {
        if (v == null) return;
        v.animate()
                .alpha(0f)
                .translationY(-dp(dyDp))
                .setStartDelay(delay)
                .setDuration(duration)
                .setInterpolator(ease)
                .start();
    }

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

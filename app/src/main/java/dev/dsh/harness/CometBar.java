package dev.dsh.harness;

import android.animation.ObjectAnimator;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.drawable.GradientDrawable;
import android.util.AttributeSet;
import android.view.View;
import android.view.animation.LinearInterpolator;
import android.widget.FrameLayout;
import android.widget.ImageView;

/**
 * 启动屏加载条（第二版：彗星条 = 一条位图在平移）。
 *
 * <p>第一版是自绘 View，每帧 onDraw 里画圆角矩形。问题在于主线程同时还在解包 889MB、起 node，
 * 逐帧重画就抖 —— 用户看到的“整体过渡卡”，其实卡在这条东西上。
 *
 * <p>现在：彗星先画成一张小位图（宽 = 条宽×2，两颗彗星首尾相接），交给 ImageView，
 * 动画只改 translationX。位图在硬件层上，平移由合成器完成；每帧不再有任何 Canvas 绘制。
 */
public class CometBar extends FrameLayout {

    private static final int FROM = 0x007AA2FF;
    private static final int MID = 0xFF7AA2FF;
    private static final int BRIGHT = 0xFFB9CDFF;

    private final ImageView strip;
    private final View fill;
    private ObjectAnimator anim;
    private float progress = -1f;
    private int builtW = -1;
    private Bitmap bitmap;

    public CometBar(Context c) {
        this(c, null);
    }

    public CometBar(Context c, AttributeSet attrs) {
        super(c, attrs);
        GradientDrawable track = new GradientDrawable();
        track.setColor(0x1FFFFFFF);
        track.setCornerRadius(dp(1.5f));
        setBackground(track);
        setClipToOutline(true);

        fill = new View(c);
        GradientDrawable fillBg = new GradientDrawable();
        fillBg.setColor(MID);
        fillBg.setCornerRadius(dp(1.5f));
        fill.setBackground(fillBg);
        fill.setVisibility(View.GONE);
        addView(fill, new LayoutParams(0, LayoutParams.MATCH_PARENT));

        strip = new ImageView(c);
        strip.setScaleType(ImageView.ScaleType.FIT_XY);
        strip.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        addView(strip, new LayoutParams(0, LayoutParams.MATCH_PARENT));
    }

    public void start() {
        if (builtW <= 0) return;
        if (anim != null) return;
        if (progress >= 0f) return;
        strip.setVisibility(VISIBLE);
        fill.setVisibility(GONE);
        strip.setTranslationX(0f);
        anim = ObjectAnimator.ofFloat(strip, View.TRANSLATION_X, 0f, -builtW / 2f);
        anim.setDuration(1700);
        anim.setRepeatCount(ObjectAnimator.INFINITE);
        anim.setRepeatMode(ObjectAnimator.RESTART);
        anim.setInterpolator(new LinearInterpolator());
        anim.start();
    }

    public void fadeOut(long delay, long duration) {
        stop();
        animate().alpha(0f).setStartDelay(delay).setDuration(duration).start();
    }

    public void stop() {
        if (anim != null) {
            anim.cancel();
            anim = null;
        }
    }

    /** @param p 0..1 真实进度；负值 = 回到不确定模式 */
    public void setProgress(float p) {
        progress = p;
        if (p < 0f) {
            fill.setVisibility(GONE);
            start();
            return;
        }
        stop();
        strip.setVisibility(GONE);
        fill.setVisibility(VISIBLE);
        LayoutParams lp = (LayoutParams) fill.getLayoutParams();
        lp.width = Math.max(1, Math.round(getWidth() * Math.min(1f, Math.max(0f, p))));
        fill.setLayoutParams(lp);
    }

    @Override
    protected void onSizeChanged(int w, int h, int ow, int oh) {
        super.onSizeChanged(w, h, ow, oh);
        if (w <= 0 || h <= 0) return;
        if (builtW == w && bitmap != null) return;
        builtW = w;
        bitmap = buildStrip(w, h);
        strip.setImageBitmap(bitmap);
        LayoutParams lp = (LayoutParams) strip.getLayoutParams();
        lp.width = w * 2;
        lp.height = LayoutParams.MATCH_PARENT;
        strip.setLayoutParams(lp);
        if (progress < 0f) {
            stop();
            start();
        }
    }

    /** 宽 2w 的位图里画两颗彗星（第二颗从 w 处开始），两端透明，接起来无缝。 */
    private Bitmap buildStrip(int w, int h) {
        Bitmap bmp = Bitmap.createBitmap(w * 2, h, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bmp);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        float barH = dp(3);
        float top = (h - barH) / 2f;
        float radius = barH / 2f;
        float cometW = w * 0.42f;
        RectF r = new RectF();
        for (int i = 0; i < 2; i++) {
            float x = i * w;
            p.setShader(new LinearGradient(x, 0, x + cometW, 0,
                    new int[]{FROM, MID, BRIGHT, FROM}, new float[]{0f, 0.45f, 0.72f, 1f},
                    Shader.TileMode.CLAMP));
            r.set(x, top, x + cometW, top + barH);
            canvas.drawRoundRect(r, radius, radius, p);
        }
        p.setShader(null);
        return bmp;
    }

    private float dp(float v) {
        return v * getResources().getDisplayMetrics().density;
    }
}

package dev.dsh.harness;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Shader;
import android.os.SystemClock;
import android.util.AttributeSet;
import android.view.View;
import android.widget.FrameLayout;

/**
 * 启动屏加载条（第三版）。
 *
 * <p>演进：
 * <ol>
 *   <li>自绘 + 每帧 new Shader：能看见在动，但主线程一忙就抖。</li>
 *   <li>位图 + ImageView 的 translationX 动画：理论上最省，但这版在设备上整条不动了
 *       （硬件层 + clipToOutline 的组合下不可靠），回退。</li>
 *   <li>现在这一版：彗星预画成一张位图，{@link #onDraw} 里只做一次 {@code drawBitmap}，
 *       位置按 {@link SystemClock#uptimeMillis()} 直接算 —— 即使某一帧没来得及画，
 *       下一帧也会跳到正确位置，不会累积延迟，也不会出现"停住"。</li>
 * </ol>
 */
public class CometBar extends FrameLayout {

    private static final int FROM = 0x007AA2FF;
    private static final int MID = 0xFF7AA2FF;
    private static final int BRIGHT = 0xFFB9CDFF;
    private static final long CYCLE_MS = 1700L;

    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final View drawLayer;
    private final View fill;
    private Bitmap strip;
    private int builtW = -1;
    private boolean running;
    private float progress = -1f;

    public CometBar(Context c) {
        this(c, null);
    }

    public CometBar(Context c, AttributeSet attrs) {
        super(c, attrs);

        // 轨道：一条不变的圆角细线，直接当背景
        android.graphics.drawable.GradientDrawable track = new android.graphics.drawable.GradientDrawable();
        track.setColor(0x1FFFFFFF);
        track.setCornerRadius(dp(1.5f));
        setBackground(track);

        fill = new View(c);
        android.graphics.drawable.GradientDrawable fillBg = new android.graphics.drawable.GradientDrawable();
        fillBg.setColor(MID);
        fillBg.setCornerRadius(dp(1.5f));
        fill.setBackground(fillBg);
        fill.setVisibility(GONE);
        addView(fill, new LayoutParams(0, LayoutParams.MATCH_PARENT));

        // 真正画彗星的那一层
        drawLayer = new View(c) {
            @Override
            protected void onDraw(Canvas canvas) {
                if (strip == null || !running || builtW <= 0) return;
                float w = builtW;
                float phase = (SystemClock.uptimeMillis() % CYCLE_MS) / (float) CYCLE_MS;
                // 从左边外面(-w)游到右边外面(+w)
                float x = -w + phase * (w * 2f);
                canvas.drawBitmap(strip, x, (getHeight() - strip.getHeight()) / 2f, paint);
                postInvalidateOnAnimation();
            }
        };
        addView(drawLayer, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
    }

    public void start() {
        running = true;
        drawLayer.postInvalidateOnAnimation();
    }

    public void stop() {
        running = false;
        drawLayer.postInvalidate();
    }

    public void fadeOut(long delay, long duration) {
        stop();
        animate().alpha(0f).setStartDelay(delay).setDuration(duration).start();
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
        fill.setVisibility(VISIBLE);
        LayoutParams lp = (LayoutParams) fill.getLayoutParams();
        lp.width = Math.max(1, Math.round(getWidth() * Math.min(1f, Math.max(0f, p))));
        fill.setLayoutParams(lp);
    }

    @Override
    protected void onSizeChanged(int w, int h, int ow, int oh) {
        super.onSizeChanged(w, h, ow, oh);
        if (w <= 0 || h <= 0) return;
        if (builtW == w && strip != null) return;
        builtW = w;
        strip = buildStrip(w, h);
        dev.dsh.harness.Life.note(getContext(), "加载条：位图 " + strip.getWidth() + "×" + strip.getHeight() + "，开始跑");
        if (running) drawLayer.postInvalidateOnAnimation();
    }

    /** 位图里画一颗彗星（宽 42%），两端透明。绘制时整块位图从 -w 平移到 +w。 */
    private Bitmap buildStrip(int w, int h) {
        Bitmap bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bmp);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        float barH = dp(3);
        float top = (h - barH) / 2f;
        float radius = barH / 2f;
        float cometW = w * 0.42f;
        p.setShader(new LinearGradient(0, 0, cometW, 0,
                new int[]{FROM, MID, BRIGHT, FROM}, new float[]{0f, 0.45f, 0.72f, 1f},
                Shader.TileMode.CLAMP));
        RectF r = new RectF(0, top, cometW, top + barH);
        canvas.drawRoundRect(r, radius, radius, p);
        p.setShader(null);
        return bmp;
    }

    private float dp(float v) {
        return v * getResources().getDisplayMetrics().density;
    }
}

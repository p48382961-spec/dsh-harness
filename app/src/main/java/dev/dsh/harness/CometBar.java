package dev.dsh.harness;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Shader;
import android.util.AttributeSet;
import android.view.View;
import android.view.animation.LinearInterpolator;

/**
 * 启动屏加载条：不用系统 {@code ProgressBar}。
 *
 * <p>系统那条 indeterminate 是"一段实色在轨道上来回撞"，观感很硬；这里改成一颗
 * <b>彗星</b>：一小段带渐变（透明→蓝→浅蓝→透明）的光从左边出现、从右边消失，
 * 匀速跑，两端自然淡掉，没有"撞墙"的折返感。
 *
 * <p>要显示真实百分比时调 {@link #setProgress(float)}；传负值回到不确定模式。
 * 只用一个 ValueAnimator 改一个 float，绘制也就是两条圆角矩形，GPU 合成，不掉帧。
 */
public class CometBar extends View {

    private static final int FROM = 0x007AA2FF;
    private static final int MID = 0xFF7AA2FF;
    private static final int BRIGHT = 0xFFB9CDFF;

    private final Paint trackPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint cometPaint = new Paint(Paint.ANTI_ALIAS_FLAG);

    /** 0..1 的循环相位；彗星从 -1 跑到 1 个身位，保证进出两端都是空。 */
    private float phase = 0f;
    /** 认识进度：0..1；<0 表示不确定。 */
    private float progress = -1f;

    private ValueAnimator anim;
    private final RectF rect = new RectF();

    public CometBar(Context c) {
        this(c, null);
    }

    public CometBar(Context c, AttributeSet attrs) {
        super(c, attrs);
        trackPaint.setColor(0x1FFFFFFF);
        cometPaint.setStyle(Paint.Style.FILL);
    }

    /** 开始跑。 */
    public void start() {
        if (anim != null) return;
        anim = ValueAnimator.ofFloat(0f, 1f);
        anim.setDuration(1700);
        anim.setRepeatCount(ValueAnimator.INFINITE);
        anim.setInterpolator(new LinearInterpolator());
        anim.addUpdateListener(a -> {
            phase = (Float) a.getAnimatedValue();
            postInvalidateOnAnimation();
        });
        anim.start();
    }

    /** 停并淡下去（交接时先淡掉，不是"啪"一下没了）。 */
    public void fadeOut(long delay, long duration) {
        if (anim != null) {
            anim.cancel();
            anim = null;
        }
        animate().alpha(0f).setStartDelay(delay).setDuration(duration).start();
    }

    public void stop() {
        if (anim != null) {
            anim.cancel();
            anim = null;
        }
    }

    /** @param p 0..1 真实进度；负值 = 不确定模式 */
    public void setProgress(float p) {
        progress = p;
        postInvalidateOnAnimation();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        float w = getWidth();
        float h = getHeight();
        if (w <= 0 || h <= 0) return;

        float barH = dp(3);
        float top = (h - barH) / 2f;
        float radius = barH / 2f;

        // 轨道
        rect.set(0, top, w, top + barH);
        canvas.drawRoundRect(rect, radius, radius, trackPaint);

        if (progress >= 0f) {
            // 确定进度：整段填充，头部略微更亮
            float end = Math.max(barH, w * Math.min(1f, progress));
            cometPaint.setShader(new LinearGradient(0, 0, end, 0,
                    new int[]{MID, BRIGHT}, new float[]{0f, 1f}, Shader.TileMode.CLAMP));
            rect.set(0, top, end, top + barH);
            canvas.drawRoundRect(rect, radius, radius, cometPaint);
            cometPaint.setShader(null);
            return;
        }

        // 不确定进度：一颗彗星，宽 42%，从左边外面游进、右边外面游出
        float cometW = w * 0.42f;
        float x = -cometW + phase * (w + cometW * 2f);
        cometPaint.setShader(new LinearGradient(x, 0, x + cometW, 0,
                new int[]{FROM, MID, BRIGHT, FROM}, new float[]{0f, 0.45f, 0.72f, 1f},
                Shader.TileMode.CLAMP));
        rect.set(x, top, x + cometW, top + barH);
        canvas.drawRoundRect(rect, radius, radius, cometPaint);
        cometPaint.setShader(null);
    }

    private float dp(float v) {
        return v * getResources().getDisplayMetrics().density;
    }
}

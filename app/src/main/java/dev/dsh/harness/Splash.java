package dev.dsh.harness;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Shader;
import android.view.View;
import android.view.animation.LinearInterpolator;

/**
 * 启动屏。
 *
 * <p>冷启动那几秒（可能要先解包 254 MB 载荷、再等 node 起来）原本就是一块纯黑的 WebView，
 * 只有底部一行小字在闪 —— 看起来像卡死。这里用一张自绘的开屏盖住：品牌鱼标 + 状态文字 +
 * 一条细进度条，状态由 {@link Engine#ensure} 的进度回调驱动，页面真正画出来之后再淡出。
 */
public class Splash extends View {
    private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint stroke = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint text = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path fish = new Path();
    private final RectF box = new RectF();

    private String status = "正在启动…";
    private float t;
    private ValueAnimator anim;

    public Splash(Context c) {
        super(c);
        stroke.setStyle(Paint.Style.STROKE);
        text.setSubpixelText(true);
        start();
    }

    private void start() {
        anim = ValueAnimator.ofFloat(0f, 1f);
        anim.setDuration(1600);
        anim.setRepeatCount(ValueAnimator.INFINITE);
        anim.setInterpolator(new LinearInterpolator());
        anim.addUpdateListener(a -> {
            t = (float) a.getAnimatedValue();
            invalidate();
        });
        anim.start();
    }

    /** 更新状态文字（"正在解包引擎 64%" 之类）。 */
    public void setStatus(String msg) {
        if (msg == null || msg.isEmpty() || msg.equals(status)) return;
        status = msg;
        if (getWidth() > 0) invalidate();
    }

    /** 停止动画，避免淡出后还在空转。 */
    public void stop() {
        if (anim != null) {
            anim.cancel();
            anim = null;
        }
    }

    @Override
    protected void onDetachedFromWindow() {
        stop();
        super.onDetachedFromWindow();
    }

    @Override
    protected void onDraw(Canvas c) {
        int w = getWidth();
        int h = getHeight();
        float cx = w / 2f;
        float cy = h / 2f;

        // 背景：比页面底色略深的竖向渐变，避免"纯黑一块"
        fill.setShader(new LinearGradient(0, 0, 0, h,
                Color.parseColor("#11141a"), Color.parseColor("#0b0d11"), Shader.TileMode.CLAMP));
        c.drawRect(0, 0, w, h, fill);
        fill.setShader(null);

        float d = dp(88);
        float bob = (float) Math.sin(t * Math.PI * 2) * dp(2.5f);

        // 鱼标：圆角方块 + 手绘鲸鱼，颜色用品牌蓝渐变
        box.set(cx - d / 2, cy - dp(86) - d / 2 + bob, cx + d / 2, cy - dp(86) + d / 2 + bob);
        fill.setShader(new LinearGradient(box.left, box.top, box.right, box.bottom,
                Color.parseColor("#7aa2ff"), Color.parseColor("#4f7dff"), Shader.TileMode.CLAMP));
        c.drawRoundRect(box, dp(26), dp(26), fill);
        fill.setShader(null);

        // 鲸鱼（简化版：身体 + 尾巴 + 眼）
        float s = d * 0.46f;
        float bx = cx - s * 0.18f;
        float by = cy - dp(86) + bob + s * 0.05f;
        fill.setColor(Color.parseColor("#0f1115"));
        box.set(bx - s, by - s * 0.55f, bx + s * 0.72f, by + s * 0.55f);
        c.drawRoundRect(box, s * 0.55f, s * 0.55f, fill);
        fish.reset();
        fish.moveTo(bx + s * 0.62f, by);
        fish.lineTo(bx + s * 1.12f, by - s * 0.52f);
        fish.lineTo(bx + s * 1.12f, by + s * 0.52f);
        fish.close();
        c.drawPath(fish, fill);
        fill.setColor(Color.parseColor("#7aa2ff"));
        c.drawCircle(bx - s * 0.42f, by - s * 0.12f, s * 0.09f, fill);

        // 标题
        text.setColor(Color.parseColor("#eceef1"));
        text.setTextSize(dp(21));
        text.setFakeBoldText(true);
        text.setTextAlign(Paint.Align.CENTER);
        c.drawText("DeepSeek Harness", cx, cy + dp(16), text);

        // 状态文字
        text.setFakeBoldText(false);
        text.setTextSize(dp(13));
        text.setColor(Color.parseColor("#8b929c"));
        c.drawText(status, cx, cy + dp(46), text);

        // 细进度条（不确定态：一段亮条来回扫）
        float bw = dp(168);
        float bh = dp(3);
        float left = cx - bw / 2;
        float top = cy + dp(72);
        box.set(left, top, left + bw, top + bh);
        fill.setColor(Color.parseColor("#22262e"));
        c.drawRoundRect(box, bh / 2, bh / 2, fill);

        float seg = bw * 0.34f;
        float travel = (bw - seg) * t;
        box.set(left + travel, top, left + travel + seg, top + bh);
        fill.setShader(new LinearGradient(box.left, top, box.right, top,
                Color.parseColor("#3d5fbb"), Color.parseColor("#7aa2ff"), Shader.TileMode.CLAMP));
        c.drawRoundRect(box, bh / 2, bh / 2, fill);
        fill.setShader(null);

        // 底部一句，告诉人这是自己的壳、不是卡住
        text.setTextSize(dp(11));
        text.setColor(Color.parseColor("#5b6068"));
        c.drawText("本地引擎 · 首次启动会慢一些", cx, h - dp(48), text);
    }

    private float dp(float v) {
        return v * getResources().getDisplayMetrics().density;
    }
}

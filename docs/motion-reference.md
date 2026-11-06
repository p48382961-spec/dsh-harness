# 启动屏/交接动效参考（0.10.12）

## 一、规范来源（先查了一遍再动手）

| 来源 | 拿到的具体东西 |
|---|---|
| [Material 3 · Easing and duration tokens](https://m3.material.io/styles/motion/easing-and-duration/tokens-specs) | 两条主曲线：`emphasized-decelerate = cubic-bezier(0.05, 0.7, 0.1, 1.0)`、`standard-accelerate = cubic-bezier(0.3, 0, 1, 1)`；时长档位 short 50/100/150/200ms、medium 250/300/350/400ms、long 450~600ms |
| [Carbon · Motion choreography](https://www.carbondesignsystem.com/building-blocks/foundations/motion/choreography) | "同一方向、错峰推进"：元素不要同时开始，按层次相隔几十毫秒起跑；离场比进场快 |
| [SpringBasedSplash](https://github.com/amanjeetsingh150/SpringBasedSplash) | 物理动画开屏：落点要有回弹（overshoot → settle），匀速到达会显得假 |
| [material-motion-android](https://github.com/material-motion/material-motion-android) | 已废弃，但"reactive motion"的思路可借：动画由状态驱动，而不是写死的时长 |

社区库（Lottie / MotionLayout / Compose）都要 AndroidX 或 Gradle，我们的构建是无 Gradle + aapt2/javac/d8，
所以**只借方法论不引依赖**，全部用 `PathInterpolator` + `ValueAnimator` + `ViewPropertyAnimator` 手写。

## 二、M3 曲线在代码里的落地

```java
// 离场：越走越快，"被推走"
new PathInterpolator(0.3f, 0f, 1f, 1f);
// 揭幕 / 飞行：尾巴长，落点稳
new PathInterpolator(0.05f, 0.7f, 0.1f, 1f);
// 回正：标准曲线
new PathInterpolator(0.2f, 0f, 0f, 1f);
```

## 三、之前三版的问题对照

| 版本 | 做法 | 为什么不好看 |
|---|---|---|
| 0.10.9 | 直线 translate + 统一 420ms + Overshoot | 直线 = "被吸走"；所有属性同一条时长 = 没有层次 |
| 0.10.10 | 位移/缩放分开定时 | 有层次了但仍走直线，且页面揭幕太快 |
| 0.10.11 | 放慢到 680ms | 只是"慢"，慢不等于"优美" |
| **0.10.12** | 贝塞尔弧线 + 旋转 + 辉光 + 落点回弹 + 文案错峰放大 + 背景延后 + 页面托起 | 有编排：先后、方向、缓动都不一样 |

## 四、时间轴（0.10.12）

```
  0ms  起步辉光 85%→0 / 文案开始离场（进度条）
 50ms  状态文字离场（错峰 +50ms）
100ms  标题离场（错峰 +100ms，放大 1.06）
 40ms  鱼起飞（贝塞尔弧线，法线方向鼓出 0.18×距离，-10° 回正）
220ms  背景揭幕 + 页面 translationY 12dp→0（340ms）
740ms  落点回弹：放大 1.15（90ms）→ 回目标尺寸并淡出（170ms）
820ms  撤开屏
~1000ms 飞行层清理
```

## 五、还差的

- 页面里侧栏鱼标到位那一刻没有"呼应"（我们控制不到侧栏内部，只能让飞行层在落点淡出）
- 想要更"贵"的话可以做：背景加极轻的视差（开屏 logo 上浮时背景渐变轻微移动）、状态文字用逐字淡入

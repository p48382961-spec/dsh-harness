package dev.dsh.harness;

/** 编译期常量：M2 用真快照，壳只负责"把它装好并启动"。 */
final class Build {
    private Build() {}

    /** 快照标识，跟着我们要装的版本走；变了就重装。 */
    // 载荷版本：换包名 + 注入凭据后的重打包；换载荷就改这里（App 据此判断要不要重装快照）
    static final String VERSION_SNAPSHOT = "v0.14.8-dshb9";

    /** 快照 tar.gz 的地址（M2 阶段：本机回环下载服务）。 */
    static final String ROOTFS_URL = "http://127.0.0.1:8099/dshb-rootfs.tar.gz";

    /** 引擎端口：刻意避开 Termux 里那个正在用的 3081。 */
    static final int PORT = 3082;
}

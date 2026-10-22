package dev.dsh.harness;

import android.content.Context;
import android.util.Log;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.zip.GZIPInputStream;

/**
 * 快照安装器：下载 → 解包 → 标记。
 *
 * 为什么是 tar.gz 而不是原厂的 tar.xz：Android 里没有 xz 解码器，
 * 而 gzip 是 JDK 自带的（GZIPInputStream），tar 格式自己解析 512 字节头就够了。
 * 代价是 242 MB 而不是 149 MB —— 走本机回环，无所谓。
 *
 * 关键点：必须保留 **符号链接**（usr/bin/dsh、libtermux-exec.so 等一串）和
 * **可执行位**（usr/bin 下的所有东西），否则 node 起不来。
 */
final class Rootfs {
    private static final String TAG = "DSH-B";
    static final String MARKER = ".rootfs-installed";

    interface Progress {
        void step(String msg);
        void bytes(long done, long total);
    }

    private Rootfs() {}

    /**
     * 快照直接铺在 filesDir 根上（不是 filesDir/rootfs）。
     * 原因：载荷里 cordis.patch.yml / dsh-node 写死的路径是
     * /data/data/<包名>/files/usr/...，安装时我们已经把包名换成自己的，
     * 只有让 usr、home 直接位于 filesDir 下，那些路径才恰好命中。
     */
    static File dir(Context ctx) { return ctx.getFilesDir(); }

    static boolean isInstalled(File root) {
        File m = new File(root, MARKER);
        if (!m.isFile()) return false;
        try (InputStream in = new FileInputStream(m)) {
            byte[] buf = new byte[64];
            int n = in.read(buf);
            return n > 0 && new String(buf, 0, n, StandardCharsets.UTF_8).trim().equals(Build.VERSION_SNAPSHOT);
        } catch (IOException e) {
            return false;
        }
    }

    /** 幂等：已装过同版本快照就直接返回。 */
    static void ensure(final Context ctx, final Progress p) throws Exception {
        final File root = dir(ctx);
        if (isInstalled(root)) {
            p.step("快照已在（跳过下载/解包）");
            return;
        }
        final File archive = new File(ctx.getCacheDir(), "rootfs.tar.gz");
        // 优先用安装包内置的载荷（APK assets）：不用联网、不用 Termux 当下载源。
        final InputStream bundled = openBundled(ctx);
        if (bundled != null) {
            p.step("使用安装包内置载荷（无需下载）");
        } else if (!archive.isFile() || archive.length() == 0) {
            download(Build.ROOTFS_URL, archive, p);
        } else {
            p.step("用已下载的压缩包 " + archive.length() / 1048576 + " MB");
        }
        p.step("清理旧快照…");
        // 先保住用户数据：会话、工作区里的文件、模型设置、凭据都在 home 下，而 home 是载荷的一部分。
        // 不做这步的话，每次换载荷（VERSION_SNAPSHOT 变了）都会把用户聊过的东西端掉。
        final File home = new File(root, "home");
        final File keep = new File(root, ".keep");
        boolean preserved = false;
        if (home.isDirectory()) {
            p.step("保留用户数据（会话/工作区/设置）…");
            deleteTree(keep);
            if (!keep.isDirectory() && !keep.mkdirs()) throw new IOException("建暂存目录失败：" + keep);
            preserved = preserveInto(home, keep);
        }
        // 只删 usr 和 home：filesDir 根部还有标记文件，别把整个目录端掉
        deleteTree(new File(root, "usr"));
        deleteTree(new File(root, "home"));
        // 0.2.0 时代把快照铺在 filesDir/rootfs，升级后那份 879 MB 就是垃圾了
        deleteTree(new File(root, "rootfs"));
        // filesDir 本身总是存在的，mkdirs() 会返回 false —— 只有"不存在且建不出来"才算失败
        if (!root.isDirectory() && !root.mkdirs()) throw new IOException("建 rootfs 目录失败：" + root);
        p.step("解包中（879 MB，约 1–3 分钟）…");
        if (bundled != null) {
            try {
                extract(bundled, root, p);
            } finally {
                try { bundled.close(); } catch (IOException ignored) { }
            }
        } else {
            extract(archive, root, p);
        }
        if (preserved) {
            p.step("恢复用户数据…");
            restoreFrom(keep, home);
            deleteTree(keep);
        }
        // 保险：凭据文件必须是属主独占（dsh-credentials-local 会挡 666/644）
        File cred = new File(root, "home/.dsh/.credentials.yaml");
        if (cred.isFile()) applyMode(cred, 0600);

        try (OutputStream out = new FileOutputStream(new File(root, MARKER))) {
            out.write(Build.VERSION_SNAPSHOT.getBytes(StandardCharsets.UTF_8));
        }
        //noinspection ResultOfMethodCallIgnored
        archive.delete();
        p.step("快照安装完成");
    }

    /** 安装包里带了载荷吗？带了就返回它的流（APK assets 里是 store 的，可直接流式解包）。 */
    private static InputStream openBundled(Context ctx) {
        try {
            return ctx.getAssets().open("dshb-rootfs.tar.gz");
        } catch (Throwable notBundled) {
            return null;
        }
    }

    private static void download(String url, File dest, Progress p) throws IOException {
        p.step("下载快照 242 MB…");
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(60000);
        c.connect();
        long total = c.getContentLengthLong();
        if (c.getResponseCode() != 200) throw new IOException("HTTP " + c.getResponseCode() + " " + url);
        File tmp = new File(dest.getPath() + ".part");
        try (InputStream in = new BufferedInputStream(c.getInputStream(), 128 * 1024);
             OutputStream out = new FileOutputStream(tmp)) {
            byte[] buf = new byte[128 * 1024];
            long done = 0;
            int n;
            long last = 0;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                done += n;
                if (done - last > 4L * 1024 * 1024) {
                    last = done;
                    p.bytes(done, total);
                }
            }
        } finally {
            c.disconnect();
        }
        Files.move(tmp.toPath(), dest.toPath(), StandardCopyOption.REPLACE_EXISTING);
    }

    /** POSIX tar（ustar + GNU longname）解包：文件入口。 */
    static void extract(File archive, File root, Progress p) throws IOException {
        try (InputStream in = new BufferedInputStream(new FileInputStream(archive), 256 * 1024)) {
            extract(in, root, p);
        }
    }

    /** POSIX tar（ustar + GNU longname）解包：流入口（内置载荷直接从这里喂，不落盘）。 */
    static void extract(InputStream raw, File root, Progress p) throws IOException {
        Path base = root.toPath().normalize();
        long count = 0;
        long bytes = 0;
        try (GZIPInputStream gz = new GZIPInputStream(raw, 256 * 1024)) {
            byte[] hdr = new byte[512];
            String longName = null;
            String longLink = null;
            while (true) {
                if (!readFully(gz, hdr)) break;
                if (isZero(hdr)) continue;

                String name = str(hdr, 0, 100);
                long mode = oct(hdr, 100, 8);
                long size = oct(hdr, 124, 12);
                char type = (char) (hdr[156] & 0xff);
                String link = str(hdr, 157, 100);
                String magic = str(hdr, 257, 6);
                if (magic.startsWith("ustar")) {
                    String prefix = str(hdr, 345, 155);
                    if (!prefix.isEmpty()) name = prefix + "/" + name;
                }
                if (longName != null) { name = longName; longName = null; }
                if (longLink != null) { link = longLink; longLink = null; }

                if (type == 'L') { // GNU 长文件名
                    longName = readBodyString(gz, size);
                    skipPadding(gz, size);
                    continue;
                }
                if (type == 'K') {
                    longLink = readBodyString(gz, size);
                    skipPadding(gz, size);
                    continue;
                }
                if (name.startsWith("./")) name = name.substring(2);
                if (name.isEmpty() || name.equals(".")) { skipPadding(gz, size); continue; }

                Path target = base.resolve(name).normalize();
                if (!target.startsWith(base)) {
                    Log.w(TAG, "跳过越界条目: " + name);
                    skipPadding(gz, size);
                    continue;
                }
                File f = target.toFile();

                switch (type) {
                    case '5': { // 目录
                        if (!f.isDirectory() && !f.mkdirs()) Log.w(TAG, "建目录失败: " + name);
                        applyMode(f, mode);
                        break;
                    }
                    case '2': { // 符号链接
                        ensureParent(f);
                        try {
                            if (f.exists() || Files.isSymbolicLink(target)) Files.delete(target);
                            Files.createSymbolicLink(target, Paths.get(link));
                        } catch (Exception e) {
                            Log.w(TAG, "建符号链接失败 " + name + " → " + link + ": " + e);
                        }
                        break;
                    }
                    case '1': { // 硬链接
                        ensureParent(f);
                        Path src = base.resolve(link).normalize();
                        try {
                            if (src.startsWith(base) && src.toFile().isFile()) {
                                if (f.exists()) Files.delete(target);
                                Files.createLink(target, src);
                            } else {
                                Files.copy(src, target, StandardCopyOption.REPLACE_EXISTING);
                            }
                        } catch (Exception e) {
                            Log.w(TAG, "硬链接失败 " + name + ": " + e);
                        }
                        break;
                    }
                    case '0':
                    case '\0':
                    case '7': { // 普通文件
                        ensureParent(f);
                        try (OutputStream out = new FileOutputStream(f)) {
                            copyN(gz, out, size);
                        }
                        applyMode(f, mode);
                        bytes += size;
                        break;
                    }
                    default: {
                        Log.w(TAG, "跳过未知 tar 类型 " + type + " (" + name + ")");
                        skipPadding(gz, size);
                        continue;
                    }
                }
                if (type != '0' && type != '\0' && type != '7') skipPadding(gz, size);
                else skipPadding(gz, size);
                if ((++count % 2000) == 0) {
                    p.step("解包 " + count + " 个条目，" + (bytes / 1048576) + " MB");
                }
            }
        }
        p.step("解包完成：" + count + " 个条目");
    }

    /**
     * 还原 tar 头里的权限位。
     *
     * 必须用 POSIX 权限整位设置，不能只调 setReadable/setWritable/setExecutable：
     * 那套 API 表达不了"只给属主"——实测把 600 的 .credentials.yaml 还原成了 666，
     * 于是 dsh-credentials-local 的 assertOwnerOnly() 直接拒绝启动
     * （错误原文："is readable beyond its owner (mode 666)"）。
     */
    private static void applyMode(File f, long mode) {
        try {
            java.util.Set<java.nio.file.attribute.PosixFilePermission> perms =
                    java.util.EnumSet.noneOf(java.nio.file.attribute.PosixFilePermission.class);
            add(perms, mode, 0400, 0200, 0100,
                    java.nio.file.attribute.PosixFilePermission.OWNER_READ,
                    java.nio.file.attribute.PosixFilePermission.OWNER_WRITE,
                    java.nio.file.attribute.PosixFilePermission.OWNER_EXECUTE);
            add(perms, mode, 0040, 0020, 0010,
                    java.nio.file.attribute.PosixFilePermission.GROUP_READ,
                    java.nio.file.attribute.PosixFilePermission.GROUP_WRITE,
                    java.nio.file.attribute.PosixFilePermission.GROUP_EXECUTE);
            add(perms, mode, 0004, 0002, 0001,
                    java.nio.file.attribute.PosixFilePermission.OTHERS_READ,
                    java.nio.file.attribute.PosixFilePermission.OTHERS_WRITE,
                    java.nio.file.attribute.PosixFilePermission.OTHERS_EXECUTE);
            java.nio.file.Files.setPosixFilePermissions(f.toPath(), perms);
            return;
        } catch (Throwable ignored) {
            // 某些文件系统不支持 POSIX 权限，退化成粗粒度设置（至少保住可执行位）
        }
        //noinspection ResultOfMethodCallIgnored
        f.setReadable((mode & 0400) != 0, false);
        //noinspection ResultOfMethodCallIgnored
        f.setWritable((mode & 0200) != 0, false);
        //noinspection ResultOfMethodCallIgnored
        f.setExecutable((mode & 0100) != 0, false);
    }

    private static void add(java.util.Set<java.nio.file.attribute.PosixFilePermission> set, long mode,
                            long r, long w, long x,
                            java.nio.file.attribute.PosixFilePermission pr,
                            java.nio.file.attribute.PosixFilePermission pw,
                            java.nio.file.attribute.PosixFilePermission px) {
        if ((mode & r) != 0) set.add(pr);
        if ((mode & w) != 0) set.add(pw);
        if ((mode & x) != 0) set.add(px);
    }

    private static void ensureParent(File f) throws IOException {
        File parent = f.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IOException("建父目录失败: " + parent);
        }
    }

    private static String readBodyString(InputStream in, long size) throws IOException {
        byte[] buf = new byte[(int) Math.min(size, 8192)];
        readFully(in, buf);
        return new String(buf, StandardCharsets.UTF_8).trim();
    }

    private static void copyN(InputStream in, OutputStream out, long size) throws IOException {
        byte[] buf = new byte[128 * 1024];
        long left = size;
        while (left > 0) {
            int want = (int) Math.min(buf.length, left);
            int n = in.read(buf, 0, want);
            if (n < 0) throw new IOException("解包时数据提前结束（还差 " + left + " 字节）");
            out.write(buf, 0, n);
            left -= n;
        }
    }

    private static void skipPadding(InputStream in, long size) throws IOException {
        long pad = (512 - (size % 512)) % 512;
        if (pad > 0) readFully(in, new byte[(int) pad]);
    }

    private static boolean readFully(InputStream in, byte[] buf) throws IOException {
        int off = 0;
        while (off < buf.length) {
            int n = in.read(buf, off, buf.length - off);
            if (n < 0) return false;
            off += n;
        }
        return true;
    }

    private static boolean isZero(byte[] b) {
        for (byte x : b) if (x != 0) return false;
        return true;
    }

    private static String str(byte[] b, int off, int len) {
        int end = off;
        while (end < off + len && b[end] != 0) end++;
        return new String(b, off, end - off, StandardCharsets.UTF_8);
    }

    private static long oct(byte[] b, int off, int len) {
        String s = str(b, off, len).trim();
        if (s.isEmpty()) return 0;
        try {
            return Long.parseLong(s, 8);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    /**
     * 换载荷时要跨版本保留的用户数据（相对 home 的路径）。
     *
     * <p>不保留的东西：{@code .dsh/profiles}（插件树属于程序，必须跟着载荷走，否则新插件装不上）、
     * {@code tmp}（引擎自己会重建）、{@code .dsh/logs}（诊断日志，留着只会让上传变慢）。
     */
    private static final String[] KEEP = {
            ".dsh/storages",          // 会话索引 + workspace.json + 各种 settings 落库
            ".dsh/sessions",          // session-persistence-jsonl 的正文
            ".dsh/settings.yaml",     // 用户在界面里改过的模型/主题
            ".dsh/.credentials.yaml", // 重新授权过的凭据比载荷里带的新
            "workspace",              // 默认工作区里的用户文件
            ".gitconfig",
    };

    /** 把 KEEP 里存在的条目 move 到暂存目录，结构原样保留。返回是否有过任何一条。 */
    private static boolean preserveInto(File home, File keep) throws IOException {
        boolean any = false;
        for (String rel : KEEP) {
            File src = new File(home, rel);
            if (!src.exists()) continue;
            File dst = new File(keep, rel);
            File parent = dst.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
                throw new IOException("建暂存子目录失败：" + parent);
            }
            deleteTree(dst);
            java.nio.file.Files.move(src.toPath(), dst.toPath(),
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            any = true;
        }
        return any;
    }

    /** 解包之后把暂存目录里的条目放回 home，覆盖载荷里的同名新鲜副本。 */
    private static void restoreFrom(File keep, File home) throws IOException {
        for (String rel : KEEP) {
            File src = new File(keep, rel);
            if (!src.exists()) continue;
            File dst = new File(home, rel);
            if (dst.exists()) deleteTree(dst);
            File parent = dst.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
                throw new IOException("建恢复目录失败：" + parent);
            }
            java.nio.file.Files.move(src.toPath(), dst.toPath(),
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        }
    }

    static void deleteTree(File f) {
        if (!f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    /**
     * 预置一个默认工作区：载荷里已经有 workspace.json 的话就跳过（幂等）。
     * 为什么需要：我们删掉上游 @dsh-android/* 之后，没有任何插件替用户建默认文件夹，
     * 首启打开只有「选/建文件夹」，得手动点一次才能聊天。
     */
    static void seedWorkspace(File root) {
        try {
            File ws = new File(root, "home/workspace");
            if (!ws.isDirectory() && !ws.mkdirs()) return;
            File storages = new File(root, "home/.dsh/storages");
            File reg = new File(storages, "workspace.json");
            if (reg.isFile()) return;
            if (!storages.isDirectory() && !storages.mkdirs()) return;
            String uuid = java.util.UUID.randomUUID().toString();
            String now = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US)
                    .format(new java.util.Date());
            String path = ws.getAbsolutePath();
            String json = "{\n"
                    + "  \"unit\": { \"name\": \"workspace\", \"version\": 2 },\n"
                    + "  \"global\": { \"initialized\": true, \"workspaceIds\": [\"" + uuid + "\"],\n"
                    + "    \"archivedSessionIds\": [], \"pinnedSessionIds\": [] },\n"
                    + "  \"tables\": { \"workspaces\": {\n"
                    + "    \"" + uuid + "\": { \"path\": \"" + path + "\", \"title\": \"工作区\",\n"
                    + "      \"sessionIds\": [], \"createdAt\": \"" + now + "\", \"updatedAt\": \"" + now + "\" }\n"
                    + "  } }\n}\n";
            java.nio.file.Files.write(reg.toPath(), json.getBytes("UTF-8"));
            if (android.os.Build.VERSION.SDK_INT >= 26) {
                java.nio.file.Files.setPosixFilePermissions(reg.toPath(),
                        java.nio.file.attribute.PosixFilePermissions.fromString("rw-------"));
            }
            Log.i(TAG, "已预置默认工作区：" + path);
        } catch (Throwable t) {
            Log.w(TAG, "预置工作区失败（不致命）", t);
        }
    }
}

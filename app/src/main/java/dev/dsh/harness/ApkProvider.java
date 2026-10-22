package dev.dsh.harness;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.File;

/**
 * 只为「把下载好的 APK 交给系统安装器」存在的最小 ContentProvider。
 *
 * 为什么不直接用 file:// —— Android 7+ 会抛 FileUriExposedException；而项目的硬约束是
 * 不用 Gradle / 不用 AndroidX（FileProvider 在 androidx.core 里）。所以要自己写一个：
 * 只暴露 cache/updates/ 下的 .apk，只读，不导出。
 */
public class ApkProvider extends ContentProvider {

    /** openFile 的返回值：只读。 */
    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws java.io.FileNotFoundException {
        String name = uri.getLastPathSegment();
        if (name == null || !name.endsWith(".apk")) {
            throw new java.io.FileNotFoundException("只提供 .apk：" + uri);
        }
        File file = new File(new File(getContext().getCacheDir(), "updates"), name);
        if (!file.isFile()) throw new java.io.FileNotFoundException("没有这个文件：" + file);
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public String getType(Uri uri) {
        return "application/vnd.android.package-archive";
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        return null;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}

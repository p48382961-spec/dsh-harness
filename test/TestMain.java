package dev.dsh.harness;
import java.io.File;

public class TestMain {
  public static void main(String[] a) throws Exception {
    File arc = new File(a[0]);
    File root = new File(a[1]);
    if (root.exists()) Rootfs.deleteTree(root);
    root.mkdirs();
    long t0 = System.currentTimeMillis();
    Rootfs.extract(arc, root, new Rootfs.Progress() {
      public void step(String msg) { System.out.println("[step] " + msg); }
      public void bytes(long d, long t) {}
    });
    System.out.println("耗时 " + (System.currentTimeMillis() - t0) + " ms");
  }
}

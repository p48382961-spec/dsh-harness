package android.util;
public final class Log {
  public static int i(String t, String m) { return 0; }
  public static int w(String t, String m) { System.out.println("WARN " + m); return 0; }
  public static int e(String t, String m) { System.out.println("ERR " + m); return 0; }
}

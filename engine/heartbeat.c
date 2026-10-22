/*
 * heartbeat.c —— 路线 B 的 M1「假引擎」
 *
 * 目的：在真 156 MB 快照之前，先用一个几 KB 的 aarch64 原生程序把壳的整条链路验通：
 *   应用私有目录解包 → exec 原生 ELF → 监听 127.0.0.1 → 打 token → 换 cookie → WebView 出页面。
 *
 * 行为刻意模仿真 DSH：
 *   stdout 第一行  : listening port=<p> token=<32 hex>
 *   GET /?token=<t> : 303 See Other + Set-Cookie（与 DSH 一致的回环换证）
 *   GET /           : 带正确 cookie → 200 HTML；否则 → 401
 *
 * 构建：clang -O2 -o heartbeat heartbeat.c（动态链接 /system/bin/linker64）
 */
#include <arpa/inet.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

#define BACKLOG 8
#define REQBUF 8192

static const char *HTML_HEAD =
    "<!doctype html><html><head><meta charset=\"utf-8\">"
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    "<title>M1 假引擎</title><style>"
    "html,body{margin:0;height:100%;background:#0f1115;color:#e6e8eb;"
    "font-family:system-ui,-apple-system,sans-serif}"
    "main{max-width:34rem;margin:0 auto;padding:12vh 1.5rem;text-align:center}"
    "h1{font-size:1.6rem;margin:0 0 1.2rem}"
    "p{color:#9aa4b2;line-height:1.7;margin:.4rem 0}"
    "code{background:#1a1e25;padding:.15rem .4rem;border-radius:.35rem;font-size:.85em}"
    ".ok{color:#4ade80;font-weight:600}"
    "</style></head><body><main>";

static const char *HTML_TAIL = "</main></body></html>";

static void random_hex(char *out, size_t n) {
    static const char *hex = "0123456789abcdef";
    unsigned char buf[128];
    size_t got = 0;
    FILE *f = fopen("/dev/urandom", "rb");
    if (f) {
        got = fread(buf, 1, n, f);
        fclose(f);
    }
    size_t i = 0;
    for (; i < got && i < n; i++) out[i] = hex[buf[i] & 0x0f];
    for (; i < n; i++) out[i] = hex[(unsigned)(i * 7 + 3) & 0x0f];
    out[n] = '\0';
}

static int write_all(int fd, const char *buf, size_t len) {
    size_t off = 0;
    while (off < len) {
        ssize_t w = write(fd, buf + off, len - off);
        if (w <= 0) return -1;
        off += (size_t)w;
    }
    return 0;
}

static void respond(int fd, int code, const char *reason, const char *extra_header,
                    const char *body, size_t body_len) {
    char head[1024];
    int n = snprintf(head, sizeof head,
                     "HTTP/1.1 %d %s\r\n"
                     "Content-Length: %zu\r\n"
                     "Cache-Control: no-store\r\n"
                     "Connection: close\r\n"
                     "%s"
                     "\r\n",
                     code, reason, body_len, extra_header ? extra_header : "");
    write_all(fd, head, (size_t)n);
    if (body && body_len) write_all(fd, body, body_len);
}

int main(int argc, char **argv) {
    signal(SIGPIPE, SIG_IGN);

    int port = argc > 1 ? atoi(argv[1]) : 3999;
    char token[33];
    random_hex(token, 32);

    int srv = socket(AF_INET, SOCK_STREAM, 0);
    if (srv < 0) { perror("socket"); return 1; }
    int on = 1;
    setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, &on, sizeof on);

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof addr);
    addr.sin_family = AF_INET;
    addr.sin_port = htons((unsigned short)port);
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (bind(srv, (struct sockaddr *)&addr, sizeof addr) != 0) { perror("bind"); return 1; }
    if (listen(srv, BACKLOG) != 0) { perror("listen"); return 1; }

    socklen_t alen = sizeof addr;
    if (getsockname(srv, (struct sockaddr *)&addr, &alen) == 0)
        port = ntohs(addr.sin_port);

    /* 壳按这一行解析端口与令牌 —— 与真 DSH 的启动日志同形 */
    printf("listening port=%d token=%s\n", port, token);
    fflush(stdout);

    for (;;) {
        int fd = accept(srv, NULL, NULL);
        if (fd < 0) continue;

        char req[REQBUF];
        size_t used = 0;
        while (used + 1 < sizeof req) {
            ssize_t r = read(fd, req + used, sizeof req - 1 - used);
            if (r <= 0) break;
            used += (size_t)r;
            req[used] = '\0';
            if (strstr(req, "\r\n\r\n")) break;
        }
        if (used == 0) { close(fd); continue; }
        req[used] = '\0';

        char method[8] = {0}, path[512] = {0};
        if (sscanf(req, "%7s %511s", method, path) != 2) { close(fd); continue; }

        int has_cookie = strstr(req, token) != NULL;
        const char *q = strstr(path, "token=");

        if (q) {
            char got[64] = {0};
            sscanf(q + 6, "%63[0-9a-fA-F]", got);
            if (strcmp(got, token) == 0) {
                char sc[160];
                snprintf(sc, sizeof sc,
                         "Set-Cookie: dshb-auth=%s; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict\r\n",
                         token);
                char loc[32];
                snprintf(loc, sizeof loc, "Location: ./\r\n");
                char extra[220];
                snprintf(extra, sizeof extra, "%s%s", loc, sc);
                respond(fd, 303, "See Other", extra, NULL, 0);
                close(fd);
                continue;
            }
        }

        if (!has_cookie) {
            const char *body = "<h1>401</h1>";
            respond(fd, 401, "Unauthorized", "Content-Type: text/html; charset=utf-8\r\n",
                    body, strlen(body));
            close(fd);
            continue;
        }

        /* 已认证：出真正的页面 */
        char page[2048];
        snprintf(page, sizeof page,
                 "%s<h1 class=\"ok\">假引擎已连通 ✅</h1>"
                 "<p>这一页是 <code>heartbeat</code> 从应用私有目录被 exec 起来后返回的。</p>"
                 "<p>端口 <code>%d</code></p>"
                 "<p>token 换 cookie 走的路径：<code>/?token=…</code> → 303 → <code>Set-Cookie</code></p>"
                 "<p>下一步 M2：把这个 ELF 换成真快照里的 <code>node</code> + DSH。</p>"
                 "%s",
                 HTML_HEAD, port, HTML_TAIL);
        respond(fd, 200, "OK", "Content-Type: text/html; charset=utf-8\r\n", page, strlen(page));
        close(fd);
    }
    return 0;
}

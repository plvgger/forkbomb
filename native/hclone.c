// hclone: clone one directory tree into N destinations with a single
// clonefile(2) call each. On APFS the clone shares every data block with the
// source until one side writes, so a fork costs metadata, not a copy.
//
// usage: hclone SRC DST [DST...]
// prints a JSON array: [{"dst": "...", "ms": 1.23, "ok": true, "err": ""}, ...]

#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/clonefile.h>
#include <time.h>

static double now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}

static void json_str(const char *s) {
  putchar('"');
  for (; *s; s++) {
    if (*s == '"' || *s == '\\') putchar('\\');
    if ((unsigned char)*s < 0x20) { printf("\\u%04x", *s); continue; }
    putchar(*s);
  }
  putchar('"');
}

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: hclone SRC DST [DST...]\n");
    return 2;
  }
  int failed = 0;
  printf("[");
  for (int i = 2; i < argc; i++) {
    double t0 = now_ms();
    int r = clonefile(argv[1], argv[i], CLONE_NOFOLLOW);
    double ms = now_ms() - t0;
    if (r != 0) failed = 1;
    printf("%s{\"dst\":", i > 2 ? "," : "");
    json_str(argv[i]);
    printf(",\"ms\":%.3f,\"ok\":%s,\"err\":", ms, r == 0 ? "true" : "false");
    json_str(r == 0 ? "" : strerror(errno));
    printf("}");
  }
  printf("]\n");
  return failed;
}

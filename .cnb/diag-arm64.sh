#!/bin/sh
# ARM64 交叉编译方言诊断（只在探针分支调用，不参与正式发布流水线）。
#
# 目的：
#   1) 打印环境事实，尤其是 clang / clang-cl 这两个名字各自被解析到哪里；
#   2) 分别验证垫片两条路真的能编东西：
#        gcc 路（被当 clang 调用）：/imsvc + /FI + .S
#        cl 路（被当 clang-cl 调用）：-Od -W4 -DYNAMICBASE + .c，外加真编一次 hrss.c
#      hrss.c 是探针 #11 的卡点（GNU 模式下 vec_t 落到 union __n128，向量算术报错），
#      所以这一项是整个诊断里最值钱的：它直接在 stage 里回答「CL 模式能不能过」。
# 全部结论以 `DIAG ` 前缀打印，便于在日志里 grep。任何一步失败都不影响 stage。
DIAG() { echo "DIAG $*"; }

DIAG "== 环境 =="
DIAG "QT_REAL_CLANG = ${QT_REAL_CLANG:-未设置}"
DIAG "PATH 头两项 = $(printf '%s' "$PATH" | cut -d: -f1,2)"
DIAG "command -v clang    = $(command -v clang || echo '(缺失)')"
DIAG "command -v clang-cl = $(command -v clang-cl || echo '(缺失)')"

AVS="$(ls -d /usr/local/cargo/registry/src/*/aws-lc-sys-0.45.0 2>/dev/null | head -1)"
DIAG "aws-lc-sys 源目录 = ${AVS:-未找到}"
XWIN=/root/.cache/cargo-xwin/xwin
DIAG "xwin 头文件目录存在？ crt=$(test -d $XWIN/crt/include && echo 是 || echo 否)"

# 一个最小 .c 和一个最小 .S，用来分离「参数能不能过」与「源码能不能编」。
printf 'int qt_diag(void) { return 0; }\n' > /tmp/qt-diag.c
printf '#define QT_DIAG 1\n.text\n.globl qt_diag_asm\nqt_diag_asm:\n  ret\n' > /tmp/qt-diag.S
printf '/* 故意留空：验证 -include 找得到文件 */\n' > /tmp/qt-diag-inc.h

DIAG "== 两个名字都指向真 clang 吗 =="
if clang --version >/dev/null 2>&1; then DIAG "GNU_VERSION OK"; else DIAG "GNU_VERSION FAIL"; fi
if clang-cl --version >/dev/null 2>&1; then DIAG "CL_VERSION OK"; else DIAG "CL_VERSION FAIL"; fi

DIAG "== gcc 路：/imsvc + /FI + .S（预期 OK）=="
if clang --target=aarch64-pc-windows-msvc \
      /imsvc "$XWIN/crt/include" \
      /FI/tmp/qt-diag-inc.h \
      -c /tmp/qt-diag.S -o /tmp/qt-diag-gcc.o >/tmp/qt-diag-gcc.log 2>&1; then
  DIAG "GCC_ASM OK"
else
  DIAG "GCC_ASM FAIL"
  sed 's/^/DIAG   /' /tmp/qt-diag-gcc.log | head -5
fi

DIAG "== cl 路：-Od -W4 -DYNAMICBASE + .c（预期 OK）=="
if clang-cl --target=aarch64-pc-windows-msvc \
      -Os -Od -W4 -DYNAMICBASE \
      -Wno-unused-command-line-argument \
      /imsvc "$XWIN/crt/include" \
      -c /tmp/qt-diag.c -o /tmp/qt-diag-cl.o >/tmp/qt-diag-cl.log 2>&1; then
  DIAG "CL_FLAGS OK"
else
  DIAG "CL_FLAGS FAIL"
  sed 's/^/DIAG   /' /tmp/qt-diag-cl.log | head -5
fi

DIAG "== cl 路：真编一次 hrss.c（探针 #11 的卡点）=="
if [ -n "$AVS" ]; then
  if clang-cl --target=aarch64-pc-windows-msvc \
        -Os -Wno-unused-command-line-argument -fuse-ld=lld-link \
        -I "$AVS/generated-include" -I "$AVS/include" -I "$AVS/aws-lc/include" \
        -I "$AVS/aws-lc/third_party/s2n-bignum/include" \
        -I "$AVS/aws-lc/third_party/s2n-bignum/s2n-bignum-imported/include" \
        -DBORINGSSL_IMPLEMENTATION=1 -DBORINGSSL_PREFIX=aws_lc_0_45_0 \
        -DOPENSSL_SMALL=1 -DAWS_LC_STDALIGN_AVAILABLE=1 \
        -DMY_ASSEMBLER_SUPPORTS_NEON_SHA3_EXTENSION=1 \
        /FI"$AVS/generated-include/openssl/boringssl_prefix_symbols.h" \
        /imsvc "$XWIN/crt/include" /imsvc "$XWIN/sdk/include/ucrt" \
        /imsvc "$XWIN/sdk/include/um" /imsvc "$XWIN/sdk/include/shared" \
        /imsvc "$XWIN/sdk/include/winrt" \
        -c "$AVS/aws-lc/crypto/hrss/hrss.c" -o /tmp/qt-diag-hrss.o >/tmp/qt-diag-hrss.log 2>&1; then
    DIAG "CL_HRSS OK（CL 模式能过 hrss.c）"
  else
    DIAG "CL_HRSS FAIL"
    sed 's/^/DIAG   /' /tmp/qt-diag-hrss.log | head -12
  fi
else
  DIAG "CL_HRSS SKIP（找不到 aws-lc-sys 源码）"
fi

DIAG "== 结束（诊断本身不影响构建）=="
exit 0

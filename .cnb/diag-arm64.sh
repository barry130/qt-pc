#!/bin/sh
# ARM64 交叉编译方言诊断（只在探针分支调用，不参与正式发布流水线）。
#
# 目的：搞清 clang-cl 与 GNU clang 两种方言下
#   (1) .c 能否编译；(2) `/FI` 强制包含能否用；(3) `.S` 汇编能否编译；
#   (4) aws-lc-sys 真正要编的那两条 s2n-bignum 汇编在 GNU 方言下能否算得动。
# 全部结论以 `DIAG ` 前缀打印，便于在日志里 grep。任何一步失败都不影响 stage。
#
# 调用时机：探针的 ARM64 stage 里、装好垫片之后、`tauri build` 之前。
# 此时 x86 stage 已经跑过一遍 cargo fetch，registry 里应有 aws-lc-sys 源码。

REG=/usr/local/cargo/registry/src
AWSLC="$(ls -d "$REG"/*/aws-lc-sys-0.45.0 2>/dev/null | head -1)"
XWIN=/root/.cache/cargo-xwin/xwin
NOCRT=/nonexistent-qt-diag-skip

printf 'int qt_diag_fn(void){return 1;}\n' > /tmp/qt-diag.c
printf '#define QT_DIAG_INC 1\n' > /tmp/qt-diag-inc.h
printf '.text\n.globl qt_diag_asm\nqt_diag_asm:\n\tret\n' > /tmp/qt-diag.S

echo "DIAG == 环境 =="
command -v clang || echo "DIAG clang 不存在"
command -v clang-cl || echo "DIAG clang-cl 不存在"
ls -l "$(command -v clang-cl 2>/dev/null)" 2>&1 | head -2
clang-cl --version 2>&1 | head -2
echo "DIAG clang-cl 解析名 = $(basename "$(command -v clang-cl 2>/dev/null)" 2>/dev/null)"
echo "DIAG PATH 头两项 = $(printf '%s' "$PATH" | cut -d: -f1-2)"
ls -l /tmp/clang-shim/clang 2>&1 | head -1

echo "DIAG == clang-cl 方言：.c =="
if clang-cl /c /tmp/qt-diag.c /Fo/tmp/qt-diag-c.obj >/dev/null 2>/tmp/qt-diag-a.err; then
  echo "DIAG CL_C OK"
else
  echo "DIAG CL_C FAIL"; head -3 /tmp/qt-diag-a.err
fi

echo "DIAG == clang-cl 方言：/FI + .S =="
if clang-cl /c "/FI/tmp/qt-diag-inc.h" /tmp/qt-diag.S /Fo/tmp/qt-diag-s.obj >/dev/null 2>/tmp/qt-diag-b.err; then
  echo "DIAG CL_ASM_FI OK"
else
  echo "DIAG CL_ASM_FI FAIL"; head -3 /tmp/qt-diag-b.err
fi

REAL_CLANG="$(command -v clang)"
echo "DIAG == GNU 方言（真 clang，绕开垫片）：/imsvc + .S =="
if "$REAL_CLANG" --target=aarch64-pc-windows-msvc "/imsvc$XWIN/crt/include" -c /tmp/qt-diag.S -o /tmp/qt-diag-g1.o >/dev/null 2>/tmp/qt-diag-c.err; then
  echo "DIAG GNU_ASM_IMSVС_ASFILENAME OK（说明 /imsvc 在 GNU 下确实不可用，垫片必要）"
else
  echo "DIAG GNU_ASM_RAW_FAIL（预期如此）"; head -3 /tmp/qt-diag-c.err
fi

echo "DIAG == 垫片路径：/imsvc + /FI + .S =="
if clang --target=aarch64-pc-windows-msvc "/imsvc$XWIN/crt/include" "/FI/tmp/qt-diag-inc.h" -c /tmp/qt-diag.S -o /tmp/qt-diag-shim.o >/dev/null 2>/tmp/qt-diag-d.err; then
  echo "DIAG SHIM_ASM_OK"
else
  echo "DIAG SHIM_ASM_FAIL"; head -3 /tmp/qt-diag-d.err
fi

if [ -n "$AWSLC" ] && [ -f "$AWSLC/aws-lc/third_party/s2n-bignum/s2n-bignum-to-be-imported/arm/aes/aes-xts-enc.S" ]; then
  ASM="$AWSLC/aws-lc/third_party/s2n-bignum/s2n-bignum-to-be-imported/arm/aes/aes-xts-enc.S"
  INC="$AWSLC/generated-include/openssl/boringssl_prefix_symbols_asm.h"
  echo "DIAG == 真实 s2n-bignum 汇编（clang-cl + /FI） =="
  if clang-cl /c "/FI$INC" "$ASM" /Fo/tmp/qt-diag-real-cl.obj >/dev/null 2>/tmp/qt-diag-e.err; then
    echo "DIAG REAL_ASM_CL OK"
  else
    echo "DIAG REAL_ASM_CL FAIL"; grep -m3 -i 'error' /tmp/qt-diag-e.err
  fi
  echo "DIAG == 真实 s2n-bignum 汇编（垫片：-include + -isystem） =="
  if clang --target=aarch64-pc-windows-msvc -include "$INC" "-isystem$XWIN/crt/include" "-isystem$XWIN/sdk/include/ucrt" -c "$ASM" -o /tmp/qt-diag-real-gnu.o >/dev/null 2>/tmp/qt-diag-f.err; then
    echo "DIAG REAL_ASM_SHIM OK"
  else
    echo "DIAG REAL_ASM_SHIM FAIL"; grep -m3 -i 'error' /tmp/qt-diag-f.err
  fi
  echo "DIAG == 真实 win-aarch64 生成汇编（垫片路径） =="
  GEN="$(ls "$AWSLC"/generated-src/win-aarch64/crypto/fipsmodule/aesv8-armx.S 2>/dev/null | head -1)"
  if [ -n "$GEN" ]; then
    if clang --target=aarch64-pc-windows-msvc -include "$INC" "-isystem$XWIN/crt/include" -c "$GEN" -o /tmp/qt-diag-gen.o >/dev/null 2>/tmp/qt-diag-g.err; then
      echo "DIAG GEN_ASM_SHIM OK"
    else
      echo "DIAG GEN_ASM_SHIM FAIL"; grep -m3 -i 'error' /tmp/qt-diag-g.err
    fi
  else
    echo "DIAG GEN_ASM_SRC_MISSING"
  fi
else
  echo "DIAG AWSLC_SRC_MISSING（$REG 下没有 aws-lc-sys-0.45.0，跳过真实汇编测试）"
fi

echo "DIAG == 结束（诊断本身不影响构建） =="
exit 0

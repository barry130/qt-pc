#!/bin/sh
# ARM64 交叉编译方言诊断（只在探针分支调用，不参与正式发布流水线）。
#
# 目的：搞清 GNU 驱动 clang 在 aarch64-pc-windows-msvc 下到底能吃到哪些参数，
#   以及 aws-lc-sys 真正要编的那几条汇编在「垫片改写后」能否算得动。
#   全部结论以 `DIAG ` 前缀打印，便于在日志里 grep。任何一步失败都不影响 stage。
#
# 调用时机：探针的 ARM64 stage 里、装好垫片之后、`tauri build` 之前。
# 此时 x86 stage 已经跑过一遍 cargo fetch，registry 里应有 aws-lc-sys 源码。
#
# 两个曾经踩过的坑（改这个脚本时别再犯）：
#   1. 不能用 `command -v clang` 找「真 clang」—— 垫片已经把 clang 抢到 PATH 前面，
#      这样找回来的还是垫片自己，测出来的「GNU 原生行为」全是假的。
#   2. 测 aws-lc-sys 的汇编必须带 `-I <crate>/generated-include`，因为
#      boringssl_prefix_symbols_asm.h 里 `#include <openssl/boringssl_prefix_symbols.h>`
#      就在那个目录下；漏了它会报 "file not found"，看起来像汇编本身编不过。

REG=/usr/local/cargo/registry/src
AWSLC="$(ls -d "$REG"/*/aws-lc-sys-0.45.0 2>/dev/null | head -1)"
XWIN=/root/.cache/cargo-xwin/xwin
# 真 clang：优先用 stage 传进来的 QT_REAL_CLANG，否则退回镜像里的绝对路径。
REAL_CLANG="${QT_REAL_CLANG:-/usr/bin/clang}"
[ -x "$REAL_CLANG" ] || REAL_CLANG=/usr/bin/clang

printf 'int qt_diag_fn(void){return 1;}\n' > /tmp/qt-diag.c
printf '#define QT_DIAG_INC 1\n' > /tmp/qt-diag-inc.h
printf '.text\n.globl qt_diag_asm\nqt_diag_asm:\n\tret\n' > /tmp/qt-diag.S

echo "DIAG == 环境 =="
echo "DIAG 真 clang = $REAL_CLANG"
echo "DIAG PATH 头两项 = $(printf '%s' "$PATH" | cut -d: -f1-2)"
ls -l /tmp/clang-shim/clang 2>&1 | head -1
echo "DIAG clang-cl = $(command -v clang-cl 2>/dev/null || echo '(镜像里没有)')"
echo "DIAG aws-lc-sys 源码 = ${AWSLC:-（未找到，跳过汇编测试）}"

echo "DIAG == clang-cl 方言：.c（预期失败：镜像没有 clang-cl） =="
if clang-cl /c /tmp/qt-diag.c /Fo/tmp/qt-diag-c.obj >/dev/null 2>/tmp/qt-diag-a.err; then
  echo "DIAG CL_C OK"
else
  echo "DIAG CL_C FAIL"; head -2 /tmp/qt-diag-a.err
fi

echo "DIAG == GNU 原生（绕开垫片）：/imsvc 当文件名（预期失败，说明垫片必要） =="
if "$REAL_CLANG" --target=aarch64-pc-windows-msvc "/imsvc$XWIN/crt/include" \
     -c /tmp/qt-diag.S -o /tmp/qt-diag-g1.o >/dev/null 2>/tmp/qt-diag-b.err; then
  echo "DIAG GNU_RAW_IMSVС 意外成功（垫片可能不必要了，需复查）"
else
  echo "DIAG GNU_RAW_IMSVС 如期失败（垫片必要）"; head -2 /tmp/qt-diag-b.err
fi

echo "DIAG == 垫片路径：/imsvc + /FI + .S（预期 OK） =="
if clang --target=aarch64-pc-windows-msvc "/imsvc$XWIN/crt/include" \
     "/FI/tmp/qt-diag-inc.h" -c /tmp/qt-diag.S -o /tmp/qt-diag-shim.o >/dev/null 2>/tmp/qt-diag-c.err; then
  echo "DIAG SHIM_ASM OK"
else
  echo "DIAG SHIM_ASM FAIL"; head -3 /tmp/qt-diag-c.err
fi

# 这一条是本次（探针 #10）真正的失败点：aws-lc-sys 的 jitterentropy 分支按
# clang-cl 方言发 -Od -W4 -DYNAMICBASE，GNU 驱动把 -Od 读成 `-O` + 值 "d"。
echo "DIAG == 垫片路径：jitterentropy 那组 MSVC 开关（-Od -W4 -DYNAMICBASE + .c） =="
if clang --target=aarch64-pc-windows-msvc -Od -W4 -DYNAMICBASE \
     "/imsvc$XWIN/crt/include" -c /tmp/qt-diag.c -o /tmp/qt-diag-jit.o >/dev/null 2>/tmp/qt-diag-d.err; then
  echo "DIAG SHIM_JIT_OK"
else
  echo "DIAG SHIM_JIT_FAIL"; head -3 /tmp/qt-diag-d.err
fi

if [ -n "$AWSLC" ] && [ -f "$AWSLC/aws-lc/third_party/s2n-bignum/s2n-bignum-to-be-imported/arm/aes/aes-xts-enc.S" ]; then
  ASM="$AWSLC/aws-lc/third_party/s2n-bignum/s2n-bignum-to-be-imported/arm/aes/aes-xts-enc.S"
  INC="$AWSLC/generated-include/openssl/boringssl_prefix_symbols_asm.h"
  GENINC="$AWSLC/generated-include"
  echo "DIAG == 真实 s2n-bignum 汇编（clang-cl 直调，预期失败：无 clang-cl） =="
  if clang-cl /c "/FI$INC" "$ASM" /Fo/tmp/qt-diag-real-cl.obj >/dev/null 2>/tmp/qt-diag-e.err; then
    echo "DIAG REAL_ASM_CL OK"
  else
    echo "DIAG REAL_ASM_CL FAIL"; grep -m2 -i 'error' /tmp/qt-diag-e.err
  fi
  echo "DIAG == 真实 s2n-bignum 汇编（垫片：-include + -isystem，带 -I generated-include） =="
  if clang --target=aarch64-pc-windows-msvc "-I$GENINC" -include "$INC" \
       "-isystem$XWIN/crt/include" "-isystem$XWIN/sdk/include/ucrt" \
       -c "$ASM" -o /tmp/qt-diag-real-gnu.o >/dev/null 2>/tmp/qt-diag-f.err; then
    echo "DIAG REAL_ASM_SHIM OK"
  else
    echo "DIAG REAL_ASM_SHIM FAIL"; grep -m3 -i 'error' /tmp/qt-diag-f.err
  fi
  echo "DIAG == 真实 s2n-bignum 汇编（垫片 + 原样 /FI /imsvc，模拟真实调用） =="
  if clang -Os -ffunction-sections -fdata-sections --target=aarch64-pc-windows-msvc \
       "-I$GENINC" "-I$AWSLC/include" "-I$AWSLC/aws-lc/include" \
       "/FI$INC" -DBORINGSSL_IMPLEMENTATION=1 -DAWSLC=1 \
       -Wno-unused-command-line-argument -fuse-ld=lld-link \
       /imsvc "$XWIN/crt/include" /imsvc "$XWIN/sdk/include/ucrt" \
       -Od -W4 -DYNAMICBASE \
       -c "$ASM" -o /tmp/qt-diag-real-mix.o >/dev/null 2>/tmp/qt-diag-g.err; then
    echo "DIAG REAL_ASM_MIX OK"
  else
    echo "DIAG REAL_ASM_MIX FAIL"; grep -m3 -i 'error' /tmp/qt-diag-g.err
  fi
else
  echo "DIAG AWSLC_SRC_MISSING（$REG 下没有 aws-lc-sys-0.45.0 的 s2n-bignum 汇编，跳过）"
fi

echo "DIAG == 结束（诊断本身不影响构建） =="
exit 0

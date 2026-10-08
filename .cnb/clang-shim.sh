#!/bin/sh
# clang 垫片 —— 只在 Windows AArch64 交叉编译时通过 PATH 前置生效。
#
# 它同时以两个名字安装：/tmp/clang-shim/clang 与 /tmp/clang-shim/clang-cl。
# 两条路要做的事完全不同，所以按 $0 分组：
#
# ■ 被当 `clang` 调用  → GNU 驱动 + 方言翻译
#     ring 0.17.14 在 Windows AArch64 上会把 C 编译器强行换成 GNU 驱动 clang
#     （ring/build.rs:562-568 的 FIXME 分支条件是 !compiler.is_like_clang()，而 cc-rs
#     把 clang-cl 归入 Msvc 家族、is_like_clang() 恒为 false → 该分支恒触发）；
#     aws-lc-sys 的 s2n-bignum 汇编也走 clang。而 cargo-xwin 通过
#     CFLAGS_aarch64_pc_windows_msvc 送进来的仍是 clang-cl 风格的 `/imsvc <dir>`，
#     aws-lc-sys 还会发 `/FI<头文件>`（builder/cc_builder.rs:610）。
#     GNU 驱动不认这两个，把它们当输入文件 →
#       clang: error: no such file or directory: '/imsvc'
#       clang: error: no such file or directory: '/FI/…/boringssl_prefix_symbols_asm.h'
#     所以这一路把 `/imsvc`→`-isystem`、`/FI`→`-include` 后原样转发。
#
# ■ 被当 `clang-cl` 调用 → CL（MSVC 兼容）模式，只修 MSVC 拼法
#     aws-lc-sys 的 C 代码需要真正的 MSVC 语义：它按 `is_cl_like` 发 `-Od`（GNU 驱动会
#     解析成「-O 后跟值 d」→ error: invalid integral value 'd' in '-Od'）和 `-W4`
#     （→ warning: unknown warning option '-W4'）。但**不能**把这一路也改成 GNU 模式：
#     hrss.c 的 `typedef uint16x8_t vec_t`（hrss.c:178-223）在 GNU 模式下会落到 MSVC
#     风格的 `union __n128`，于是 `a + b`、`v[i]` 全部报
#       error: invalid operands to binary expression ('vec_t' (aka 'union __n128') …)
#       error: subscripted value is not an array, pointer, or vector
#     CL 模式下 clang 才把 `__n128` 当内建向量类型。所以这一路让真 clang 以
#     `--driver-mode=cl` 运行，只把 CL 模式会误解析的少数 dash 拼法归一成 cl 拼法：
#       -Od → /Od      -W[0-4] → /W<n>      -DYNAMICBASE → 丢弃
#     其余（/imsvc、/FI、-Os、-I、-D、-o、-c、--target=、-fuse-ld=lld-link、
#     -Wno-unused-command-line-argument）在 CL 模式下本来就是合法写法，原样转发。
#
# 真 clang 的路径由 QT_REAL_CLANG 给出 —— 垫片自己占了 clang / clang-cl 这两个名字，
# 不能再靠 `command -v clang` 找。
#
# `QT_SHIM_LOG` 非空时（只在探针开），先写一次环境快照（含 PATH 与 PATH 上所有
# clang-cl 候选的 ls -l，用来确认到底谁在被调用），之后每次调用追加**改写前**的 argv。
# 注意记的是改写前的 argv，不能用它判断改写是否生效。
REAL="${QT_REAL_CLANG:?clang-shim: 需要 QT_REAL_CLANG 指向真正的 clang}"
ME="${0##*/}"

if [ -n "${QT_SHIM_LOG:-}" ]; then
  if [ ! -s "$QT_SHIM_LOG" ]; then
    {
      echo "--- 首次调用时的环境 ---"
      env | grep -E '^(CC|CXX|CFLAGS|CXXFLAGS|AR|RANLIB|TARGET|CARGO_TARGET_DIR|XWIN|PATH)' || true
      echo "--- PATH 上的 clang-cl 候选（本垫片排在最前，下面是真实存在的）---"
      _oldifs=$IFS
      IFS=:
      for _d in $PATH; do
        if [ -n "$_d" ] && [ -x "$_d/clang-cl" ]; then
          ls -l "$_d/clang-cl" 2>/dev/null || true
        fi
      done
      IFS=$_oldifs
      echo "--- 之后的 argv（改写前；行首 cl=CL 模式、gcc=GNU 模式）---"
    } >>"$QT_SHIM_LOG" 2>/dev/null || true
  fi
fi

case "$ME" in
  clang-cl*)
    # ---- CL 模式 ----
    [ -n "${QT_SHIM_LOG:-}" ] && printf 'cl %s\n' "$*" >>"$QT_SHIM_LOG" 2>/dev/null
    n=$#; i=0
    while [ "$i" -lt "$n" ]; do
      a=$1; shift
      case "$a" in
        -Od|/Od)                set -- "$@" /Od ;;   # GNU 拼法不成立，换成 cl 拼法
        -W0|-W1|-W2|-W3|-W4)    set -- "$@" "/${a#-}" ;;
        -DYNAMICBASE|/DYNAMICBASE) ;;                # MSVC 链接期开关，编译不需要
        *)                      set -- "$@" "$a" ;;
      esac
      i=$((i+1))
    done
    exec "$REAL" --driver-mode=cl "$@"
    ;;
esac

# ---- 默认：GNU 模式 + clang-cl 方言翻译 ----
[ -n "${QT_SHIM_LOG:-}" ] && printf 'gcc %s\n' "$*" >>"$QT_SHIM_LOG" 2>/dev/null
n=$#; i=0
while [ "$i" -lt "$n" ]; do
  a=$1; shift
  case "$a" in
    # cargo-xwin / aws-lc-sys 注入的 clang-cl 风格包含路径
    /imsvc)  set -- "$@" -isystem ;;
    /imsvc*) set -- "$@" "-isystem${a#/imsvc}" ;;
    /FI)     set -- "$@" -include ;;
    /FI*)    set -- "$@" -include "${a#/FI}" ;;
    # MSVC 的优化/警告拼法：GNU 驱动会误解析，归一
    /Od|-Od) set -- "$@" -O0 ;;
    -W[0-4]|/W[0-4]|/Wall|/WX|/WX-|/wd[0-9]*|/Wv:*) ;;   # GNU 没有这些，丢弃
    -DYNAMICBASE|/DYNAMICBASE|/DYNAMICBASE:NO) ;;        # MSVC 链接期开关，丢弃
    /GS|/GS-|-GS|-GR|/GR|-GF|/GF|-Gy|/Gy|-Gw|/Gw) ;;     # MSVC 代码生成开关，丢弃
    /EHsc|/EHsc-|/EHa|/EHs) ;;                           # MSVC 异常开关，丢弃
    /MD|/MT|/MDd|/MTd|/LD|/LDd) ;;                       # MSVC CRT 选择，丢弃
    /Zi|/ZI|/Z7) ;;                                      # MSVC 调试信息，丢弃
    /nologo|/utf-8|/permissive-|/Zc:*) ;;
    /DEBUG|/DEBUG:FULL|/DEBUG:FASTLINK|/INCREMENTAL|/LTCG|/OPT:*|/SUBSYSTEM:*) ;;
    # 需要换写法的：MSVC 拼法 → GNU 拼法
    /c)       set -- "$@" -c ;;
    /Fo)      set -- "$@" -o ;;
    /Fo*)     set -- "$@" -o "${a#/Fo}" ;;
    /D*)      set -- "$@" "-D${a#/D}" ;;
    /I*)      set -- "$@" "-I${a#/I}" ;;
    /U*)      set -- "$@" "-U${a#/U}" ;;
    /std:c11)   set -- "$@" -std=c11 ;;
    /std:c17)   set -- "$@" -std=c17 ;;
    /std:c++14) set -- "$@" -std=c++14 ;;
    /std:c++17) set -- "$@" -std=c++17 ;;
    /std:c++20) set -- "$@" -std=c++20 ;;
    /Fd*|/Fp*|/Fa*|/Fe*|/Fm*|/sourceDependencies*) ;;    # 只写文件，GNU 无对应概念
    *) set -- "$@" "$a" ;;
  esac
  i=$((i+1))
done
exec "$REAL" "$@"

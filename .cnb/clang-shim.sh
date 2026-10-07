#!/bin/sh
# clang 垫片 —— 只在 Windows AArch64 交叉编译时通过 PATH 前置生效。
#
# 为什么需要
#   ring 0.17.14 在 Windows AArch64 上会把 C 编译器强行换成 GNU 驱动 clang：
#   ring-0.17.14/build.rs:562-568 那段 `// FIXME: On Windows AArch64 we currently
#   must use Clang to compile C code` 的条件是 `!compiler.is_like_clang()`，而
#   cc-rs 把 clang-cl 归入 Msvc 家族（cc-1.6.0/src/tool.rs:506-529：
#   is_like_clang() 只认 ToolFamily::Clang），于是这条分支恒被触发；
#   编译器从 clang-cl 换成 clang，但 cargo-xwin 通过
#   CFLAGS_aarch64_pc_windows_msvc 送进来的仍是 clang-cl 风格的 `/imsvc <dir>`。
#   GNU 驱动不认 `/imsvc`，把它当成输入文件：
#       clang: error: no such file or directory: '/imsvc'
#
#   aws-lc-sys 0.45.0 是同一类问题的另外两个实例（它按 clang-cl 方言发参数，
#   但真正执行的是 GNU 驱动）：
#     - builder/cc_builder.rs:610 发 `/FI<头文件>`：
#         clang: error: no such file or directory:
#           '/FI/.../generated-include/openssl/boringssl_prefix_symbols_asm.h'
#     - jitterentropy 分支发 MSVC 的优化/警告开关 `-Od -W4 -DYNAMICBASE`：
#         clang: error: invalid integral value 'd' in '-Od'
#       （GNU 驱动把 -Od 当成 `-O` 后面跟了值 "d"）
#
# 做什么
#   把 clang-cl 方言的参数翻译成 GNU 驱动能懂的写法，再逐字转发给真正的 clang：
#     /imsvc <dir> 和 /imsvc<dir>  →  -isystem <dir>
#     /FI <file>   和 /FI<file>    →  -include <file>
#     -Od /Od                      →  -O0        （/O1 /O2 /Ox 同理映射）
#     -W4 /W4 /WX /wd4996 …        →  丢弃（GNU 驱动没有对应开关）
#     -DYNAMICBASE /MD /MT /Zi …   →  丢弃（MSVC 专有，GNU 驱动会当成输入文件或报错）
#     /c → -c、/Fo<x> → -o <x>、/D<x> → -D<x>、/I<x> → -I<x>、/std:c11 → -std=c11
#   真 clang 的路径由 QT_REAL_CLANG 给出 —— 垫片自己占了 `clang` 这个名字，
#   不能再靠 `command -v clang` 找。这条命令行里其余参数（-Os、-I、-o、-c、
#   --target=、-D、-fuse-ld=lld-link、-Wno-unused-command-line-argument 等）
#   本来就是 GNU 兼容写法，原样转发。
#
#   `QT_SHIM_LOG` 非空时，把首次调用时的环境（CC/CXX/CFLAGS…）和每次调用的
#   改写前 argv 追加进该文件 —— 只在探针里开，用来确认「哪些编译真的走了
#   GNU 驱动」。注意记的是改写前的 argv，不能用它判断改写是否生效。
#
# 验证
#   本机 Git Bash 跑过真实 argv 形状（F:\qtMusic\_tmp\shimtest\run.sh）：
#   参数顺序、空参数保持、两种 /imsvc 写法、未设置 QT_REAL_CLANG 时的退出码，
#   全部符合预期。
REAL="${QT_REAL_CLANG:?clang-shim: 需要 QT_REAL_CLANG 指向真正的 clang}"

if [ -n "${QT_SHIM_LOG:-}" ]; then
  if [ ! -s "$QT_SHIM_LOG" ]; then
    {
      echo "--- 首次调用时编译器子进程看到的环境 ---"
      env | grep -E '^(CC|CXX|CFLAGS|CXXFLAGS|AR|RANLIB|TARGET|CARGO_TARGET_DIR|XWIN)' || true
      echo "--- 之后的 argv（改写前，每行一次调用） ---"
    } >>"$QT_SHIM_LOG" 2>/dev/null || true
  fi
  printf '%s\n' "$*" >>"$QT_SHIM_LOG" 2>/dev/null || true
fi

n=$#; i=0
while [ "$i" -lt "$n" ]; do
  a=$1; shift
  case "$a" in
    # ---- cargo-xwin / aws-lc-sys 注入的 clang-cl 风格包含路径 ----
    /imsvc)  set -- "$@" -isystem ;;
    /imsvc*) set -- "$@" "-isystem${a#/imsvc}" ;;
    /FI)     set -- "$@" -include ;;
    /FI*)    set -- "$@" -include "${a#/FI}" ;;

    # ---- 优化等级：MSVC 拼法 → GNU 拼法 ----
    /Od|-Od) set -- "$@" -O0 ;;
    /O1|-O1) set -- "$@" -O1 ;;
    /O2|-O2) set -- "$@" -O2 ;;
    /O3|-O3) set -- "$@" -O3 ;;
    /Ox|-Ox) set -- "$@" -O2 ;;
    /Ot|/Oy|/Oi|/Ob0|/Ob1|/Ob2|/Ob3) ;;   # 无对应开关，丢弃

    # ---- 警告等级与开关：GNU 驱动没有这些拼法，丢弃 ----
    -W[0-4]|/W[0-4]|/Wall|/WX|/WX-|/wd[0-9]*|/Wv:*) ;;

    # ---- MSVC 专有开关：丢弃（留着会被 GNU 驱动当成输入文件或直接报错） ----
    -DYNAMICBASE|/DYNAMICBASE|/DYNAMICBASE:NO) ;;
    -GS|/GS|/GS-|-GR|/GR|/GR-|-GF|/GF|-Gy|/Gy|-Gw|/Gw) ;;
    /EHsc|/EHsc-|/EHa|/EHs) ;;
    /MD|/MT|/MDd|/MTd|/LD|/LDd) ;;
    /Zi|/ZI|/Z7) ;;
    /nologo|/utf-8|/permissive-|/Zc:*) ;;
    /DEBUG|/DEBUG:FULL|/DEBUG:FASTLINK|/INCREMENTAL|/LTCG|/OPT:*|/SUBSYSTEM:*) ;;

    # ---- 需要换写法的：MSVC 拼法 → GNU 拼法 ----
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

    # ---- 只写文件、GNU 驱动无对应概念的输出开关：丢弃 ----
    /Fd*|/Fp*|/Fa*|/Fe*|/Fm*|/sourceDependencies*) ;;

    *) set -- "$@" "$a" ;;
  esac
  i=$((i+1))
done
exec "$REAL" "$@"

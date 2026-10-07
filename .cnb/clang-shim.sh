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
#   aws-lc-sys 0.45.0 的 aarch64 汇编是同一类问题的第二个实例：它按
#   clang-cl 方言发 `/FI<头文件>`（builder/cc_builder.rs:610），GNU 驱动照样
#   把它当文件名：
#       clang: error: no such file or directory: '/FI/.../boringssl_prefix_symbols_asm.h'
#
# 做什么
#   把 `/imsvc`（以及拼接式 `/imsvc<dir>`）改写成 GNU 驱动的 `-isystem`，
#   把 `/FI<path>` 改写成 `-include <path>`，其余参数逐字转发给真正的 clang。
#   真 clang 的路径由 QT_REAL_CLANG 给出 —— 垫片自己占了 `clang` 这个名字，
#   不能再靠 `command -v clang` 找。这条命令行里其余参数（-Os、-I、-o、-c、
#   --target=、-D、-fuse-ld=lld-link 等）本来就是 GNU 兼容写法。
#
#   `QT_SHIM_LOG` 非空时，把每次调用的原始 argv 追加进该文件 —— 只在探针里开，
#   用来确认「哪些编译真的走了 GNU 驱动」（例如 aws-lc-sys 的 *.S 汇编）。
#
# 验证
#   本机 Git Bash 跑过真实 argv 形状（F:\qtMusic\_tmp\shimtest\run.sh）：
#   参数顺序、空参数保持、两种 /imsvc 写法、未设置 QT_REAL_CLANG 时的退出码，
#   全部符合预期。
REAL="${QT_REAL_CLANG:?clang-shim: 需要 QT_REAL_CLANG 指向真正的 clang}"

if [ -n "${QT_SHIM_LOG:-}" ]; then
  if [ ! -s "$QT_SHIM_LOG" ]; then
    echo "--- 首次调用时编译器子进程看到的环境 ---" >>"$QT_SHIM_LOG" 2>/dev/null || true
    env | grep -E '^(CC|CXX|CFLAGS|CXXFLAGS|AR|RANLIB|TARGET|CARGO_TARGET_DIR|XWIN)' >>"$QT_SHIM_LOG" 2>/dev/null || true
    echo "--- 之后的 argv ---" >>"$QT_SHIM_LOG" 2>/dev/null || true
  fi
  printf '%s\n' "$*" >>"$QT_SHIM_LOG" 2>/dev/null || true
fi

n=$#; i=0
while [ "$i" -lt "$n" ]; do
  a=$1; shift
  case "$a" in
    /imsvc)  set -- "$@" -isystem ;;
    /imsvc*) set -- "$@" "-isystem${a#/imsvc}" ;;
    /FI)     set -- "$@" -include ;;
    /FI*)    set -- "$@" -include "${a#/FI}" ;;
    *)       set -- "$@" "$a" ;;
  esac
  i=$((i+1))
done
exec "$REAL" "$@"

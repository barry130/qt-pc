#!/bin/sh
# clang 垫片 —— 只在 Windows AArch64 交叉编译时通过 PATH 前置生效。
#
# 为什么需要
#   ring 0.17.14 在 Windows AArch64 上会把 C 编译器强行换成 GNU 驱动 clang：
#   ring-0.17.14/build.rs:562-568 那段 `// FIXME: On Windows AArch64 we currently
#   must use Clang to compile C code` 的条件是 `!compiler.is_like_clang()`，而
#   cc-rs 把 clang-cl 归入 Msvc 家族（cc-1.6.0/src/tool.rs:506-529，
#   is_like_clang() 只认 ToolFamily::Clang），于是这条分支恒被触发：
#   编译器从 clang-cl 换成 clang，但 cargo-xwin 通过
#   CFLAGS_aarch64_pc_windows_msvc 送进来的仍是 clang-cl 风格的 `/imsvc <dir>`。
#   GNU 驱动不认识 `/imsvc`，把它当成输入文件：
#       clang: error: no such file or directory: '/imsvc'
#
# 做什么
#   把 `/imsvc`（以及拼接式 `/imsvc<dir>`）改写成 GNU 驱动的 `-isystem`
#   （`/imsvc` 与 `-isystem` 都是「加入系统头文件搜索路径」，语义一致），
#   其余参数逐字转发给真正的 clang —— 真 clang 的路径由 QT_REAL_CLANG 给出，
#   因为垫片自己就占用了 `clang` 这个名字，不能再用 `command -v clang` 找。
#   这条命令行里其余参数（`-Os -ffunction-sections -fdata-sections --target=
#   -I <dir> -fvisibility=hidden -std=c1x -g3 -DNDEBUG
#   -Wno-unused-command-line-argument -fuse-ld=lld-link -o -c`）本来就是 GNU 兼容写法。
#
# 验证
#   本机 Git Bash 跑过真实 argv 形状（F:\qtMusic\_tmp\shimtest\run.sh）：
#   参数顺序、空参数保持、两种 /imsvc 写法、未设置 QT_REAL_CLANG 时报错，全部符合预期。

REAL="${QT_REAL_CLANG:?clang-shim: 需要 QT_REAL_CLANG 指向真正的 clang}"
n=$#; i=0
while [ "$i" -lt "$n" ]; do
  a=$1; shift
  case "$a" in
    /imsvc)  set -- "$@" -isystem ;;
    /imsvc*) set -- "$@" "-isystem${a#/imsvc}" ;;
    *)       set -- "$@" "$a" ;;
  esac
  i=$((i+1))
done
exec "$REAL" "$@"

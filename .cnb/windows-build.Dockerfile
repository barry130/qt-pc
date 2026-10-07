# 轻听桌面端 —— Windows 交叉编译镜像（Linux 宿主 -> Windows MSVC 三架构）
#
# CNB 的托管构建节点只有 Linux，没有 Windows；要在 CNB 上出 .exe 安装包，
# 必须走 Tauri 官方的 Linux 交叉编译路线：cargo-xwin 调 clang-cl 生成 MSVC ABI 的
# PE 可执行文件，再用系统 makensis 打 NSIS 安装包。
#
# 这个镜像把所有一次性依赖烘进来，避免每个流水线都要重装。CNB 会把 docker.build
# 的产物推到项目制品库并按版本哈希复用。
#
# 基线镜像 messense/cargo-xwin:0.23.1 = debian trixie + rust 1.89.0 + clang/llvm
# + cargo-xwin + winehq + cmake + ninja，并且已经装好 rust-std for
# x86_64-pc-windows-msvc 与 aarch64-pc-windows-msvc（但**没有** i686，见下）。
# 缺的是：Node.js / npm / pnpm / makensis。下面补齐。

FROM messense/cargo-xwin:0.23.1

# --- Node 22 + pnpm：前端（vite / tsc / @tauri-apps/cli）需要 ---
# 基线镜像里完全没有 node/npm/pnpm。用同为 debian trixie 的官方 node 镜像，
# glibc 与基线一致，直接拷 /usr/local（只落 bin/lib/include，不会碰到
# /usr/local/rustup 与 /usr/local/cargo）。
COPY --from=node:22-trixie-slim /usr/local/bin /usr/local/bin
COPY --from=node:22-trixie-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=node:22-trixie-slim /usr/local/include/node /usr/local/include/node
RUN node -v && npm -v && npm install -g pnpm@11.7.0 && pnpm --version

# --- NSIS：必须是「完整」发行版 ---
# Tauri 在非 Windows 上只会去 PATH 找 makensis，不会自己下载 NSIS 工具链
# （tauri-bundler 里 get_and_extract_nsis 整块被 #[cfg(target_os = "windows")] 编译掉），
# 且它只校验 Plugins/x86-unicode/additional/nsis_tauri_utils.dll 一项，
# 缺 Stubs/Plugins 它查不出来 —— 所以这里必须装到完整的数据文件。
# Debian 把 makensis 二进制放在 nsis、把 /usr/share/nsis 下的 Stubs/Plugins/Include
# 放在 nsis-common，两个都显式装上（Ubuntu 通常 nsis 会依赖 nsis-common，Debian 这里不赌）。
# Fedora 的 mingw64-nsis 是不完整的，不要用。
RUN apt-get update \
 && apt-get install -y --no-install-recommends nsis nsis-common \
 && rm -rf /var/lib/apt/lists/* \
 && makensis -VERSION \
 && ls /usr/share/nsis/Stubs | head -5 \
 && ls /usr/share/nsis/Plugins/x86-unicode | head -5

# --- Rust 工具链：对齐 GitHub 侧的 stable，并补齐三个 Windows 目标 ---
# tauri-cli 会先用 `rustup target list` 校验 --target，缺了会直接报
# "Target ... is not installed ... run `rustup target add`"。
# llvm-tools-preview 必须装：cargo-xwin 用的 lld-link / llvm-lib 是它从 rustc
# 自带的 LLVM 里符号链接出来的（它自己不提供链接器）。
# 若某个依赖抱怨 rustc 版本太低，改这里的 rustup 版本即可。
RUN rustup update stable \
 && rustup default stable \
 && rustup component add llvm-tools-preview \
 && rustup target add x86_64-pc-windows-msvc i686-pc-windows-msvc aarch64-pc-windows-msvc \
 && rustc --version && rustup target list --installed

# --- 预热 Tauri 的 NSIS 插件缓存 ---
# tauri-bundler 无论宿主平台都会去 GitHub 下 nsis_tauri_utils.dll 放到
# <cache_dir>/tauri/NSIS/Plugins/x86-unicode/additional/（cache_dir = /root/.cache）。
# 提前放好可以省一次外网请求；下载失败也不阻断镜像构建（真正的构建阶段还会再试一次）。
RUN mkdir -p /root/.cache/tauri/NSIS/Plugins/x86-unicode/additional \
 && (curl -fsSL --retry 3 -o /root/.cache/tauri/NSIS/Plugins/x86-unicode/additional/nsis_tauri_utils.dll \
        https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll \
      && echo "nsis_tauri_utils.dll 预热完成") \
     || echo "警告：nsis_tauri_utils.dll 预热失败，构建阶段会自行下载"

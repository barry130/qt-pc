// release 下不分配控制台窗口（GUI 程序标准做法）；
// dev 保留控制台，日志直接打在终端里方便排查
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    lightlisten_lib::run()
}

// 防止 Windows Release 构建时弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    api_key_manager_lib::run()
}

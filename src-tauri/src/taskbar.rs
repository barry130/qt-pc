//! Windows 任务栏缩略图工具栏（ITaskbarList3::ThumbBarAddButtons）。
//!
//! 鼠标悬停任务栏图标时，在缩略图预览下方显示「上一首 / 播放·暂停 / 下一首」三个按钮，
//! 与网易云音乐等播放器的交互一致（DESIGN §14 桌面集成的延伸）。
//!
//! 几个关键点：
//! - 按钮点击以 `WM_COMMAND`（`THBN_CLICKED`）发到窗口，Tauri/tao 没有暴露消息钩子，
//!   所以这里用 `SetWindowLongPtrW(GWLP_WNDPROC)` 换掉窗口过程，非本模块的消息原样
//!   透传给原过程（`CallWindowProcW`），不影响 tao 自身的处理。
//! - 动作直接复用 `media::dispatch_media_action`，与托盘菜单、全局快捷键、SMTC 同一条路径，
//!   主窗口隐藏时同样可用。
//! - 图标不引入资源文件，用 GDI 现场光栅化（32bpp DIB + 全零掩码 → CreateIconIndirect）；
//!   颜色跟随系统主题（浅色主题画深色图标，深色主题画白色图标）。
//! - 非 Windows 平台整体降级为空实现，调用方无需分支。
//!
//! **挂载时机由 `TaskbarButtonCreated` 驱动**（2026-10-13 修复「三个按钮经常不显示」）。
//! 官方文档（Taskbar Extensions / ThumbBarAddButtons）规定：任务栏按钮由 shell 创建，
//! 建好之后它会向窗口发一条 `RegisterWindowMessageW(L"TaskbarButtonCreated")` 注册消息，
//! **必须先收到这条消息，才能调用任何 ITaskbarList3 方法**。而且 shell 每次**重建**任务栏
//! 按钮都会重发它 —— 主窗口 hide→show（点关闭收进托盘、再从托盘打开）就会走一遍重建，
//! 旧按钮上的缩略图工具栏随旧按钮一起消失。早先的实现只挂一次、也不认这条消息，
//! 所以「关掉主窗口再打开，三个按钮就没了」；启动时那次「等窗口可见再睡 300ms」的盲等
//! 撞不上 shell 就绪窗口时同样会静默失败（shell 返回成功但按钮不渲染）。
//!
//! 「hide→show 会重发」已在本机实测确认（独立探针窗口，ShowWindow(SW_HIDE) 后再
//! SW_SHOW，累计收到 3 条 TaskbarButtonCreated）—— 不是照文档推断的。

#[cfg(target_os = "windows")]
mod imp {
    use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;

    use tauri::{AppHandle, Manager};
    use windows::core::{w, Interface};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::Graphics::Gdi::{
        CreateBitmap, CreateDIBSection, DeleteObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        DIB_RGB_COLORS, HGDIOBJ,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::Shell::{
        ITaskbarList, ITaskbarList3, TaskbarList, THBF_ENABLED, THBN_CLICKED, THB_FLAGS, THB_ICON,
        THB_TOOLTIP, THUMBBUTTON, THUMBBUTTONMASK,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallWindowProcW, CreateIconIndirect, DefWindowProcW, IsWindowVisible,
        RegisterWindowMessageW, SetWindowLongPtrW, GWLP_WNDPROC, HICON, ICONINFO, WM_COMMAND,
    };

    use crate::media::{dispatch_media_action, MediaAction};

    /// 三个按钮的 ID。取值刻意避开低位小区间，防止与 tao 的菜单命令 ID 相撞。
    const BTN_PREV: u32 = 0x7A01;
    const BTN_PLAY: u32 = 0x7A02;
    const BTN_NEXT: u32 = 0x7A03;

    /// 图标句柄（HICON 是裸指针，存成 isize 才能放进 static）
    #[derive(Clone, Copy)]
    struct Icons {
        prev: isize,
        play: isize,
        pause: isize,
        next: isize,
        /// 光栅化时的像素边长与系统主题，仅用于日志
        size: i32,
        light: bool,
    }

    struct Inner {
        hwnd: isize,
        icons: Icons,
    }

    /// 已安装的任务栏集成状态；None = 未启用（非 Windows 已在模块外降级 / 初始化失败）
    static STATE: Mutex<Option<Inner>> = Mutex::new(None);
    /// 原窗口过程。窗口过程对**每条**窗口消息都会被调用（鼠标移动、重绘…），
    /// 所以这里用原子量而不是去锁 STATE，避免热路径加锁。
    static OLD_PROC: AtomicIsize = AtomicIsize::new(0);
    /// 按钮点击回调需要 AppHandle（窗口过程是自由函数，拿不到闭包捕获）
    static APP: OnceLock<AppHandle> = OnceLock::new();
    /// 上次同步的「是否正在播放」：publish 会被进度更新高频调用，
    /// 只有播放↔暂停翻转才需要动任务栏按钮
    static LAST_PLAYING: AtomicBool = AtomicBool::new(false);
    /// shell 的 `TaskbarButtonCreated` 注册消息 ID（0 = 还没注册成功）
    static TASKBAR_CREATED_MSG: AtomicU32 = AtomicU32::new(0);
    /// 收到 `TaskbarButtonCreated` 的次数。窗口过程可能比窗口首次显示晚一拍装好，
    /// 那样 shell 那条消息就永远错过了；兜底补挂前先用它判断要不要补。
    static CREATED_COUNT: AtomicU32 = AtomicU32::new(0);
    /// 防重入：on_button_created 是在窗口过程里跑的，ThumbBarAddButtons 期间 shell
    /// 若再往窗口投消息就会递归进来。只允许一层。
    static IN_CREATE: AtomicBool = AtomicBool::new(false);

    /// 安装任务栏缩略图工具栏。失败只返回 Err 由调用方记日志，绝不影响主流程。
    ///
    /// 关键时序（2026-10-13 修复「三个按钮经常不显示」）：
    /// 1. `init` 在 `setup` 里跑，**早于** `lib.rs` 末尾那次 `win.show()`。正好赶在窗口
    ///    首次显示前把窗口过程换好，这样 shell 建好任务栏按钮后发出的 `TaskbarButtonCreated`
    ///    不会漏收。
    /// 2. 真正调 `ThumbBarAddButtons` 的时机交给那条消息（见 `wnd_proc` / `on_button_created`）。
    ///    官方要求「必须先收到这条消息，才能调用任何 ITaskbarList3 方法」，早调会被 shell
    ///    静默丢弃（返回 S_OK 但按钮不渲染）。shell 每次重建任务栏按钮都会重发它，
    ///    所以主窗口 hide→show 后也能自动补挂。
    /// 3. 窗口过程万一装晚了就收不到首次那条消息，这里留一条兜底：等窗口可见后主动挂一次。
    pub fn init(app: &AppHandle) -> Result<(), String> {
        let raw = app
            .get_webview_window("main")
            .and_then(|w| w.hwnd().ok())
            .map(|h| h.0 as isize)
            .ok_or_else(|| "取不到主窗口句柄".to_string())?;

        // 按钮点击回调需要 AppHandle（窗口过程是自由函数，拿不到闭包捕获）
        let _ = APP.set(app.clone());

        // 消息 ID 必须先注册好：窗口过程要靠它认人
        let msg = unsafe { RegisterWindowMessageW(w!("TaskbarButtonCreated")) };
        if msg == 0 {
            log::warn!("[taskbar] 注册 TaskbarButtonCreated 失败，改用兜底挂载");
        }
        TASKBAR_CREATED_MSG.store(msg, Ordering::Release);

        // 关键：这里是 setup，主线程，且**早于** lib.rs 末尾那次 win.show()。
        // 同步装好窗口过程（而不是 run_on_main_thread 排队 —— 排队要等 setup 返回，
        // 那时窗口已经显示、shell 的消息已经发过了），首次显示的那条
        // TaskbarButtonCreated 才不会漏。
        unsafe { install_hook(raw) };

        let app2 = app.clone();
        let spawned = std::thread::Builder::new()
            .name("taskbar".into())
            .spawn(move || {
                // 兜底：窗口过程万一没赶上首次显示（或注册消息拿不到），
                // 等窗口可见后主动挂一次，避免「就是没有按钮」。
                let hwnd = HWND(raw as *mut core::ffi::c_void);
                let mut visible = false;
                for _ in 0..100 {
                    if unsafe { IsWindowVisible(hwnd).as_bool() } {
                        visible = true;
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                if !visible {
                    log::warn!("[taskbar] 窗口 10s 内未显示，缩略图工具栏未挂载");
                    return;
                }
                // shell 已经发过 TaskbarButtonCreated 就别重复挂（会多一次无用调用）
                if CREATED_COUNT.load(Ordering::Acquire) > 0 {
                    return;
                }
                // 窗口可见 ≠ 任务栏按钮已注册，留一拍给 shell
                std::thread::sleep(Duration::from_millis(300));
                if CREATED_COUNT.load(Ordering::Acquire) > 0 {
                    return;
                }
                log::info!("[taskbar] 未收到 TaskbarButtonCreated，改用兜底挂载");
                let _ = app2.run_on_main_thread(|| unsafe { on_button_created() });
            });
        if spawned.is_err() {
            return Err(format!("等待线程创建失败: {:?}", spawned.err()));
        }
        Ok(())
    }

    /// 换掉窗口过程、备好图标（须在主线程、且尽量在窗口首次显示前调用）。
    /// 幂等：重复调用直接返回。
    unsafe fn install_hook(hwnd_raw: isize) {
        if STATE.lock().map(|g| g.is_some()).unwrap_or(false) {
            return;
        }
        let hwnd = HWND(hwnd_raw as *mut core::ffi::c_void);

        // tao 通常已为主线程初始化过 COM，重复初始化返回 RPC_E_CHANGED_MODE 属正常
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        // 缩略图预览底色跟随系统主题，图标颜色要反着来才看得见
        let light = system_uses_light_theme();
        let (r, g, b) = if light {
            (0x1F, 0x1F, 0x1F)
        } else {
            (0xFF, 0xFF, 0xFF)
        };
        let dpi = {
            let d = GetDpiForWindow(hwnd);
            if d == 0 {
                96
            } else {
                d
            }
        };
        // 缩略图工具栏图标基准 16px，按 DPI 放大渲染，避免被系统拉伸糊掉
        let size = ((16 * dpi as i32) / 96).max(16);

        let icons = Icons {
            prev: make_icon(Glyph::Prev, size, r, g, b).0 as isize,
            play: make_icon(Glyph::Play, size, r, g, b).0 as isize,
            pause: make_icon(Glyph::Pause, size, r, g, b).0 as isize,
            next: make_icon(Glyph::Next, size, r, g, b).0 as isize,
            size,
            light,
        };

        // 换窗口过程：按钮点击（WM_COMMAND）和 shell 的 TaskbarButtonCreated 都靠它。
        // 原过程要透传（鼠标移动、重绘…），所以必须先存下来。
        let proc_ptr: unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT = wnd_proc;
        // 同 lyric_window.rs：32 位下该函数是 SetWindowLongW 的 re-export，入参 i32、
        // 返回 i32。入参用 `as _` 自适应宽度；返回值显式 `as isize` 归一化回
        // OLD_PROC: AtomicIsize 与后面 transmute::<isize, _> 需要的类型。
        let old = SetWindowLongPtrW(hwnd, GWLP_WNDPROC, proc_ptr as usize as _) as isize;
        if old == 0 {
            // 不敢 return：STATE 仍要置位，兜底路径靠它拿 hwnd / icons 挂按钮
            log::warn!("[taskbar] 窗口过程替换失败，缩略图按钮点击不会生效");
        }
        OLD_PROC.store(old, Ordering::Release);

        if let Ok(mut guard) = STATE.lock() {
            *guard = Some(Inner {
                hwnd: hwnd_raw,
                icons,
            });
        }

        log::info!(
            "[taskbar] 窗口过程已接管（图标 {size}px、{}主题），等待 shell 的 TaskbarButtonCreated",
            if light { "浅色" } else { "深色" }
        );
    }

    /// 把三个按钮挂到当前任务栏按钮上（须在收到 `TaskbarButtonCreated` 之后调用）。
    /// shell 每次重建任务栏按钮都会重发该消息，这里也就跟着重新挂一遍。
    unsafe fn on_button_created() {
        // 只允许一层：本函数在窗口过程里被调用，COM 调用期间 shell 可能再投消息进来
        if IN_CREATE.swap(true, Ordering::AcqRel) {
            return;
        }
        // 下面有多条提前 return 的分支，靠 RAII 复位，免得漏掉某条把标志永久卡住
        let _guard = CreateGuard;

        let Some((hwnd_raw, icons)) = STATE
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|i| (i.hwnd, i.icons)))
        else {
            return;
        };
        let hwnd = HWND(hwnd_raw as *mut core::ffi::c_void);

        // 初始播放/暂停图标按真实状态画（启动即恢复播放时 publish 已把 LAST_PLAYING 置真）
        let playing = LAST_PLAYING.load(Ordering::Relaxed);
        let buttons = [
            thumb_button(BTN_PREV, icons.prev, "上一首"),
            thumb_button(BTN_PLAY, play_icon(icons, playing), "播放 / 暂停"),
            thumb_button(BTN_NEXT, icons.next, "下一首"),
        ];

        let Ok(taskbar) =
            CoCreateInstance::<_, ITaskbarList3>(&TaskbarList, None, CLSCTX_INPROC_SERVER)
        else {
            log::warn!("[taskbar] 创建任务栏对象失败");
            return;
        };
        // HrInit 定义在基接口上，windows-rs 不会自动继承，先 cast
        let Ok(base) = taskbar.cast::<ITaskbarList>() else {
            log::warn!("[taskbar] 获取 ITaskbarList 失败");
            return;
        };
        if let Err(e) = base.HrInit() {
            log::warn!("[taskbar] 任务栏初始化失败: {e}");
            return;
        }
        if let Err(e) = taskbar.ThumbBarAddButtons(hwnd, &buttons) {
            log::warn!("[taskbar] 添加缩略图按钮失败: {e}");
            return;
        }

        log::info!(
            "[taskbar] 任务栏缩略图工具栏已启用（上一首 / 播放暂停 / 下一首），图标 {}px、{}主题",
            icons.size,
            if icons.light { "浅色" } else { "深色" }
        );
    }

    /// 防重入标志的 RAII 守卫：on_button_created 提前返回也不漏复位
    struct CreateGuard;

    impl Drop for CreateGuard {
        fn drop(&mut self) {
            IN_CREATE.store(false, Ordering::Release);
        }
    }

    /// 播放状态同步：只在「播放 ↔ 暂停」翻转时更新按钮图标。
    /// 从音频引擎线程调用，实际动 COM 的活儿扔回主线程做。
    pub fn sync(playing: bool) {
        if LAST_PLAYING.swap(playing, Ordering::Relaxed) == playing {
            return;
        }
        // 还没收到过 TaskbarButtonCreated，按钮尚不存在：此刻调 ThumbBarUpdateButtons
        // 会被 shell 丢掉。不要紧 —— LAST_PLAYING 已经更新，首次挂载时 on_button_created
        // 会按它画出正确的初始图标。
        if CREATED_COUNT.load(Ordering::Acquire) == 0 {
            return;
        }
        let Some(app) = APP.get().cloned() else {
            return;
        };
        let _ = app.run_on_main_thread(move || unsafe {
            if let Some((taskbar, hwnd, icons)) = attach() {
                set_play_button(&taskbar, hwnd, icons, playing);
            }
        });
    }

    /// 取当前窗口的任务栏对象（须在主线程调用）。
    /// 每次现建 COM 对象：ITaskbarList3 是进程内轻量对象，比跨线程长期持有
    /// 一个 !Send 的接口省心得多。
    unsafe fn attach() -> Option<(ITaskbarList3, HWND, Icons)> {
        let (hwnd_raw, icons) = STATE
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|i| (i.hwnd, i.icons)))?;
        let taskbar: ITaskbarList3 =
            CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER).ok()?;
        // HrInit 定义在基接口上，windows-rs 不会自动继承，先 cast
        let base: ITaskbarList = taskbar.cast().ok()?;
        base.HrInit().ok()?;
        Some((taskbar, HWND(hwnd_raw as *mut core::ffi::c_void), icons))
    }

    /// 按钮语义是「点下去会发生什么」：正在播 → 显示暂停图标
    fn play_icon(icons: Icons, playing: bool) -> isize {
        if playing {
            icons.pause
        } else {
            icons.play
        }
    }

    /// 把播放/暂停按钮换成对应图标
    unsafe fn set_play_button(taskbar: &ITaskbarList3, hwnd: HWND, icons: Icons, playing: bool) {
        let btn = thumb_button(BTN_PLAY, play_icon(icons, playing), "播放 / 暂停");
        if let Err(e) = taskbar.ThumbBarUpdateButtons(hwnd, &[btn]) {
            log::warn!("[taskbar] 更新播放按钮失败: {e}");
        }
    }

    /// 组装一个缩略图工具栏按钮（图标 + 悬停提示 + 启用态）
    fn thumb_button(id: u32, icon: isize, tip: &str) -> THUMBBUTTON {
        let mut btn = THUMBBUTTON::default();
        // 位标志类型没实现 BitOr，按底层值合并
        btn.dwMask = THUMBBUTTONMASK(THB_ICON.0 | THB_TOOLTIP.0 | THB_FLAGS.0);
        btn.iId = id;
        btn.hIcon = HICON(icon as *mut core::ffi::c_void);
        btn.dwFlags = THBF_ENABLED;
        let wide: Vec<u16> = tip.encode_utf16().take(btn.szTip.len() - 1).collect();
        btn.szTip[..wide.len()].copy_from_slice(&wide);
        btn
    }

    /// 替换后的窗口过程：认 shell 的 `TaskbarButtonCreated` 和自家按钮点击，其余原样透传
    unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        // shell 建好（或重建）任务栏按钮后发这条注册消息，这才是挂按钮的唯一正确时机。
        // 主窗口 hide→show（关闭收进托盘再打开）会走一遍重建，于是自动补挂。
        let created = TASKBAR_CREATED_MSG.load(Ordering::Acquire);
        if created != 0 && msg == created {
            CREATED_COUNT.fetch_add(1, Ordering::AcqRel);
            on_button_created();
            // 不 return：继续透传给原过程，tao / tray-icon 也要收这条消息
        } else if msg == WM_COMMAND {
            let id = (wparam.0 & 0xFFFF) as u32;
            let code = ((wparam.0 >> 16) & 0xFFFF) as u32;
            if code == THBN_CLICKED && matches!(id, BTN_PREV | BTN_PLAY | BTN_NEXT) {
                if let Some(app) = APP.get() {
                    let action = match id {
                        BTN_PREV => MediaAction::Previous,
                        BTN_NEXT => MediaAction::Next,
                        _ => MediaAction::PlayPause,
                    };
                    dispatch_media_action(app, action);
                }
                // 自己消费掉：不让它继续传给 tao，避免被当成菜单命令处理
                return LRESULT(0);
            }
        }

        let old = OLD_PROC.load(Ordering::Acquire);
        if old == 0 {
            // 没能拿到原过程（理论上只在替换失败时发生）：交给系统默认处理，
            // 比返回 0 安全 —— 无边框窗口的命中测试靠 WM_NCCALCSIZE / WM_NCHITTEST。
            return DefWindowProcW(hwnd, msg, wparam, lparam);
        }
        let prev: Option<unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT> =
            Some(core::mem::transmute::<
                isize,
                unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT,
            >(old));
        CallWindowProcW(prev, hwnd, msg, wparam, lparam)
    }

    /// 系统是否为浅色主题（任务栏缩略图底色跟着它走）
    fn system_uses_light_theme() -> bool {
        let mut value: u32 = 1;
        let mut cb = core::mem::size_of::<u32>() as u32;
        let rc = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                w!("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"),
                w!("AppsUseLightTheme"),
                RRF_RT_REG_DWORD,
                None,
                Some(&mut value as *mut u32 as *mut core::ffi::c_void),
                Some(&mut cb),
            )
        };
        // 读不到就按浅色处理（Win11 默认浅色任务栏）
        rc.is_ok() && value != 0
    }

    /// 图标形状
    #[derive(Clone, Copy, Debug)]
    enum Glyph {
        Prev,
        Play,
        Pause,
        Next,
    }

    /// 用 GDI 现场画一个图标：32bpp 自上而下 DIB + 全零单色掩码 → CreateIconIndirect。
    /// 不依赖任何图标资源文件，颜色/尺寸都能按主题与 DPI 现算。
    unsafe fn make_icon(glyph: Glyph, size: i32, r: u8, g: u8, b: u8) -> HICON {
        let mut bi = BITMAPINFO::default();
        bi.bmiHeader.biSize = core::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bi.bmiHeader.biWidth = size;
        // 负高度 = 自上而下，省得写完还要翻行
        bi.bmiHeader.biHeight = -size;
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32;
        bi.bmiHeader.biCompression = BI_RGB.0 as u32;

        let mut bits: *mut core::ffi::c_void = core::ptr::null_mut();
        let Ok(color) = CreateDIBSection(None, &bi, DIB_RGB_COLORS, &mut bits, None, 0) else {
            log::warn!("[taskbar] 图标位图创建失败（{glyph:?}）");
            return HICON(core::ptr::null_mut());
        };
        if bits.is_null() {
            log::warn!("[taskbar] 图标像素缓冲为空（{glyph:?}）");
            let _ = DeleteObject(HGDIOBJ(color.0));
            return HICON(core::ptr::null_mut());
        }

        // 光栅化：每像素 2×2 超采样，边缘不至于全是硬锯齿
        let px = bits as *mut u8;
        let n = (size * size) as usize;
        let inv = 1.0 / size as f32;
        for i in 0..n {
            let x = (i % size as usize) as f32;
            let y = (i / size as usize) as f32;
            let mut hits = 0u32;
            for j in 0..2 {
                for k in 0..2 {
                    let u = (x + (k as f32 + 0.5) * 0.5) * inv;
                    let v = (y + (j as f32 + 0.5) * 0.5) * inv;
                    if inside(glyph, u, v) {
                        hits += 1;
                    }
                }
            }
            let a = (hits * 255 / 4) as u8;
            // BGRA，直通 alpha（CreateIconIndirect 用彩色位图的 alpha 通道）
            *px.add(i * 4) = b;
            *px.add(i * 4 + 1) = g;
            *px.add(i * 4 + 2) = r;
            *px.add(i * 4 + 3) = a;
        }

        // 单色掩码全 0 = 一律使用彩色位图（现代 Windows 只看 alpha）
        let mask = CreateBitmap(size, size, 1, 1, None);
        let info = ICONINFO {
            fIcon: true.into(),
            xHotspot: 0,
            yHotspot: 0,
            hbmMask: mask,
            hbmColor: color,
        };
        let icon = match CreateIconIndirect(&info) {
            Ok(h) => h,
            Err(e) => {
                log::warn!("[taskbar] 图标创建失败（{glyph:?}）: {e}");
                HICON(core::ptr::null_mut())
            }
        };
        let _ = DeleteObject(HGDIOBJ(color.0));
        let _ = DeleteObject(HGDIOBJ(mask.0));
        icon
    }

    /// 归一化坐标 (u, v) ∈ [0,1]² 是否落在图形内
    fn inside(glyph: Glyph, u: f32, v: f32) -> bool {
        match glyph {
            Glyph::Play => tri(u, v, (0.30, 0.16), (0.30, 0.84), (0.80, 0.50)),
            Glyph::Pause => bar(u, v, 0.32, 0.44) || bar(u, v, 0.56, 0.68),
            Glyph::Prev => {
                bar(u, v, 0.22, 0.34) || tri(u, v, (0.80, 0.16), (0.80, 0.84), (0.34, 0.50))
            }
            Glyph::Next => {
                tri(u, v, (0.20, 0.16), (0.20, 0.84), (0.66, 0.50)) || bar(u, v, 0.66, 0.78)
            }
        }
    }

    /// 竖条（上一首/下一首的「停靠杆」、暂停的两根杆）
    fn bar(u: f32, v: f32, x0: f32, x1: f32) -> bool {
        (x0..=x1).contains(&u) && (0.18..=0.82).contains(&v)
    }

    /// 三角形（重心法：三个叉积同号即在内部）
    fn tri(u: f32, v: f32, a: (f32, f32), b: (f32, f32), c: (f32, f32)) -> bool {
        let cross =
            |p: (f32, f32), q: (f32, f32)| (u - q.0) * (p.1 - q.1) - (p.0 - q.0) * (v - q.1);
        let (d1, d2, d3) = (cross(a, b), cross(b, c), cross(c, a));
        let has_neg = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
        let has_pos = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
        !(has_neg && has_pos)
    }
}

#[cfg(target_os = "windows")]
pub use imp::{init, sync};

/// 非 Windows：整体空实现，调用方无分支
#[cfg(not(target_os = "windows"))]
pub fn init(_app: &tauri::AppHandle) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn sync(_playing: bool) {}

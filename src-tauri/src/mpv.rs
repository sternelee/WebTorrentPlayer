use std::ffi::CString;
use std::sync::Arc;
use std::time::Duration;

use libmpv2::events::{Event, EventContext, PropertyData};
use libmpv2::mpv_node::MpvNode;
use libmpv2::{Format, Mpv, MpvInitializer};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tauri::Manager;
use tokio::sync::Mutex;

#[derive(Debug, Serialize, Deserialize)]
pub struct MpvProbe {
    pub available: bool,
    pub binary: Option<String>,
    pub version: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvStartArgs {
    pub url: String,
    pub start_at_sec: Option<f64>,
    pub subtitles: Option<Vec<MpvSub>>,
    pub embed: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvGeometry {
    pub screen_x: i32,
    pub screen_y: i32,
    pub w: u32,
    pub h: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MpvSub {
    pub url: String,
    pub lang: Option<String>,
}

pub struct MpvState {
    inner: Arc<Mutex<Option<MpvSession>>>,
}

struct MpvSession {
    mpv: Arc<Mpv>,
    #[cfg(any(windows, target_os = "linux"))]
    embedded: bool,
}

impl MpvState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
        }
    }
}

const OBSERVED_PROPS: &[(&str, u64, PropertyKind)] = &[
    ("time-pos", 1, PropertyKind::Double),
    ("duration", 2, PropertyKind::Double),
    ("pause", 3, PropertyKind::Flag),
    ("eof-reached", 4, PropertyKind::Flag),
    ("track-list", 5, PropertyKind::Node),
    ("volume", 6, PropertyKind::Double),
    ("mute", 7, PropertyKind::Flag),
    ("chapter-list", 8, PropertyKind::Node),
    ("sub-delay", 9, PropertyKind::Double),
    ("audio-delay", 10, PropertyKind::Double),
    ("sub-text", 11, PropertyKind::String),
];

#[derive(Clone, Copy)]
enum PropertyKind {
    Double,
    Flag,
    Int64,
    String,
    Node,
}

impl PropertyKind {
    fn fmt(&self) -> Format {
        match self {
            PropertyKind::Double => Format::Double,
            PropertyKind::Flag => Format::Flag,
            PropertyKind::Int64 => Format::Int64,
            PropertyKind::String => Format::String,
            PropertyKind::Node => Format::Node,
        }
    }
}

#[cfg(unix)]
fn force_c_numeric_locale() {
    unsafe {
        libc::setlocale(libc::LC_NUMERIC, b"C\0".as_ptr() as *const libc::c_char);
    }
}

#[cfg(not(unix))]
fn force_c_numeric_locale() {}

fn mpv_argv_command(mpv: &Mpv, argv: &[&str]) -> Result<(), String> {
    let cstrings: Vec<CString> = argv
        .iter()
        .map(|s| CString::new(*s).map_err(|e| format!("cstring: {}", e)))
        .collect::<Result<Vec<_>, _>>()?;
    let mut ptrs: Vec<*const std::os::raw::c_char> = cstrings.iter().map(|c| c.as_ptr()).collect();
    ptrs.push(std::ptr::null());
    let rc = unsafe { libmpv2_sys::mpv_command(mpv.ctx.as_ptr(), ptrs.as_mut_ptr()) };
    if rc < 0 {
        return Err(format!("mpv_command rc={}", rc));
    }
    Ok(())
}

#[tauri::command]
pub async fn mpv_probe(_app: AppHandle) -> MpvProbe {
    force_c_numeric_locale();
    match Mpv::new() {
        Ok(mpv) => {
            let version = mpv
                .get_property::<String>("mpv-version")
                .ok()
                .or_else(|| Some("libmpv (embedded)".to_string()));
            MpvProbe {
                available: true,
                binary: Some("embedded libmpv".into()),
                version,
                error: None,
            }
        }
        Err(e) => MpvProbe {
            available: false,
            binary: None,
            version: None,
            error: Some(format!("libmpv init failed: {}", e)),
        },
    }
}

fn apply_pre_init(
    init: &MpvInitializer,
    args: &MpvStartArgs,
    embed_hwnd: Option<&str>,
) -> Result<(), String> {
    let set = |k: &str, v: &str| -> Result<(), String> {
        init.set_property(k, v)
            .map_err(|e| format!("set {}={}: {}", k, v, e))
    };

    set("title", "TorPlay")?;
    set("audio-client-name", "TorPlay")?;
    set("terminal", "no")?;
    set("msg-level", "all=warn")?;
    set("user-agent", "TorPlay/1.0")?;

    #[cfg(target_os = "macos")]
    {
        set("hwdec", "videotoolbox-copy")?;
        if embed_hwnd.is_some() {
            set("force-window", "no")?;
        } else {
            set("force-window", "yes")?;
        }
    }
    #[cfg(target_os = "linux")]
    {
        set("hwdec", "auto-safe")?;
        if args.embed.unwrap_or(false) {
            set("force-window", "no")?;
        } else {
            set("force-window", "yes")?;
        }
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "linux")))]
    {
        set("hwdec", "auto")?;
        set("force-window", "immediate")?;
    }

    set("input-default-bindings", "no")?;
    set("input-cursor", "no")?;
    set("osc", "no")?;
    set("osd-level", "0")?;
    set("cursor-autohide", "200")?;
    set("volume-max", "150")?;
    let _ = init.set_property("background-color", "#000000");
    let _ = init.set_property("background", "color");

    if let Some(hwnd) = embed_hwnd {
        #[cfg(windows)]
        {
            let hwnd_i64: i64 = hwnd
                .parse()
                .map_err(|e| format!("parse wid {}: {}", hwnd, e))?;
            init.set_property("wid", hwnd_i64)
                .map_err(|e| format!("set wid={}: {}", hwnd_i64, e))?;
        }
        #[cfg(not(windows))]
        {
            let _ = hwnd;
        }
    } else if !args.embed.unwrap_or(false) {
        set("ontop", "yes")?;
    }

    if let Some(start) = args.start_at_sec {
        if start > 0.0 {
            set("start", &format!("{}", start))?;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn mpv_start(
    app: AppHandle,
    state: State<'_, MpvState>,
    args: MpvStartArgs,
) -> Result<(), String> {
    let mut g = state.inner.lock().await;
    if let Some(prev) = g.take() {
        #[cfg(target_os = "macos")]
        {
            let (tx, rx) = std::sync::mpsc::sync_channel::<()>(1);
            let _ = app.run_on_main_thread(move || {
                let _ = crate::mpv_render_mac::uninstall();
                let _ = prev.mpv.command("quit", &[]);
                drop(prev);
                let _ = tx.send(());
            });
            let _ = rx.recv_timeout(Duration::from_millis(4000));
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = prev.mpv.command("quit", &[]);
            drop(prev);
        }
    }

    let want_embed = args.embed.unwrap_or(false);
    let embed_hwnd = if want_embed { get_main_hwnd_str(&app) } else { None };
    eprintln!(
        "[torplay::mpv] start url={} want_embed={} embed_hwnd={:?}",
        args.url, want_embed, embed_hwnd
    );
    let embed_hwnd_for_init = embed_hwnd.clone();
    let args_for_init = args.clone();
    let init_err: Arc<std::sync::Mutex<Option<String>>> = Arc::new(std::sync::Mutex::new(None));
    let init_err_cap = init_err.clone();

    force_c_numeric_locale();
    let mpv = Mpv::with_initializer(move |init| {
        if let Err(e) = apply_pre_init(&init, &args_for_init, embed_hwnd_for_init.as_deref()) {
            eprintln!("[torplay::mpv] pre-init failed: {}", e);
            if let Ok(mut g) = init_err_cap.lock() {
                *g = Some(e);
            }
            return Err(libmpv2::Error::Raw(-1));
        }
        Ok(())
    })
    .map_err(|e| {
        let msg = if let Ok(g) = init_err.lock() {
            g.clone().unwrap_or_else(|| format!("mpv init: {}", e))
        } else {
            format!("mpv init: {}", e)
        };
        eprintln!("[torplay::mpv] init error: {}", msg);
        msg
    })?;

    let use_render_api = cfg!(target_os = "macos") && want_embed;
    if !use_render_api {
        if let Err(e) = mpv.set_property("vo", "gpu-next,") {
            eprintln!("[torplay::mpv] vo set FAILED: {:?}", e);
        }
    } else {
        if let Err(e) = mpv.set_property("vo", "libmpv") {
            eprintln!("[torplay::mpv] vo=libmpv FAILED: {:?}", e);
        }
        let _ = mpv.set_property("force-window", "no");
    }

    #[cfg(target_os = "macos")]
    if use_render_api {
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "main window missing for render API install".to_string())?;
        let ns_window_ptr = window
            .ns_window()
            .map_err(|e| format!("ns_window: {:?}", e))? as i64;
        let mpv_ctx_addr: usize = mpv.ctx.as_ptr() as usize;
        let (tx, rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
        let _ = app.run_on_main_thread(move || {
            let res = match std::ptr::NonNull::new(mpv_ctx_addr as *mut libmpv2_sys::mpv_handle) {
                Some(p) => crate::mpv_render_mac::install(p, ns_window_ptr),
                None => Err("null mpv ctx".into()),
            };
            let _ = tx.send(res);
        });
        match rx.recv_timeout(Duration::from_millis(3000)) {
            Ok(Ok(())) => eprintln!("[torplay::mpv_mac] install OK"),
            Ok(Err(e)) => {
                eprintln!("[torplay::mpv_mac] install failed: {}", e);
                return Err(format!("mac render install: {}", e));
            }
            Err(e) => {
                eprintln!("[torplay::mpv_mac] install timed out: {:?}", e);
                return Err("mac render install timeout".into());
            }
        }
    }

    let _ = mpv.set_property("cache", "yes");
    let _ = mpv.set_property("cache-secs", "60");
    let _ = mpv.set_property("cache-pause", "yes");
    let _ = mpv.set_property("demuxer-max-bytes", "128MiB");
    let _ = mpv.set_property("demuxer-max-back-bytes", "32MiB");
    let _ = mpv.set_property("demuxer-readahead-secs", "60");
    if let Ok(base) = app.path().app_cache_dir() {
        let dvr = base.join("mpv-cache");
        let _ = std::fs::create_dir_all(&dvr);
        if let Some(s) = dvr.to_str() {
            let _ = mpv.set_property("cache-dir", s);
        }
    }
    let _ = mpv.set_property("cache-on-disk", "yes");
    let _ = mpv.set_property("network-timeout", "600");
    let _ = mpv.set_property(
        "stream-lavf-o",
        "reconnect=1,reconnect_streamed=1,reconnect_delay_max=10,reconnect_on_network_error=1",
    );
    let _ = mpv.set_property("stream-buffer-size", "32MiB");

    if let Some(subs) = &args.subtitles {
        for s in subs {
            let _ = mpv_argv_command(&mpv, &["sub-add", &s.url, "auto"]);
        }
    }

    let mpv_arc = Arc::new(mpv);

    let event_ctx = EventContext::new(mpv_arc.ctx);
    for (name, id, kind) in OBSERVED_PROPS {
        if let Err(e) = event_ctx.observe_property(name, kind.fmt(), *id) {
            eprintln!("[mpv] observe {} failed: {}", name, e);
        }
    }
    spawn_event_loop(app.clone(), mpv_arc.clone(), event_ctx);

    eprintln!("[torplay::mpv] loadfile {}", args.url);
    mpv_argv_command(&*mpv_arc, &["loadfile", &args.url, "replace"]).map_err(|e| {
        eprintln!("[torplay::mpv] loadfile FAILED: {}", e);
        format!("loadfile: {}", e)
    })?;
    eprintln!("[torplay::mpv] loadfile OK");

    *g = Some(MpvSession {
        mpv: mpv_arc,
        #[cfg(windows)]
        embedded: embed_hwnd.is_some(),
        #[cfg(target_os = "linux")]
        embedded: use_render_api,
    });
    drop(g);

    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    let _ = embed_hwnd;
    Ok(())
}

fn spawn_event_loop(app: AppHandle, mpv_keepalive: Arc<Mpv>, mut ctx: EventContext) {
    std::thread::spawn(move || {
        let mut last_timepos: Option<std::time::Instant> = None;
        loop {
            let res = ctx.wait_event(0.5);
            match res {
                Some(Ok(event)) => {
                    let mut shutdown = false;
                    if matches!(event, Event::Shutdown) {
                        shutdown = true;
                    }
                    if let Event::EndFile(reason) = &event {
                        eprintln!("[torplay::mpv] end-file reason={:?}", reason);
                    }
                    if let Event::PropertyChange { name, .. } = &event {
                        if *name == "time-pos" {
                            let now = std::time::Instant::now();
                            if let Some(prev) = last_timepos {
                                if now.duration_since(prev).as_millis() < 200 {
                                    continue;
                                }
                            }
                            last_timepos = Some(now);
                        }
                    }
                    let payload = event_to_payload(event);
                    if let Some(p) = payload {
                        let _ = app.emit("mpv://event", p);
                    }
                    if shutdown {
                        break;
                    }
                }
                Some(Err(e)) => {
                    eprintln!("[mpv] event err: {}", e);
                }
                None => {}
            }
        }
        drop(mpv_keepalive);
    });
}

fn event_to_payload(event: Event) -> Option<Value> {
    match event {
        Event::PropertyChange { name, change, .. } => {
            let data = match change {
                PropertyData::Str(s) => Value::String(s.to_string()),
                PropertyData::OsdStr(s) => Value::String(s.to_string()),
                PropertyData::Flag(b) => Value::Bool(b),
                PropertyData::Int64(i) => json!(i),
                PropertyData::Double(f) => json!(f),
                PropertyData::Node(n) => mpv_node_to_json(n),
            };
            Some(json!({ "event": "property-change", "name": name, "data": data }))
        }
        Event::EndFile(reason) => {
            let reason = match reason {
                0 => "eof",
                2 => "stop",
                3 => "quit",
                4 => "error",
                5 => "redirect",
                _ => "other",
            };
            Some(json!({ "event": "end-file", "reason": reason }))
        }
        Event::FileLoaded => Some(json!({ "event": "file-loaded" })),
        Event::PlaybackRestart => Some(json!({ "event": "playback-restart" })),
        Event::Seek => Some(json!({ "event": "seek" })),
        Event::Shutdown => Some(json!({ "event": "shutdown" })),
        _ => None,
    }
}

fn mpv_node_to_json(node: MpvNode) -> Value {
    match node {
        MpvNode::None => Value::Null,
        MpvNode::String(s) => Value::String(s),
        MpvNode::Flag(b) => Value::Bool(b),
        MpvNode::Int64(i) => json!(i),
        MpvNode::Double(f) => json!(f),
        MpvNode::ArrayIter(it) => Value::Array(it.map(mpv_node_to_json).collect()),
        MpvNode::MapIter(it) => {
            let mut obj = serde_json::Map::new();
            for (k, v) in it {
                obj.insert(k, mpv_node_to_json(v));
            }
            Value::Object(obj)
        }
    }
}

#[tauri::command]
pub async fn mpv_command(state: State<'_, MpvState>, cmd: Vec<Value>) -> Result<(), String> {
    let mpv = {
        let g = state.inner.lock().await;
        g.as_ref()
            .map(|s| s.mpv.clone())
            .ok_or_else(|| "mpv not started".to_string())?
    };
    if cmd.is_empty() {
        return Err("empty command".into());
    }
    let head = cmd[0]
        .as_str()
        .ok_or_else(|| "first arg must be string".to_string())?;
    let tail: Vec<String> = cmd[1..].iter().map(value_to_arg).collect();
    let mut argv: Vec<&str> = Vec::with_capacity(tail.len() + 1);
    argv.push(head);
    for s in &tail {
        argv.push(s.as_str());
    }
    mpv_argv_command(&mpv, &argv)
}

fn value_to_arg(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Bool(b) => {
            if *b {
                "yes".into()
            } else {
                "no".into()
            }
        }
        Value::Number(n) => n.to_string(),
        Value::Null => String::new(),
        _ => v.to_string(),
    }
}

#[tauri::command]
pub async fn mpv_set_property(
    state: State<'_, MpvState>,
    name: String,
    value: Value,
) -> Result<(), String> {
    let mpv = {
        let g = state.inner.lock().await;
        g.as_ref()
            .map(|s| s.mpv.clone())
            .ok_or_else(|| "mpv not started".to_string())?
    };
    let str_val = value_to_arg(&value);
    mpv.set_property(&name, str_val.as_str())
        .map_err(|e| format!("set {}: {}", name, e))
}

#[tauri::command]
pub async fn mpv_set_geometry(
    app: AppHandle,
    _state: State<'_, MpvState>,
    geom: MpvGeometry,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let state = _state;
        let embedded = {
            let g = state.inner.lock().await;
            g.as_ref().map(|s| s.embedded).unwrap_or(false)
        };
        if embedded {
            return position_embedded_mpv_child(&app, geom.screen_x, geom.screen_y, geom.w, geom.h);
        }
    }

    #[cfg(target_os = "macos")]
    {
        let x = geom.screen_x as f64;
        let y = geom.screen_y as f64;
        let w = geom.w as f64;
        let h = geom.h as f64;
        let (tx, rx) = std::sync::mpsc::sync_channel::<()>(1);
        let _ = app.run_on_main_thread(move || {
            let _ = crate::mpv_render_mac::resize_to(x, y, w, h);
            let _ = tx.send(());
        });
        let _ = rx.recv_timeout(Duration::from_millis(300));
        return Ok(());
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = app;
        let mpv = {
            let g = state.inner.lock().await;
            g.as_ref()
                .map(|s| s.mpv.clone())
                .ok_or_else(|| "mpv not started".to_string())?
        };
        let geo = format!("{}x{}+{}+{}", geom.w, geom.h, geom.screen_x, geom.screen_y);
        mpv.set_property("geometry", geo.as_str())
            .map_err(|e| format!("geometry: {}", e))
    }
}

#[tauri::command]
pub async fn mpv_stop(app: AppHandle, state: State<'_, MpvState>) -> Result<(), String> {
    let mut g = state.inner.lock().await;
    if let Some(session) = g.take() {
        #[cfg(target_os = "macos")]
        {
            let (tx, rx) = std::sync::mpsc::sync_channel::<()>(1);
            let _ = app.run_on_main_thread(move || {
                let _ = crate::mpv_render_mac::uninstall();
                let _ = session.mpv.command("quit", &[]);
                drop(session);
                let _ = tx.send(());
            });
            let _ = rx.recv_timeout(Duration::from_millis(4000));
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = session.mpv.command("quit", &[]);
            drop(session);
        }
    }
    #[cfg(windows)]
    {
        if let Ok(mut guard) = MPV_POS_LAST_RECT.lock() {
            *guard = None;
        }
        MPV_POS_LAST_COUNT.store(usize::MAX, std::sync::atomic::Ordering::Relaxed);
    }
    let _ = app;
    Ok(())
}

#[cfg(windows)]
fn get_main_hwnd_str(app: &AppHandle) -> Option<String> {
    let window = app.get_webview_window("main")?;
    let hwnd = window.hwnd().ok()?;
    let raw: isize = hwnd.0 as isize;
    Some(raw.to_string())
}

#[cfg(target_os = "macos")]
static MAC_NSVIEW_CACHE: std::sync::OnceLock<i64> = std::sync::OnceLock::new();

#[cfg(target_os = "macos")]
fn get_main_hwnd_str(app: &AppHandle) -> Option<String> {
    if let Some(&v) = MAC_NSVIEW_CACHE.get() {
        if v == 0 {
            return None;
        }
        return Some(v.to_string());
    }
    use std::sync::mpsc;
    let window = app.get_webview_window("main")?;
    let (tx, rx) = mpsc::sync_channel::<i64>(1);
    window
        .with_webview(move |webview| {
            let raw = webview.inner() as *mut std::ffi::c_void as i64;
            let _ = tx.send(raw);
        })
        .ok()?;
    let v = rx.recv_timeout(Duration::from_millis(2000)).ok()?;
    let _ = MAC_NSVIEW_CACHE.set(v);
    eprintln!("[torplay::mpv] mac: captured NSView wid={:#x}", v);
    if v == 0 {
        return None;
    }
    Some(v.to_string())
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn get_main_hwnd_str(_app: &AppHandle) -> Option<String> {
    None
}

#[cfg(windows)]
const TORPLAY_MPV_SUBCLASS_ID: usize = 0xA1B2C3D4;

#[cfg(windows)]
unsafe extern "system" fn mpv_subclass_proc(
    hwnd: windows::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
    _id: usize,
    _data: usize,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::Foundation::LRESULT;
    use windows::Win32::UI::Shell::DefSubclassProc;
    use windows::Win32::UI::WindowsAndMessaging::{HTTRANSPARENT, WM_NCHITTEST};
    if msg == WM_NCHITTEST {
        return LRESULT(HTTRANSPARENT as isize);
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}

#[cfg(windows)]
static MPV_POS_LAST_COUNT: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(usize::MAX);

#[cfg(windows)]
static MPV_POS_LAST_RECT: std::sync::Mutex<Option<(isize, i32, i32, u32, u32)>> =
    std::sync::Mutex::new(None);

#[cfg(windows)]
fn position_embedded_mpv_child(
    app: &AppHandle,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
) -> Result<(), String> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::Graphics::Gdi::{
        RedrawWindow, RDW_ALLCHILDREN, RDW_INVALIDATE, RDW_UPDATENOW,
    };
    use windows::Win32::UI::Shell::SetWindowSubclass;
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, GetClassNameW, GetWindowLongW, GetWindowTextW, SetWindowLongW,
        SetWindowPos, GWL_EXSTYLE, HWND_BOTTOM, SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_NOMOVE,
        SWP_NOSIZE, SWP_SHOWWINDOW, WS_EX_TRANSPARENT,
    };

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    let parent_hwnd = window.hwnd().map_err(|e| format!("hwnd: {}", e))?;

    let (x, y, w, h) = {
        use windows::Win32::Foundation::RECT;
        use windows::Win32::UI::WindowsAndMessaging::GetClientRect;
        let mut rc = RECT::default();
        let ok = unsafe { GetClientRect(parent_hwnd, &mut rc).is_ok() };
        let (cw, ch) = (rc.right, rc.bottom);
        let (mut x, mut y, mut w, mut h) = (x, y, w as i32, h as i32);
        if ok && cw > 0 && ch > 0 {
            if x.abs() <= 2 {
                w += x;
                x = 0;
            }
            if y.abs() <= 2 {
                h += y;
                y = 0;
            }
            if (x + w - cw).abs() <= 2 {
                w = cw - x;
            }
            if (y + h - ch).abs() <= 2 {
                h = ch - y;
            }
        }
        (x, y, w.max(1) as u32, h.max(1) as u32)
    };

    struct EnumState {
        mpv_hwnds: Vec<isize>,
        all_classes: Vec<(isize, String, String)>,
    }
    let mut state = EnumState {
        mpv_hwnds: Vec::new(),
        all_classes: Vec::new(),
    };
    let state_ptr = &mut state as *mut EnumState;

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let mut class_buf = [0u16; 256];
        let class_len = GetClassNameW(hwnd, &mut class_buf);
        let class_name = String::from_utf16_lossy(&class_buf[..class_len as usize]);
        let mut title_buf = [0u16; 256];
        let title_len = GetWindowTextW(hwnd, &mut title_buf);
        let title = String::from_utf16_lossy(&title_buf[..title_len as usize]);
        let s = lparam.0 as *mut EnumState;
        (*s).all_classes.push((hwnd.0 as isize, class_name.clone(), title.clone()));
        let is_mpv = class_name == "mpv"
            || class_name.starts_with("mpv ")
            || (class_name.is_empty() && title.starts_with("TorPlay"));
        if is_mpv {
            (*s).mpv_hwnds.push(hwnd.0 as isize);
        }
        BOOL(1)
    }

    unsafe {
        let _ = EnumChildWindows(
            Some(parent_hwnd),
            Some(enum_proc),
            LPARAM(state_ptr as isize),
        );
    }

    let prev_count = MPV_POS_LAST_COUNT.swap(
        state.mpv_hwnds.len(),
        std::sync::atomic::Ordering::Relaxed,
    );
    if prev_count != state.mpv_hwnds.len() {
        eprintln!(
            "[torplay::mpv] enumerated {} children of main hwnd:",
            state.all_classes.len()
        );
        for (h, cls, title) in &state.all_classes {
            eprintln!("  hwnd={:#x} class={:?} title={:?}", h, cls, title);
        }
        eprintln!(
            "[torplay::mpv] mpv child matches found: {} (was {})",
            state.mpv_hwnds.len(),
            prev_count
        );
        eprintln!("[torplay::mpv] requested rect x={} y={} w={} h={}", x, y, w, h);
    }

    let found = state.mpv_hwnds;
    if let Some(&first) = found.first() {
        for &leftover in found.iter().skip(1) {
            let target = HWND(leftover as *mut _);
            unsafe {
                let _ = SetWindowPos(
                    target,
                    Some(HWND_BOTTOM),
                    -32000,
                    -32000,
                    1,
                    1,
                    SWP_NOACTIVATE | SWP_HIDEWINDOW,
                );
            }
        }
        let new_rect = (first, x, y, w, h);
        let prev_rect = {
            let mut guard = MPV_POS_LAST_RECT.lock().unwrap();
            let prev = *guard;
            *guard = Some(new_rect);
            prev
        };
        let first_position = prev_rect.map(|r| r.0) != Some(first);
        let rect_unchanged = prev_rect == Some(new_rect);
        let target = HWND(first as *mut _);
        unsafe {
            if first_position {
                let cur_ex = GetWindowLongW(target, GWL_EXSTYLE);
                let want_ex = cur_ex | WS_EX_TRANSPARENT.0 as i32;
                if cur_ex != want_ex {
                    SetWindowLongW(target, GWL_EXSTYLE, want_ex);
                }
                let _ = SetWindowSubclass(target, Some(mpv_subclass_proc), TORPLAY_MPV_SUBCLASS_ID, 0);
                let _ = SetWindowPos(
                    target,
                    Some(HWND_BOTTOM),
                    x,
                    y,
                    w as i32,
                    h as i32,
                    SWP_NOACTIVATE | SWP_SHOWWINDOW,
                );
            } else if rect_unchanged {
                let _ = SetWindowPos(
                    target,
                    Some(HWND_BOTTOM),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
                );
            } else {
                let _ = SetWindowPos(
                    target,
                    Some(HWND_BOTTOM),
                    x,
                    y,
                    w as i32,
                    h as i32,
                    SWP_NOACTIVATE | SWP_SHOWWINDOW,
                );
            }
            let _ = RedrawWindow(
                Some(target),
                None,
                None,
                RDW_INVALIDATE | RDW_UPDATENOW | RDW_ALLCHILDREN,
            );
        }
    }
    Ok(())
}

mod authkey;

use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Once, OnceLock};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use corelib::device::data::{DeviceDataType, request_device_data_json};
use corelib::device::vivo::{
    SendError as VivoSendError, VivoBindStartType, VivoConnectType, VivoDeviceConfig,
};
use corelib::device::xiaomi::SendError as XiaomiSendError;
use corelib::device::xiaomi::components::install::InstallSystem;
use corelib::device::xiaomi::packet::dispatcher as xiaomi_dispatcher;
use corelib::device::xiaomi::packet::mass::MassDataType;
use corelib::device::xiaomi::resutils::{FileType, get_file_type};
use corelib::device::xiaomi::r#type::ConnectType as XiaomiConnectType;
use corelib::device::{DeviceKind, cleanup_device_state, create_device, create_vivo_device};
use jni::JNIEnv;
use jni::JavaVM;
use jni::objects::{GlobalRef, JByteArray, JObject, JString, JValue};
use jni::sys::{JNI_VERSION_1_6, jint, jstring};
use once_cell::sync::OnceCell;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::runtime::Runtime;

type SendCallback = unsafe extern "C" fn(*mut c_void, *const u8, usize) -> c_int;
type EventCallback = unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char);

struct CallbackContext {
    send: SendCallback,
    event: EventCallback,
    user_data: *mut c_void,
}

unsafe impl Send for CallbackContext {}
unsafe impl Sync for CallbackContext {}

#[derive(Debug, Clone)]
struct ActiveDevice {
    address: String,
    kind: DeviceKind,
}

static RUNTIME: OnceCell<Runtime> = OnceCell::new();
static CALLBACKS: OnceLock<Mutex<Option<CallbackContext>>> = OnceLock::new();
static ACTIVE_DEVICE: OnceLock<Mutex<Option<ActiveDevice>>> = OnceLock::new();
static JVM: OnceCell<JavaVM> = OnceCell::new();
static JAVA_BRIDGE: OnceLock<Mutex<Option<GlobalRef>>> = OnceLock::new();

fn runtime() -> &'static Runtime {
    RUNTIME.get_or_init(corelib::asyncrt::build_runtime)
}

fn callbacks() -> &'static Mutex<Option<CallbackContext>> {
    CALLBACKS.get_or_init(|| Mutex::new(None))
}

fn active_device() -> &'static Mutex<Option<ActiveDevice>> {
    ACTIVE_DEVICE.get_or_init(|| Mutex::new(None))
}

fn java_bridge() -> &'static Mutex<Option<GlobalRef>> {
    JAVA_BRIDGE.get_or_init(|| Mutex::new(None))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectRequest {
    name: String,
    address: String,
    kind: String,
    preferred_transport: String,
    #[serde(default)]
    auth_key: String,
    #[serde(default)]
    open_id: String,
    #[serde(default)]
    phone_device_id: String,
    #[serde(default = "default_sar")]
    sar_version: u32,
    tx_win_overrun_allowance: Option<u8>,
    ble_mtu: Option<usize>,
}

fn default_sar() -> u32 {
    2
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddressRequest {
    address: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClassifyRequest {
    path: String,
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallRequest {
    id: String,
    address: String,
    path: String,
    name: String,
    resource_type: String,
    package_name: Option<String>,
    #[serde(default)]
    force: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallCandidate {
    resource_type: &'static str,
    compatible_device_kinds: Vec<&'static str>,
    confidence: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    package_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version_name: Option<String>,
}

#[unsafe(no_mangle)]
pub extern "C" fn expo_abcore_init() -> c_int {
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        let _ = runtime();
        corelib::init();
        let _ = callbacks();
        let _ = active_device();
    });
    0
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn expo_abcore_set_callbacks(
    send: SendCallback,
    event: EventCallback,
    user_data: *mut c_void,
) -> c_int {
    expo_abcore_init();
    *callbacks().lock() = Some(CallbackContext {
        send,
        event,
        user_data,
    });
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn expo_abcore_clear_callbacks() {
    *callbacks().lock() = None;
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn expo_abcore_call(
    command_ptr: *const c_char,
    input_ptr: *const c_char,
) -> *mut c_char {
    expo_abcore_init();
    let result = (|| -> Result<Value> {
        let command = unsafe { c_string(command_ptr) }?;
        let input = unsafe { c_string(input_ptr) }?;
        dispatch(&command, &input)
    })();
    let response = match result {
        Ok(data) => json!({ "ok": true, "data": data }),
        Err(error) => json!({
            "ok": false,
            "error": {
                "code": classify_error(&error),
                "message": format!("{error:#}"),
            }
        }),
    };
    CString::new(response.to_string())
        .expect("JSON response cannot contain NUL")
        .into_raw()
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn expo_abcore_on_packet(
    kind_ptr: *const c_char,
    address_ptr: *const c_char,
    data_ptr: *const u8,
    data_len: usize,
) -> c_int {
    let kind = match unsafe { c_string(kind_ptr) } {
        Ok(value) => value,
        Err(_) => return -1,
    };
    let address = match unsafe { c_string(address_ptr) } {
        Ok(value) => value,
        Err(_) => return -1,
    };
    if data_ptr.is_null() || data_len == 0 {
        return -1;
    }
    let data = unsafe { std::slice::from_raw_parts(data_ptr, data_len) }.to_vec();
    let handle = runtime().handle().clone();
    if kind == "vivo" {
        corelib::device::vivo::packet::on_packet(handle, address, data);
    } else {
        xiaomi_dispatcher::on_packet(handle, address, data);
    }
    0
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn expo_abcore_string_free(ptr: *mut c_char) {
    if !ptr.is_null() {
        drop(unsafe { CString::from_raw(ptr) });
    }
}

fn dispatch(command: &str, input: &str) -> Result<Value> {
    match command {
        "extractAuthKeys" => {
            let value: Value = serde_json::from_str(input)?;
            let path = value["path"].as_str().context("Missing log file")?;
            let platform = value["platform"].as_str().context("Missing log platform")?;
            let pairs = authkey::extract(Path::new(path), platform)
                .map_err(|_| anyhow!("Unable to extract device keys from selected log"))?;
            Ok(Value::Array(pairs.into_iter().map(|pair| json!({"name": pair.name, "authKey": pair.encrypt_key, "platform": platform})).collect()))
        }
        "resource" => resource_command(serde_json::from_str(input)?),
        "connect" => connect_device(serde_json::from_str(input)?),
        "disconnect" => disconnect_device(),
        "refresh" => refresh_device(serde_json::from_str(input)?),
        "classify" => classify_file(serde_json::from_str(input)?),
        "install" => install_file(serde_json::from_str(input)?),
        _ => bail!("Unknown command: {command}"),
    }
}

fn resource_command(request: Value) -> Result<Value> {
    let active = active_device()
        .lock()
        .clone()
        .context("No connected device")?;
    let address = request["address"]
        .as_str()
        .context("Missing resource target")?;
    if !active.address.eq_ignore_ascii_case(address) {
        bail!("Connected device changed");
    }
    let action = request["action"]
        .as_str()
        .context("Missing resource action")?;
    let id = request["id"].as_str().unwrap_or_default().to_string();
    runtime().block_on(async move {
        tokio::time::timeout(Duration::from_secs(20), async move {
            use corelib::device::{resource, thirdparty_app, watchface};
            match action {
                "listWatchfaces" => resource::request_watchface_list_json(active.address).await,
                "listApps" => resource::request_quick_app_list_json(active.address).await,
                _ => {
                    if id.is_empty() {
                        bail!("Missing resource identifier");
                    }
                    match action {
                        "setWatchface" => watchface::set_current(active.address, id).await?,
                        "removeWatchface" => watchface::uninstall(active.address, id).await?,
                        "launchApp" => {
                            thirdparty_app::launch(active.address, id, String::new()).await?
                        }
                        "removeApp" => thirdparty_app::uninstall(active.address, id).await?,
                        _ => bail!("Unsupported resource action"),
                    }
                    Ok(Value::Null)
                }
            }
        })
        .await
        .context("Device resource request timed out")?
    })
}

fn connect_device(request: ConnectRequest) -> Result<Value> {
    if callbacks().lock().is_none() {
        bail!("Transport callback is not registered");
    }
    disconnect_device().ok();
    let address = request.address.clone();
    let kind = parse_kind(&request.kind)?;
    let info = match kind {
        DeviceKind::Xiaomi => {
            if request.auth_key.trim().is_empty() {
                bail!("Xiaomi auth key is required");
            }
            let sender = |chunks: Vec<Vec<u8>>| async move {
                for chunk in chunks {
                    invoke_send(&chunk).map_err(XiaomiSendError::Io)?;
                }
                Ok(())
            };
            runtime().block_on(create_device(
                runtime().handle().clone(),
                DeviceKind::Xiaomi,
                request.name,
                request.address,
                request.auth_key,
                request.sar_version,
                if request.preferred_transport == "spp" {
                    XiaomiConnectType::SPP
                } else {
                    XiaomiConnectType::BLE
                },
                request.tx_win_overrun_allowance,
                Some(60 * 1024),
                request.ble_mtu.map(|mtu| mtu.saturating_sub(3).max(20)),
                false,
                sender,
            ))?
        }
        DeviceKind::Vivo => {
            if request.open_id.trim().is_empty() {
                bail!("Vivo openId is required");
            }
            let mut config = VivoDeviceConfig::default();
            config.open_id = request.open_id;
            config.phone_device_id = if request.phone_device_id.trim().is_empty() {
                format!("expo-abcore-{}", uuid::Uuid::new_v4())
            } else {
                request.phone_device_id
            };
            config.phone_model = "ExpoABCore".to_string();
            config.app_version = env!("CARGO_PKG_VERSION").to_string();
            config.bind_start_type = VivoBindStartType::UserConnect;
            if let Some(mtu) = request.ble_mtu {
                config.ble_att_mtu = mtu;
                config.vscp.pack_size = mtu;
                config.vscp.max_data_length = mtu;
            }
            let sender = |chunks: Vec<Vec<u8>>| async move {
                for chunk in chunks {
                    invoke_send(&chunk).map_err(VivoSendError::Io)?;
                }
                Ok(())
            };
            runtime().block_on(create_vivo_device(
                runtime().handle().clone(),
                request.name,
                request.address,
                VivoConnectType::BLE,
                config,
                sender,
            ))?
        }
    };
    *active_device().lock() = Some(ActiveDevice { address, kind });
    Ok(serde_json::to_value(info)?)
}

fn disconnect_device() -> Result<Value> {
    let active = active_device().lock().take();
    let Some(active) = active else {
        return Ok(json!(null));
    };
    cleanup_device_state(active.kind, &active.address);
    let address = active.address;
    let removed = runtime().block_on(async move {
        corelib::ecs::with_rt_mut(move |rt| rt.remove_device(&address).is_some()).await
    });
    Ok(json!({ "removed": removed }))
}

fn refresh_device(request: AddressRequest) -> Result<Value> {
    let address = request.address;
    let info = runtime()
        .block_on(request_device_data_json(
            address.clone(),
            DeviceDataType::Info,
        ))
        .context("Device info request failed")?;
    let status = runtime()
        .block_on(request_device_data_json(
            address.clone(),
            DeviceDataType::Status,
        ))
        .context("Device status request failed")?;
    let storage = runtime()
        .block_on(request_device_data_json(address, DeviceDataType::Storage))
        .context("Device storage request failed")?;
    Ok(json!({ "info": info, "status": status, "storage": storage }))
}

fn classify_file(request: ClassifyRequest) -> Result<Value> {
    let data = fs::read(&request.path).context("Unable to read installation file")?;
    let name = request.name.to_ascii_lowercase();
    if name.ends_with(".abp") || name.ends_with(".apk") {
        return Ok(Value::Null);
    }

    let file_type = get_file_type(&data);
    let is_zip = data.starts_with(b"PK\x03\x04");
    let vivo_dial = is_zip
        .then(|| corelib::device::vivo::dial_manifest::parse_vivo_dial_manifest(&data).ok())
        .flatten();
    let vivo_quick_app = is_zip
        .then(|| {
            corelib::device::vivo::quickapp_manifest::parse_vivo_quick_app_manifest(&data).ok()
        })
        .flatten();
    let candidate = if file_type == FileType::Firmware {
        Some(InstallCandidate {
            resource_type: "firmware",
            compatible_device_kinds: vec!["xiaomi"],
            confidence: "content",
            package_name: None,
            version_name: None,
        })
    } else if file_type == FileType::WatchFace {
        Some(InstallCandidate {
            resource_type: "watchface",
            compatible_device_kinds: vec!["xiaomi"],
            confidence: "content",
            package_name: None,
            version_name: None,
        })
    } else if file_type == FileType::ThirdPartyApp {
        Some(InstallCandidate {
            resource_type: "quickApp",
            compatible_device_kinds: vec!["xiaomi"],
            confidence: "manifest",
            package_name: vivo_quick_app
                .as_ref()
                .map(|manifest| manifest.package.clone()),
            version_name: vivo_quick_app
                .as_ref()
                .and_then(|manifest| non_empty(manifest.version_name.clone())),
        })
    } else if let Some(manifest) = vivo_dial {
        Some(InstallCandidate {
            resource_type: "watchface",
            compatible_device_kinds: vec!["vivo"],
            confidence: "manifest",
            package_name: Some(manifest.package),
            version_name: non_empty(manifest.version_name),
        })
    } else if let Some(manifest) = vivo_quick_app {
        Some(InstallCandidate {
            resource_type: "quickApp",
            compatible_device_kinds: vec!["vivo"],
            confidence: "manifest",
            package_name: Some(manifest.package),
            version_name: non_empty(manifest.version_name),
        })
    } else {
        match file_type {
            _ if is_zip => {
                if name.ends_with(".mwz") {
                    Some(InstallCandidate {
                        resource_type: "watchface",
                        compatible_device_kinds: vec!["xiaomi"],
                        confidence: "extension",
                        package_name: None,
                        version_name: None,
                    })
                } else if name.ends_with(".ota.zip") {
                    Some(InstallCandidate {
                        resource_type: "firmware",
                        compatible_device_kinds: vec!["vivo"],
                        confidence: "extension",
                        package_name: None,
                        version_name: None,
                    })
                } else {
                    None
                }
            }
            _ => None,
        }
    };
    Ok(serde_json::to_value(candidate)?)
}

fn non_empty(value: String) -> Option<String> {
    if value.trim().is_empty() {
        None
    } else {
        Some(value)
    }
}

fn install_file(request: InstallRequest) -> Result<Value> {
    let data = fs::read(&request.path).context("Unable to read installation file")?;
    let active = active_device()
        .lock()
        .clone()
        .ok_or_else(|| anyhow!("No connected device"))?;
    if !active.address.eq_ignore_ascii_case(&request.address) {
        bail!("Connected device does not match installation target");
    }
    let progress_job_id = request.id.clone();
    let result = match active.kind {
        DeviceKind::Xiaomi => install_xiaomi(&request, data, progress_job_id),
        DeviceKind::Vivo => install_vivo(&request, data, progress_job_id),
    };
    if let Err(error) = result {
        let detail = format!("{error:#}").to_ascii_lowercase();
        if request.resource_type == "watchface"
            && (detail.contains("downgrade")
                || detail.contains("already")
                || detail.contains("conflict"))
        {
            return Err(error.context("WATCHFACE_CONFLICT"));
        }
        return Err(error);
    }
    emit_event(
        "installProgress",
        &json!({ "id": request.id, "progress": 1.0 }).to_string(),
    );
    Ok(json!({ "installed": true }))
}

fn install_xiaomi(request: &InstallRequest, data: Vec<u8>, job_id: String) -> Result<()> {
    let address = request.address.clone();
    let resource_type = parse_resource_type(&request.resource_type)?;
    let watchface_id = if resource_type == MassDataType::Watchface {
        let address_for_config = address.clone();
        let res_config = runtime().block_on(async move {
            corelib::ecs::with_rt_mut(move |rt| {
                rt.component_ref::<corelib::device::xiaomi::XiaomiDevice>(&address_for_config)
                    .map(|device| device.config.res.clone())
            })
            .await
        });
        res_config
            .and_then(|config| corelib::device::xiaomi::resutils::get_watchface_id(&data, &config))
    } else {
        None
    };
    if request.force {
        if let Some(id) = watchface_id.as_ref() {
            let _ = runtime().block_on(corelib::device::watchface::uninstall(
                address.clone(),
                id.clone(),
            ));
        }
    }
    let package_name = request.package_name.clone();
    let transfer_complete = Arc::new(AtomicBool::new(false));
    let transfer_complete_for_callback = transfer_complete.clone();
    let address_for_install = address.clone();
    let install_future = runtime().block_on(async move {
        corelib::ecs::with_rt_mut(move |rt| {
            rt.with_device_mut(&address_for_install, |world, entity| {
                let mut system = world
                    .get_mut::<InstallSystem>(entity)
                    .ok_or_else(|| anyhow!("Install system not found"))?;
                system.send_install_request_with_progress(
                    resource_type,
                    data,
                    Some(package_name.as_deref().unwrap_or("a.b.c")),
                    Arc::new(move |progress| {
                        if progress.progress >= 1.0 {
                            transfer_complete_for_callback.store(true, Ordering::Release);
                        }
                        emit_event(
                            "installProgress",
                            &json!({
                                "id": job_id,
                                "progress": progress.progress,
                            })
                            .to_string(),
                        );
                    }),
                    None,
                )
            })
            .ok_or_else(|| anyhow!("Device not found"))?
        })
        .await
    })?;
    match runtime().block_on(install_future) {
        Ok(()) => Ok(()),
        Err(error)
            if transfer_complete.load(Ordering::Acquire)
                && watchface_id
                    .as_deref()
                    .is_some_and(|id| verify_xiaomi_watchface_installed(&address, id)) =>
        {
            Ok(())
        }
        Err(error) => Err(error),
    }
}

fn verify_xiaomi_watchface_installed(address: &str, watchface_id: &str) -> bool {
    let address = address.to_string();
    let watchface_id = watchface_id.to_string();
    runtime().block_on(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let result = tokio::time::timeout(
            Duration::from_secs(8),
            corelib::device::resource::request_watchface_list_json(address),
        )
        .await;
        let Ok(Ok(Value::Array(items))) = result else {
            return false;
        };
        items
            .iter()
            .any(|item| item.get("id").and_then(Value::as_str) == Some(watchface_id.as_str()))
    })
}

fn install_vivo(request: &InstallRequest, data: Vec<u8>, job_id: String) -> Result<()> {
    let address = request.address.clone();
    let progress: Arc<dyn Fn(u64, u64) + Send + Sync> = Arc::new(move |sent, total| {
        let ratio = if total == 0 {
            0.0
        } else {
            (sent as f64 / total as f64).clamp(0.0, 1.0)
        };
        emit_event(
            "installProgress",
            &json!({ "id": job_id, "progress": ratio }).to_string(),
        );
    });
    match request.resource_type.as_str() {
        "watchface" => {
            if request.force {
                let manifest =
                    corelib::device::vivo::dial_manifest::parse_vivo_dial_manifest(&data)
                        .context("Unable to identify Vivo watchface for replacement")?;
                runtime().block_on(corelib::device::watchface::uninstall(
                    address.clone(),
                    manifest.dial_id.to_string(),
                ))?;
            }
            runtime().block_on(corelib::device::install::install_vivo_watchface_local(
                address,
                data,
                None,
                Some(progress),
            ))?
        }
        "quickApp" => {
            runtime().block_on(corelib::device::install::install_vivo_quick_app_local(
                address,
                data,
                request.package_name.clone(),
                None,
                None,
                Some(progress),
            ))?
        }
        "firmware" => {
            let version = request
                .package_name
                .clone()
                .or_else(|| {
                    Path::new(&request.name)
                        .file_stem()
                        .and_then(|value| value.to_str())
                        .map(str::to_string)
                })
                .unwrap_or_else(|| "unknown".to_string());
            runtime().block_on(corelib::device::install::install_vivo_firmware_local(
                address,
                data,
                version,
                Some(request.name.clone()),
                true,
                Some(progress),
            ))?;
        }
        _ => bail!("Unsupported resource type: {}", request.resource_type),
    }
    Ok(())
}

fn parse_kind(value: &str) -> Result<DeviceKind> {
    match value {
        "xiaomi" => Ok(DeviceKind::Xiaomi),
        "vivo" => Ok(DeviceKind::Vivo),
        _ => bail!("Unsupported device kind: {value}"),
    }
}

fn parse_resource_type(value: &str) -> Result<MassDataType> {
    match value {
        "watchface" => Ok(MassDataType::Watchface),
        "quickApp" => Ok(MassDataType::ThirdPartyApp),
        "firmware" => Ok(MassDataType::Firmare),
        _ => bail!("Unsupported resource type: {value}"),
    }
}

fn invoke_send(data: &[u8]) -> Result<(), String> {
    let guard = callbacks().lock();
    let context = guard
        .as_ref()
        .ok_or_else(|| "Transport callback is not registered".to_string())?;
    let result = unsafe { (context.send)(context.user_data, data.as_ptr(), data.len()) };
    if result == 0 {
        Ok(())
    } else {
        Err(format!("Transport send failed with code {result}"))
    }
}

fn emit_event(name: &str, payload: &str) {
    let Ok(name) = CString::new(name) else { return };
    let Ok(payload) = CString::new(payload) else {
        return;
    };
    let guard = callbacks().lock();
    if let Some(context) = guard.as_ref() {
        unsafe {
            (context.event)(context.user_data, name.as_ptr(), payload.as_ptr());
        }
    }
}

fn classify_error(error: &anyhow::Error) -> &'static str {
    let message = format!("{error:#}").to_ascii_lowercase();
    if message.contains("auth") {
        "AUTH_FAILED"
    } else if message.contains("watchface_conflict") {
        "WATCHFACE_CONFLICT"
    } else if message.contains("disconnect") {
        "DEVICE_DISCONNECTED"
    } else if message.contains("not found") {
        "NOT_FOUND"
    } else {
        "NATIVE_ERROR"
    }
}

unsafe fn c_string(ptr: *const c_char) -> Result<String> {
    if ptr.is_null() {
        bail!("Null C string");
    }
    Ok(unsafe { CStr::from_ptr(ptr) }.to_str()?.to_string())
}

unsafe extern "C" fn android_send(_context: *mut c_void, data: *const u8, len: usize) -> c_int {
    let Some(vm) = JVM.get() else { return -1 };
    let Some(bridge) = java_bridge().lock().clone() else {
        return -1;
    };
    let Ok(mut env) = vm.attach_current_thread_permanently() else {
        return -1;
    };
    let bytes = unsafe { std::slice::from_raw_parts(data, len) };
    let Ok(array) = env.byte_array_from_slice(bytes) else {
        return -1;
    };
    let object = JObject::from(array);
    match env.call_method(
        bridge.as_obj(),
        "onRustSend",
        "([B)I",
        &[JValue::Object(&object)],
    ) {
        Ok(value) => value.i().unwrap_or(-1),
        Err(_) => -1,
    }
}

unsafe extern "C" fn android_event(
    _context: *mut c_void,
    name: *const c_char,
    payload: *const c_char,
) {
    let Some(vm) = JVM.get() else { return };
    let Some(bridge) = java_bridge().lock().clone() else {
        return;
    };
    let Ok(mut env) = vm.attach_current_thread_permanently() else {
        return;
    };
    let Ok(name) = unsafe { CStr::from_ptr(name) }.to_str() else {
        return;
    };
    let Ok(payload) = unsafe { CStr::from_ptr(payload) }.to_str() else {
        return;
    };
    let Ok(j_name) = env.new_string(name) else {
        return;
    };
    let Ok(j_payload) = env.new_string(payload) else {
        return;
    };
    let name_obj = JObject::from(j_name);
    let payload_obj = JObject::from(j_payload);
    let _ = env.call_method(
        bridge.as_obj(),
        "onRustEvent",
        "(Ljava/lang/String;Ljava/lang/String;)V",
        &[JValue::Object(&name_obj), JValue::Object(&payload_obj)],
    );
}

#[unsafe(no_mangle)]
pub extern "system" fn JNI_OnLoad(_vm: JavaVM, _reserved: *mut c_void) -> jint {
    JNI_VERSION_1_6
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_bandbbs_expoabcore_RustBridge_nativeInit(
    env: JNIEnv,
    this: JObject,
) -> jint {
    let result = (|| -> Result<()> {
        let _ = JVM.set(env.get_java_vm()?);
        *java_bridge().lock() = Some(env.new_global_ref(this)?);
        expo_abcore_init();
        unsafe {
            expo_abcore_set_callbacks(android_send, android_event, std::ptr::null_mut());
        }
        Ok(())
    })();
    if result.is_ok() { 0 } else { -1 }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_bandbbs_expoabcore_RustBridge_nativeDestroy(
    _env: JNIEnv,
    _this: JObject,
) {
    expo_abcore_clear_callbacks();
    *java_bridge().lock() = None;
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_bandbbs_expoabcore_RustBridge_nativeCall(
    mut env: JNIEnv,
    _this: JObject,
    command: JString,
    input: JString,
) -> jstring {
    let response = (|| -> Result<String> {
        let command: String = env.get_string(&command)?.into();
        let input: String = env.get_string(&input)?.into();
        let command = CString::new(command)?;
        let input = CString::new(input)?;
        let raw = unsafe { expo_abcore_call(command.as_ptr(), input.as_ptr()) };
        if raw.is_null() {
            bail!("Native call returned null");
        }
        let value = unsafe { CStr::from_ptr(raw) }.to_string_lossy().to_string();
        unsafe { expo_abcore_string_free(raw) };
        Ok(value)
    })()
    .unwrap_or_else(|error| {
        json!({ "ok": false, "error": { "code": "JNI_ERROR", "message": error.to_string() } })
            .to_string()
    });
    env.new_string(response)
        .map(JString::into_raw)
        .unwrap_or(std::ptr::null_mut())
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_bandbbs_expoabcore_RustBridge_nativeOnPacket(
    mut env: JNIEnv,
    _this: JObject,
    kind: JString,
    address: JString,
    data: JByteArray,
) -> jint {
    let result = (|| -> Result<c_int> {
        let kind: String = env.get_string(&kind)?.into();
        let address: String = env.get_string(&address)?.into();
        let data = env.convert_byte_array(&data)?;
        let kind = CString::new(kind)?;
        let address = CString::new(address)?;
        Ok(unsafe {
            expo_abcore_on_packet(kind.as_ptr(), address.as_ptr(), data.as_ptr(), data.len())
        })
    })();
    result.unwrap_or(-1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_commands() {
        let error = dispatch("unknown", "{}").unwrap_err();
        assert!(error.to_string().contains("Unknown command"));
    }

    #[test]
    fn ignores_plain_zip_files() {
        let temp = std::env::temp_dir().join("expo-abcore-plain.zip");
        fs::write(&temp, b"PK\x03\x04plain").unwrap();
        let value = classify_file(ClassifyRequest {
            path: temp.to_string_lossy().to_string(),
            name: "plain.zip".to_string(),
        })
        .unwrap();
        assert!(value.is_null());
        let _ = fs::remove_file(temp);
    }

    #[test]
    fn ignores_android_packages() {
        let temp = std::env::temp_dir().join("expo-abcore-app.apk");
        fs::write(&temp, b"PK\x03\x04android-package").unwrap();
        let value = classify_file(ClassifyRequest {
            path: temp.to_string_lossy().to_string(),
            name: "app.apk".to_string(),
        })
        .unwrap();
        assert!(value.is_null());
        let _ = fs::remove_file(temp);
    }

    #[test]
    fn identifies_vivo_quick_app_from_manifest() {
        use std::io::Write as _;

        let temp = std::env::temp_dir().join("expo-abcore-vivo-quick-app.rpk");
        let mut data = Vec::new();
        {
            let cursor = std::io::Cursor::new(&mut data);
            let mut archive = zip::ZipWriter::new(cursor);
            archive
                .start_file("manifest.json", zip::write::FileOptions::default())
                .unwrap();
            archive
                .write_all(
                    br#"{"package":"com.example.watchapp","name":"Example","versionName":"1.2.3","versionCode":7}"#,
                )
                .unwrap();
            archive.finish().unwrap();
        }
        fs::write(&temp, data).unwrap();
        let value = classify_file(ClassifyRequest {
            path: temp.to_string_lossy().to_string(),
            name: "example.rpk".to_string(),
        })
        .unwrap();
        assert_eq!(value["resourceType"], "quickApp");
        assert_eq!(value["compatibleDeviceKinds"], json!(["vivo"]));
        assert_eq!(value["packageName"], "com.example.watchapp");
        assert_eq!(value["versionName"], "1.2.3");
        let _ = fs::remove_file(temp);
    }

    #[test]
    fn identifies_xiaomi_quick_app_before_generic_vivo_manifest() {
        use std::io::Write as _;

        let temp = std::env::temp_dir().join("expo-abcore-xiaomi-quick-app.rpk");
        let mut data = Vec::new();
        {
            let cursor = std::io::Cursor::new(&mut data);
            let mut archive = zip::ZipWriter::new(cursor);
            archive
                .start_file("manifest.json", zip::write::FileOptions::default())
                .unwrap();
            archive
                .write_all(
                    br#"{"package":"com.example.miwear","name":"Example","versionName":"2.0.0","versionCode":8}"#,
                )
                .unwrap();
            archive
                .start_file("manifest-watch.json", zip::write::FileOptions::default())
                .unwrap();
            archive.write_all(br#"{"type":"wearable"}"#).unwrap();
            archive.finish().unwrap();
        }
        fs::write(&temp, data).unwrap();
        let value = classify_file(ClassifyRequest {
            path: temp.to_string_lossy().to_string(),
            name: "example.rpk".to_string(),
        })
        .unwrap();
        assert_eq!(value["resourceType"], "quickApp");
        assert_eq!(value["compatibleDeviceKinds"], json!(["xiaomi"]));
        assert_eq!(value["packageName"], "com.example.miwear");
        assert_eq!(value["versionName"], "2.0.0");
        let _ = fs::remove_file(temp);
    }
}

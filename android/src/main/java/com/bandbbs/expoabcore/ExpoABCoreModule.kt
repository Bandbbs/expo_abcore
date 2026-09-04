package com.bandbbs.expoabcore

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.interfaces.permissions.Permissions
import java.io.File
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject

class ExpoABCoreModule : Module(), RustBridge.Callbacks {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private lateinit var store: SecureJsonStore
  private lateinit var transport: BluetoothTransport
  private lateinit var bridge: RustBridge
  private var scanJob: Job? = null
  private var activeProfileId: String? = null
  private var activeKind: String? = null
  private var activeAddress: String? = null
  private var activeTransport: String? = null
  private val installing = AtomicBoolean(false)

  override fun definition() = ModuleDefinition {
    Name("ExpoABCore")
    Events(
      "scanResult",
      "scanStateChanged",
      "connectionChanged",
      "deviceSnapshotChanged",
      "installJobChanged",
    )

    OnCreate {
      val activity = appContext.currentActivity
        ?: throw IllegalStateException("ExpoABCore requires an active Activity")
      store = SecureJsonStore(activity.applicationContext)
      transport = BluetoothTransport(activity) { message ->
        android.util.Log.d("ExpoABCore", message)
      }
      transport.setDataListener(object : BluetoothTransport.DataListener {
        override fun onDataReceived(data: ByteArray) {
          val kind = activeKind ?: return
          val address = activeAddress ?: return
          bridge.nativeOnPacket(kind, address, data)
        }

        override fun onError(e: java.io.IOException) {
          emitConnectionFailure("DEVICE_DISCONNECTED", e.message ?: "Bluetooth disconnected")
        }
      })
      bridge = RustBridge(this@ExpoABCoreModule)
    }

    OnDestroy {
      scanJob?.cancel()
      runCatching { bridge.call("disconnect") }
      transport.stopScan()
      transport.stopBleScan()
      transport.disconnect()
      transport.disconnectBle()
      bridge.close()
      scope.coroutineContext[Job]?.cancel()
    }

    AsyncFunction("requestPermissions") { promise: Promise ->
      val permissions = runtimePermissions()
      Permissions.askForPermissionsWithPermissionsManager(
        appContext.permissions,
        promise,
        *permissions,
      )
    }

    AsyncFunction("startScan") { options: Map<String, Any?>? ->
      ensurePermissions()
      val transportFilter = options?.get("transport") as? String
      stopScanning()
      if (transportFilter == null || transportFilter == "ble") transport.startBleScan()
      if (transportFilter == null || transportFilter == "spp") transport.startScan()
      sendEvent("scanStateChanged", mapOf("scanning" to true))
      val emitted = mutableSetOf<String>()
      scanJob = scope.launch {
        while (true) {
          val requestedKind = options?.get("kind") as? String
          if (transportFilter == null || transportFilter == "ble") {
            transport.getBleScannedDevices().forEach { device ->
              val kind = device.kind
              val key = "ble:${device.address}"
              if ((requestedKind == null || requestedKind == kind) && emitted.add(key)) {
                sendEvent(
                  "scanResult",
                  mapOf(
                    "name" to (device.name ?: device.address),
                    "address" to device.address,
                    "kind" to kind,
                    "transports" to listOf("ble"),
                  ),
                )
              }
            }
          }
          if (transportFilter == null || transportFilter == "spp") {
            transport.getScannedDevices().forEach { device ->
              val name = runCatching { device.name }.getOrNull()
              if (kindForName(name) == "vivo") return@forEach
              val kind = "xiaomi"
              val key = "spp:${device.address}"
              if ((requestedKind == null || requestedKind == kind) && emitted.add(key)) {
                sendEvent(
                  "scanResult",
                  mapOf(
                    "name" to (name ?: device.address),
                    "address" to device.address,
                    "kind" to kind,
                    "transports" to listOf("spp"),
                  ),
                )
              }
            }
          }
          delay(350)
        }
      }
    }

    AsyncFunction("stopScan") { stopScanning() }

    AsyncFunction("listDeviceProfiles") {
      profiles().map(::publicProfile)
    }

    AsyncFunction("saveDeviceProfile") { input: Map<String, Any?> ->
      val profile = mapToJson(input).apply {
        if (optString("id").isEmpty()) put("id", UUID.randomUUID().toString())
        put("sarVersion", optInt("sarVersion", 2))
        put(
          "txWinOverrunAllowance",
          optInt("txWinOverrunAllowance", if (Build.VERSION.SDK_INT > 0) 6 else 2),
        )
      }
      validateProfile(profile)
      val list = profiles()
      val index = list.indexOfFirst { it.optString("id") == profile.optString("id") }
      if (index >= 0) {
        list[index] = mergeSecretFields(list[index], profile)
      } else {
        if (profile.optString("phoneDeviceId").isEmpty()) {
          profile.put("phoneDeviceId", UUID.randomUUID().toString())
        }
        list += profile
      }
      saveProfiles(list)
      publicProfile(list.first { it.optString("id") == profile.optString("id") })
    }

    AsyncFunction("updateDeviceProfile") { id: String, patch: Map<String, Any?> ->
      ensureNotInstalling()
      val list = profiles()
      val index = list.indexOfFirst { it.optString("id") == id }
      if (index < 0) throw ExpoABCoreException("PROFILE_NOT_FOUND", "Device profile not found")
      val next = JSONObject(list[index].toString())
      mapToJson(patch).keys().forEach { key -> next.put(key, mapToJson(patch).get(key)) }
      list[index] = mergeSecretFields(list[index], next)
      validateProfile(list[index])
      saveProfiles(list)
      publicProfile(list[index])
    }

    AsyncFunction("removeDeviceProfile") { id: String ->
      ensureNotInstalling()
      if (activeProfileId == id) disconnectNow()
      saveProfiles(profiles().filterNot { it.optString("id") == id })
    }

    AsyncFunction("connect") { id: String ->
      runBlocking(Dispatchers.IO) { connectProfile(id) }
    }

    AsyncFunction("disconnect") {
      ensureNotInstalling()
      disconnectNow()
    }

    AsyncFunction("getDeviceSnapshot") { id: String? ->
      val profile = profiles().firstOrNull { it.optString("id") == (id ?: activeProfileId) }
      if (profile == null) {
        null
      } else {
        snapshot(
          profile,
          if (profile.optString("id") == activeProfileId) "connected" else "disconnected",
        )
      }
    }

    AsyncFunction("refreshDeviceSnapshot") {
      runBlocking(Dispatchers.IO) { refreshSnapshot() }
    }

    AsyncFunction("classifyInstallFile") { input: Map<String, Any?> ->
      withStagedFile(input) { file ->
        val request = JSONObject()
          .put("path", file.path)
          .put("name", input["name"] as? String ?: file.name)
        (bridge.call("classify", request) as? JSONObject)?.toMap()
      }
    }

    AsyncFunction("executeInstall") { input: Map<String, Any?> ->
      if (!installing.compareAndSet(false, true)) {
        throw ExpoABCoreException("INSTALL_IN_PROGRESS", "Another installation is running")
      }
      try {
        val profileId = input["profileId"] as? String
          ?: throw ExpoABCoreException("INVALID_JOB", "profileId is required")
        val profile = profileById(profileId)
        if (activeProfileId != profileId) runBlocking(Dispatchers.IO) { connectProfile(profileId) }
        withStagedFile(input) { file ->
          val request = mapToJson(input)
            .put("address", profile.getString("address"))
            .put("path", file.path)
          bridge.call("install", request)
        }
      } finally {
        installing.set(false)
      }
    }

    AsyncFunction("loadInstallJobs") {
      JSONArray(store.get(INSTALL_JOBS_KEY, "[]")).toListValue()
    }

    AsyncFunction("saveInstallJobs") { jobs: List<Map<String, Any?>> ->
      store.set(INSTALL_JOBS_KEY, JSONArray(jobs).toString())
    }

    AsyncFunction("getRuntimeLicenses") {
      loadRuntimeLicenses()
    }
  }

  override fun send(data: ByteArray): Int {
    val selectedTransport = activeTransport ?: return -1
    return if (selectedTransport == "ble") {
      val result = runBlocking(Dispatchers.IO) { transport.sendBle(data) }
      if (result.first) 0 else -1
    } else if (transport.send(data)) {
      0
    } else {
      -1
    }
  }

  override fun event(name: String, payload: JSONObject) {
    if (name == "installProgress") {
      sendEvent(
        "installJobChanged",
        mapOf(
          "id" to payload.optString("id"),
          "status" to "running",
          "progress" to payload.optDouble("progress", 0.0),
        ),
      )
    }
  }

  private suspend fun connectProfile(id: String): Map<String, Any?> {
    val profile = profileById(id)
    if (activeProfileId == id) return refreshSnapshot()
    disconnectNow()
    sendEvent("connectionChanged", snapshot(profile, "connecting"))
    val preferred = profile.optString("preferredTransport", "ble")
    val kind = profile.getString("kind")
    val connection = if (preferred == "spp" && kind == "xiaomi") {
      transport.connect(
        requireNotNull(appContext.currentActivity),
        profile.getString("address"),
        false,
        listOf(5, 1),
      )
    } else {
      transport.connectBle(profile.getString("address"))
    }
    if (!connection.first) {
      sendEvent(
        "connectionChanged",
        snapshot(profile, "failed", "TRANSPORT_CONNECT_FAILED", connection.second),
      )
      throw ExpoABCoreException(
        "TRANSPORT_CONNECT_FAILED",
        connection.second ?: "Bluetooth connection failed",
      )
    }
    activeProfileId = id
    activeKind = kind
    activeAddress = profile.getString("address")
    activeTransport = if (kind == "vivo") "ble" else preferred
    val subscription = if (activeTransport == "ble") {
      transport.startBleSubscription()
    } else {
      transport.startSubscription()
      true to null
    }
    if (!subscription.first) {
      disconnectNow()
      throw ExpoABCoreException(
        "TRANSPORT_SUBSCRIBE_FAILED",
        subscription.second ?: "Bluetooth notification subscription failed",
      )
    }
    val request = JSONObject(profile.toString()).put("bleMtu", transport.getBleMaxSendLen()?.plus(3))
    try {
      bridge.call("connect", request)
    } catch (error: Throwable) {
      disconnectNow()
      throw error
    }
    profile.put("lastConnectedAt", System.currentTimeMillis())
    val list = profiles().map { if (it.optString("id") == id) profile else it }
    saveProfiles(list)
    val result = refreshSnapshot()
    sendEvent("connectionChanged", result)
    return result
  }

  private fun disconnectNow() {
    runCatching { bridge.call("disconnect") }
    transport.disconnect()
    transport.disconnectBle()
    val id = activeProfileId
    val profile = profiles().firstOrNull { it.optString("id") == id }
    activeProfileId = null
    activeKind = null
    activeAddress = null
    activeTransport = null
    if (profile != null) sendEvent("connectionChanged", snapshot(profile, "disconnected"))
  }

  private fun refreshSnapshot(): Map<String, Any?> {
    val profile = profileById(
      activeProfileId ?: throw ExpoABCoreException("NO_DEVICE", "No connected device"),
    )
    val data = bridge.call(
      "refresh",
      JSONObject().put("address", profile.getString("address")),
    ) as? JSONObject ?: JSONObject()
    val result = snapshot(profile, "connected", data = data)
    sendEvent("deviceSnapshotChanged", result)
    return result
  }

  private fun profiles(): MutableList<JSONObject> {
    val array = JSONArray(store.get(PROFILES_KEY, "[]"))
    return (0 until array.length()).mapNotNull { array.optJSONObject(it) }.toMutableList()
  }

  private fun saveProfiles(profiles: List<JSONObject>) {
    store.set(PROFILES_KEY, JSONArray(profiles).toString())
  }

  private fun profileById(id: String): JSONObject = profiles().firstOrNull {
    it.optString("id") == id
  } ?: throw ExpoABCoreException("PROFILE_NOT_FOUND", "Device profile not found")

  private fun publicProfile(profile: JSONObject): Map<String, Any?> = mapOf(
    "id" to profile.getString("id"),
    "name" to profile.getString("name"),
    "address" to profile.getString("address"),
    "kind" to profile.getString("kind"),
    "preferredTransport" to profile.optString("preferredTransport", "ble"),
    "sarVersion" to profile.optInt("sarVersion", 2),
    "txWinOverrunAllowance" to profile.optInt("txWinOverrunAllowance", 6),
    "hasCredentials" to (
      profile.optString("authKey").isNotBlank() || profile.optString("openId").isNotBlank()
    ),
    "lastConnectedAt" to profile.optLong("lastConnectedAt").takeIf { it > 0 },
  )

  private fun snapshot(
    profile: JSONObject,
    state: String,
    errorCode: String? = null,
    errorMessage: String? = null,
    data: JSONObject? = null,
  ): Map<String, Any?> = publicProfile(profile).let { public ->
    buildMap {
      put("profile", public)
      put("connectionState", state)
      data?.optJSONObject("info")?.let { put("info", it.toMap()) }
      data?.optJSONObject("status")?.let { put("status", it.toMap()) }
      data?.optJSONObject("storage")?.let { put("storage", it.toMap()) }
      errorCode?.let { put("errorCode", it) }
      errorMessage?.let { put("errorMessage", it) }
    }
  }

  private fun validateProfile(profile: JSONObject) {
    val kind = profile.optString("kind")
    if (kind !in setOf("xiaomi", "vivo")) {
      throw ExpoABCoreException("INVALID_PROFILE", "Unsupported device kind")
    }
    if (profile.optString("name").isBlank() || profile.optString("address").isBlank()) {
      throw ExpoABCoreException("INVALID_PROFILE", "Device name and address are required")
    }
    if (kind == "xiaomi" && profile.optString("authKey").isBlank()) {
      throw ExpoABCoreException("INVALID_PROFILE", "Xiaomi auth key is required")
    }
    if (kind == "vivo" && profile.optString("openId").isBlank()) {
      throw ExpoABCoreException("INVALID_PROFILE", "Vivo openId is required")
    }
  }

  private fun mergeSecretFields(previous: JSONObject, next: JSONObject): JSONObject {
    if (next.optString("authKey").isBlank() && previous.optString("authKey").isNotBlank()) {
      next.put("authKey", previous.getString("authKey"))
    }
    if (next.optString("openId").isBlank() && previous.optString("openId").isNotBlank()) {
      next.put("openId", previous.getString("openId"))
    }
    if (next.optString("phoneDeviceId").isBlank() && previous.optString("phoneDeviceId").isNotBlank()) {
      next.put("phoneDeviceId", previous.getString("phoneDeviceId"))
    }
    return next
  }

  private fun stopScanning() {
    scanJob?.cancel()
    scanJob = null
    transport.stopScan()
    transport.stopBleScan()
    sendEvent("scanStateChanged", mapOf("scanning" to false))
  }

  private fun runtimePermissions(): Array<String> = when {
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> arrayOf(
      Manifest.permission.BLUETOOTH_SCAN,
      Manifest.permission.BLUETOOTH_CONNECT,
    )
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q -> arrayOf(
      Manifest.permission.ACCESS_FINE_LOCATION,
    )
    else -> arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION)
  }

  private fun ensurePermissions() {
    val context = requireNotNull(appContext.reactContext)
    if (runtimePermissions().any {
        ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED
      }) {
      throw ExpoABCoreException("PERMISSION_DENIED", "Bluetooth permission is required")
    }
  }

  private fun ensureNotInstalling() {
    if (installing.get()) {
      throw ExpoABCoreException("INSTALL_IN_PROGRESS", "Wait for the current installation")
    }
  }

  private fun emitConnectionFailure(code: String, message: String) {
    val profile = profiles().firstOrNull { it.optString("id") == activeProfileId } ?: return
    runCatching { bridge.call("disconnect") }
    transport.disconnect()
    transport.disconnectBle()
    activeProfileId = null
    activeKind = null
    activeAddress = null
    activeTransport = null
    sendEvent("connectionChanged", snapshot(profile, "failed", code, message))
  }

  private fun kindForName(name: String?): String {
    val normalized = name?.lowercase().orEmpty()
    return if (normalized.startsWith("vivo watch") || normalized.startsWith("iqoo watch")) {
      "vivo"
    } else {
      "xiaomi"
    }
  }

  private fun <T> withStagedFile(input: Map<String, Any?>, block: (File) -> T): T {
    val uriText = input["uri"] as? String
      ?: throw ExpoABCoreException("INVALID_FILE", "File URI is required")
    val uri = Uri.parse(uriText)
    val direct = if (uri.scheme == "file") {
      File(URLDecoder.decode(uri.path.orEmpty(), StandardCharsets.UTF_8.name()))
    } else null
    if (direct != null && direct.exists()) return block(direct)

    val context = requireNotNull(appContext.reactContext)
    val staged = File.createTempFile("expo-abcore-", ".bin", context.cacheDir)
    try {
      context.contentResolver.openInputStream(uri)?.use { source ->
        staged.outputStream().use(source::copyTo)
      } ?: throw ExpoABCoreException("FILE_NOT_FOUND", "Unable to open installation file")
      return block(staged)
    } finally {
      staged.delete()
    }
  }

  private fun loadRuntimeLicenses(): List<Any?> {
    val context: Context = requireNotNull(appContext.reactContext)
    return runCatching {
      context.assets.open("expo_abcore_licenses.json").bufferedReader().use { reader ->
        JSONArray(reader.readText()).toListValue()
      }
    }.getOrDefault(emptyList())
  }

  private companion object {
    const val PROFILES_KEY = "device_profiles_v1"
    const val INSTALL_JOBS_KEY = "install_jobs_v1"
  }
}

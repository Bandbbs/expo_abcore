import CoreBluetooth
import ExpoModulesCore
import Foundation

private let profilesKey = "device_profiles_v1"
private let jobsKey = "install_jobs_v1"

public final class ExpoABCoreModule: Module {
  private let store = KeychainJsonStore()
  private let transport = BluetoothTransport()
  private var activeProfileId: String?
  private var activeKind: String?
  private var activeAddress: String?
  private var scanKindFilter: String?
  private var installing = false
  private lazy var runtime = ExpoABCoreRuntime(
    transport: transport,
    event: { [weak self] name, payload in self?.handleRustEvent(name, payload) }
  )

  public func definition() -> ModuleDefinition {
    Name("ExpoABCore")
    Events(
      "scanResult",
      "scanStateChanged",
      "connectionChanged",
      "deviceSnapshotChanged",
      "installJobChanged"
    )

    OnCreate {
      transport.ensureInitialized()
      transport.onDiscovery = { [weak self] device in
        guard self?.scanKindFilter == nil || self?.scanKindFilter == device.kind else { return }
        self?.sendEvent("scanResult", [
          "name": device.name,
          "address": device.address,
          "kind": device.kind,
          "transports": ["ble"],
          "rssi": device.rssi,
        ])
      }
      transport.onPacket = { [weak self] data in self?.runtime.onPacket(data) }
      transport.onDisconnect = { [weak self] error in self?.handleDisconnect(error) }
    }

    OnDestroy {
      transport.stopScan()
      runtime.disconnectCore()
      transport.disconnect()
      expo_abcore_clear_callbacks()
    }

    AsyncFunction("configureConnectionNotification") { (_: [String: String]) in
      // iOS connection notifications are presented by the host notification center.
    }

    AsyncFunction("requestPermissions") { () -> [String: Any] in
      let authorization = transport.waitForAuthorization()
      return [
        "status": authorization == .allowedAlways ? "granted" :
          (authorization == .notDetermined ? "undetermined" : "denied"),
        "granted": authorization == .allowedAlways,
        "canAskAgain": authorization == .notDetermined,
      ]
    }

    AsyncFunction("startScan") { (options: [String: Any]?) in
      if options?["transport"] as? String == "spp" {
        throw ModuleError("UNSUPPORTED_TRANSPORT", "SPP is not available on iOS")
      }
      self.scanKindFilter = options?["kind"] as? String
      try transport.startScan()
      self.sendEvent("scanStateChanged", ["scanning": true])
    }

    AsyncFunction("stopScan") {
      transport.stopScan()
      self.scanKindFilter = nil
      self.sendEvent("scanStateChanged", ["scanning": false])
    }

    AsyncFunction("listDeviceProfiles") { () -> [[String: Any]] in
      self.profiles().map(self.publicProfile)
    }

    AsyncFunction("saveDeviceProfile") { (input: [String: Any]) throws -> [String: Any] in
      var profile = input
      profile["id"] = (profile["id"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        ?? UUID().uuidString
      profile["preferredTransport"] = "ble"
      profile["sarVersion"] = profile["sarVersion"] ?? 2
      profile["txWinOverrunAllowance"] = profile["txWinOverrunAllowance"] ?? 2
      try self.resolveAuthKeyRecord(&profile)
      try self.validate(profile)
      var values = self.profiles()
      if let index = values.firstIndex(where: { $0["id"] as? String == profile["id"] as? String }) {
        profile = self.mergeSecrets(previous: values[index], next: profile)
        values[index] = profile
      } else {
        profile["phoneDeviceId"] = UUID().uuidString
        values.append(profile)
      }
      try self.saveProfiles(values)
      return self.publicProfile(profile)
    }

    AsyncFunction("updateDeviceProfile") {
      (id: String, patch: [String: Any]) throws -> [String: Any] in
      try self.ensureNotInstalling()
      var values = self.profiles()
      guard let index = values.firstIndex(where: { $0["id"] as? String == id }) else {
        throw ModuleError("PROFILE_NOT_FOUND", "Device profile not found")
      }
      var next = values[index]
      patch.forEach { next[$0.key] = $0.value }
      try self.resolveAuthKeyRecord(&next)
      next = self.mergeSecrets(previous: values[index], next: next)
      try self.validate(next)
      values[index] = next
      try self.saveProfiles(values)
      return self.publicProfile(next)
    }

    AsyncFunction("removeDeviceProfile") { (id: String) throws in
      try self.ensureNotInstalling()
      if self.activeProfileId == id { self.disconnectNow() }
      try self.saveProfiles(self.profiles().filter { $0["id"] as? String != id })
    }

    AsyncFunction("connect") { (id: String) throws -> [String: Any] in
      try self.connectProfile(id)
    }

    AsyncFunction("disconnect") { () throws in
      try self.ensureNotInstalling()
      self.disconnectNow()
    }

    AsyncFunction("getDeviceSnapshot") { (id: String?) -> [String: Any]? in
      guard let profile = self.profile(id ?? self.activeProfileId) else { return nil }
      let state = profile["id"] as? String == self.activeProfileId ? "connected" : "disconnected"
      return self.snapshot(profile, state: state)
    }

    AsyncFunction("refreshDeviceSnapshot") { () throws -> [String: Any] in
      try self.refreshSnapshot()
    }

    AsyncFunction("listAuthKeyRecords") { () -> [[String: Any]] in
      self.authKeyRecords().map(self.publicAuthKeyRecord)
    }

    AsyncFunction("extractAuthKeys") {
      (input: [String: Any], platform: String) throws -> [[String: Any]] in
      try self.withLocalFile(input) { url in
        guard let pairs = try self.runtime.call("extractAuthKeys", ["path": url.path, "platform": platform]) as? [[String: Any]] else {
          throw ModuleError("INVALID_LOG", "Unable to extract device keys")
        }
        let records = pairs.map { pair in
          var record = pair
          record["id"] = UUID().uuidString
          return record
        }
        let data = try JSONSerialization.data(withJSONObject: records)
        try self.store.set(String(decoding: data, as: UTF8.self), for: "auth_key_records_v1")
        return records.map(self.publicAuthKeyRecord)
      }
    }

    AsyncFunction("deviceResource") {
      (profileId: String, action: String, id: String?) throws -> Any? in
      try self.ensureNotInstalling()
      guard self.activeProfileId == profileId, let address = self.activeAddress else {
        throw ModuleError("DEVICE_DISCONNECTED", "Connected device changed")
      }
      return try self.runtime.call("resource", ["address": address, "action": action, "id": id ?? ""])
    }

    AsyncFunction("classifyInstallFile") {
      (input: [String: Any]) throws -> [String: Any]? in
      try self.withLocalFile(input) { url in
        let value = try self.runtime.call("classify", [
          "path": url.path,
          "name": input["name"] as? String ?? url.lastPathComponent,
        ])
        return value as? [String: Any]
      }
    }

    AsyncFunction("executeInstall") { (input: [String: Any]) throws in
      guard !self.installing else {
        throw ModuleError("INSTALL_IN_PROGRESS", "Another installation is running")
      }
      self.installing = true
      defer { self.installing = false }
      guard let profileId = input["profileId"] as? String,
            let profile = self.profile(profileId)
      else { throw ModuleError("INVALID_JOB", "profileId is required") }
      if self.activeProfileId != profileId { _ = try self.connectProfile(profileId) }
      try self.withLocalFile(input) { url in
        var request = input
        request["path"] = url.path
        request["address"] = profile["address"]
        _ = try self.runtime.call("install", request)
      }
    }

    AsyncFunction("loadInstallJobs") { () -> [[String: Any]] in
      guard let data = UserDefaults.standard.data(forKey: jobsKey),
            let value = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
      else { return [] }
      return value
    }

    AsyncFunction("saveInstallJobs") { (jobs: [[String: Any]]) throws in
      let data = try JSONSerialization.data(withJSONObject: jobs)
      UserDefaults.standard.set(data, forKey: jobsKey)
    }

    AsyncFunction("getRuntimeLicenses") { () -> [[String: Any]] in
      self.loadRuntimeLicenses()
    }
  }

  private func connectProfile(_ id: String) throws -> [String: Any] {
    guard let profile = profile(id) else {
      throw ModuleError("PROFILE_NOT_FOUND", "Device profile not found")
    }
    if activeProfileId == id { return try refreshSnapshot() }
    disconnectNow()
    sendEvent("connectionChanged", snapshot(profile, state: "connecting"))
    let kind = profile["kind"] as? String ?? "xiaomi"
    let address = profile["address"] as? String ?? ""
    do {
      let mtu = try transport.connect(address: address, kind: kind)
      activeProfileId = id
      activeKind = kind
      activeAddress = address
      ExpoABCoreRuntimeState.shared.set(kind: kind, address: address)
      var request = profile
      request["preferredTransport"] = "ble"
      request["bleMtu"] = mtu
      _ = try runtime.call("connect", request)
      var values = profiles()
      if let index = values.firstIndex(where: { $0["id"] as? String == id }) {
        values[index]["lastConnectedAt"] = Int(Date().timeIntervalSince1970 * 1000)
        try saveProfiles(values)
      }
      let result = try refreshSnapshot()
      sendEvent("connectionChanged", result)
      return result
    } catch {
      disconnectNow()
      sendEvent(
        "connectionChanged",
        snapshot(profile, state: "failed", error: error)
      )
      throw error
    }
  }

  private func disconnectNow() {
    runtime.disconnectCore()
    transport.disconnect()
    let oldId = activeProfileId
    activeProfileId = nil
    activeKind = nil
    activeAddress = nil
    ExpoABCoreRuntimeState.shared.clear()
    if let oldId, let oldProfile = profile(oldId) {
      sendEvent("connectionChanged", snapshot(oldProfile, state: "disconnected"))
    }
  }

  private func refreshSnapshot() throws -> [String: Any] {
    guard let id = activeProfileId, let profile = profile(id),
          let address = profile["address"] as? String
    else { throw ModuleError("NO_DEVICE", "No connected device") }
    let data = try runtime.call("refresh", ["address": address]) as? [String: Any] ?? [:]
    let result = snapshot(profile, state: "connected", data: data)
    sendEvent("deviceSnapshotChanged", result)
    return result
  }

  private func profiles() -> [[String: Any]] {
    let raw = store.string(for: profilesKey, fallback: "[]")
    guard let data = raw.data(using: .utf8),
          let value = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
    else { return [] }
    return value
  }

  private func saveProfiles(_ profiles: [[String: Any]]) throws {
    let data = try JSONSerialization.data(withJSONObject: profiles)
    guard let value = String(data: data, encoding: .utf8) else {
      throw ModuleError("STORE_FAILED", "Unable to encode device profiles")
    }
    try store.set(value, for: profilesKey)
  }

  private func profile(_ id: String?) -> [String: Any]? {
    guard let id else { return nil }
    return profiles().first { $0["id"] as? String == id }
  }

  private func publicProfile(_ profile: [String: Any]) -> [String: Any] {
    var result = profile
    result.removeValue(forKey: "authKey")
    result.removeValue(forKey: "openId")
    result.removeValue(forKey: "phoneDeviceId")
    result["hasCredentials"] =
      !((profile["authKey"] as? String) ?? "").isEmpty
      || !((profile["openId"] as? String) ?? "").isEmpty
    return result
  }

  private func validate(_ profile: [String: Any]) throws {
    let kind = profile["kind"] as? String
    guard kind == "xiaomi" || kind == "vivo" else {
      throw ModuleError("INVALID_PROFILE", "Unsupported device kind")
    }
    guard !((profile["name"] as? String) ?? "").isEmpty,
          !((profile["address"] as? String) ?? "").isEmpty
    else { throw ModuleError("INVALID_PROFILE", "Device name and address are required") }
    if kind == "xiaomi", ((profile["authKey"] as? String) ?? "").isEmpty {
      throw ModuleError("INVALID_PROFILE", "Xiaomi auth key is required")
    }
    if kind == "vivo", ((profile["openId"] as? String) ?? "").isEmpty {
      throw ModuleError("INVALID_PROFILE", "Vivo openId is required")
    }
  }

  private func authKeyRecords() -> [[String: Any]] {
    let raw = store.string(for: "auth_key_records_v1", fallback: "[]")
    return (try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [[String: Any]]) ?? []
  }

  private func publicAuthKeyRecord(_ value: [String: Any]) -> [String: Any] {
    ["id": value["id"] ?? "", "name": value["name"] ?? "", "platform": value["platform"] ?? ""]
  }

  private func resolveAuthKeyRecord(_ profile: inout [String: Any]) throws {
    guard let id = profile.removeValue(forKey: "authKeyRecordId") as? String, !id.isEmpty else { return }
    guard let record = authKeyRecords().first(where: { $0["id"] as? String == id }) else {
      throw ModuleError("KEY_RECORD_NOT_FOUND", "Saved key record no longer exists")
    }
    profile["authKey"] = record["authKey"]
  }

  private func mergeSecrets(
    previous: [String: Any],
    next: [String: Any]
  ) -> [String: Any] {
    var result = next
    if ((result["authKey"] as? String) ?? "").isEmpty {
      result["authKey"] = previous["authKey"]
    }
    if ((result["openId"] as? String) ?? "").isEmpty {
      result["openId"] = previous["openId"]
    }
    if ((result["phoneDeviceId"] as? String) ?? "").isEmpty {
      result["phoneDeviceId"] = previous["phoneDeviceId"]
    }
    return result
  }

  private func snapshot(
    _ profile: [String: Any],
    state: String,
    error: Error? = nil,
    data: [String: Any] = [:]
  ) -> [String: Any] {
    var result: [String: Any] = [
      "profile": publicProfile(profile),
      "connectionState": state,
    ]
    ["info", "status", "storage"].forEach { key in result[key] = data[key] }
    if let error {
      result["errorCode"] = (error as? ModuleError)?.code ?? "CONNECTION_FAILED"
      result["errorMessage"] = (error as? ModuleError)?.moduleMessage ?? error.localizedDescription
    }
    return result
  }

  private func ensureNotInstalling() throws {
    if installing { throw ModuleError("INSTALL_IN_PROGRESS", "Wait for the current installation") }
  }

  private func withLocalFile<T>(
    _ input: [String: Any],
    body: (URL) throws -> T
  ) throws -> T {
    guard let text = input["uri"] as? String, let url = URL(string: text) else {
      throw ModuleError("INVALID_FILE", "File URI is required")
    }
    let accessed = url.startAccessingSecurityScopedResource()
    defer { if accessed { url.stopAccessingSecurityScopedResource() } }
    guard FileManager.default.fileExists(atPath: url.path) else {
      throw ModuleError("FILE_NOT_FOUND", "Installation file does not exist")
    }
    return try body(url)
  }

  private func handleRustEvent(_ name: String, _ payload: [String: Any]) {
    guard name == "installProgress" else { return }
    sendEvent("installJobChanged", [
      "id": payload["id"] ?? "",
      "status": "running",
      "progress": payload["progress"] ?? 0,
    ])
  }

  private func handleDisconnect(_ error: Error?) {
    guard let id = activeProfileId, let profile = profile(id) else { return }
    runtime.disconnectCore()
    activeProfileId = nil
    activeKind = nil
    activeAddress = nil
    ExpoABCoreRuntimeState.shared.clear()
    sendEvent(
      "connectionChanged",
      snapshot(profile, state: "failed", error: error ?? BluetoothError.connectionFailed)
    )
  }

  private func loadRuntimeLicenses() -> [[String: Any]] {
    let candidates = [
      Bundle(for: ExpoABCoreModule.self),
      Bundle.main,
    ]
    for bundle in candidates {
      if let url = bundle.url(forResource: "expo_abcore_licenses", withExtension: "json"),
         let data = try? Data(contentsOf: url),
         let value = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
        return value
      }
    }
    return []
  }
}

private final class ExpoABCoreRuntime {
  private let transport: BluetoothTransport
  private let event: (String, [String: Any]) -> Void

  init(transport: BluetoothTransport, event: @escaping (String, [String: Any]) -> Void) {
    self.transport = transport
    self.event = event
    expo_abcore_init()
    let context = Unmanaged.passUnretained(self).toOpaque()
    expo_abcore_set_callbacks(swiftSendCallback, swiftEventCallback, context)
  }

  func call(_ command: String, _ input: [String: Any]) throws -> Any? {
    let data = try JSONSerialization.data(withJSONObject: input)
    guard let inputJson = String(data: data, encoding: .utf8) else {
      throw ModuleError("JSON_ERROR", "Unable to encode native request")
    }
    let raw = command.withCString { commandPointer in
      inputJson.withCString { inputPointer in
        expo_abcore_call(commandPointer, inputPointer)
      }
    }
    guard let raw else { throw ModuleError("NATIVE_ERROR", "Native call returned null") }
    defer { expo_abcore_string_free(raw) }
    let responseData = Data(String(cString: raw).utf8)
    guard let response = try JSONSerialization.jsonObject(with: responseData) as? [String: Any]
    else { throw ModuleError("NATIVE_ERROR", "Invalid native response") }
    if response["ok"] as? Bool == true { return response["data"] }
    let error = response["error"] as? [String: Any]
    throw ModuleError(
      error?["code"] as? String ?? "NATIVE_ERROR",
      error?["message"] as? String ?? "Native operation failed"
    )
  }

  func onPacket(_ data: Data) {
    guard let kind = currentModuleValue("kind"), let address = currentModuleValue("address") else {
      return
    }
    kind.withCString { kindPointer in
      address.withCString { addressPointer in
        data.withUnsafeBytes { bytes in
          _ = expo_abcore_on_packet(
            kindPointer,
            addressPointer,
            bytes.bindMemory(to: UInt8.self).baseAddress,
            data.count
          )
        }
      }
    }
  }

  func disconnectCore() {
    _ = try? call("disconnect", [:])
  }

  func send(_ data: Data) -> Int32 {
    transport.send(data) ? 0 : -1
  }

  func emit(_ name: String, payload: String) {
    guard let data = payload.data(using: .utf8),
          let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return }
    event(name, value)
  }

  private func currentModuleValue(_ key: String) -> String? {
    // Rust tracks the active device and accepts the same stable identifier used at connect.
    // The callback does not expose it, so the transport owner sets these through thread-local
    // values before connect and packet dispatch uses the profile identifier as its address.
    ExpoABCoreRuntimeState.shared.value(for: key)
  }
}

private final class ExpoABCoreRuntimeState {
  static let shared = ExpoABCoreRuntimeState()
  private let lock = NSLock()
  private var values: [String: String] = [:]

  func set(kind: String, address: String) {
    lock.lock(); defer { lock.unlock() }
    values = ["kind": kind, "address": address]
  }

  func clear() {
    lock.lock(); defer { lock.unlock() }
    values.removeAll()
  }

  func value(for key: String) -> String? {
    lock.lock(); defer { lock.unlock() }
    return values[key]
  }
}

private func swiftSendCallback(
  context: UnsafeMutableRawPointer?,
  data: UnsafePointer<UInt8>?,
  length: Int
) -> Int32 {
  guard let context, let data else { return -1 }
  let runtime = Unmanaged<ExpoABCoreRuntime>.fromOpaque(context).takeUnretainedValue()
  return runtime.send(Data(bytes: data, count: length))
}

private func swiftEventCallback(
  context: UnsafeMutableRawPointer?,
  name: UnsafePointer<CChar>?,
  payload: UnsafePointer<CChar>?
) {
  guard let context, let name, let payload else { return }
  let runtime = Unmanaged<ExpoABCoreRuntime>.fromOpaque(context).takeUnretainedValue()
  runtime.emit(String(cString: name), payload: String(cString: payload))
}

private final class ModuleError: ExpoModulesCore.Exception, @unchecked Sendable {
  let moduleMessage: String

  init(_ code: String, _ message: String) {
    self.moduleMessage = message
    super.init(name: "ExpoABCoreError", description: message, code: code)
  }

  override var reason: String { moduleMessage }
}

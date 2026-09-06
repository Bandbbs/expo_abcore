import CoreBluetooth
import Foundation
import OSLog

struct DiscoveredWearable {
  let name: String
  let address: String
  let kind: String
  let rssi: Int
}

final class BluetoothTransport: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
  var onDiscovery: ((DiscoveredWearable) -> Void)?
  var onPacket: ((Data) -> Void)?
  var onDisconnect: ((Error?) -> Void)?
  var onStateChanged: ((CBManagerState) -> Void)?

  private let queue = DispatchQueue(label: "com.bandbbs.expoabcore.bluetooth")
  private let logger = Logger(subsystem: "com.bandbbs.expoabcore", category: "Bluetooth")
  private let sendLock = NSLock()
  private let stateCondition = NSCondition()
  private lazy var central = CBCentralManager(
    delegate: self,
    queue: queue,
    options: [
      CBCentralManagerOptionRestoreIdentifierKey: "com.bandbbs.expoabcore.central",
      CBCentralManagerOptionShowPowerAlertKey: true,
    ]
  )
  private var peripherals: [UUID: CBPeripheral] = [:]
  private var activePeripheral: CBPeripheral?
  private var serviceProbeCharacteristic: CBCharacteristic?
  private var writeCharacteristic: CBCharacteristic?
  private var notifyCharacteristic: CBCharacteristic?
  private var connectSemaphore: DispatchSemaphore?
  private var servicesSemaphore: DispatchSemaphore?
  private var connectError: Error?
  private var notificationReady = false
  private var expectedKind = "xiaomi"
  private var manualDisconnects = Set<UUID>()

  var authorization: CBManagerAuthorization { CBManager.authorization }

  var isReady: Bool {
    activePeripheral?.state == .connected
      && writeCharacteristic != nil
      && notifyCharacteristic != nil
      && notificationReady
  }

  func ensureInitialized() {
    _ = central
  }

  func waitForAuthorization(timeout: TimeInterval = 15) -> CBManagerAuthorization {
    ensureInitialized()
    let deadline = Date(timeIntervalSinceNow: timeout)
    stateCondition.lock()
    while (central.state == .unknown || authorization == .notDetermined)
      && stateCondition.wait(until: deadline) {}
    stateCondition.unlock()
    return authorization
  }

  func waitUntilPoweredOn(timeout: TimeInterval = 6) throws {
    ensureInitialized()
    let deadline = Date(timeIntervalSinceNow: timeout)
    stateCondition.lock()
    while central.state == .unknown || central.state == .resetting {
      if !stateCondition.wait(until: deadline) { break }
    }
    let state = central.state
    stateCondition.unlock()
    switch state {
    case .poweredOn:
      return
    case .poweredOff:
      throw BluetoothError.poweredOff
    case .unauthorized:
      throw BluetoothError.unauthorized
    case .unsupported:
      throw BluetoothError.unsupported
    case .unknown, .resetting:
      throw BluetoothError.unavailable
    @unknown default:
      throw BluetoothError.unavailable
    }
  }

  func startScan() throws {
    try waitUntilPoweredOn()
    central.stopScan()
    peripherals.removeAll()
    central.scanForPeripherals(
      withServices: nil,
      options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
    )
  }

  func stopScan() {
    central.stopScan()
  }

  func connect(
    address: String,
    kind: String,
    timeout: TimeInterval = 30,
    notificationAuthorizationTimeout: TimeInterval = 120
  ) throws -> Int {
    try waitUntilPoweredOn()
    guard let identifier = UUID(uuidString: address) else { throw BluetoothError.invalidAddress }
    let peripheral = peripherals[identifier]
      ?? central.retrievePeripherals(withIdentifiers: [identifier]).first
    guard let peripheral else { throw BluetoothError.notFound }

    disconnect()
    expectedKind = kind
    activePeripheral = peripheral
    peripheral.delegate = self
    connectError = nil
    if peripheral.state != .connected {
      let connectWaiter = DispatchSemaphore(value: 0)
      connectSemaphore = connectWaiter
      central.connect(peripheral)
      guard connectWaiter.wait(timeout: .now() + timeout) == .success else {
        connectSemaphore = nil
        disconnect()
        throw BluetoothError.timeout
      }
      connectSemaphore = nil
      if let connectError { throw normalizedConnectionError(connectError) }
    }

    connectError = nil
    notificationReady = false
    let servicesWaiter = DispatchSemaphore(value: 0)
    servicesSemaphore = servicesWaiter
    peripheral.discoverServices(nil)
    guard servicesWaiter.wait(timeout: .now() + notificationAuthorizationTimeout) == .success else {
      logger.error("Timed out waiting for BLE services and notification authorization")
      disconnect()
      throw BluetoothError.notificationAuthorizationTimedOut
    }
    servicesSemaphore = nil
    if let connectError { throw normalizedConnectionError(connectError) }
    guard writeCharacteristic != nil, notifyCharacteristic != nil, notificationReady else {
      disconnect()
      throw BluetoothError.characteristicNotFound
    }
    return peripheral.maximumWriteValueLength(for: .withoutResponse) + 3
  }

  func disconnect() {
    let pendingConnect = connectSemaphore
    let pendingServices = servicesSemaphore
    connectError = BluetoothError.connectionFailed
    if let peripheral = activePeripheral {
      manualDisconnects.insert(peripheral.identifier)
      central.cancelPeripheralConnection(peripheral)
    }
    activePeripheral = nil
    serviceProbeCharacteristic = nil
    writeCharacteristic = nil
    notifyCharacteristic = nil
    notificationReady = false
    connectSemaphore = nil
    servicesSemaphore = nil
    pendingConnect?.signal()
    pendingServices?.signal()
  }

  func send(_ data: Data) -> Bool {
    sendLock.lock()
    defer { sendLock.unlock() }
    guard let peripheral = activePeripheral,
          let characteristic = writeCharacteristic,
          peripheral.state == .connected,
          notificationReady
    else {
      logger.error("Rejected a BLE write because the transport is not ready")
      return false
    }
    let type: CBCharacteristicWriteType = characteristic.properties.contains(.writeWithoutResponse)
      ? .withoutResponse
      : .withResponse
    let maxLength = max(20, peripheral.maximumWriteValueLength(for: type))
    for start in stride(from: 0, to: data.count, by: maxLength) {
      let end = min(data.count, start + maxLength)
      peripheral.writeValue(data[start..<end], for: characteristic, type: type)
      if type == .withoutResponse {
        Thread.sleep(forTimeInterval: 0.012)
      }
    }
    return true
  }

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    stateCondition.lock()
    stateCondition.broadcast()
    stateCondition.unlock()
    if let error = stateError(central.state), let peripheral = activePeripheral {
      handleDisconnect(peripheral, error: error)
    }
    onStateChanged?(central.state)
  }

  func centralManager(
    _ central: CBCentralManager,
    willRestoreState dict: [String: Any]
  ) {
    let restored = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral] ?? []
    for peripheral in restored {
      peripherals[peripheral.identifier] = peripheral
      peripheral.delegate = self
    }
  }

  func centralManager(
    _ central: CBCentralManager,
    didDiscover peripheral: CBPeripheral,
    advertisementData: [String: Any],
    rssi RSSI: NSNumber
  ) {
    let name = (advertisementData[CBAdvertisementDataLocalNameKey] as? String)
      ?? peripheral.name
      ?? ""
    let services = advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] ?? []
    let manufacturer = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data
    guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
    let kind = classify(name: name, services: services, manufacturer: manufacturer)
    guard let kind else { return }
    peripherals[peripheral.identifier] = peripheral
    onDiscovery?(
      DiscoveredWearable(
        name: name,
        address: peripheral.identifier.uuidString,
        kind: kind,
        rssi: RSSI.intValue
      )
    )
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    guard activePeripheral?.identifier == peripheral.identifier else {
      manualDisconnects.insert(peripheral.identifier)
      central.cancelPeripheralConnection(peripheral)
      return
    }
    manualDisconnects.remove(peripheral.identifier)
    connectSemaphore?.signal()
  }

  func centralManager(
    _ central: CBCentralManager,
    didFailToConnect peripheral: CBPeripheral,
    error: Error?
  ) {
    manualDisconnects.remove(peripheral.identifier)
    guard activePeripheral?.identifier == peripheral.identifier else { return }
    connectError = error ?? BluetoothError.connectionFailed
    connectSemaphore?.signal()
  }

  func centralManager(
    _ central: CBCentralManager,
    didDisconnectPeripheral peripheral: CBPeripheral,
    timestamp: CFAbsoluteTime,
    isReconnecting: Bool,
    error: Error?
  ) {
    handleDisconnect(peripheral, error: error)
  }

  func centralManager(
    _ central: CBCentralManager,
    didDisconnectPeripheral peripheral: CBPeripheral,
    error: Error?
  ) {
    handleDisconnect(peripheral, error: error)
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    guard activePeripheral?.identifier == peripheral.identifier else { return }
    if let error {
      finishServiceDiscovery(error: error)
      return
    }
    let services = peripheral.services ?? []
    let relevant = services.filter { service in
      let compact = service.uuid.uuidString.replacingOccurrences(of: "-", with: "").lowercased()
      return compact.contains("fe95")
        || compact.contains("0050")
        || compact == "0000276008c211e190730e8ac72e1011"
    }
    if relevant.isEmpty {
      finishServiceDiscovery()
      return
    }
    for service in relevant { peripheral.discoverCharacteristics(nil, for: service) }
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didDiscoverCharacteristicsFor service: CBService,
    error: Error?
  ) {
    guard activePeripheral?.identifier == peripheral.identifier else { return }
    if let error {
      finishServiceDiscovery(error: error)
      return
    }
    for characteristic in service.characteristics ?? [] {
      let compact = characteristic.uuid.uuidString
        .replacingOccurrences(of: "-", with: "")
        .lowercased()
      if expectedKind == "xiaomi", compact.contains("0050") {
        serviceProbeCharacteristic = characteristic
      }
      if compact.contains("005f") || compact == "0000276008c211e190730e8ac72e0011" {
        writeCharacteristic = characteristic
      }
      if compact.contains("005e") || compact == "0000276008c211e190730e8ac72e0012" {
        notifyCharacteristic = characteristic
        if characteristic.isNotifying {
          notificationReady = true
        } else {
          peripheral.setNotifyValue(true, for: characteristic)
        }
      }
    }
    finishServiceDiscoveryIfReady()
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didUpdateNotificationStateFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    guard activePeripheral?.identifier == peripheral.identifier,
          let notifyCharacteristic,
          characteristic === notifyCharacteristic
    else { return }
    if let error {
      logger.error("BLE notification subscription failed: \(error.localizedDescription, privacy: .public)")
      finishServiceDiscovery(error: error)
      return
    }
    guard characteristic.isNotifying else {
      logger.error("BLE notification subscription completed without enabling notifications")
      finishServiceDiscovery(error: BluetoothError.notificationSubscriptionFailed)
      return
    }
    notificationReady = true
    logger.notice("BLE notification subscription is ready")
    finishServiceDiscoveryIfReady()
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didUpdateValueFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    guard activePeripheral?.identifier == peripheral.identifier,
          let notifyCharacteristic,
          characteristic === notifyCharacteristic
    else { return }
    if let error {
      logger.error("BLE notification update failed: \(error.localizedDescription, privacy: .public)")
      return
    }
    guard let value = characteristic.value else { return }
    onPacket?(value)
  }

  private func finishServiceDiscoveryIfReady() {
    guard servicesSemaphore != nil,
          writeCharacteristic != nil,
          notifyCharacteristic != nil,
          notificationReady
    else { return }
    if let peripheral = activePeripheral, let probe = serviceProbeCharacteristic {
      peripheral.readValue(for: probe)
    }
    finishServiceDiscovery()
  }

  private func finishServiceDiscovery(error: Error? = nil) {
    if let error { connectError = error }
    guard let waiter = servicesSemaphore else { return }
    servicesSemaphore = nil
    waiter.signal()
  }

  private func classify(name: String, services: [CBUUID], manufacturer: Data?) -> String? {
    let lowerName = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if lowerName.hasPrefix("vivo watch") || lowerName.hasPrefix("iqoo watch") {
      return "vivo"
    }
    if let manufacturer, manufacturer.count >= 2 {
      let company = UInt16(manufacturer[0]) | UInt16(manufacturer[1]) << 8
      if company == 2103 { return "vivo" }
    }
    let hasXiaomiService = services.contains { uuid in
      let compact = uuid.uuidString.replacingOccurrences(of: "-", with: "").lowercased()
      return compact.contains("fe95") || compact.contains("0050")
    }
    let xiaomiName = ["xiaomi", "redmi", "mi band", "mi watch"].contains {
      lowerName.contains($0)
    }
    return hasXiaomiService || xiaomiName ? "xiaomi" : nil
  }

  private func handleDisconnect(_ peripheral: CBPeripheral, error: Error?) {
    if manualDisconnects.remove(peripheral.identifier) != nil { return }
    guard activePeripheral?.identifier == peripheral.identifier else { return }
    let reportedError = error ?? BluetoothError.connectionFailed
    connectError = reportedError
    connectSemaphore?.signal()
    servicesSemaphore?.signal()
    activePeripheral = nil
    serviceProbeCharacteristic = nil
    writeCharacteristic = nil
    notifyCharacteristic = nil
    notificationReady = false
    onDisconnect?(reportedError)
  }

  private func stateError(_ state: CBManagerState) -> Error? {
    switch state {
    case .poweredOff:
      BluetoothError.poweredOff
    case .unauthorized:
      BluetoothError.unauthorized
    case .unsupported:
      BluetoothError.unsupported
    default:
      nil
    }
  }

  private func normalizedConnectionError(_ error: Error) -> Error {
    let value = error as NSError
    if value.code == CBError.peerRemovedPairingInformation.rawValue
      && (value.domain == CBErrorDomain || value.domain == CBATTErrorDomain) {
      return BluetoothError.pairingInformationRemoved
    }
    return error
  }
}

enum BluetoothError: LocalizedError {
  case unavailable
  case poweredOff
  case unauthorized
  case unsupported
  case invalidAddress
  case notFound
  case timeout
  case connectionFailed
  case characteristicNotFound
  case notificationAuthorizationTimedOut
  case notificationSubscriptionFailed
  case pairingInformationRemoved

  var errorDescription: String? {
    switch self {
    case .unavailable: "Bluetooth is unavailable"
    case .poweredOff: "Bluetooth is turned off"
    case .unauthorized: "Bluetooth permission was denied"
    case .unsupported: "Bluetooth Low Energy is not supported on this device"
    case .invalidAddress: "Invalid peripheral identifier"
    case .notFound: "Bluetooth device not found"
    case .timeout: "Bluetooth connection timed out"
    case .connectionFailed: "Bluetooth connection failed"
    case .characteristicNotFound: "Required wearable characteristics were not found"
    case .notificationAuthorizationTimedOut: "Bluetooth notification authorization timed out"
    case .notificationSubscriptionFailed: "Bluetooth notification subscription failed"
    case .pairingInformationRemoved: "The device removed its Bluetooth pairing information"
    }
  }
}

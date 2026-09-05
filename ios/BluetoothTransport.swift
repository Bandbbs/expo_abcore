import CoreBluetooth
import Foundation

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

  private let queue = DispatchQueue(label: "com.bandbbs.expoabcore.bluetooth")
  private lazy var central = CBCentralManager(delegate: self, queue: queue)
  private var peripherals: [UUID: CBPeripheral] = [:]
  private var activePeripheral: CBPeripheral?
  private var writeCharacteristic: CBCharacteristic?
  private var notifyCharacteristic: CBCharacteristic?
  private var connectSemaphore: DispatchSemaphore?
  private var servicesSemaphore: DispatchSemaphore?
  private var stateSemaphore: DispatchSemaphore?
  private var connectError: Error?
  private var expectedKind = "xiaomi"
  private var manualDisconnects = Set<UUID>()

  var authorization: CBManagerAuthorization { CBManager.authorization }

  func ensureInitialized() {
    _ = central
  }

  func waitForAuthorization(timeout: TimeInterval = 15) -> CBManagerAuthorization {
    ensureInitialized()
    if central.state == .unknown || authorization == .notDetermined {
      let waiter = DispatchSemaphore(value: 0)
      stateSemaphore = waiter
      _ = waiter.wait(timeout: .now() + timeout)
      stateSemaphore = nil
    }
    return authorization
  }

  func startScan() throws {
    ensureInitialized()
    guard central.state == .poweredOn else { throw BluetoothError.unavailable }
    peripherals.removeAll()
    central.scanForPeripherals(
      withServices: nil,
      options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
    )
  }

  func stopScan() {
    central.stopScan()
  }

  func connect(address: String, kind: String, timeout: TimeInterval = 30) throws -> Int {
    ensureInitialized()
    guard central.state == .poweredOn else { throw BluetoothError.unavailable }
    guard let identifier = UUID(uuidString: address) else { throw BluetoothError.invalidAddress }
    let peripheral = peripherals[identifier]
      ?? central.retrievePeripherals(withIdentifiers: [identifier]).first
    guard let peripheral else { throw BluetoothError.notFound }

    disconnect()
    expectedKind = kind
    activePeripheral = peripheral
    peripheral.delegate = self
    connectError = nil
    let connectWaiter = DispatchSemaphore(value: 0)
    connectSemaphore = connectWaiter
    central.connect(peripheral)
    guard connectWaiter.wait(timeout: .now() + timeout) == .success else {
      central.cancelPeripheralConnection(peripheral)
      throw BluetoothError.timeout
    }
    if let connectError { throw connectError }

    let servicesWaiter = DispatchSemaphore(value: 0)
    servicesSemaphore = servicesWaiter
    peripheral.discoverServices(nil)
    guard servicesWaiter.wait(timeout: .now() + timeout) == .success else {
      disconnect()
      throw BluetoothError.timeout
    }
    guard writeCharacteristic != nil, notifyCharacteristic != nil else {
      disconnect()
      throw BluetoothError.characteristicNotFound
    }
    return peripheral.maximumWriteValueLength(for: .withoutResponse) + 3
  }

  func disconnect() {
    if let peripheral = activePeripheral {
      manualDisconnects.insert(peripheral.identifier)
      central.cancelPeripheralConnection(peripheral)
    }
    activePeripheral = nil
    writeCharacteristic = nil
    notifyCharacteristic = nil
    connectSemaphore = nil
    servicesSemaphore = nil
  }

  func send(_ data: Data) -> Bool {
    guard let peripheral = activePeripheral,
          let characteristic = writeCharacteristic,
          peripheral.state == .connected
    else { return false }
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
    stateSemaphore?.signal()
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
    manualDisconnects.remove(peripheral.identifier)
    connectSemaphore?.signal()
  }

  func centralManager(
    _ central: CBCentralManager,
    didFailToConnect peripheral: CBPeripheral,
    error: Error?
  ) {
    manualDisconnects.remove(peripheral.identifier)
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
    if let error {
      connectError = error
      servicesSemaphore?.signal()
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
      servicesSemaphore?.signal()
      return
    }
    for service in relevant { peripheral.discoverCharacteristics(nil, for: service) }
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didDiscoverCharacteristicsFor service: CBService,
    error: Error?
  ) {
    if let error { connectError = error }
    for characteristic in service.characteristics ?? [] {
      let compact = characteristic.uuid.uuidString
        .replacingOccurrences(of: "-", with: "")
        .lowercased()
      if compact.contains("005f") || compact == "0000276008c211e190730e8ac72e0011" {
        writeCharacteristic = characteristic
      }
      if compact.contains("005e") || compact == "0000276008c211e190730e8ac72e0012" {
        notifyCharacteristic = characteristic
        peripheral.setNotifyValue(true, for: characteristic)
      }
    }
    if writeCharacteristic != nil, notifyCharacteristic != nil {
      servicesSemaphore?.signal()
      servicesSemaphore = nil
    }
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didUpdateValueFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    guard error == nil, let value = characteristic.value else { return }
    onPacket?(value)
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
    activePeripheral = nil
    writeCharacteristic = nil
    notifyCharacteristic = nil
    onDisconnect?(error)
  }
}

enum BluetoothError: LocalizedError {
  case unavailable
  case invalidAddress
  case notFound
  case timeout
  case connectionFailed
  case characteristicNotFound

  var errorDescription: String? {
    switch self {
    case .unavailable: "Bluetooth is unavailable"
    case .invalidAddress: "Invalid peripheral identifier"
    case .notFound: "Bluetooth device not found"
    case .timeout: "Bluetooth connection timed out"
    case .connectionFailed: "Bluetooth connection failed"
    case .characteristicNotFound: "Required wearable characteristics were not found"
    }
  }
}

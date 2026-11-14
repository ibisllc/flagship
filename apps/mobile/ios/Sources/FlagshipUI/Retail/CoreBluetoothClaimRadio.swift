import Foundation
import CoreBluetooth
import FlagshipCore

/// The retail claim over Core Bluetooth (docs/retail-box-setup.md §11.2). Not AccessorySetupKit:
/// its picker hides how many boxes advertise, and the presence rule needs every advert.
public final class CoreBluetoothClaimRadio: NSObject, BoxClaimRadio, CBCentralManagerDelegate, @unchecked Sendable {
    private let queue = DispatchQueue(label: "flagship.retail-claim.ble")
    private var central: CBCentralManager?
    private var onState: ((CBManagerState) -> Void)?
    private var onAdverts: (@Sendable ([BoxClaimAdvert]) -> Void)?
    private var seen: [UUID: (advert: BoxClaimAdvert, at: Date)] = [:]
    private var peripherals: [UUID: CBPeripheral] = [:]
    private var reportTimer: DispatchSourceTimer?
    private var links: [UUID: CoreBluetoothClaimLink] = [:]

    static let service = CBUUID(string: BoxClaim.bleServiceUUID)
    static let inbox = CBUUID(string: BoxClaim.bleInboxUUID)
    static let outbox = CBUUID(string: BoxClaim.bleOutboxUUID)
    /// An advert not heard again within this long counts as gone.
    static let staleAfter: TimeInterval = 5

    public override init() { super.init() }

    private func ready() async throws {
        let state: CBManagerState = await withCheckedContinuation { c in
            queue.async {
                if let central = self.central, central.state != .unknown, central.state != .resetting {
                    c.resume(returning: central.state)
                    return
                }
                self.onState = { s in c.resume(returning: s) }
                if self.central == nil { self.central = CBCentralManager(delegate: self, queue: self.queue) }
            }
        }
        switch state {
        case .poweredOn: return
        case .poweredOff: throw BoxClaimRadioError.bluetoothOff
        case .unauthorized: throw BoxClaimRadioError.notAllowed
        default: throw BoxClaimRadioError.unsupported
        }
    }

    public func startScan(onAdverts: @escaping @Sendable ([BoxClaimAdvert]) -> Void) async throws {
        try await ready()
        queue.async {
            self.onAdverts = onAdverts
            self.seen = [:]
            self.central?.scanForPeripherals(withServices: [Self.service], options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
            let t = DispatchSource.makeTimerSource(queue: self.queue)
            t.schedule(deadline: .now() + 1, repeating: 1)
            t.setEventHandler { [weak self] in self?.report() }
            t.resume()
            self.reportTimer?.cancel()
            self.reportTimer = t
            self.report()
        }
    }

    private func report() {
        let now = Date()
        seen = seen.filter { now.timeIntervalSince($0.value.at) < Self.staleAfter }
        onAdverts?(seen.values.map(\.advert).sorted { $0.advertId < $1.advertId })
    }

    public func stopScan() {
        queue.async {
            self.central?.stopScan()
            self.reportTimer?.cancel()
            self.reportTimer = nil
            self.onAdverts = nil
        }
    }

    public func connect(_ advert: BoxClaimAdvert) async throws -> any BoxClaimLink {
        guard let id = UUID(uuidString: advert.peripheral) else { throw BoxClaimRadioError.connectFailed }
        let peripheral: CBPeripheral = try await withCheckedThrowingContinuation { c in
            queue.async {
                guard let p = self.peripherals[id], let central = self.central else {
                    c.resume(throwing: BoxClaimRadioError.connectFailed)
                    return
                }
                central.connect(p)
                self.pendingConnect[id] = (p, c)
            }
        }
        let link = CoreBluetoothClaimLink(peripheral: peripheral, queue: queue) { [weak self] in
            self?.queue.async { if let c = self?.central { c.cancelPeripheralConnection(peripheral) } }
        }
        queue.sync { links[id] = link }
        try await link.open()
        return link
    }

    private var pendingConnect: [UUID: (CBPeripheral, CheckedContinuation<CBPeripheral, Error>)] = [:]

    // MARK: CBCentralManagerDelegate (on `queue`)

    public func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard central.state != .unknown, central.state != .resetting else { return }
        let cb = onState
        onState = nil
        cb?(central.state)
        if central.state != .poweredOn {
            for l in links.values { l.fail() }
        }
    }

    public func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                               advertisementData: [String: Any], rssi RSSI: NSNumber) {
        peripherals[peripheral.identifier] = peripheral
        let data = (advertisementData[CBAdvertisementDataServiceDataKey] as? [CBUUID: Data])?[Self.service]
        let parsed = data.flatMap { BoxClaim.parseAdvert(serviceData: Array($0)) }
        let advert = BoxClaimAdvert(peripheral: peripheral.identifier.uuidString,
                                    advertId: parsed?.id ?? peripheral.identifier.uuidString,
                                    state: parsed?.state ?? .unclaimed)
        let had = seen[peripheral.identifier]?.advert
        seen[peripheral.identifier] = (advert, Date())
        if had != advert { report() }
    }

    public func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        if let (p, c) = pendingConnect.removeValue(forKey: peripheral.identifier) { c.resume(returning: p) }
    }

    public func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        if let (_, c) = pendingConnect.removeValue(forKey: peripheral.identifier) { c.resume(throwing: BoxClaimRadioError.connectFailed) }
    }

    public func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        if let (_, c) = pendingConnect.removeValue(forKey: peripheral.identifier) { c.resume(throwing: BoxClaimRadioError.connectFailed) }
        links.removeValue(forKey: peripheral.identifier)?.fail()
    }
}

/// One GATT link: frames out on the inbox characteristic, frames in as outbox notifications.
final class CoreBluetoothClaimLink: NSObject, BoxClaimLink, CBPeripheralDelegate, @unchecked Sendable {
    private let peripheral: CBPeripheral
    private let queue: DispatchQueue
    private let disconnect: () -> Void
    private var inbox: CBCharacteristic?
    private var opening: CheckedContinuation<Void, Error>?
    private var writing: CheckedContinuation<Void, Error>?
    private var readyToWrite: CheckedContinuation<Void, Never>?
    private let reassembler = BoxClaim.Reassembler()
    private var messages: [[UInt8]] = []
    private var receiving: CheckedContinuation<[UInt8], Error>?
    private var closed = false

    init(peripheral: CBPeripheral, queue: DispatchQueue, disconnect: @escaping () -> Void) {
        self.peripheral = peripheral
        self.queue = queue
        self.disconnect = disconnect
        super.init()
    }

    func open() async throws {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            queue.async {
                self.opening = c
                self.peripheral.delegate = self
                self.peripheral.discoverServices([CoreBluetoothClaimRadio.service])
            }
        }
    }

    private func finishOpen(_ error: Error?) {
        let c = opening
        opening = nil
        if let error { c?.resume(throwing: error) } else { c?.resume() }
    }

    func send(_ message: [UInt8]) async throws {
        let (withResponse, mtu): (Bool, Int) = queue.sync {
            let props = inbox?.properties ?? []
            let wr = !props.contains(.writeWithoutResponse)
            return (wr, peripheral.maximumWriteValueLength(for: wr ? .withResponse : .withoutResponse))
        }
        guard let ch = queue.sync(execute: { inbox }), !queue.sync(execute: { closed }) else { throw BoxClaimRadioError.linkClosed }
        for frame in try BoxClaim.fragment(message, mtu: max(20, min(mtu, 512))) {
            if withResponse {
                try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
                    queue.async {
                        self.writing = c
                        self.peripheral.writeValue(Data(frame), for: ch, type: .withResponse)
                    }
                }
            } else {
                await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                    queue.async {
                        if self.peripheral.canSendWriteWithoutResponse { c.resume() } else { self.readyToWrite = c }
                    }
                }
                queue.sync { peripheral.writeValue(Data(frame), for: ch, type: .withoutResponse) }
            }
        }
    }

    func receive() async throws -> [UInt8] {
        try await withCheckedThrowingContinuation { c in
            queue.async {
                if !self.messages.isEmpty { c.resume(returning: self.messages.removeFirst()); return }
                if self.closed { c.resume(throwing: BoxClaimRadioError.linkClosed); return }
                self.receiving = c
            }
        }
    }

    func close() {
        queue.async {
            guard !self.closed else { return }
            self.fail()
            self.disconnect()
        }
    }

    /// The link ended (on `queue`).
    func fail() {
        closed = true
        finishOpen(BoxClaimRadioError.linkClosed)
        writing?.resume(throwing: BoxClaimRadioError.linkClosed); writing = nil
        readyToWrite?.resume(); readyToWrite = nil
        receiving?.resume(throwing: BoxClaimRadioError.linkClosed); receiving = nil
    }

    // MARK: CBPeripheralDelegate (on `queue`)

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard error == nil, let s = peripheral.services?.first(where: { $0.uuid == CoreBluetoothClaimRadio.service }) else {
            return finishOpen(BoxClaimRadioError.connectFailed)
        }
        peripheral.discoverCharacteristics([CoreBluetoothClaimRadio.inbox, CoreBluetoothClaimRadio.outbox], for: s)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        let chars = service.characteristics ?? []
        guard error == nil, let i = chars.first(where: { $0.uuid == CoreBluetoothClaimRadio.inbox }),
              let o = chars.first(where: { $0.uuid == CoreBluetoothClaimRadio.outbox }) else {
            return finishOpen(BoxClaimRadioError.connectFailed)
        }
        inbox = i
        peripheral.setNotifyValue(true, for: o)
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        finishOpen(error == nil && characteristic.isNotifying ? nil : BoxClaimRadioError.connectFailed)
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        let c = writing
        writing = nil
        if error != nil { c?.resume(throwing: BoxClaimRadioError.linkClosed) } else { c?.resume() }
    }

    func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
        readyToWrite?.resume(); readyToWrite = nil
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard error == nil, characteristic.uuid == CoreBluetoothClaimRadio.outbox, let v = characteristic.value else { return }
        do {
            guard let whole = try reassembler.push(Array(v)) else { return }
            if let r = receiving { receiving = nil; r.resume(returning: whole) } else { messages.append(whole) }
        } catch {
            fail()
            disconnect()
        }
    }
}

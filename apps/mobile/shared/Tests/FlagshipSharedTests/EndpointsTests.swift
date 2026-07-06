import XCTest
@testable import FlagshipAPI
@testable import FlagshipCore

/// `Endpoints` (G2) — the single apex accessor. Pins the prod-default
/// invariant (no override ⇒ today's literal byte-for-byte, so the live app
/// is unchanged) and the gym test-build override (one knob retargets the
/// whole stack, control + data + sub-origins).
final class EndpointsTests: XCTestCase {
    override func tearDown() {
        Endpoints.setOverride(nil) // never leak an override across tests
        super.tearDown()
    }

    func test_prodDefault_isTodaysLiteral() {
        Endpoints.setOverride(nil)
        XCTAssertEqual(Endpoints.controlHost, "flagshipserver.com")
        XCTAssertEqual(Endpoints.controlBaseUrl.absoluteString, "https://flagshipserver.com")
        XCTAssertEqual(Endpoints.dataApex, "flagship.services")
        XCTAssertEqual(Endpoints.bootBaseUrl.absoluteString, "https://boot.flagshipserver.com")
        XCTAssertEqual(Endpoints.recoveryBaseUrl.absoluteString, "https://recovery.flagshipserver.com")
        XCTAssertEqual(Endpoints.webappHost, "web.flagshipserver.com")
        XCTAssertEqual(Endpoints.registrationUrl, "https://flagshipserver.com/api/server/register")
        XCTAssertEqual(Endpoints.serverFqdn(server: "home", user: "harry"), "home.harry.flagship.services")
        XCTAssertEqual(Endpoints.userZoneHost("harry"), "harry.flagship.services")
    }

    func test_gymOverride_retargetsTheWholeStack() {
        Endpoints.setOverride(controlHost: "gym.flagshipserver.com")
        XCTAssertEqual(Endpoints.controlHost, "gym.flagshipserver.com")
        XCTAssertEqual(Endpoints.controlBaseUrl.absoluteString, "https://gym.flagshipserver.com")
        // The data plane mirrors the gym prefix.
        XCTAssertEqual(Endpoints.dataApex, "gym.flagship.services")
        XCTAssertEqual(Endpoints.serverFqdn(server: "home", user: "harry"), "home.harry.gym.flagship.services")
        XCTAssertEqual(Endpoints.userZoneHost("harry"), "harry.gym.flagship.services")
        // Sub-origins ride the gym apex.
        XCTAssertEqual(Endpoints.bootBaseUrl.absoluteString, "https://boot.gym.flagshipserver.com")
        XCTAssertEqual(Endpoints.recoveryBaseUrl.absoluteString, "https://recovery.gym.flagshipserver.com")
        XCTAssertEqual(Endpoints.webappHost, "web.gym.flagshipserver.com")
        XCTAssertEqual(Endpoints.registrationUrl, "https://gym.flagshipserver.com/api/server/register")
    }

    func test_dataApexFor_mapsControlHostToSiblingDataApex() {
        XCTAssertEqual(Endpoints.dataApexFor(controlHost: "flagshipserver.com"), "flagship.services")
        XCTAssertEqual(Endpoints.dataApexFor(controlHost: "gym.flagshipserver.com"), "gym.flagship.services")
        // An unknown host floors to the prod data apex (never silently odd).
        XCTAssertEqual(Endpoints.dataApexFor(controlHost: "example.com"), "flagship.services")
    }

    func test_setOverride_nil_restoresProdDefault() {
        Endpoints.setOverride(controlHost: "gym.flagshipserver.com")
        Endpoints.setOverride(nil)
        XCTAssertEqual(Endpoints.controlHost, "flagshipserver.com")
        XCTAssertEqual(Endpoints.dataApex, "flagship.services")
    }

    func test_clientDefaults_followEndpoints() {
        // The live clients' static base URLs derive from Endpoints, so prod is
        // unchanged and a gym override flows through with no extra wiring.
        Endpoints.setOverride(nil)
        XCTAssertEqual(LiveFlagshipServerClient.defaultBaseUrl.absoluteString, "https://flagshipserver.com")
        XCTAssertEqual(LiveSecretMailboxClient.defaultBaseUrl.absoluteString, "https://flagshipserver.com")
        XCTAssertEqual(LiveSecretMailboxClient.defaultBootBaseUrl.absoluteString, "https://boot.flagshipserver.com")
        XCTAssertEqual(LiveQrRelayClient.defaultHost, "flagshipserver.com")

        Endpoints.setOverride(controlHost: "gym.flagshipserver.com")
        XCTAssertEqual(LiveFlagshipServerClient.defaultBaseUrl.absoluteString, "https://gym.flagshipserver.com")
        XCTAssertEqual(LiveSecretMailboxClient.defaultBootBaseUrl.absoluteString, "https://boot.gym.flagshipserver.com")
        XCTAssertEqual(LiveQrRelayClient.defaultHost, "gym.flagshipserver.com")
    }

    func test_coreTypes_followEndpoints() {
        Endpoints.setOverride(nil)
        XCTAssertEqual(PairingQr.joinHost, "flagshipserver.com")
        XCTAssertEqual(QrRelay.qrUrlHost, "flagshipserver.com")
        XCTAssertEqual(CompanionTicketURL.webappHost, "web.flagshipserver.com")

        Endpoints.setOverride(controlHost: "gym.flagshipserver.com")
        XCTAssertEqual(PairingQr.joinHost, "gym.flagshipserver.com")
        XCTAssertEqual(QrRelay.qrUrlHost, "gym.flagshipserver.com")
        XCTAssertEqual(CompanionTicketURL.webappHost, "web.gym.flagshipserver.com")
    }

    func test_installBlob_registrationUrlDefault_isProd_unlessOverridden() {
        Endpoints.setOverride(nil)
        let prod = InstallBlob(
            serverDomain: "home.harry.flagship.services",
            username: "harry",
            serverName: "home",
            phoneDelegatedPubKey: Data(repeating: 1, count: 32),
            authCode: sampleAuthCode(),
            authCodeUserSignature: Data(repeating: 2, count: 64),
            rckPubKey: Data(repeating: 3, count: 32)
        )
        XCTAssertEqual(prod.registrationUrl, "https://flagshipserver.com/api/server/register")
    }

    // A minimal AuthCode for the InstallBlob default-arg test. Field names
    // mirror the daemon wire shape; values are placeholders.
    private func sampleAuthCode() -> AuthCode {
        AuthCode(
            version: 1,
            serial: "0123456789abcdef",
            username: "harry",
            serverName: "home",
            serverDomain: "home.harry.flagship.services",
            delegatedPubKey: Data(repeating: 1, count: 32),
            userPubKey: Data(repeating: 4, count: 32),
            issuedAt: 1_700_000_000_000,
            expiresAt: 1_700_000_900_000
        )
    }
}

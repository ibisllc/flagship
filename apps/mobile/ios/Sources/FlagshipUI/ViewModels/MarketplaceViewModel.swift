import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

@Observable
@MainActor
public final class MarketplaceViewModel {
    public private(set) var state: LoadingState<[MarketplaceListing]> = .idle
    public var searchQuery: String = ""

    private let client: any ScreensClient
    /// Signing seam — production derives the OWNER IRK from the Keystore
    /// (biometric on every install). Tests inject a fixed key so the recorded
    /// signature is verifiable. Mirror of FrontPageViewModel.signer + Android
    /// MarketplaceViewModel.signer.
    private let signer: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    private let now: () -> Int64

    public init(
        client: any ScreensClient,
        signer: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.client = client
        self.now = now
        self.signer = signer ?? { reason in try await Keystore.deriveIRK(reason: reason) }
    }

    public var filtered: [MarketplaceListing] {
        guard let listings = state.value else { return [] }
        if searchQuery.isEmpty { return listings }
        let q = searchQuery.lowercased()
        return listings.filter {
            $0.title.lowercased().contains(q)
                || $0.summary.lowercased().contains(q)
                || $0.creator.lowercased().contains(q)
        }
    }

    public func load() async {
        state = .loading
        do {
            let resp = try await client.marketplaceBrowse()
            state = .loaded(resp.listings)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    // MARK: - Install (parity with Android MarketplaceViewModel + the webapp
    // installFromMarketplace flow)

    /// Per-install lifecycle for the detail screen's CTA.
    public enum InstallState: Equatable, Sendable {
        case idle
        case installing
        case succeeded(serviceId: String)
        /// The listing is paid and not yet owned (.com install gate → 402). The
        /// screen routes the owner to checkout for `priceUsdCents`.
        case paymentRequired(priceUsdCents: Int)
        case failed(String)
    }

    public private(set) var installState: InstallState = .idle
    public func resetInstall() { installState = .idle }

    /// Install `creator`/`slug` onto the box at `serverId` (the pod's FQDN).
    /// Two-step like Android / the webapp: fetch the full listing for its
    /// carried `manifestJson`, verify the manifest hashes to the listing's
    /// committed `manifestHash` (reject a swapped manifest), sign the canonical
    /// bytes with the OWNER IRK (biometric), and POST the envelope to the box.
    /// A paid app the account doesn't own surfaces as `.paymentRequired`.
    public func install(creator: String, slug: String, serverId: String) async {
        installState = .installing
        let detail: MarketplaceListingDetail
        do {
            detail = try await client.marketplaceFetchListing(creator: creator, slug: slug)
        } catch {
            installState = .failed(installErrorText(error, fallback: "Couldn't fetch the listing."))
            return
        }

        // The manifest is carried on the listing but not in the signed canonical
        // bytes; bind it by re-checking it hashes to the committed manifestHash.
        if !detail.manifestHash.isEmpty,
           detail.manifestHash.lowercased() != manifestSha256Hex(detail.manifestJson) {
            installState = .failed("Manifest hash mismatch — refusing to install a tampered listing.")
            return
        }

        let request = InstallServiceRequest(
            serverId: serverId,
            creator: creator,
            slug: slug,
            manifestJson: detail.manifestJson,
            addOwnerToMembership: true,
            issuedAt: now()
        )

        let key: Curve25519.Signing.PrivateKey
        do {
            key = try await signer("Install \(creator)/\(slug)")
        } catch {
            installState = .failed("Couldn't access your account key: \(error.localizedDescription)")
            return
        }

        let signature: Data
        do {
            signature = try key.signature(for: installServiceCanonicalBytes(request))
        } catch {
            installState = .failed("Couldn't sign the install order: \(error.localizedDescription)")
            return
        }

        do {
            let resp = try await client.installFromMarketplace(
                InstallServiceEnvelope(request: request, signature: HexUtil.encode(signature))
            )
            installState = .succeeded(serviceId: resp.serviceId)
        } catch let e as ScreensClientError {
            // Paid-app gate: .com returns 402 with a `price_usd_cents` body when
            // the app must be purchased first. Route the owner to checkout.
            if case .http(let status, let message) = e, status == 402 {
                installState = .paymentRequired(priceUsdCents: parsePriceUsdCents(message))
                return
            }
            installState = .failed(e.errorDescription ?? "That install didn't take. Try again in a moment.")
        } catch {
            installState = .failed(installErrorText(error, fallback: "Couldn't reach the box."))
        }
    }

    private func installErrorText(_ error: Error, fallback: String) -> String {
        if let e = error as? ScreensClientError { return e.errorDescription ?? fallback }
        return fallback
    }

    /// Best-effort parse of `price_usd_cents` out of a 402 body. Returns 0 when
    /// the field is absent/unparseable — the screen still shows a purchase CTA.
    private func parsePriceUsdCents(_ message: String) -> Int {
        guard let data = message.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let cents = obj["price_usd_cents"] as? Int else {
            return 0
        }
        return cents
    }
}

import StoreKit
import SwiftUI

struct PaywallView: View {
    let product: Product?

    var body: some View {
        VStack {
            if let product {
                Text("ReceiptLoop Monthly · \(product.displayPrice) per month")
                    .accessibilityIdentifier("paywall.price")
                Text("Billed monthly")
                    .accessibilityIdentifier("paywall.period")
                Text("7-day free trial, then renews monthly at the displayed price. Cancel anytime.")
                    .accessibilityIdentifier("paywall.offer")
                Link("Terms of Use", destination: URL(string: "https://example.com/terms")!)
                Link("Privacy Policy", destination: URL(string: "https://example.com/privacy")!)
                Button("Subscribe for \(product.displayPrice) per month") {
                    Task { _ = try? await product.purchase() }
                }
                .accessibilityIdentifier("paywall.purchase")
            } else {
                ProgressView("Loading price")
                Button("Price unavailable") {}
                    .disabled(true)
                    .accessibilityIdentifier("paywall.purchase")
            }
        }
    }
}

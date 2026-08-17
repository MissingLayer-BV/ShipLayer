import StoreKit
import SwiftUI

struct PaywallView: View {
    let product: Product

    var body: some View {
        VStack {
            Text("ReceiptLoop Monthly · \(product.displayPrice)")
                .accessibilityIdentifier("paywall.price")
            Button("Subscribe for \(product.displayPrice)") {
                Task { _ = try? await product.purchase() }
            }
        }
    }
}

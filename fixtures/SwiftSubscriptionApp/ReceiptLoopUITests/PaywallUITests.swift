import XCTest

final class PaywallUITests: XCTestCase {
    func testLocalizedPriceIsVisibleBeforePurchase() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts["paywall.price"].waitForExistence(timeout: 5))
    }
}

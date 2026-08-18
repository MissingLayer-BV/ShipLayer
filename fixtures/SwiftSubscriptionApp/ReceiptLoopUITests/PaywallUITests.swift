import XCTest

final class PaywallUITests: XCTestCase {
    func testLocalizedPriceIsVisibleBeforePurchase() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts["paywall.price"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["paywall.period"].exists)
        XCTAssertTrue(app.staticTexts["paywall.offer"].exists) // free trial terms
        XCTAssertTrue(app.links["Terms of Use"].exists)
        XCTAssertTrue(app.links["Privacy Policy"].exists)
    }

    func testPurchaseIsDisabledUntilProductLoads() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing-product-unavailable"]
        app.launch()
        XCTAssertFalse(app.buttons["paywall.purchase"].isEnabled)
    }
}

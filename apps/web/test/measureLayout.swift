import AppKit
import WebKit

struct Fixture: Decodable {
    let html: String
    let measure: String
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(EXIT_FAILURE)
}

final class Measurement: NSObject, WKNavigationDelegate {
    let expression: String

    init(_ expression: String) { self.expression = expression }

    func webView(_ view: WKWebView, didFinish navigation: WKNavigation!) {
        view.evaluateJavaScript(expression) { value, error in
            if let error { fail("Layout measurement failed: \(error)") }
            guard let value else { fail("Layout measurement returned no value") }
            do {
                let json = try JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed)
                FileHandle.standardOutput.write(json)
                exit(EXIT_SUCCESS)
            } catch { fail("Could not encode layout measurement: \(error)") }
        }
    }

    func webView(_ view: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fail("Could not load layout fixture: \(error)")
    }

    func webView(_ view: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fail("Could not load layout fixture: \(error)")
    }

    func webViewWebContentProcessDidTerminate(_ view: WKWebView) { fail("WebKit terminated during layout measurement") }
}

NSApplication.shared.setActivationPolicy(.prohibited)
guard NSApp.activationPolicy() == .prohibited else { fail("Could not prohibit application activation") }
do {
    let fixture = try JSONDecoder().decode(Fixture.self, from: FileHandle.standardInput.readDataToEndOfFile())
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    config.mediaTypesRequiringUserActionForPlayback = .all
    let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 1280, height: 900), configuration: config)
    let measurement = Measurement(fixture.measure)
    view.navigationDelegate = measurement
    view.loadHTMLString(fixture.html, baseURL: nil)
    DispatchQueue.main.asyncAfter(deadline: .now() + 10) { fail("Timed out loading or measuring layout") }
    // No window is needed for WebKit to resolve layout on a view with a frame.
    withExtendedLifetime((view, measurement)) { RunLoop.main.run() }
    fail("WebKit stopped before returning the layout measurement")
} catch { fail("Invalid layout fixture: \(error)") }

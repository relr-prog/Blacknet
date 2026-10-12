# Manual proxy leak check

This procedure checks the current desktop implementation on the machine where
it runs. It is not a certification and does not prove that every operating
system, Chromium build, or proxy provider behaves identically.

## Fail-closed behavior

1. Configure a test upstream and enable the IP rotator in BlackNet.
2. Load a normal HTTPS page and confirm the rotator reports a running gateway.
3. Stop the gateway process while leaving the browser and its proxy setting on.
4. Navigate to a fresh external URL and load a page containing an external
   resource. The navigation and resource requests should be blocked; they must
   not reach their destination directly.
5. Turn the proxy setting off explicitly and confirm that direct browsing is
   then allowed. Direct mode is intentional and is the default.

The desktop request guard blocks network requests when the rotator is wanted
but unavailable, or when the active tab's session has not applied the reported
gateway address. It does not govern traffic from other applications or prove
that a running upstream itself is healthy.

## DNS and WebRTC

Use a controlled test domain and a DNS resolver/logging service you trust. With
the proxy enabled, visit a unique, never-before-used hostname and capture
packets on the browser machine's active network interface. Verify that the
machine does not send a DNS query for that hostname directly to its configured
resolver; expected proxy/gateway traffic depends on the chosen upstream. Repeat
after restarting the browser and with a fresh hostname. DNS prefetch and
operating-system resolver behavior can vary, so a passing single request is not
a general guarantee.

For WebRTC, use a test page you control that creates an `RTCPeerConnection` and
reports gathered ICE candidates. With the proxy enabled, check that no
non-proxied public or private host candidate is exposed. BlackNet asks Chromium
to disable non-proxied UDP; this is not a guarantee against every WebRTC,
browser, or platform leak.

Do not include credentials or personal network details in issue reports. Share
only sanitized packet summaries and the BlackNet version when reporting a
reproducible leak.

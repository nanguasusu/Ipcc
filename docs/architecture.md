# Architecture

## Measurement model

All latency and stability probes run in the visitor's browser. This is the only
way to measure the visitor-to-proxy-to-target path. The Cloudflare Worker serves
the application and provides `/api/ip`, which describes the connection that
arrived at Cloudflare; it never probes third-party test targets on behalf of a
visitor.

## Data flow

On load, the app requests `/api/ip` once with `Cache-Control: no-store`. The
browser then runs independent target probes with a five-second `AbortController`
timeout and cache-busted URLs. CORS-readable responses report HTTP status;
opaque responses report only reachability. Histories remain in browser
`localStorage` and are never sent to the Worker.

## Worker privacy boundaries

The Worker does not write to D1, KV, R2, Analytics Engine, or logs. When an
`IPINFO_TOKEN` secret is configured, a lookup sends the detected IP to IPinfo
only for the active request, enabling its privacy classification; without that
secret the app returns Cloudflare-native network information and labels type as
`Unknown`.

## Browser limitations

HTTP latency is not ICMP ping, and Request Loss is failed/timed-out HTTP probes,
not packet loss. Browser CORS can prevent reading a response even when a target
is reachable. A separate A-only and AAAA-only probe endpoint must be configured
at deployment time for definitive IPv4/IPv6 availability checks. Browser APIs
cannot reliably reveal the current recursive DNS resolver.

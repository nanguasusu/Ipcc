# Network Lens

A privacy-first network quality dashboard for proxy, VPN and transit users.

## Features

- Cloudflare-origin public IP, ASN, location and time zone lookup
- Browser-side target probes with CORS-aware reachability status
- Limited-concurrency stability sampling, P50/P95, jitter and Request Loss
- WebRTC ICE candidate visibility, local-only history and JSON export
- Dark and light interfaces, mobile responsive layout, no server-side history

## Development

Run `npm run dev`, then open the printed local URL. Run `npm run build` before
deployment.

## Cloudflare deployment

The generated Vite/Sites build produces a Cloudflare Worker-compatible output.
Deploy with the configured Sites workflow or adapt the `dist` output to a
Worker Static Assets deployment. Configure an optional `IPINFO_TOKEN` Worker
secret to enable third-party privacy classification. Do not add a database.

For authoritative protocol checks, deploy two controlled health endpoints: one
hostname with only an A record and one with only an AAAA record, then set their
URLs in the client configuration.

## Privacy and limits

History is stored only in the browser. The IP endpoint is uncached, same-origin
only, and has a best-effort per-isolate rate limit. HTTP latency is not ICMP
ping; Request Loss is request failure rate, not packet loss. CORS can make a
target unreadable even when it is reachable.

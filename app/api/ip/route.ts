import { NextRequest } from 'next/server';

export const runtime = 'edge';

type CloudflareRequest = NextRequest & {
  cf?: {
    asn?: number;
    asOrganization?: string;
    city?: string;
    country?: string;
    region?: string;
    timezone?: string;
    colo?: string;
  };
};

const windowMs = 60_000;
const maxRequests = 24;
const requestBuckets = new Map<string, { count: number; resetAt: number }>();

function response(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      'Content-Security-Policy': "default-src 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    },
  });
}

function isRateLimited(ip: string) {
  const now = Date.now();
  const bucket = requestBuckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    requestBuckets.set(ip, { count: 1, resetAt: now + windowMs });
    return false;
  }
  bucket.count += 1;
  return bucket.count > maxRequests;
}

function classifyPrivacy(info: { privacy?: { vpn?: boolean; proxy?: boolean; hosting?: boolean; tor?: boolean } } | null) {
  if (!info?.privacy) return { networkType: 'Unknown', suspectedProxy: false };
  const { vpn, proxy, hosting, tor } = info.privacy;
  return {
    networkType: hosting ? 'Hosting' : vpn || proxy || tor ? 'Proxy / VPN' : 'Residential or Business',
    suspectedProxy: Boolean(vpn || proxy || hosting || tor),
  };
}

export async function GET(request: CloudflareRequest) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) {
    return response({ error: 'Cross-origin requests are not allowed.' }, 403);
  }

  const ip = request.headers.get('CF-Connecting-IP') ?? 'Unavailable in local preview';
  if (isRateLimited(ip)) {
    return response({ error: 'Too many IP lookups. Please try again in a minute.' }, 429);
  }

  const cf = request.cf;
  const token = process.env.IPINFO_TOKEN;
  let intelligence: { privacy?: { vpn?: boolean; proxy?: boolean; hosting?: boolean; tor?: boolean }; org?: string } | null = null;

  if (token && ip !== 'Unavailable in local preview') {
    try {
      const intelligenceResponse = await fetch(`https://ipinfo.io/${encodeURIComponent(ip)}/json?token=${encodeURIComponent(token)}`, {
        headers: { Accept: 'application/json', 'Cache-Control': 'no-store' },
      });
      if (intelligenceResponse.ok) intelligence = await intelligenceResponse.json();
    } catch {
      intelligence = null;
    }
  }

  return response({
    ip,
    country: cf?.country ?? null,
    city: cf?.city ?? null,
    region: cf?.region ?? null,
    timezone: cf?.timezone ?? null,
    asn: cf?.asn ? `AS${cf.asn}` : null,
    organization: intelligence?.org ?? cf?.asOrganization ?? null,
    colo: cf?.colo ?? null,
    intelligenceEnabled: Boolean(token),
    ...classifyPrivacy(intelligence),
  });
}

export type TestStatus = 'idle' | 'testing' | 'success' | 'timeout' | 'blocked' | 'error';

export type Evidence = 'http' | 'reachability';

export interface ProbeResult {
  targetId: string;
  status: TestStatus;
  success: boolean;
  latency: number | null;
  timestamp: number;
  evidence?: Evidence;
  httpStatus?: number;
  error?: string;
}

export interface TestTarget {
  id: string;
  name: string;
  host: string;
  category: 'AI' | 'International' | 'Domestic';
  url: string;
  icon: string;
}

export interface NetworkStats {
  samples: number;
  success: number;
  failed: number;
  successRate: number;
  average: number | null;
  min: number | null;
  max: number | null;
  median: number | null;
  p95: number | null;
  jitter: number | null;
  requestLoss: number;
}

export const targets: TestTarget[] = [
  { id: 'cloudflare', name: 'Cloudflare', host: '1.1.1.1', category: 'International', url: 'https://one.one.one.one/cdn-cgi/trace', icon: 'https://cdn.simpleicons.org/cloudflare/f38020' },
  { id: 'github', name: 'GitHub', host: 'github.com', category: 'International', url: 'https://github.com/favicon.ico', icon: 'https://cdn.simpleicons.org/github/181717' },
  { id: 'chatgpt', name: 'ChatGPT', host: 'chatgpt.com', category: 'AI', url: 'https://chatgpt.com/favicon.ico', icon: '/openai-monoblossom.svg' },
  { id: 'gemini', name: 'Gemini', host: 'gemini.google.com', category: 'AI', url: 'https://gemini.google.com/favicon.ico', icon: 'https://cdn.simpleicons.org/googlegemini/4285f4' },
  { id: 'youtube', name: 'YouTube', host: 'youtube.com', category: 'International', url: 'https://www.youtube.com/favicon.ico', icon: 'https://cdn.simpleicons.org/youtube/ff0033' },
  { id: 'bilibili', name: 'Bilibili', host: 'bilibili.com', category: 'Domestic', url: 'https://www.bilibili.com/favicon.ico', icon: 'https://cdn.simpleicons.org/bilibili/00aeec' },
];

const timeoutResult = (targetId: string, startedAt: number): ProbeResult => ({
  targetId,
  status: 'timeout',
  success: false,
  latency: null,
  timestamp: Date.now(),
  error: `Timed out after ${Math.round((Date.now() - startedAt) / 1000)}s`,
});

function cacheBusted(url: string) {
  const probeUrl = new URL(url);
  probeUrl.searchParams.set('__network_test', `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  return probeUrl.toString();
}

async function requestWithTimeout(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort('timeout'), timeoutMs);
  const abort = () => controller.abort(signal?.reason ?? 'stopped');
  signal?.addEventListener('abort', abort, { once: true });

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abort);
  }
}

/**
 * Measures one browser HTTP reachability request. Cross-origin targets are sent
 * with no-cors because CORS is a JavaScript read policy, not a connection failure.
 */
export async function runHttpProbe(target: TestTarget, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ProbeResult> {
  const startedAt = performance.now();
  const startedWallClock = Date.now();
  const timeoutMs = options.timeoutMs ?? 5000;
  const url = cacheBusted(target.url);

  try {
    const response = await requestWithTimeout(url, { cache: 'no-store', redirect: 'follow', mode: 'no-cors' }, timeoutMs, options.signal);
    const reachable = response.type === 'opaque' || response.ok;
    return {
      targetId: target.id,
      status: reachable ? 'success' : 'blocked',
      success: reachable,
      latency: Math.round(performance.now() - startedAt),
      timestamp: Date.now(),
      evidence: 'reachability',
      httpStatus: response.type === 'opaque' ? undefined : response.status,
      error: reachable ? undefined : `HTTP ${response.status}`,
    };
  } catch (error) {
    if (options.signal?.aborted) {
      throw error;
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      return timeoutResult(target.id, startedWallClock);
    }
    return {
      targetId: target.id,
      status: 'error',
      success: false,
      latency: null,
      timestamp: Date.now(),
      error: 'Network, DNS, or browser policy blocked this probe',
    };
  }
}

export async function runWithConcurrency<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      results.push(await task(item));
    }
  });
  await Promise.all(workers);
  return results;
}

export function medianProbeResult(results: ProbeResult[]): ProbeResult {
  const successful = results.filter((result) => result.success && result.latency !== null).sort((a, b) => (a.latency as number) - (b.latency as number));
  if (!successful.length) return results.at(-1)!;
  return { ...successful[Math.floor(successful.length / 2)], timestamp: Date.now() };
}

const round = (value: number) => Math.round(value * 10) / 10;

export function calculateStats(results: ProbeResult[]): NetworkStats {
  const successful = results.filter((result) => result.success && result.latency !== null).map((result) => result.latency as number);
  const sorted = [...successful].sort((a, b) => a - b);
  const samples = results.length;
  const average = successful.length ? round(successful.reduce((sum, latency) => sum + latency, 0) / successful.length) : null;
  const percentile = (p: number) => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
  const jitter = successful.length > 1
    ? round(successful.slice(1).reduce((sum, latency, index) => sum + Math.abs(latency - successful[index]), 0) / (successful.length - 1))
    : null;

  return {
    samples,
    success: successful.length,
    failed: samples - successful.length,
    successRate: samples ? round((successful.length / samples) * 100) : 0,
    average,
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null,
    median: percentile(0.5),
    p95: percentile(0.95),
    jitter,
    requestLoss: samples ? round(((samples - successful.length) / samples) * 100) : 0,
  };
}

export function calculateScore(results: ProbeResult[]) {
  const stats = calculateStats(results);
  if (!stats.samples) return null;
  const latencyScore = stats.average === null ? 0 : Math.max(0, 100 - stats.average / 5);
  const stabilityScore = Math.max(0, stats.successRate - (stats.jitter ?? 100) / 4);
  return Math.round(latencyScore * 0.5 + stabilityScore * 0.5);
}

export function latencyLabel(latency: number | null) {
  if (latency === null) return 'Unavailable';
  if (latency < 80) return 'Excellent';
  if (latency < 150) return 'Good';
  if (latency < 250) return 'Normal';
  if (latency < 500) return 'Poor';
  return 'Very poor';
}

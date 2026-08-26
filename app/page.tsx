'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { calculateScore, calculateStats, latencyLabel, runHttpProbe, runWithConcurrency, targets, type ProbeResult, type TestStatus } from './lib/network';

type IpInfo = { ip: string; country: string | null; city: string | null; region: string | null; timezone: string | null; asn: string | null; organization: string | null; colo: string | null; networkType: string; suspectedProxy: boolean; intelligenceEnabled: boolean; };
type HistoryItem = { id: string; time: number; ip: string; country: string | null; score: number | null; results: ProbeResult[]; };

const historyKey = 'network-lens-history-v1';
const statusCopy: Record<TestStatus, string> = { idle: 'Ready', testing: 'Testing', success: 'Reachable', timeout: 'Timed out', blocked: 'Blocked', error: 'Unavailable' };

function Flag({ country }: { country: string | null }) {
  if (!country || country.length !== 2) return <span aria-hidden="true">◌</span>;
  return <span aria-label={country}>{String.fromCodePoint(...[...country.toUpperCase()].map((letter) => 127397 + letter.charCodeAt(0)))}</span>;
}
function ResultDot({ status }: { status: TestStatus }) { return <span className={`status-dot status-${status}`} aria-label={statusCopy[status]} />; }
function formatLatency(value: number | null) { return value === null ? '—' : `${value} ms`; }
function scoreLabel(score: number | null) { if (score === null) return 'Run a test'; if (score >= 85) return 'Excellent'; if (score >= 70) return 'Good'; if (score >= 50) return 'Fair'; return 'Needs attention'; }
function exportHistory(history: HistoryItem[]) { const file = new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(file); link.download = `network-lens-history-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(link.href); }

export default function Home() {
  const [dark, setDark] = useState(false);
  const [ipInfo, setIpInfo] = useState<IpInfo | null>(null);
  const [ipError, setIpError] = useState<string | null>(null);
  const [ipLoading, setIpLoading] = useState(true);
  const [results, setResults] = useState<Record<string, ProbeResult>>({});
  const [isRunning, setIsRunning] = useState(false);
  const [stabilitySeconds, setStabilitySeconds] = useState(30);
  const [stabilityRunning, setStabilityRunning] = useState(false);
  const [stabilitySamples, setStabilitySamples] = useState<ProbeResult[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [webrtc, setWebrtc] = useState<string[]>([]);
  const controller = useRef<AbortController | null>(null);
  const latestResults = useMemo(() => Object.values(results), [results]);
  const overviewStats = useMemo(() => calculateStats(latestResults), [latestResults]);
  const score = useMemo(() => calculateScore(latestResults), [latestResults]);
  const stabilityStats = useMemo(() => calculateStats(stabilitySamples), [stabilitySamples]);

  const fetchIp = async () => {
    setIpLoading(true); setIpError(null);
    try { const response = await fetch('/api/ip', { cache: 'no-store' }); if (!response.ok) throw new Error('Could not load network information'); setIpInfo(await response.json()); }
    catch (error) { setIpError(error instanceof Error ? error.message : 'Could not load network information'); }
    finally { setIpLoading(false); }
  };
  useEffect(() => { void fetchIp(); try { setHistory(JSON.parse(localStorage.getItem(historyKey) ?? '[]')); } catch { setHistory([]); } }, []);
  const updateResult = (result: ProbeResult) => setResults((current) => ({ ...current, [result.targetId]: result }));

  const runAll = async () => {
    controller.current?.abort('new test'); const active = new AbortController(); controller.current = active; setIsRunning(true);
    setResults(Object.fromEntries(targets.map((target) => [target.id, { targetId: target.id, status: 'testing', success: false, latency: null, timestamp: Date.now() }])));
    try { await runWithConcurrency(targets, 4, async (target) => { const result = await runHttpProbe(target, { signal: active.signal }); updateResult(result); return result; }); }
    catch { /* User stops preserve completed cards. */ }
    finally { if (controller.current === active) { controller.current = null; setIsRunning(false); } }
  };
  const stopAll = () => controller.current?.abort('stopped by user');
  const runStability = async () => {
    controller.current?.abort('new stability run'); const active = new AbortController(); controller.current = active; setStabilityRunning(true); setStabilitySamples([]); const deadline = Date.now() + stabilitySeconds * 1000;
    try {
      while (Date.now() < deadline && !active.signal.aborted) {
        const started = Date.now();
        const wave = await runWithConcurrency(targets.slice(0, 5), 3, async (target) => { const result = await runHttpProbe(target, { signal: active.signal }); updateResult(result); return result; });
        setStabilitySamples((samples) => [...samples, ...wave]);
        const remaining = 1000 - (Date.now() - started); if (remaining > 0) await new Promise((resolve) => window.setTimeout(resolve, remaining));
      }
    } catch { /* A user stop is not an error state. */ }
    finally { if (controller.current === active) controller.current = null; setStabilityRunning(false); }
  };
  const saveHistory = () => { const item: HistoryItem = { id: crypto.randomUUID(), time: Date.now(), ip: ipInfo?.ip ?? 'Unknown', country: ipInfo?.country ?? null, score, results: latestResults }; const next = [item, ...history].slice(0, 20); setHistory(next); localStorage.setItem(historyKey, JSON.stringify(next)); };
  const runWebrtc = async () => {
    const PeerConnection = window.RTCPeerConnection; if (!PeerConnection) { setWebrtc(['WebRTC is not supported by this browser.']); return; }
    const peer = new PeerConnection({ iceServers: [] }); const candidates = new Set<string>(); peer.createDataChannel('network-lens');
    peer.onicecandidate = (event) => { if (!event.candidate?.candidate) return; const match = event.candidate.candidate.match(/(?:\d{1,3}\.){3}\d{1,3}|(?:[a-f\d]{1,4}:){2,}[a-f\d:]+/i); if (match) candidates.add(match[0]); };
    try { const offer = await peer.createOffer(); await peer.setLocalDescription(offer); window.setTimeout(() => { peer.close(); setWebrtc(candidates.size ? [...candidates] : ['No IP candidate was exposed. Modern browsers often protect private addresses with mDNS.']); }, 1100); }
    catch { peer.close(); setWebrtc(['WebRTC candidate gathering could not be started.']); }
  };

  return <main className={dark ? 'app-shell dark' : 'app-shell'}>
    <header className="topbar"><a className="brand" href="#overview"><span className="brand-mark">N</span><span>Network Lens</span></a><nav aria-label="Primary navigation"><a href="#overview">Overview</a><a href="#stability">Stability</a><a href="#privacy">Privacy</a><a href="#history">History</a></nav><button className="icon-button" type="button" onClick={() => setDark((value) => !value)} aria-label="Toggle color theme">{dark ? '☀' : '◐'}</button></header>
    <section className="hero" id="overview"><div><p className="eyebrow">YOUR CURRENT NETWORK PATH</p><h1>Know where your connection really exits.</h1><p className="hero-copy">Measure the route your browser and proxy actually take — never a remote server’s route.</p></div><div className="hero-actions"><button className="button primary" onClick={() => void runAll()} disabled={isRunning || stabilityRunning}>{isRunning ? 'Testing network…' : 'Run all tests'}</button>{(isRunning || stabilityRunning) && <button className="button secondary" onClick={stopAll}>Stop</button>}</div></section>
    <section className="overview-grid" aria-label="Network overview">
      <article className="card ip-card"><div className="card-heading"><div><p className="eyebrow">PUBLIC EXIT</p><h2>{ipLoading ? 'Loading…' : ipInfo?.ip ?? 'Unavailable'}</h2></div><Flag country={ipInfo?.country ?? null} /></div>{ipError ? <p className="error-copy">{ipError}</p> : <div className="info-list"><span><small>Location</small><b>{[ipInfo?.city, ipInfo?.region, ipInfo?.country].filter(Boolean).join(' · ') || 'Waiting for a live Worker'}</b></span><span><small>Network</small><b>{ipInfo?.asn ?? '—'} {ipInfo?.organization ?? ''}</b></span><span><small>Type</small><b>{ipInfo?.networkType ?? 'Unknown'} {ipInfo?.suspectedProxy ? '· suspected' : ''}</b></span></div>}<div className="card-footer"><button className="text-button" onClick={() => navigator.clipboard.writeText(ipInfo?.ip ?? '')} disabled={!ipInfo?.ip}>Copy IP</button><button className="text-button" onClick={() => void fetchIp()}>Refresh</button></div></article>
      <article className="card score-card"><p className="eyebrow">NETWORK SCORE</p><div className="score-row"><strong>{score ?? '—'}</strong><span>/ 100</span></div><p className="score-label">{scoreLabel(score)}</p><div className="score-breakdown"><span>Latency <b>{overviewStats.average ? `${overviewStats.average} ms` : '—'}</b></span><span>Success <b>{overviewStats.samples ? `${overviewStats.successRate}%` : '—'}</b></span><span>Jitter <b>{overviewStats.jitter ? `${overviewStats.jitter} ms` : '—'}</b></span></div></article>
      <article className="card route-card"><p className="eyebrow">ESTIMATED MODE</p><h2>{ipInfo?.suspectedProxy ? 'Proxy / VPN' : 'Unknown'}</h2><p>The current exit is visible at Cloudflare. Domestic versus international routing needs both target results and is always an estimate.</p><span className="subtle-badge">CF ingress · {ipInfo?.colo ?? 'Live deployment required'}</span></article>
    </section>
    <section className="section-head"><div><p className="eyebrow">BROWSER-SIDE PROBES</p><h2>Service reachability</h2></div><p>Each card owns its timeout and result. HTTP status appears only when the browser is allowed to read it.</p></section>
    <section className="target-grid" aria-label="Service tests">{targets.map((target) => { const result = results[target.id]; const status = result?.status ?? 'idle'; return <article className="card target-card" key={target.id}><div className="target-top"><span className="target-icon">{target.name.slice(0, 1)}</span><ResultDot status={status} /></div><p className="target-category">{target.category}</p><h3>{target.name}</h3><p className="target-host">{target.host}</p><div className="latency">{status === 'testing' ? <span className="testing-wave">Testing</span> : formatLatency(result?.latency ?? null)}</div><p className="result-copy">{status === 'success' ? `${result?.evidence === 'http' ? 'HTTP response' : 'Reachability detected'} · ${latencyLabel(result?.latency ?? null)}` : statusCopy[status]}</p></article>; })}</section>
    <section className="section-head" id="stability"><div><p className="eyebrow">SEQUENTIAL TEST WINDOW</p><h2>Stability monitor</h2></div><div className="inline-actions"><label>Duration <select value={stabilitySeconds} onChange={(event) => setStabilitySeconds(Number(event.target.value))} disabled={stabilityRunning}><option value={10}>10s</option><option value={30}>30s</option><option value={60}>60s</option><option value={120}>120s</option></select></label><button className="button primary" onClick={() => void runStability()} disabled={isRunning || stabilityRunning}>{stabilityRunning ? 'Sampling…' : 'Start stability test'}</button></div></section>
    <section className="stability-grid"><article className="card chart-card"><div className="chart-title"><div><h3>Live response timeline</h3><p>Cloudflare, GitHub, ChatGPT, Gemini and YouTube</p></div><span className={stabilityRunning ? 'live-pill active' : 'live-pill'}>{stabilityRunning ? 'Live' : 'Idle'}</span></div><div className="chart" aria-label="Latency samples chart">{stabilitySamples.length ? stabilitySamples.slice(-45).map((sample, index) => <span key={`${sample.targetId}-${sample.timestamp}`} title={`${sample.targetId}: ${formatLatency(sample.latency)}`} className={sample.success ? 'chart-bar' : 'chart-bar failed'} style={{ height: `${sample.latency ? Math.min(100, Math.max(12, 100 - sample.latency / 8)) : 8}%`, animationDelay: `${index * 20}ms` }} />) : <p>Start a stability test to see the real-time response timeline.</p>}</div><p className="chart-caption">Timeouts and failures appear as short red bars. This measures HTTP requests, not ICMP ping.</p></article><article className="card stats-card"><p className="eyebrow">REQUEST QUALITY</p><div className="stat-matrix"><span><small>Samples</small><b>{stabilityStats.samples}</b></span><span><small>Success rate</small><b>{stabilityStats.samples ? `${stabilityStats.successRate}%` : '—'}</b></span><span><small>Average</small><b>{formatLatency(stabilityStats.average)}</b></span><span><small>P95</small><b>{formatLatency(stabilityStats.p95)}</b></span><span><small>Jitter</small><b>{formatLatency(stabilityStats.jitter)}</b></span><span><small>Request Loss</small><b>{stabilityStats.samples ? `${stabilityStats.requestLoss}%` : '—'}</b></span></div><p className="note">Request Loss means failed or timed-out HTTP probes, not ICMP packet loss.</p></article></section>
    <section className="privacy-grid" id="privacy"><article className="card"><p className="eyebrow">IPV4 / IPV6</p><h2>Protocol checks</h2><p>Definitive checks require your deployment’s A-only and AAAA-only health endpoints. Cloudflare’s edge connection alone cannot prove both paths.</p><span className="subtle-badge">Configuration required</span></article><article className="card"><p className="eyebrow">WEBRTC VISIBILITY</p><h2>ICE candidates</h2><p>Modern browsers commonly hide private IP addresses with mDNS. No result is not an error.</p><button className="text-button" onClick={() => void runWebrtc()}>Check WebRTC</button>{webrtc.length > 0 && <ul className="candidate-list">{webrtc.map((candidate) => <li key={candidate}>{candidate}</li>)}</ul>}</article><article className="card"><p className="eyebrow">DNS HEURISTIC</p><h2>Resolver privacy</h2><p>A browser cannot reliably expose its recursive resolver. This product will only flag controlled, evidence-based checks — never claim a definitive DNS leak from this page.</p><span className="subtle-badge">Heuristic only</span></article></section>
    <section className="section-head" id="history"><div><p className="eyebrow">ON-DEVICE ONLY</p><h2>Test history</h2></div><div className="inline-actions"><button className="button secondary" onClick={saveHistory} disabled={!latestResults.length}>Save current run</button><button className="text-button" onClick={() => exportHistory(history)} disabled={!history.length}>Export JSON</button></div></section>
    <section className="card history-card">{history.length ? <div className="history-list">{history.map((item) => <div className="history-row" key={item.id}><span><Flag country={item.country} /> {item.ip}</span><span>{new Date(item.time).toLocaleString()}</span><span>{item.score ?? '—'} / 100</span><span>{item.results.length} probes</span></div>)}</div> : <p className="empty-state">No saved runs yet. Your history will remain only in this browser.</p>}<div className="card-footer"><span>Your IP and results are never uploaded as history.</span>{history.length > 0 && <button className="text-button danger" onClick={() => { setHistory([]); localStorage.removeItem(historyKey); }}>Clear history</button>}</div></section>
    <footer><span>Network Lens · Privacy-first browser diagnostics</span><span>HTTP latency ≠ ICMP ping · Request Loss ≠ packet loss</span></footer>
  </main>;
}

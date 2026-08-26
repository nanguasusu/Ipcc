'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { calculateScore, calculateStats, latencyLabel, runHttpProbe, runWithConcurrency, targets, type ProbeResult, type TestStatus } from './lib/network';

type IpInfo = { ip: string; country: string | null; city: string | null; region: string | null; timezone: string | null; asn: string | null; organization: string | null; colo: string | null; networkType: string; suspectedProxy: boolean; intelligenceEnabled: boolean; };
type HistoryItem = { id: string; time: number; ip: string; country: string | null; score: number | null; results: ProbeResult[]; };

const historyKey = 'network-lens-history-v1';
const statusCopy: Record<TestStatus, string> = { idle: '等待检测', testing: '检测中', success: '连接正常', timeout: '请求超时', blocked: '访问受限', error: '暂不可用' };
const categoryCopy = { AI: '人工智能', International: '国际服务', Domestic: '国内服务' } as const;

function Flag({ country }: { country: string | null }) {
  if (!country || country.length !== 2) return <span aria-hidden="true">◌</span>;
  return <span aria-label={country}>{String.fromCodePoint(...[...country.toUpperCase()].map((letter) => 127397 + letter.charCodeAt(0)))}</span>;
}

function ResultDot({ status }: { status: TestStatus }) {
  return <span className={`status-dot status-${status}`} aria-label={statusCopy[status]} />;
}

function formatLatency(value: number | null) { return value === null ? '—' : `${value} ms`; }
function scoreLabel(score: number | null) { if (score === null) return '等待一次完整检测'; if (score >= 85) return '网络状态很棒'; if (score >= 70) return '网络状态良好'; if (score >= 50) return '网络状态一般'; return '建议检查网络'; }
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
  const [history, setHistory] = useState<HistoryItem[]>(() => {
    if (typeof window === 'undefined') return [];
    try { return JSON.parse(localStorage.getItem(historyKey) ?? '[]'); } catch { return []; }
  });
  const [webrtc, setWebrtc] = useState<string[]>([]);
  const controller = useRef<AbortController | null>(null);
  const latestResults = useMemo(() => Object.values(results), [results]);
  const overviewStats = useMemo(() => calculateStats(latestResults), [latestResults]);
  const score = useMemo(() => calculateScore(latestResults), [latestResults]);
  const stabilityStats = useMemo(() => calculateStats(stabilitySamples), [stabilitySamples]);

  const fetchIp = async () => {
    setIpLoading(true); setIpError(null);
    try { const response = await fetch('/api/ip', { cache: 'no-store' }); if (!response.ok) throw new Error('无法获取网络信息'); setIpInfo(await response.json()); }
    catch (error) { setIpError(error instanceof Error ? error.message : '无法获取网络信息'); }
    finally { setIpLoading(false); }
  };

  useEffect(() => { const timer = window.setTimeout(() => void fetchIp(), 0); return () => window.clearTimeout(timer); }, []);
  const updateResult = (result: ProbeResult) => setResults((current) => ({ ...current, [result.targetId]: result }));

  const runAll = async () => {
    controller.current?.abort('new test'); const active = new AbortController(); controller.current = active; setIsRunning(true);
    setResults(Object.fromEntries(targets.map((target) => [target.id, { targetId: target.id, status: 'testing', success: false, latency: null, timestamp: Date.now() }])));
    try { await runWithConcurrency(targets, 4, async (target) => { const result = await runHttpProbe(target, { signal: active.signal }); updateResult(result); return result; }); }
    catch { /* 用户停止时保留已经完成的卡片。 */ }
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
    } catch { /* 用户停止时不显示错误状态。 */ }
    finally { if (controller.current === active) controller.current = null; setStabilityRunning(false); }
  };

  const saveHistory = () => { const item: HistoryItem = { id: crypto.randomUUID(), time: Date.now(), ip: ipInfo?.ip ?? '未知', country: ipInfo?.country ?? null, score, results: latestResults }; const next = [item, ...history].slice(0, 20); setHistory(next); localStorage.setItem(historyKey, JSON.stringify(next)); };

  const runWebrtc = async () => {
    const PeerConnection = window.RTCPeerConnection; if (!PeerConnection) { setWebrtc(['当前浏览器不支持 WebRTC']); return; }
    const peer = new PeerConnection({ iceServers: [] }); const candidates = new Set<string>(); peer.createDataChannel('network-lens');
    peer.onicecandidate = (event) => { if (!event.candidate?.candidate) return; const match = event.candidate.candidate.match(/(?:\d{1,3}\.){3}\d{1,3}|(?:[a-f\d]{1,4}:){2,}[a-f\d:]+/i); if (match) candidates.add(match[0]); };
    try { const offer = await peer.createOffer(); await peer.setLocalDescription(offer); window.setTimeout(() => { peer.close(); setWebrtc(candidates.size ? [...candidates] : ['未暴露 IP 候选。现代浏览器通常会用 mDNS 保护私有地址。']); }, 1100); }
    catch { peer.close(); setWebrtc(['无法开始收集 WebRTC 候选。']); }
  };

  return <main className={dark ? 'app-shell dark' : 'app-shell'}>
    <div className="window-frame">
      <header className="window-bar">
        <div className="traffic-lights" aria-hidden="true"><i className="traffic-red" /><i className="traffic-yellow" /><i className="traffic-green" /></div>
        <span className="window-title">网络透镜</span>
        <button className="theme-button" type="button" onClick={() => setDark((value) => !value)} aria-label={dark ? '切换浅色模式' : '切换深色模式'}>{dark ? '☀︎' : '☾'}</button>
      </header>
      <div className="app-layout">
        <aside className="sidebar">
          <a className="brand" href="#overview"><span className="brand-mark">N</span><span>网络透镜</span></a>
          <p className="sidebar-label">工作台</p>
          <nav aria-label="主导航"><a className="active" href="#overview"><span>⌂</span>总览</a><a href="#stability"><span>⌁</span>稳定性</a><a href="#privacy"><span>◌</span>隐私检查</a><a href="#history"><span>↺</span>检测历史</a></nav>
          <div className="sidebar-footer"><span className="status-online" /><span>本地检测模式</span></div>
        </aside>
        <div className="content-area">
          <section className="hero" id="overview"><div><p className="eyebrow">浏览器网络诊断</p><h1>看见你的网络，<em>正在发生什么。</em></h1><p className="hero-copy">从当前浏览器出发，测量真实的访问路径、延迟与稳定性。所有结果只保留在你的设备上。</p></div><div className="hero-actions"><button className="button primary" onClick={() => void runAll()} disabled={isRunning || stabilityRunning}><span className="button-icon">{isRunning ? '◌' : '▶'}</span>{isRunning ? '正在检测…' : '开始全面检测'}</button>{(isRunning || stabilityRunning) && <button className="button secondary" onClick={stopAll}>停止</button>}</div></section>

          <section className="overview-grid" aria-label="网络概览">
            <article className="card ip-card pastel-blue"><div className="card-heading"><div><p className="eyebrow">当前公网 IP</p><h2>{ipLoading ? '获取中…' : ipInfo?.ip ?? '暂不可用'}</h2></div><div className="flag-orbit"><Flag country={ipInfo?.country ?? null} /></div></div>{ipError ? <p className="error-copy">{ipError}</p> : <div className="info-list"><span><small>位置</small><b>{[ipInfo?.city, ipInfo?.region, ipInfo?.country].filter(Boolean).join(' · ') || '等待实时数据'}</b></span><span><small>网络</small><b>{ipInfo?.asn ?? '—'} {ipInfo?.organization ?? ''}</b></span><span><small>类型</small><b>{ipInfo?.networkType ?? '未知'} {ipInfo?.suspectedProxy ? '· 可能使用代理' : ''}</b></span></div>}<div className="card-footer"><button className="text-button" onClick={() => navigator.clipboard.writeText(ipInfo?.ip ?? '')} disabled={!ipInfo?.ip}>复制 IP</button><button className="text-button" onClick={() => void fetchIp()}>刷新</button></div></article>
            <article className="card score-card pastel-peach"><div className="card-topline"><p className="eyebrow">网络健康分</p><span className="sparkle">✦</span></div><div className="score-row"><strong>{score ?? '—'}</strong><span>/ 100</span></div><p className="score-label">{scoreLabel(score)}</p><div className="score-progress"><span style={{ width: `${score ?? 0}%` }} /></div><div className="score-breakdown"><span>平均延迟 <b>{overviewStats.average ? `${overviewStats.average} ms` : '—'}</b></span><span>成功率 <b>{overviewStats.samples ? `${overviewStats.successRate}%` : '—'}</b></span></div></article>
            <article className="card route-card pastel-mint"><div><p className="eyebrow">网络出口推测</p><h2>{ipInfo?.suspectedProxy ? '代理 / VPN' : '暂未判断'}</h2><p>出口位于 Cloudflare 边缘节点。国内与国际路由会结合下方探测结果综合估算。</p></div><span className="subtle-badge">CF 节点 · {ipInfo?.colo ?? '等待部署'}</span></article>
          </section>

          <section className="section-head"><div><p className="eyebrow">浏览器端探测</p><h2>服务连通性</h2></div><p>每个服务独立计时，结果来自当前浏览器发起的真实 HTTP 请求。</p></section>
          <section className="target-grid" aria-label="服务连通性检测">{targets.map((target) => { const result = results[target.id]; const status = result?.status ?? 'idle'; return <article className="card target-card" key={target.id}><div className="target-top"><span className="target-icon">{target.name.slice(0, 1)}</span><ResultDot status={status} /></div><p className="target-category">{categoryCopy[target.category]}</p><h3>{target.name}</h3><p className="target-host">{target.host}</p><div className="latency">{status === 'testing' ? <span className="testing-wave">检测中</span> : formatLatency(result?.latency ?? null)}</div><p className="result-copy">{status === 'success' ? `${result?.evidence === 'http' ? 'HTTP 响应正常' : '已检测到连接'} · ${latencyLabel(result?.latency ?? null)}` : statusCopy[status]}</p></article>; })}</section>

          <section className="section-head" id="stability"><div><p className="eyebrow">连续请求窗口</p><h2>稳定性监测</h2></div><div className="inline-actions"><label>检测时长 <select value={stabilitySeconds} onChange={(event) => setStabilitySeconds(Number(event.target.value))} disabled={stabilityRunning}><option value={10}>10 秒</option><option value={30}>30 秒</option><option value={60}>60 秒</option><option value={120}>120 秒</option></select></label><button className="button primary" onClick={() => void runStability()} disabled={isRunning || stabilityRunning}>{stabilityRunning ? '采样中…' : '开始稳定性检测'}</button></div></section>
          <section className="stability-grid"><article className="card chart-card"><div className="chart-title"><div><h3>实时响应曲线</h3><p>Cloudflare、GitHub、ChatGPT、Gemini、YouTube</p></div><span className={stabilityRunning ? 'live-pill active' : 'live-pill'}>{stabilityRunning ? '● 实时' : '已暂停'}</span></div><div className="chart" aria-label="延迟采样图">{stabilitySamples.length ? stabilitySamples.slice(-45).map((sample, index) => <span key={`${sample.targetId}-${sample.timestamp}`} title={`${sample.targetId}: ${formatLatency(sample.latency)}`} className={sample.success ? 'chart-bar' : 'chart-bar failed'} style={{ height: `${sample.latency ? Math.min(100, Math.max(12, 100 - sample.latency / 8)) : 8}%`, animationDelay: `${index * 20}ms` }} />) : <p>开始稳定性检测，在这里查看实时响应曲线。</p>}</div><p className="chart-caption">短红柱代表超时或失败。这里测量的是 HTTP 请求，不是 ICMP Ping。</p></article><article className="card stats-card pastel-lilac"><p className="eyebrow">请求质量</p><div className="stat-matrix"><span><small>采样数</small><b>{stabilityStats.samples}</b></span><span><small>成功率</small><b>{stabilityStats.samples ? `${stabilityStats.successRate}%` : '—'}</b></span><span><small>平均延迟</small><b>{formatLatency(stabilityStats.average)}</b></span><span><small>P95</small><b>{formatLatency(stabilityStats.p95)}</b></span><span><small>抖动</small><b>{formatLatency(stabilityStats.jitter)}</b></span><span><small>请求丢失</small><b>{stabilityStats.samples ? `${stabilityStats.requestLoss}%` : '—'}</b></span></div><p className="note">请求丢失代表 HTTP 探测失败或超时，不等同于丢包。</p></article></section>

          <section className="privacy-grid" id="privacy"><article className="card pastel-yellow"><p className="eyebrow">IPV4 / IPV6</p><h2>协议检查</h2><p>需要部署端提供仅 IPv4 与仅 IPv6 的健康检查地址，才能进行确定性判断。</p><span className="subtle-badge">需要配置</span></article><article className="card"><p className="eyebrow">WEBRTC 可见性</p><h2>ICE 候选</h2><p>现代浏览器通常会用 mDNS 隐藏私有 IP。没有结果并不代表发生错误。</p><button className="text-button" onClick={() => void runWebrtc()}>检查 WebRTC ↗</button>{webrtc.length > 0 && <ul className="candidate-list">{webrtc.map((candidate) => <li key={candidate}>{candidate}</li>)}</ul>}</article><article className="card pastel-pink"><p className="eyebrow">DNS 启发式</p><h2>解析器隐私</h2><p>浏览器无法可靠暴露递归 DNS。这里只展示有证据支持的结果，不会武断地宣称 DNS 泄漏。</p><span className="subtle-badge">仅供参考</span></article></section>

          <section className="section-head" id="history"><div><p className="eyebrow">仅保存在本机</p><h2>检测历史</h2></div><div className="inline-actions"><button className="button secondary" onClick={saveHistory} disabled={!latestResults.length}>保存本次结果</button><button className="text-button" onClick={() => exportHistory(history)} disabled={!history.length}>导出 JSON</button></div></section>
          <section className="card history-card">{history.length ? <div className="history-list">{history.map((item) => <div className="history-row" key={item.id}><span><Flag country={item.country} /> {item.ip}</span><span>{new Date(item.time).toLocaleString('zh-CN')}</span><span>{item.score ?? '—'} / 100</span><span>{item.results.length} 项探测</span></div>)}</div> : <p className="empty-state">还没有保存的检测记录。你的历史只会保留在当前浏览器中。</p>}<div className="card-footer"><span>IP 与检测结果不会上传为历史记录。</span>{history.length > 0 && <button className="text-button danger" onClick={() => { setHistory([]); localStorage.removeItem(historyKey); }}>清空历史</button>}</div></section>
          <footer><span>网络透镜 · 隐私优先的浏览器网络诊断</span><span>HTTP 延迟 ≠ ICMP Ping · 请求丢失 ≠ 网络丢包</span></footer>
        </div>
      </div>
    </div>
  </main>;
}

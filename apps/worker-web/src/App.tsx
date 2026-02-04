import { useState, useEffect, useRef } from 'react'
import { LoxiWorkerDevice, type WorkerLease, type NodeSpecs as SDKNodeSpecs } from '../../../sdk/web/src/index';
import './App.css'
import LeafletMap from './components/LeafletMap';

const PRESETS: Record<string, { threads: number, ram: number, label: string }> = {
  TITAN: { threads: 16, ram: 32, label: "TITAN (Matrix Hub)" },
  DESKTOP: { threads: 8, ram: 16, label: "DESKTOP (General)" },
  MOBILE: { threads: 4, ram: 4, label: "MOBILE (Light Solver)" }
};

type Log = {
  id: number
  time: string
  message: string
  type: 'info' | 'success' | 'error' | 'action'
}

const DEFAULT_ORCHESTRATOR = "ws://localhost:3005"

function App() {
  const [url, setUrl] = useState(DEFAULT_ORCHESTRATOR)
  const [isConnected, setIsConnected] = useState(false)
  const [status, setStatus] = useState("DISCONNECTED")
  const [logs, setLogs] = useState<Log[]>([]);
  const [activeLease, setActiveLease] = useState<WorkerLease | null>(null)
  const [activeShape, setActiveShape] = useState<string | null>(null)
  const [nodeSpecs, setNodeSpecs] = useState<SDKNodeSpecs | null>(null)
  const [architectProblem, setArchitectProblem] = useState<any>(null)
  const [activeSolutions, setActiveSolutions] = useState<Record<string, any>>({})
  const [cores, setCores] = useState<number[]>([])
  const [currentMission, setCurrentMission] = useState<string>("")

  const sdkRef = useRef<LoxiWorkerDevice | null>(null)
  const logsEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [logs])

  useEffect(() => {
    const detectHardware = () => {
      const threads = navigator.hardwareConcurrency || 4;
      // @ts-ignore
      const ramGb = navigator.deviceMemory || 8;
      applyInitialSpecs(threads, ramGb);
    };
    detectHardware();
  }, []);

  const applyInitialSpecs = (threads: number, ramGb: number) => {
    const ramMb = ramGb * 1024;
    const specs: SDKNodeSpecs = {
      id: `titan_${threads}c_${ramGb}gb_${Math.floor(Math.random() * 1000)}`,
      ram_mb: ramMb,
      vram_mb: 0,
      thread_count: threads,
      is_webgpu_enabled: false,
      affinity_hashes: [],
      verified_capacity: 0
    };
    setNodeSpecs(specs);
    setCores(new Array(threads).fill(0));
  };

  const addLog = (msg: string, type: Log['type'] = 'info') => {
    setLogs(prev => [...prev.slice(-49), {
      id: Date.now() + Math.random(),
      time: new Date().toLocaleTimeString(),
      message: msg,
      type
    }])
  }

  const connect = () => {
    if (!url || !nodeSpecs) return

    const sdk = new LoxiWorkerDevice(url);
    sdk.setSpecs(nodeSpecs);

    sdk.onEvent((ev) => {
      switch (ev.type) {
        case 'CONNECTED':
          setIsConnected(true);
          setStatus("IDLE");
          break;
        case 'DISCONNECTED':
          setIsConnected(false);
          setStatus("DISCONNECTED");
          break;
        case 'TASK_ASSIGNED':
          setActiveLease(ev.lease);
          setStatus("EXECUTING");
          break;
        case 'TASK_COMPLETED':
          setActiveLease(null);
          setStatus("IDLE");
          break;
        case 'LOG':
          addLog(ev.message, ev.level);
          break;
        case 'TASK_ERROR':
          setActiveLease(null);
          setStatus("IDLE");
          break;
        default: break;
      }
    });

    // Apply currently selected profile as constraints before connecting
    const profileKey = (document.querySelector('.profile-select') as HTMLSelectElement)?.value;
    if (profileKey && PRESETS[profileKey]) {
      const p = PRESETS[profileKey];
      sdk.setConstraints({ maxRamMb: p.ram * 1024, maxThreads: p.threads });
    }

    sdk.connect();
    sdkRef.current = sdk;
  }

  const dispatchToSwarm = async () => {
    if (!architectProblem) return;
    try {
      addLog(`🚀[COMMAND] Sending problem to Conductor...`, "action");

      const response = await fetch('http://localhost:3007/submit-problem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(architectProblem)
      });

      if (response.ok) {
        const result = await response.json();
        const missionId = result.mission_id || "";
        const ids = result.auction_ids || [];

        setCurrentMission(missionId);
        setActiveSolutions({});
        addLog(`✅ Conductor accepted. Mission ID: ${missionId}`, "success");

        if (missionId) {
          const pollInterval = setInterval(async () => {
            try {
              const solRes = await fetch(`http://localhost:3007/get-solution?mission_id=${missionId}`);
              const solutionsMap = await solRes.json();
              const solutions = Array.isArray(solutionsMap) ? solutionsMap : Object.values(solutionsMap);

              if (solutions.length > 0) {
                solutions.forEach((sol: any) => {
                  const id = sol.id || sol.auction_id;
                  if (id) {
                    // Robust check for nested or direct solution
                    const stops = sol.stops || (sol.solution && sol.solution.stops); // Not expected in solution but injected
                    const route = sol.route || (sol.solution && sol.solution.route) || sol.routes;

                    if (route || stops) {
                      setActiveSolutions(prev => ({
                        ...prev,
                        [id]: { ...sol, mission_id: missionId }
                      }));
                    }
                  }
                });
                // Note: We don't clear interval aggressively so user can see trailing updates
              }
            } catch (e) {
              console.warn("Polling error:", e);
            }
          }, 3000);
          setTimeout(() => clearInterval(pollInterval), 600000);
        }
      }
    } catch (e) { addLog(`❌ Failed to reach Conductor`, "error"); }
  };

  const generateProblem = (count: number) => {
    setActiveSolutions({});
    const base = { lat: -34.592365579155024, lon: -58.5529111002654 };
    const stops = Array.from({ length: count }, (_, i) => ({
      id: `Stop_${i + 1}`,
      location: { lat: base.lat + (Math.random() - 0.5) * 0.02, lon: base.lon + (Math.random() - 0.5) * 0.02 },
      time_window: { start: 0, end: 86400 },
      service_time: 300,
      demand: 10.0,
      priority: 1
    }));
    setArchitectProblem({
      stops,
      fleet_size: 1,
      seed: 42,
      vehicle: { id: "Vehicle_1", capacity: 100.0, start_location: base, shift_window: { start: 0, end: 86400 }, speed_mps: 10.0 }
    });
    addLog(`🔧 Created ${count} stops.`, "info");
  };

  if (!nodeSpecs) return <div className="loading">Hardware Detection...</div>

  // --- DATA PREPARATION FOR MAP ---

  // 1. STOPS: Combine Architect Input (local) with Solution Output (backend)
  const solutionStops = Object.values(activeSolutions)
    .filter((sol: any) => sol.mission_id === currentMission && sol.stops)
    .flatMap((sol: any) => sol.stops);

  const uniqueSolutionStops = Array.from(new Map(solutionStops.map((s: any) => [s.id, s])).values());
  const currentStops = architectProblem?.stops || uniqueSolutionStops || [];

  // 2. ROUTES: Extract route ID sequences
  const currentRoutes = Object.values(activeSolutions)
    .filter((sol: any) => sol.mission_id === currentMission)
    .map((sol: any) => {
      // Handle legacy or nested structure
      if (sol.routes && sol.routes[0]) return sol.routes[0].stops.map((s: any) => typeof s === 'string' ? s : s.id);
      if (sol.route) return sol.route.map((s: any) => typeof s === 'string' ? s : s.id);
      if (sol.solution && sol.solution.route) return sol.solution.route.map((s: any) => typeof s === 'string' ? s : s.id);
      return [];
    });

  // Debug for user
  // (Log removed to reduce noise)

  // 3. ASSIGNMENTS: Map stops to workers for coloring
  const stopAssignments: Record<string, string> = {};
  Object.values(activeSolutions).forEach((sol: any) => {
    if (sol.worker_id) {
      const color = (id: string) => {
        const hash = id.split('').reduce((acc, char) => char.charCodeAt(0) + ((acc << 5) - acc), 0);
        const colors = ['#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444'];
        return colors[Math.abs(hash) % colors.length];
      };
      const c = color(sol.worker_id);
      const stops = sol.route || (sol.routes && sol.routes[0]?.stops) || (sol.solution && sol.solution.route) || [];
      stops.forEach((s: any) => { stopAssignments[typeof s === 'string' ? s : s.id] = c; });
    }
  });

  const completedCount = Object.values(activeSolutions).filter((s: any) => s.mission_id === currentMission && (s.route || s.routes)).length;

  return (
    <div className="container">
      <header className="header">
        <div className="logo">LOXI // SWARM HUB</div>
        <div className={`status-badge ${status.toLowerCase()}`}>{status}</div>
      </header>

      <main className="dashboard">
        <div className="sidebar-left">
          <section className="panel status-panel">
            <h2>Node Authority</h2>
            <div className="profile-selector">
              <label>Voluntary Resource Limit</label>
              <select className="profile-select" onChange={(e) => {
                const p = PRESETS[e.target.value as keyof typeof PRESETS];
                if (p && sdkRef.current) sdkRef.current.setConstraints({ maxRamMb: p.ram * 1024, maxThreads: p.threads });
                if (p) {
                  const newSpecs = { ...nodeSpecs, ram_mb: Math.min(p.ram * 1024, nodeSpecs.ram_mb), thread_count: Math.min(p.threads, nodeSpecs.thread_count) };
                  setNodeSpecs(newSpecs);
                }
              }}>
                <option value="AUTO">-- No Limit --</option>
                {Object.entries(PRESETS).map(([key, p]) => <option key={key} value={key}>{p.label}</option>)}
              </select>
            </div>
            <div className="spec-grid">
              <div className="spec-item"><label>Handle</label><span>{nodeSpecs.id.split('_')[0]}</span></div>
              <div className="spec-item"><label>Reported RAM</label><span>{nodeSpecs.ram_mb} MB</span></div>
              <div className="spec-item"><label>Reported CPU</label><span>{nodeSpecs.thread_count} Cores</span></div>
            </div>

            <div className="referral-box" style={{ margin: "10px 0", padding: "10px", background: "#1e1e1e", borderRadius: "8px" }}>
              <label style={{ display: "block", fontSize: "12px", marginBottom: "5px", color: "#aaa" }}>PARTNER / REFERRAL ID</label>
              <input
                type="text"
                placeholder="e.g. loxi_internal_pool"
                value={nodeSpecs.owner_id || ""}
                onChange={e => setNodeSpecs({ ...nodeSpecs, owner_id: e.target.value || undefined })}
                disabled={isConnected}
                style={{ width: "100%", padding: "8px", background: "#333", border: "none", color: "white", borderRadius: "4px" }}
              />
            </div>

            <div className="connection-box">
              <input type="text" value={url} onChange={e => setUrl(e.target.value)} disabled={isConnected} />
              <button onClick={connect} disabled={isConnected} className="conn-btn">{isConnected ? "ACTIVE" : "JOIN SWARM"}</button>
            </div>
          </section>

          <section className="panel">
            <h2>Mission Architect</h2>
            <div className="gen-buttons">
              <button onClick={() => generateProblem(10)}>Small</button>
              <button onClick={() => generateProblem(100)}>Medium</button>
              <button onClick={() => generateProblem(200)} className="stress-btn">Heavy</button>
            </div>
            {currentMission && <div style={{ marginTop: 10, fontSize: '0.8em', color: '#8b5cf6' }}>Current Mission: {currentMission}</div>}
            {completedCount > 0 && <div style={{ marginTop: 5, fontSize: '0.9em', color: '#10b981' }}>Mission Progress: {completedCount} solutions found</div>}
            <button onClick={dispatchToSwarm} className="dispatch-btn" disabled={!architectProblem || !isConnected}>DISPATCH</button>
          </section>
        </div>

        <div className="map-wrapper">
          <LeafletMap stops={currentStops} routes={currentRoutes} stopAssignments={stopAssignments} />
        </div>

        <div className="sidebar-right">
          <section className="logs-panel">
            <h3>Live Telemetry</h3>
            <div className="logs-list">
              {logs.map(log => (
                <div key={log.id} className={`log-row ${log.type}`}>
                  <span className="time">{log.time}</span>
                  <span>{log.message}</span>
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
          </section>
        </div>
      </main>
    </div>
  )
}

export default App
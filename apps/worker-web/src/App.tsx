import { useState, useEffect, useRef } from 'react'
import { LoxiWorkerDevice, type NodeSpecs as SDKNodeSpecs } from '../../../sdk/web/src/index';
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

const DEFAULT_ORCHESTRATOR = import.meta.env.VITE_ORCHESTRATOR_URL || "ws://localhost:3005";

function App() {
  const [url, setUrl] = useState(DEFAULT_ORCHESTRATOR)
  const [isConnected, setIsConnected] = useState(false)
  const [status, setStatus] = useState("DISCONNECTED")
  const [logs, setLogs] = useState<Log[]>([]);
  const [nodeSpecs, setNodeSpecs] = useState<SDKNodeSpecs | null>(null)
  const [architectProblem, setArchitectProblem] = useState<any>(null)
  const [activeSolutions, setActiveSolutions] = useState<Record<string, any>>({})
  const [currentMission, setCurrentMission] = useState<string>("")

  const sdkRef = useRef<LoxiWorkerDevice | null>(null)
  const logsEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [logs])

  useEffect(() => {
    const threads = navigator.hardwareConcurrency || 4;
    // @ts-ignore
    const ramGb = navigator.deviceMemory || 8;

    const ramMb = ramGb * 1024;
    const specs: SDKNodeSpecs = {
      id: `titan_${threads}c_${ramGb}gb_${Math.floor(Math.random() * 1000)}`,
      ram_mb: ramMb,
      vram_mb: 0,
      thread_count: threads,
      is_webgpu_enabled: false,
      affinity_hashes: [],
      verified_capacity: 0,
      owner_id: `owner_${Math.floor(Math.random() * 10000)}` // Set an owner ID for notifications
    };
    setNodeSpecs(specs);
  }, []);

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
          setStatus("EXECUTING");
          break;
        case 'TASK_COMPLETED':
          setStatus("IDLE");
          break;
        case 'LOG':
          addLog(ev.message, ev.level);
          break;
        case 'TASK_ERROR':
          setStatus("IDLE");
          break;
        case 'OWNER_NOTIFICATION':
          addLog(`🎁 NOTIFICATION: ${ev.notify_type}`, "success");
          if (ev.notify_type === 'MISSION_COMPLETED') {
            addLog("🏁 Mission is fully completed! Starting visualization...", "success");
            try {
              const payload = JSON.parse(ev.payload);
              const missionId = payload.mission_id || currentMission;
              if (missionId) {
                // Pass full notification payload to visualizeSolution
                visualizeSolution(missionId, payload);
              }
            } catch (e) {
              addLog(`❌ Failed to process mission completion: ${e}`, "error");
            }
          }
          break;
        default: break;
      }
    });

    const profileKey = (document.querySelector('.profile-select') as HTMLSelectElement)?.value;
    if (profileKey && PRESETS[profileKey]) {
      const p = PRESETS[profileKey];
      sdk.setConstraints({ maxRamMb: p.ram * 1024, maxThreads: p.threads });
    }

    sdk.connect();
    sdkRef.current = sdk;
  }

  const visualizeSolution = async (missionId: string, payload: any) => {
    if (!sdkRef.current) return;
    addLog(`✅ Solution received. Auto-executing Visualizer Artifact...`, "success");

    // The payload now contains everything needed
    const { solution, stops } = payload;

    setActiveSolutions(prev => ({
      ...prev,
      [missionId]: {
        ...solution,
        mission_id: missionId,
        stops: stops, // Coordinates hydrated from payload!
        routes: solution.routes || (solution.route ? [solution.route] : [])
      }
    }));

    try {
      // Use the artifact name from metadata or default to loxi_solution_visualizer
      const metadata = Array.isArray(payload.metadata) ? payload.metadata : [];
      const artifactName = metadata.find(([k]: any) => k === 'visualizer_artifact')?.[1] || 'loxi_solution_visualizer';
      const artifactBase = "http://localhost:8080/logistics";

      addLog(`👷 Spawning Visualizer: ${artifactName}`, "info");

      const result = await sdkRef.current.runAgnosticWorker(
        artifactBase,
        artifactName,
        "VISUALIZE_ROUTES",
        JSON.stringify(payload)
      );
      if (result && result.routes) {
        addLog(`✅ Polylines generated by SDK Visualizer. Routes: ${result.routes.length}`, "success");
        setActiveSolutions(prev => ({
          ...prev,
          [missionId]: {
            ...solution,
            mission_id: missionId,
            stops: stops,
            routes: result.routes
          }
        }));
      }
    } catch (err) {
      addLog(`❌ SDK Visualization error: ${err}`, "error");
    }
  };

  const dispatchToSwarm = async () => {
    if (!architectProblem) return;
    try {
      addLog(`🚀[COMMAND] Sending problem to Conductor...`, "action");

      const response = await fetch('/logistics/submit-problem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(architectProblem)
      });

      if (response.ok) {
        const result = await response.json();
        const missionId = result.mission_id || "";

        setCurrentMission(missionId);
        setActiveSolutions({});
        addLog(`✅ Conductor accepted. Mission ID: ${missionId}`, "success");

        if (missionId) {
          const pollInterval = setInterval(async () => {
            try {
              const solRes = await fetch(`/get-solution/${missionId}`);
              const result = await solRes.json();

              if (result.status === 'completed' && result.solution) {
                clearInterval(pollInterval);
                visualizeSolution(missionId, result);
              } else if (result.status === 'processing') {
                addLog(`⏳ Processing... ${result.message}`, "info");
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
    setCurrentMission("");
    const base = { lat: -34.6036, lon: -58.5408 };
    const toE6 = (val: number) => Math.round(val * 1000000);

    const stops = Array.from({ length: count }, (_, i) => ({
      id: `Stop_${i + 1}`,
      location: {
        lat: toE6(base.lat + (Math.random() - 0.5) * 0.015),
        lon: toE6(base.lon + (Math.random() - 0.5) * 0.015)
      },
      time_window: { start: 0, end: 86399 },
      service_time: 300,
      demand: 10.0,
      priority: 1
    }));

    setArchitectProblem({
      stops,
      fleet_size: 5, // INCREASE: Allow up to 5 routes
      seed: 42,
      vehicle: {
        id: "Vehicle_1",
        capacity: 150.0, // CONSTRAIN: 60 stops * 10 demand = 600 total. 150 capacity forces at least 4 vehicles.
        start_location: { lat: toE6(base.lat), lon: toE6(base.lon) },
        shift_window: { start: 0, end: 86399 },
        speed_mps: 10.0
      },
      client_owner_id: nodeSpecs?.owner_id
    });
    addLog(`🔧 Created ${count} stops.`, "info");
  };

  if (!nodeSpecs) return <div className="loading">Hardware Detection...</div>

  // --- DATA PREPARATION FOR MAP ---
  const solutionStops = Object.values(activeSolutions)
    .filter((sol: any) => sol.mission_id === currentMission && Array.isArray(sol.stops))
    .flatMap((sol: any) => sol.stops);

  const uniqueSolutionStops = Array.from(new Map(solutionStops.map((s: any) => [s.id, s])).values());
  const currentStops = architectProblem?.stops || uniqueSolutionStops || [];

  const currentRoutes = Object.values(activeSolutions)
    .filter((sol: any) => sol.mission_id === currentMission)
    .flatMap((sol: any) => {
      // Priority 1: Normalized routes from polyline worker
      if (Array.isArray(sol.routes)) {
        return sol.routes.map((r: any) => {
          const stops = r.stops || r;
          return Array.isArray(stops) ? stops.map((s: any) => typeof s === 'string' ? s : s.id) : [];
        });
      }
      // Priority 2: Simple route from solver
      if (Array.isArray(sol.route)) {
        return [sol.route.map((s: any) => typeof s === 'string' ? s : s.id)];
      }
      return [];
    });

  const stopAssignments: Record<string, string> = {};
  Object.values(activeSolutions).forEach((sol: any) => {
    if (sol.worker_id) {
      const color = (id: string) => {
        const hash = id.split('').reduce((acc, char) => char.charCodeAt(0) + ((acc << 5) - acc), 0);
        const colors = ['#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444'];
        return colors[Math.abs(hash) % colors.length];
      };
      const c = color(sol.worker_id);

      const allStops: any[] = [];
      if (Array.isArray(sol.routes)) {
        sol.routes.forEach((r: any) => {
          const stops = r.stops || r;
          if (Array.isArray(stops)) allStops.push(...stops);
        });
      } else if (Array.isArray(sol.route)) {
        allStops.push(...sol.route);
      }

      allStops.forEach((s: any) => {
        const id = typeof s === 'string' ? s : s?.id;
        if (id) stopAssignments[id] = c;
      });
    }
  });

  const completedCount = Object.values(activeSolutions).filter((s: any) => s.mission_id === currentMission && (s.route || s.routes)).length;
  const currentSolution = Object.values(activeSolutions).find((s: any) => s.mission_id === currentMission && (s.route || s.routes));

  const currentShapes = Object.values(activeSolutions)
    .filter((sol: any) => sol.mission_id === currentMission && Array.isArray(sol.routes))
    .flatMap((sol: any) => sol.routes.map((r: any) => r.shape).filter(Boolean));

  console.log(`🗺️ [App] currentShapes length: ${currentShapes.length}. Sample: ${currentShapes[0]?.substring(0, 20)}...`);

  return (
    <div className="container">
      <header className="header">
        <div className="flex items-center gap-4">
          <div className="logo-icon">▲</div>
          <h1 className="title">LOXI <span className="title-alt">GRID</span></h1>
        </div>

        <div className="flex items-center gap-4">
          {currentMission && currentSolution && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => visualizeSolution(currentMission, { solution: currentSolution, stops: currentStops, mission_id: currentMission, problem: architectProblem })}
                style={{ background: '#8b5cf6', color: 'white', padding: '6px 14px', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 'bold', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}
              >
                📊 RE-VISUALIZE
              </button>
            </div>
          )}
          <div className={`status-badge ${status.toLowerCase()}`}>{status}</div>
        </div>
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
              <button onClick={() => generateProblem(60)}>Medium</button>
              <button onClick={() => generateProblem(500)} className="stress-btn">Heavy</button>
            </div>
            {currentMission && <div style={{ marginTop: 10, fontSize: '0.8em', color: '#8b5cf6' }}>Current Mission: {currentMission}</div>}
            {completedCount > 0 && <div style={{ marginTop: 5, fontSize: '0.9em', color: '#10b981' }}>Mission Progress: {completedCount} solutions found</div>}
            <button onClick={dispatchToSwarm} className="dispatch-btn" disabled={!architectProblem || !isConnected}>DISPATCH</button>
          </section>
        </div>

        <div className="map-wrapper">
          <LeafletMap stops={currentStops} routes={currentRoutes} shapes={currentShapes} stopAssignments={stopAssignments} />
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
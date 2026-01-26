import { useState, useEffect, useRef } from 'react'
import { loadValhalla } from './utils/ValhallaLoader';
import { callValhallaBridge } from './utils/ValhallaBridge';
import { loadTilesForRegion, calculateBoundingBox } from './utils/ValhallaTileLoader';
import './App.css'
import LeafletMap from './components/LeafletMap';


declare global {
  interface Window {
    callValhallaBridge: (input: string) => string;
  }
}

type NodeSpecs = {
  id: string
  ram_mb: number
  vram_mb: number
  thread_count: number
  is_webgpu_enabled: boolean
  affinity_hashes: string[]
  verified_capacity: number
}

const PRESETS = {
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

type Lease = {
  auction_id: string
  worker_id: string
  architect_address: string
  artifact_hash: string
  task_type: string
}

const DEFAULT_ORCHESTRATOR = "ws://localhost:3005"

function App() {
  const [url, setUrl] = useState(DEFAULT_ORCHESTRATOR)
  const [isConnected, setIsConnected] = useState(false)
  const [status, setStatus] = useState("DISCONNECTED")
  const [logs, setLogs] = useState<Log[]>([]);
  const [activeLease, setActiveLease] = useState<Lease | null>(null)
  const [activePayload, setActivePayload] = useState<string | null>(null)
  const [nodeSpecs, setNodeSpecs] = useState<NodeSpecs | null>(null)
  const [architectProblem, setArchitectProblem] = useState<any>(null)
  const [activeSolution, setActiveSolution] = useState<any>(null)
  const [cores, setCores] = useState<number[]>([])

  const wsRef = useRef<WebSocket | null>(null)
  const payloadRef = useRef<string | null>(null)
  const activeLeaseRef = useRef<Lease | null>(null) // Prevents race conditions
  const isBiddingRef = useRef<boolean>(false) // Prevents multi-bid concurrency
  const logsEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Auto-scroll logs
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [logs])

  useEffect(() => {
    const detectHardware = async () => {
      const threads = navigator.hardwareConcurrency || 4;
      // @ts-ignore
      const ramGb = navigator.deviceMemory || 8;
      applyProfile(threads, ramGb);

      try {
        await loadValhalla();
        addLog("✅ Valhalla Engine Loaded", "success");
        console.log("🗺️ Valhalla WASM ready. Tiles will be downloaded on-demand per task.");
      } catch (e) {
        console.error("Valhalla Load Failed", e);
        addLog("❌ Valhalla Engine Failed", "error");
      }
    };
    detectHardware();
  }, []);

  const applyProfile = (threads: number, ramGb: number) => {
    const ramMb = ramGb * 1024;
    const specs: NodeSpecs = {
      id: `titan_${threads}c_${ramGb}gb_${Math.floor(Math.random() * 1000)}`,
      ram_mb: ramMb,
      vram_mb: 0,
      thread_count: threads,
      is_webgpu_enabled: false,
      affinity_hashes: ["loxi_logistics_v1", "H3_BUE_7"],
      verified_capacity: 0
    };

    setNodeSpecs(specs);
    setCores(new Array(threads).fill(0));
    addLog(`⚙️ Applied Profile: ${threads} Cores / ${ramGb}GB RAM`, "action");
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
    addLog(`Connecting to ${url}...`)
    try {
      const ws = new WebSocket(url)
      wsRef.current = ws

      ws.onopen = async () => {
        setIsConnected(true)
        setStatus("IDLE")
        addLog("Connected. Registering Node with the Grid...", "success")
        ws.send(JSON.stringify({ RegisterNode: nodeSpecs }))
      }

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)

          if (msg.RequestLease) {
            const req = msg.RequestLease

            // BUSY CHECK: If we are already working, ignore new requests
            // BUSY CHECK: If we are already working OR bidding, ignore new requests
            if (activeLeaseRef.current || isBiddingRef.current) {
              return;
            }

            addLog(`Task Broadcast: ${req.requirement.task_type} (${req.requirement.min_ram_mb}MB Required)`)

            if (req.payload) {
              payloadRef.current = req.payload; // IMMEDIATE ACCESS
              setActivePayload(req.payload);
            }

            const freeRamMb = nodeSpecs.ram_mb * 0.8;
            if (req.requirement.min_ram_mb <= freeRamMb) {
              isBiddingRef.current = true; // LOCK
              setTimeout(() => { if (!activeLeaseRef.current) isBiddingRef.current = false; }, 3000); // Failsafe unlock

              addLog(`Specs Match. Submitting Bid...`, "action")
              ws.send(JSON.stringify({
                SubmitBid: {
                  auction_id: req.requirement.id,
                  worker_id: nodeSpecs.id,
                  specs: nodeSpecs,
                  price: 10
                }
              }))
            }
          }

          if (msg.LeaseAssignment) {
            isBiddingRef.current = false; // Unlock bidding
            if (activeLeaseRef.current) return; // Prevent double assignment

            const lease = msg.LeaseAssignment
            setActiveLease(lease)
            activeLeaseRef.current = lease;
            addLog(`WON LEASE! Executing Task: ${lease.task_type} `, "success")
            runArtifact(lease, payloadRef.current); // USE REF FOR IMMEDIATE ACCESS
          }

          if (msg.SubmitSolution) {
            const { auction_id, worker_id, payload } = msg.SubmitSolution;
            const shortId = (id: string) => id.split('_')[0];
            addLog(`✅ Solution Published by ${shortId(worker_id)} for ${shortId(auction_id)}`, "success");
            if (payload) {
              try {
                setActiveSolution(JSON.parse(payload));
              } catch (e) {
                console.warn("Payload decode fail");
              }
            }
          }

        } catch (e) { console.error(e) }
      }
      ws.onclose = () => { setIsConnected(false); setStatus("DISCONNECTED"); addLog("Disconnected", "error"); }
    } catch (e) { addLog("Connection Failed", "error") }
  }

  const runArtifact = async (lease: Lease, initialPayload: string | null) => {
    if (!nodeSpecs) return;
    setStatus("EXECUTING")
    let interval = setInterval(() => setCores(prev => prev.map(() => Math.random() * 100)), 100)
    const hash = lease.artifact_hash;

    try {
      let finalPayload = initialPayload;
      console.log("RunArtifact Payload Status:", initialPayload ? initialPayload.length + " chars" : "NULL");

      let archAddr = lease.architect_address;

      // AUTO-FIX: Force localhost for local dev if stale IP is detected
      if (archAddr.includes("192.168.0.196")) {
        archAddr = archAddr.replace("192.168.0.196", "localhost");
        console.warn("🔧 Auto-corrected Authority Address to localhost");
      }

      // OPTIMIZATION: Only fetch from Data Stream if payload is missing
      if (!finalPayload && archAddr !== "grid://orchestrator") {
        addLog(`🔒 Joining Direct Data Stream: ${archAddr} `, "action");
        const salaSocket = new WebSocket(archAddr);
        finalPayload = await new Promise((resolve, reject) => {
          // FIX: Use LEASE AUCTION ID to request the specific problem data
          salaSocket.onopen = () => {
            console.log(`🔌 Connected to Data Server. Requesting: ${lease.auction_id}`);
            salaSocket.send(JSON.stringify({ DiscoverAuthority: { domain_id: lease.auction_id } }));
          };
          salaSocket.onmessage = (e) => {
            console.log(`📥 Received Data (${e.data.length} bytes)`);
            resolve(e.data);
          };
          salaSocket.onerror = (err) => {
            console.error("Data Socket Error:", err);
            reject("Data Socket Connection Failed");
          };
          salaSocket.onclose = () => {
            console.log("🔌 Data Socket Closed");
          };
          setTimeout(() => reject("Timeout (15s) - Server Unreachable"), 15000);
        });
      }

      if (!finalPayload) {
        addLog("CRITICAL: Payload is NULL. Skipping execution.", "error");
        setStatus("IDLE");
        activeLeaseRef.current = null;
        return;
      }

      // After this point, finalPayload is guaranteed to be a string for WASM calls
      const payload: string = finalPayload;

      // UNWRAP AGNOSTIC ENVELOPE (if present)
      let unwrappedPayload = payload;
      try {
        const parsed = JSON.parse(payload);
        if (parsed.domain_id && parsed.payload && typeof parsed.payload === 'string') {
          console.log("🎁 Unwrapping Agnostic Payload...");
          unwrappedPayload = parsed.payload;
        }
      } catch (e) { /* Not a JSON envelope, proceed as raw */ }

      // PRE-LOAD VALHALLA TILES
      try {
        console.log("🔍 Attempting to pre-load tiles...");
        const problemData = JSON.parse(unwrappedPayload);
        console.log("🔍 Problem data parsed:", Object.keys(problemData));

        // Extract locations from either Matrix format or VRP format
        let locations: Array<{ lat: number; lon: number }> = [];

        if (problemData.locations && Array.isArray(problemData.locations)) {
          // Matrix format
          locations = problemData.locations;
        } else if (problemData.stops && Array.isArray(problemData.stops)) {
          // VRP format - extract lat/lon from stops
          const vehicleStart = problemData.vehicle?.start_location;
          const vehicleEnd = problemData.vehicle?.end_location;

          const stopLocations = problemData.stops.map((stop: any) => ({
            lat: stop.location.lat,
            lon: stop.location.lon
          }));

          // Construct sequence: [Start, ...Stops, End]
          // Using a Set-like approach to avoid exact duplicates if depot is already a stop
          locations = [];
          if (vehicleStart) locations.push(vehicleStart);
          locations.push(...stopLocations);
          if (vehicleEnd && (vehicleEnd.lat !== vehicleStart?.lat || vehicleEnd.lon !== vehicleStart?.lon)) {
            locations.push(vehicleEnd);
          }

          console.log("🔍 Problem context extracted:", {
            stops: stopLocations.length,
            hasStart: !!vehicleStart,
            hasEnd: !!vehicleEnd
          });
        }

        if (locations.length > 0) {
          addLog("📦 Loading tiles...", "action");
          const bbox = calculateBoundingBox(locations);

          const tileServerUrl = import.meta.env.VITE_TILE_SERVER_URL || 'http://localhost:8080';
          // --- FIX: Await Valhalla with fallback if not ready ---
          let module = window.valhallaModule;
          if (!module) {
            console.log("⏳ Valhalla not ready for tiles. Waiting for initialization...");
            module = await loadValhalla();
          }

          if (module) {
            await loadTilesForRegion(module, bbox, tileServerUrl, (loaded, total) => {
              if (loaded % 5 === 0 || loaded === total) {
                console.log(`⏳ Tiles: ${loaded}/${total}`);
              }
            });
            addLog("✅ Tiles ready", "success");
          } else {
            throw new Error("Valhalla engine failed to initialize");
          }
        } else {
          console.warn("⚠️ No locations found in problem data");
        }
      } catch (e) {
        console.warn("⚠️ Tile pre-load warning:", e);
        if (hash === "loxi_sector_v1" || hash === "loxi_valhalla_v1") {
          addLog("❌ Valhalla Initialization Failed", "error");
          throw e; // Abort the task if it depends on Valhalla
        }
      }

      const startTime = Date.now();
      let wasmResponseRaw = "";
      console.log(`🚀 Loading Artifact: ${hash} `);

      if (hash === "loxi_vrp_artifact_v1") {
        // --- VRP SOLVER ARTIFACT ---
        const module = await import(/* @vite-ignore */ `${window.location.origin}/artifacts/loxi_vrp_artifact.js`);
        await module.default();

        // 1. GENERATE MATRIX IF VALHALLA IS AVAILABLE
        let enrichedPayload = unwrappedPayload;
        try {
          const problem = JSON.parse(unwrappedPayload);
          // Only generate matrix if not present and we have stops
          if (!problem.matrix && problem.stops && problem.stops.length > 0) {
            console.log("🧩 Generating Matrix for VRP...");
            addLog("📏 Calculating Cost Matrix...", "action");

            const stops = problem.stops.map((s: any) => s.location);
            const start = problem.vehicle?.start_location || stops[0];
            const end = problem.vehicle?.end_location;

            // Locations: [Start, ...Stops, End] (Generic VRP structure)
            const locations = [start, ...stops];
            if (end && (end.lat !== start.lat || end.lon !== start.lon)) {
              locations.push(end);
            }

            // Call Valhalla Bridge
            const matrixJson = JSON.stringify({ locations, costing: "auto" });
            const matrixResRaw = await callValhallaBridge(matrixJson);
            const matrixRes = JSON.parse(matrixResRaw);

            if (matrixRes.sources_to_targets) {
              console.log("✅ Matrix Calculated:", matrixRes.sources_to_targets.length + "x" + matrixRes.sources_to_targets[0].length);

              // Transform to pure arrays
              const distance_matrix = matrixRes.sources_to_targets.map((row: any[]) => row.map(cell => cell.distance * 1000)); // KM to Meters! Valhalla is KM often, or check units?
              // Valhalla default units: kilometers (distance), seconds (time).
              // Loxi-Logistics (VRP) likely expects Meters and Seconds. 
              // WARNING: Check Loxi units. Default to meters.

              const time_matrix = matrixRes.sources_to_targets.map((row: any[]) => row.map(cell => cell.time));

              problem.matrix = {
                distances: distance_matrix,
                durations: time_matrix
                // dimensions?
              };

              // Alternative keys based on rust struct?
              // Often "distance_matrix" and "duration_matrix" at root or inside "matrix"
              // Let's attach at root for safety too if the rust struct is flat
              problem.distance_matrix = distance_matrix;
              problem.duration_matrix = time_matrix;

              enrichedPayload = JSON.stringify(problem);
              addLog("✅ Matrix Injected", "success");
            }
          }
        } catch (e) {
          console.warn("⚠️ Matrix Generation Failed (Fallack to Haversine):", e);
          addLog("⚠️ Matrix Failed - Using Haversine", "error");
        }

        wasmResponseRaw = module.solve(enrichedPayload);
        console.log("🧩 VRP RAW Response:", wasmResponseRaw);

      } else if (hash === "loxi_partitioner_v1") {
        // --- PARTITIONER ARTIFACT ---
        console.log("🔪 Loading Partitioning WASM...");
        const module = await import(/* @vite-ignore */ `${window.location.origin}/artifacts/loxi_partition_artifact.js`);
        await module.default(`${window.location.origin}/artifacts/loxi_partition_artifact_bg.wasm`);
        wasmResponseRaw = module.partition(unwrappedPayload);

      } else if (hash === "loxi_sector_v1" || hash === "loxi_valhalla_v1") {
        // --- SECTOR / MATRIX ARTIFACT (Titan Potencia) ---
        let vModule = (window as any).valhallaModule;
        if (!vModule) {
          console.log("⏳ Initializing Valhalla for Artifact execution...");
          vModule = await loadValhalla();
        }

        // The engine is already initialized by loadTilesForRegion above if locations were found.
        // If no locations were found, matrix results will be empty anyway.

        // Define the Bridge with Auto-Retry for cold starts
        // Define the Bridge with Auto-Retry for cold starts
        // @ts-ignore
        window.callValhallaBridge = callValhallaBridge; // Use imported utility


        const isSector = hash === "loxi_sector_v1";
        const artBasename = isSector ? "loxi_sector_artifact" : "loxi_matrix_artifact";
        const artModule = await import(/* @vite-ignore */ `${window.location.origin}/artifacts/${artBasename}.js`);
        await artModule.default(`${window.location.origin}/artifacts/${artBasename}_bg.wasm`);

        console.log(`📏 Executing ${artBasename}...`);

        let input = unwrappedPayload;
        try {
          const problem = JSON.parse(unwrappedPayload);
          if (hash === "loxi_valhalla_v1" && problem.stops) {
            const stops = problem.stops.map((s: any) => s.location);
            const start = problem.vehicle?.start_location || stops[0];
            const end = problem.vehicle?.end_location;

            // Unique set of locations for the matrix (Depot Start + Stops + Depot End)
            // But for Matrix we usually want all-to-all starting from Depot
            const locations = [start, ...stops];
            if (end && (end.lat !== start.lat || end.lon !== start.lon)) {
              locations.push(end);
            }

            // Valhalla needs at least 2 locations for a matrix
            if (locations.length < 2) {
              console.warn("⚠️ Minimal locations reached, adding dummy return");
              wasmResponseRaw = JSON.stringify({
                sources_to_targets: [[{ distance: 0, time: 0 }]],
                costing: "auto"
              });
            } else {
              input = JSON.stringify({ locations, costing: "auto" });
            }
          }
        } catch (e) { }

        wasmResponseRaw = isSector ? artModule.solve_sector(input) : artModule.solve(input);
        console.log("📏 Artifact Calculated!");
      } else {
        throw new Error(`Unknown Artifact Hash: ${hash}`);
      }

      const wasmResponse = JSON.parse(wasmResponseRaw);

      // ERROR HANDLING: WASM Wrapper returns "error" field on failure
      if (wasmResponse.error) {
        addLog(`❌ Artifact Error: ${wasmResponse.error} `, "error");
        console.error("Artifact Error:", wasmResponse.error);
        throw new Error(wasmResponse.error); // Abort
      }

      const duration = Date.now() - startTime;
      addLog(`✅ Task Complete in ${duration} ms`, "success");

      wsRef.current?.send(JSON.stringify({
        SubmitSolution: {
          auction_id: lease.auction_id,
          worker_id: nodeSpecs.id,
          result_hash: wasmResponse.hash,
          cost: wasmResponse.cost,
          unassigned_jobs: wasmResponse.unassigned_jobs || [],
          content_type: "application/json",
          payload: wasmResponse.payload
        }
      }));

    } catch (e) { addLog(`❌ Task Error: ${e} `, "error"); console.error(e); }
    finally {
      clearInterval(interval);
      setCores(new Array(nodeSpecs.thread_count).fill(0));
      setStatus("IDLE");
      setActiveLease(null);
      activeLeaseRef.current = null;
    }
  }

  const dispatchToSwarm = async () => {
    if (!architectProblem) return;

    try {
      addLog(`🚀[COMMAND] Sending problem to Conductor...`, "action");
      console.log("Sending to Conductor:", JSON.stringify(architectProblem, null, 2));

      const response = await fetch('http://localhost:3007/submit-problem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(architectProblem)
      });

      if (response.ok) {
        const result = await response.json();
        addLog(`✅ Conductor accepted problem(${result.stops} stops)`, "success");
      } else {
        const errorText = await response.text();
        addLog(`❌ Conductor rejected: ${errorText} `, "error");
        console.error("Conductor error:", errorText);
      }
    } catch (e) {
      addLog(`❌ Failed to reach Conductor: ${e} `, "error");
      console.error("Fetch error:", e);
    }
  };

  const generateProblem = (count: number) => {
    setActivePayload(null);
    setActiveSolution(null);
    // Tile 837 (file: 0/000/837.gph)
    // Rio Gallegos, Argentina - Moving further west to avoid river and snapping issues
    const base = { lat: -51.6226, lon: -69.2450 };

    // Create Depot stop explicitly if we want it to show up as a marker easily,
    // or just let the vehicle handle it.
    const stops = Array.from({ length: count }, (_, i) => ({
      id: `Stop_${i + 1}`,
      location: {
        lat: base.lat + (Math.random() - 0.5) * 0.02, // Smaller spread for urban density
        lon: base.lon + (Math.random() - 0.5) * 0.02
      },
      time_window: { start: 0, end: 86400 },
      service_time: 300,
      demand: 10.0,
      priority: 1
    }));

    setArchitectProblem({
      stops,
      fleet_size: 1,
      seed: 42,
      vehicle: {
        id: "Vehicle_1",
        capacity: 100.0,
        start_location: base,
        // End Location omitted for Open Route
        // end_location: base, 
        shift_window: { start: 0, end: 86400 },
        speed_mps: 10.0
      }
    });
    addLog(`🔧[PILOT] Drafted ${count} stops with Depot. View in Master Map.`, "info");
  };

  if (!nodeSpecs) return <div className="loading">Hardware Detection...</div>

  // MISSION DATA RESOLVER
  let currentStops: any[] = [];
  if (activePayload) {
    try {
      const p = JSON.parse(activePayload);
      currentStops = p.stops || p.problem?.stops || [];
    } catch (e) { }
  }

  // Fallback to local draft if swarm payload is missing/invalid
  if (currentStops.length === 0 && architectProblem) {
    currentStops = architectProblem.stops;
  }

  // ROBUST ROUTE PARSING
  let currentRoute: string[] = [];
  if (activeSolution) {
    if (activeSolution.routes && activeSolution.routes[0] && activeSolution.routes[0].stops) {
      // Standard VRP format: routes[0].stops = [{id: "Stop_1"}, ...]
      currentRoute = activeSolution.routes[0].stops.map((s: any) => typeof s === 'string' ? s : s.id);
    } else if (activeSolution.route) {
      // Simple array format
      currentRoute = activeSolution.route.map((s: any) => typeof s === 'string' ? s : s.id);
    }
    // Ensure we have IDs, filter out undefined
    currentRoute = currentRoute.filter(id => id && typeof id === 'string');
  }

  return (
    <div className="container">
      <header className="header">
        <div className="logo">LOXI // SWARM HUB</div>
        <div className={`status - badge ${status.toLowerCase()} `}>{status}</div>
      </header>

      <main className="dashboard">

        {/* COL 1: CONFIG & STATS */}
        <div className="sidebar-left">
          {/* NODE IDENTITY */}
          <section className="panel status-panel">
            <h2>Node Authority</h2>
            <div className="profile-selector" style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', fontSize: '11px', color: '#94a3b8', marginBottom: '5px' }}>Hardware Profile Simulation</label>
              <select
                onChange={(e) => {
                  const p = PRESETS[e.target.value as keyof typeof PRESETS];
                  applyProfile(p.threads, p.ram);
                }}
                style={{ width: '100%', background: '#020617', color: '#f8fafc', border: '1px solid #1e293b', padding: '8px', borderRadius: '4px' }}
                disabled={isConnected}
              >
                <option value="AUTO">-- Auto Detect --</option>
                {Object.entries(PRESETS).map(([key, p]) => (
                  <option key={key} value={key}>{p.label}</option>
                ))}
              </select>
            </div>
            <div className="spec-grid">
              <div className="spec-item"><label>Node Handle</label><span>{nodeSpecs.id.split('_')[0]}</span></div>
              <div className="spec-item"><label>Cluster Status</label><span>{isConnected ? "SYNCHRONIZED" : "STANDBY"}</span></div>
            </div>
            <div className="connection-box">
              <input type="text" value={url} onChange={e => setUrl(e.target.value)} disabled={isConnected} />
              <button onClick={connect} disabled={isConnected} className="conn-btn">
                {isConnected ? "ACTIVE IN GRID" : "JOIN THE SWARM"}
              </button>
            </div>
          </section>

          {/* MISSION COMMAND */}
          <section className="panel">
            <h2>Mission Command</h2>
            <p className="panel-desc">Dispatch complex logistics tasks to the enjambre grid.</p>
            <div className="gen-buttons">
              <button onClick={() => generateProblem(25)}>25 Stops</button>
              <button onClick={() => generateProblem(100)}>100 Stops</button>
              <button onClick={() => generateProblem(500)} className="stress-btn">500 Stops</button>
            </div>
            {architectProblem && (
              <button className="dispatch-btn" onClick={dispatchToSwarm} disabled={!isConnected}>
                LAUNCH SWARM MISSION
              </button>
            )}
          </section>

          {/* HARDWARE ANALYTICS */}
          <section className="panel">
            <h2>Grid Resource Load</h2>
            <div className="cores-v-grid">
              {cores.map((load, i) => (
                <div key={i} className="core-v">
                  <div className="core-v-bar" style={{ width: `${load}% ` }}></div>
                  <span className="core-v-label">C{i}: {Math.floor(load)}%</span>
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* COL 2: MAP (CENTER) */}
        <div className="map-wrapper">
          <div className="map-header-overlay" style={{ position: 'absolute', top: 20, left: 20, right: 20, zIndex: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', pointerEvents: 'none' }}>
            <div className="map-title" style={{ background: 'rgba(15, 23, 42, 0.9)', padding: '10px 20px', borderRadius: '8px', border: '1px solid rgba(148, 163, 184, 0.1)', backdropFilter: 'blur(8px)', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)' }}>
              <h2 style={{ margin: 0, fontSize: '1rem', color: '#f8fafc', pointerEvents: 'auto' }}>
                {activeLease ? `🛰️ PROCESSING MISSION: ${activeLease.task_type} ` :
                  activeSolution ? "🚩 OPTIMIZATION COMPLETE" :
                    architectProblem ? "📋 MISSION PREVIEW (DRAFT)" : "🔭 SWARM LISTENING..."}
              </h2>
            </div>
            {activeSolution && activeSolution.cost != null &&
              <div className="cost-tag" style={{ background: '#10b981', color: '#fff', padding: '6px 12px', borderRadius: '4px', fontWeight: 'bold', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)' }}>
                Efficiency: {activeSolution.cost.toFixed(1)}
              </div>
            }
          </div>

          {(architectProblem || activePayload) ? (
            <LeafletMap
              stops={currentStops}
              route={currentRoute}
              vehicle={activePayload ? JSON.parse(activePayload).vehicle : architectProblem?.vehicle}
            />
          ) : (
            <div className="placeholder-map" style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569', background: '#020617' }}>
              <p>MASTER MAP OFFLINE - SELECT JOB TO INITIALIZE</p>
            </div>
          )}
        </div>

        {/* COL 3: LOGS (RIGHT) */}
        <div className="sidebar-right">
          <section className="logs-panel">
            <h3>Mission Logs</h3>
            <div className="logs-list">
              {logs.map(log => (
                <div key={log.id} className={`log-row ${log.type}`}>
                  <span className="time">{log.time}</span><span className="msg">{log.message}</span>
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

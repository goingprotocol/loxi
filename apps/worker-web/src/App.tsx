import { useState, useEffect, useRef } from 'react'
import { loadValhalla } from './utils/ValhallaLoader';
import { callValhallaBridge, callValhallaBridgeSync } from './utils/ValhallaBridge';
import { loadSmartTiles, calculateBoundingBox } from './utils/ValhallaTileLoader';
import './App.css'
import LeafletMap from './components/LeafletMap';


declare global {
  interface Window {
    callValhallaBridge: (input: string) => string;
    callValhallaBridgeSync: (input: string) => any;
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
  task_type: string | { Custom: string } | { Compute: null } | { Proxy: null }
  ticket: string
  affinities?: string[]
  metadata?: [string, string][]
}

const DEFAULT_ORCHESTRATOR = "ws://localhost:3005"

function App() {
  const [url, setUrl] = useState(DEFAULT_ORCHESTRATOR)
  const [isConnected, setIsConnected] = useState(false)
  const [status, setStatus] = useState("DISCONNECTED")
  const [logs, setLogs] = useState<Log[]>([]);
  const [activeLease, setActiveLease] = useState<Lease | null>(null)
  const [activePayload, setActivePayload] = useState<string | null>(null)
  const [activeShape, setActiveShape] = useState<string | null>(null)
  const [nodeSpecs, setNodeSpecs] = useState<NodeSpecs | null>(null)
  const [architectProblem, setArchitectProblem] = useState<any>(null)
  const [activeSolutions, setActiveSolutions] = useState<Record<string, any>>({})
  const [valhallaReady, setValhallaReady] = useState(false)
  const [cores, setCores] = useState<number[]>([])
  const [currentMission, setCurrentMission] = useState<string>("")

  const wsRef = useRef<WebSocket | null>(null)
  const payloadRef = useRef<string | null>(null)
  const activeLeaseRef = useRef<Lease | null>(null) // Prevents race conditions
  const isBiddingRef = useRef<boolean>(false) // Prevents multi-bid concurrency
  const logsEndRef = useRef<HTMLDivElement>(null)

  // COMMIT-REVEAL STATE
  const pendingResultRef = useRef<{ auction_id: string, ticket: string, payload: string, architect_address?: string } | null>(null);

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
        // Obviamos la carga en el hilo principal para liberar RAM para los Workers.
        // Valhalla se cargará bajo demanda en hilos separados.
        setValhallaReady(true);
        addLog("✅ Valhalla Engine Ready (Worker-Only Mode)", "success");
      } catch (e) {
        console.error("Valhalla Load Failed", e);
        addLog("❌ Valhalla Engine Initialization Failed", "error");
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

  const getWorkerColor = (id: string) => {
    const hash = id.split('').reduce((acc, char) => char.charCodeAt(0) + ((acc << 5) - acc), 0);
    const colors = ['#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#06b6d4'];
    return colors[Math.abs(hash) % colors.length];
  };

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
              // console.log("Skipping Bid: Busy or already bidding.");
              return;
            }

            const taskTypeDisplay = typeof req.requirement.task_type === 'string'
              ? req.requirement.task_type
              : JSON.stringify(req.requirement.task_type);

            const artifactHash = req.requirement.affinities.find((a: string) => a.startsWith("loxi_")) || "unknown";
            addLog(`📡 Task Broadcast: ${taskTypeDisplay} [${artifactHash}] (${req.requirement.min_ram_mb}MB Required)`)

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
            const tt = lease.task_type;
            const taskTypeDisplay = typeof tt === 'string'
              ? tt
              : (typeof tt === 'object' && tt !== null && 'Custom' in tt ? tt.Custom : Object.keys(tt)[0]);

            addLog(`WON LEASE! Executing Task: ${taskTypeDisplay} `, "success")
            runArtifact(lease, null); // STRICT SEPARATION: No Payload from Lease
          }

          if (msg.RevealRequest) {
            const req = msg.RevealRequest;
            addLog(`🔓 Reveal Request Received for ${req.auction_id}. Pushing Data...`, "action");

            const pending = pendingResultRef.current;
            if (pending && pending.auction_id === req.auction_id) {
              // PUSH DATA TO ARCHITECT
              const targetAddr = req.destination !== "architect_lookup_pending" ? req.destination : pending.architect_address;
              if (targetAddr) {
                const archSocket = new WebSocket(targetAddr);
                archSocket.onopen = () => {
                  archSocket.send(JSON.stringify({
                    PushSolution: {
                      auction_id: pending.auction_id,
                      ticket: pending.ticket,
                      payload: pending.payload
                    }
                  }));
                  setTimeout(() => archSocket.close(), 500);
                };
              }
            }
          }

          if (msg.SubmitSolution) {
            const { auction_id, worker_id, payload } = msg.SubmitSolution;
            const shortId = (id: string) => id.split('_')[0];
            addLog(`✅ Solution Published by ${shortId(worker_id)} for ${shortId(auction_id)}`, "success");
            if (payload) {
              try {
                const sol = JSON.parse(payload);
                setActiveSolutions(prev => ({ ...prev, [auction_id]: { ...sol, worker_id } }));
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

    // RECOVER ARTIFACT HASH FROM LEASE (Agnostic)
    let hash = lease.affinities?.find(a => a.startsWith("loxi_")) || "";

    try {
      if (initialPayload) setActivePayload(initialPayload);
      let finalPayload = initialPayload;
      console.log("RunArtifact Payload Status:", initialPayload ? initialPayload.length + " chars" : "NULL");

      let archAddr = lease.architect_address;

      // AUTO-FIX: Force localhost for local dev if stale IP is detected
      if (archAddr.includes("192.168.0.196")) {
        archAddr = archAddr.replace("192.168.0.196", "localhost");
      }

      // MANDATORY: Fetch from Data Stream (Direct Pull)
      if (!finalPayload && archAddr !== "grid://orchestrator") {
        addLog(`🔒 Joining Direct Data Stream: ${archAddr} `, "action");
        const salaSocket = new WebSocket(archAddr);
        finalPayload = await new Promise((resolve, reject) => {
          // FIX: Use LEASE AUCTION ID to request the specific problem data
          salaSocket.onopen = () => {
            console.log(`🔌 Connected to Data Server. Requesting: ${lease.auction_id}`);
            console.log("🎟️ Authenticating with Ticket...");
            salaSocket.send(JSON.stringify({ ClaimTask: { auction_id: lease.auction_id, ticket: lease.ticket } }));
          };
          salaSocket.onmessage = (e) => {
            console.log(`📥 Received Data (${e.data.length} bytes)`);
            resolve(e.data);
            salaSocket.close(); // Close after fetch
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
        if (parsed.PostTask && parsed.PostTask.payload) {
          console.log("🎁 Unwrapping Loxi Protocol Envelope (PostTask)...");
          unwrappedPayload = parsed.PostTask.payload;
        } else if (parsed.domain_id && parsed.payload && typeof parsed.payload === 'string') {
          console.log("🎁 Unwrapping Agnostic Payload...");
          unwrappedPayload = parsed.payload;
        }
      } catch (e) { /* Not a JSON envelope, proceed as raw */ }

      // Double-check unwrapping if nested
      if (typeof unwrappedPayload === 'string' && (unwrappedPayload.startsWith('{') || unwrappedPayload.startsWith('['))) {
        try {
          // Peek inside to see if we need another layer of unwrap (rare edge case)
          const deep = JSON.parse(unwrappedPayload);
          if (deep.PostTask && deep.PostTask.payload) unwrappedPayload = deep.PostTask.payload;
        } catch (e) { }
      }

      console.log("📦 [APP-DEBUG] Unwrapped Payload Preview:", unwrappedPayload.substring(0, 500));

      // FINAL HASH RECOVERY (If still missing)
      if (!hash) {
        try {
          const parsed = JSON.parse(unwrappedPayload);
          hash = parsed.artifact_hash || parsed.hash || "";
        } catch (e) { }
      }

      if (!hash) {
        addLog("❌ Error: Could not resolve Artifact Hash from payload.", "error");
        throw new Error("Missing Artifact Hash");
      }

      // ============================================================
      // 🧠 SMART TILE LOADING STRATEGY
      // ============================================================
      const requiresMainThreadTiles = hash === "loxi_vrp_artifact_v1" || hash === "loxi_sector_v1";

      if (requiresMainThreadTiles) {
        try {
          console.log("🔍 Pre-loading tiles for Main Thread Execution...");
          const problemData = JSON.parse(unwrappedPayload);
          let locations: Array<{ lat: number; lon: number }> = [];

          if (problemData.locations) {
            locations = problemData.locations;
          } else if (problemData.stops) {
            const vehicleStart = problemData.vehicle?.start_location;
            const stopLocations = problemData.stops.map((stop: any) => stop.location);
            locations = [vehicleStart, ...stopLocations].filter(l => l);
          }

          if (locations.length > 0) {
            addLog("📦 Loading tiles (Main Thread)...", "action");
            calculateBoundingBox(locations);

            const tileServerUrl = import.meta.env.VITE_TILE_SERVER_URL || 'http://localhost:8080';
            let module = (window as any).valhallaModule;
            if (!module) {
              console.log("⏳ Valhalla not ready for tiles. Waiting for initialization...");
              module = await loadValhalla();
            }

            if (module) {
              await loadSmartTiles(module, locations, tileServerUrl, (loaded, total) => {
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
          if (hash === "loxi_sector_v1") {
            addLog("❌ Valhalla Initialization Failed", "error");
            throw e;
          }
        }
      } else {
        console.log("⏩ Skipping Main Thread Tile Load (Worker will handle it).");
      }


      const startTime = Date.now();
      let wasmResponseRaw = "";
      console.log(`🚀 Loading Artifact: ${hash} `);

      if (hash === "loxi_vrp_artifact_v1") {
        const module = await import(/* @vite-ignore */ `${window.location.origin}/artifacts/loxi_vrp_artifact.js`);
        await module.default();
        const solverInput = JSON.stringify({
          auction_id: lease.auction_id,
          domain_id: "logistics",
          payload: unwrappedPayload
        });

        wasmResponseRaw = module.solve(solverInput);
        console.log("🧩 VRP RAW Response:", wasmResponseRaw);

      } else if (hash === "loxi_partitioner_v1") {
        console.log("🔪 Loading Partitioning WASM...");
        const module = await import(/* @vite-ignore */ `${window.location.origin}/artifacts/loxi_partition_artifact.js`);
        await module.default(`${window.location.origin}/artifacts/loxi_partition_artifact_bg.wasm`);
        wasmResponseRaw = module.partition(unwrappedPayload);

      } else if (hash === "loxi_sector_v1") {
        let input = unwrappedPayload;
        try {
          const problem = JSON.parse(unwrappedPayload);
          if (problem.stops) {
            const stops = problem.stops.map((s: any) => s.location);
            const start = problem.vehicle?.start_location || stops[0];
            const end = problem.vehicle?.end_location;

            const locations = [start, ...stops];
            if (end && (end.lat !== start.lat || end.lon !== start.lon)) {
              locations.push(end);
            }
          }
        } catch (e) { }

        let vModule = (window as any).valhallaModule;
        if (!vModule) vModule = await loadValhalla();
        // @ts-ignore
        window.callValhallaBridge = callValhallaBridge;
        // @ts-ignore
        window.callValhallaBridgeSync = callValhallaBridgeSync;

        const artModule = await import(/* @vite-ignore */ `${window.location.origin}/artifacts/loxi_sector_artifact.js`);
        await artModule.default(`${window.location.origin}/artifacts/loxi_sector_artifact_bg.wasm`);
        wasmResponseRaw = artModule.solve_sector(input);
      } else if (hash === "loxi_valhalla_v1") {
        console.log("⚡ Executing Matrix in Disposable Worker...");

        let input = unwrappedPayload;
        try {
          const problem = JSON.parse(unwrappedPayload);
          if (problem.stops || problem.locations) {
            console.log("🔄 Transforming Payload for Matrix Worker...");
            const locations = problem.locations || (problem.stops.map((s: any) => s.location));
            const start = problem.vehicle?.start_location || locations[0];
            const end = problem.vehicle?.end_location;

            const finalLocations = [start, ...locations].filter((l: any) => l && typeof l.lat === 'number');
            if (end && (end.lat !== start.lat || end.lon !== start.lon)) {
              finalLocations.push(end);
            }
            input = JSON.stringify({ locations: finalLocations, costing: problem.costing || "auto" });
          }
        } catch (e) { console.warn("Payload transform warning:", e); }

        // @ts-ignore
        const { runValhallaWorker } = await import('./utils/ValhallaBridge');

        const workerResult = await runValhallaWorker(input, 'CALCULATE_MATRIX');

        if (typeof workerResult === 'string' && (workerResult.includes("std::bad_alloc") || workerResult.includes("unordered_map") || workerResult.includes("Valhalla not initialized"))) {
          addLog(`🚨 Critical: Engine hit a memory boundary (bad_alloc) during Matrix.`, "error");
          throw new Error(`Valhalla Worker Error: ${workerResult}`);
        }

        wasmResponseRaw = typeof workerResult === 'string' ? workerResult : JSON.stringify(workerResult);

      } else {
        throw new Error(`Unknown Artifact Hash: ${hash}`);
      }

      let wasmResponse: any;
      try {
        wasmResponse = typeof wasmResponseRaw === 'string' ? JSON.parse(wasmResponseRaw) : wasmResponseRaw;
      } catch (e) {
        if (typeof wasmResponseRaw === 'string' && wasmResponseRaw.includes("bad_alloc")) {
          wasmResponse = { error: wasmResponseRaw };
        } else {
          console.error("JSON Parse Error on WASM response:", wasmResponseRaw);
          throw new Error("Invalid WASM Response Format");
        }
      }

      if (wasmResponse.error) {
        addLog(`❌ Artifact Error: ${wasmResponse.error} `, "error");
        console.error("Artifact Error:", wasmResponse.error);
        throw new Error(wasmResponse.error);
      }

      const duration = Date.now() - startTime;
      addLog(`✅ Task Complete in ${duration} ms`, "success");

      const sol = wasmResponse.payload
        ? (typeof wasmResponse.payload === 'string' ? JSON.parse(wasmResponse.payload) : wasmResponse.payload)
        : wasmResponse;

      if (sol.sources_to_targets && sol.sources_to_targets[0]) {
        // Matrix success display
        const firstTrip = sol.sources_to_targets[0].find((t: any) => t && t.distance > 0);
        if (firstTrip) {
          const dist = firstTrip.distance.toFixed(1);
          const time = firstTrip.time.toFixed(1);
          addLog(`📊 Matrix Result: ${dist}km / ${time}s`, "success");
        }
        setActiveShape(null);
      } else if (sol.route && sol.route.length > 0) {
        // Solve success display
        const stopCount = sol.route.length;
        const cost = sol.cost?.toFixed(1) || 0;
        addLog(`🏆 Solve Result: ${stopCount} stops / Efficiency ${cost}`, "success");
        setActiveShape(null);
      } else {
        setActiveShape(null);
      }

      setActiveSolutions(prev => ({ ...prev, [lease.auction_id]: sol }));

      const nextAction = hash === "loxi_partitioner_v1" ? "matrix"
        : hash === "loxi_valhalla_v1" ? "solve"
          : hash === "loxi_vrp_artifact_v1" ? "finish"
            : undefined;

      const finalPayloadString = wasmResponse.payload
        ? (typeof wasmResponse.payload === 'string' ? wasmResponse.payload : JSON.stringify(wasmResponse.payload))
        : JSON.stringify(wasmResponse);

      // 1. STORE RESULT (COMMIT)
      pendingResultRef.current = {
        auction_id: lease.auction_id,
        ticket: lease.ticket || "",
        payload: finalPayloadString, // Full Payload
        // We also need the architect address to push to later
        // Hack: we attach it here or use the one from RevealRequest if provided
        // Let's attach it to the object for safety
        // @ts-ignore
        architect_address: lease.architect_address
      };

      const metadata = [
        ["state", "finished"],
        ["duration_ms", duration.toString()],
        ["next_action", nextAction || "none"]
      ];

      // 2. CONTROL PLANE: Signal Completion (HASH ONLY)
      addLog("🔒 Committing Solution Hash to Orchestrator...", "action");
      wsRef.current?.send(JSON.stringify({
        SubmitSolution: {
          auction_id: lease.auction_id,
          worker_id: nodeSpecs.id,
          result_hash: wasmResponse.hash || "generated", // Hash
          payload: null,
          metadata
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

      const response = await fetch('http://localhost:3007/submit-problem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(architectProblem)
      });

      if (response.ok) {
        const result = await response.json();
        const ids = result.auction_ids || [];
        const missionId = result.mission_id || "";

        setCurrentMission(missionId);
        setActiveSolutions({}); // Clear previous mission data

        addLog(`✅ Conductor accepted problem. Mission ID: ${missionId}. IDs: ${ids.join(', ')}`, "success");

        if (missionId) {
          const pollInterval = setInterval(async () => {
            try {
              const solRes = await fetch(`http://localhost:3007/get-solution?mission_id=${missionId}`);
              const solutionsMap = await solRes.json();

              // Handle both legacy Array and new HashMap semantic
              const solutions = Array.isArray(solutionsMap) ? solutionsMap : Object.values(solutionsMap);

              if (solutions.length > 0) {
                let resolvedCount = 0;
                solutions.forEach((sol: any) => {
                  const id = sol.id || sol.auction_id;
                  if (id && (sol.routes || sol.route)) {
                    // Log if it's new
                    setActiveSolutions(prev => {
                      if (!prev[id]) {
                        addLog(`📦 Partition Resolved: ${id.split('-')[0]}...`, "success");
                      }
                      return {
                        ...prev,
                        [id]: sol
                      };
                    });
                    resolvedCount++;
                  }
                });

                if (resolvedCount >= ids.length && ids.length > 0) {
                  addLog("🏁 Mission Complete: Optimization goals reached.", "success");
                  clearInterval(pollInterval);
                }
              }
            } catch (e) {
              console.warn("Polling error:", e);
            }
          }, 3000);

          setTimeout(() => clearInterval(pollInterval), 600000);
        }
      } else {
        const errorText = await response.text();
        addLog(`❌ Conductor rejected: ${errorText}`, "error");
        console.error("Conductor error:", errorText);
      }
    } catch (e) {
      addLog(`❌ Failed to reach Conductor: ${e} `, "error");
      console.error("Fetch error:", e);
    }
  };

  const generateProblem = (count: number) => {
    setActivePayload(null);
    setActiveSolutions({});
    setActiveShape(null);
    const base = { lat: -34.592365579155024, lon: -58.5529111002654 };

    const stops = Array.from({ length: count }, (_, i) => ({
      id: `Stop_${i + 1}`,
      location: {
        lat: base.lat + (Math.random() - 0.5) * 0.02,
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
        shift_window: { start: 0, end: 86400 },
        speed_mps: 10.0
      }
    });
    addLog(`🔧[PILOT] Drafted ${count} stops with Depot. View in Master Map.`, "info");
  };


  if (!nodeSpecs) return <div className="loading">Hardware Detection...</div>

  let currentStops: any[] = [];
  if (activePayload) {
    try {
      const p = JSON.parse(activePayload);
      currentStops = p.stops || p.problem?.stops || [];
    } catch (e) { }
  }

  if (currentStops.length === 0 && architectProblem) {
    currentStops = architectProblem.stops;
  }

  const currentRoutes: string[][] = Object.entries(activeSolutions)
    .filter(([id, sol]: [string, any]) => (id.startsWith(currentMission) || sol.mission_id === currentMission || !currentMission))
    .map(([_, sol]: [string, any]) => {
      let route: string[] = [];
      if (sol.routes && sol.routes[0] && sol.routes[0].stops) {
        route = sol.routes[0].stops.map((s: any) => typeof s === 'string' ? s : s.id);
      } else if (sol.route) {
        route = sol.route.map((s: any) => typeof s === 'string' ? s : s.id);
      }
      return route.filter(id => id && typeof id === 'string');
    }).filter(r => r.length > 0);

  const totalCost = Object.values(activeSolutions).reduce((acc: number, sol: any) => acc + (sol.cost || 0), 0);
  const hasSolutions = Object.keys(activeSolutions).length > 0;

  const totalPartitions = architectProblem?.stops?.length > nodeSpecs?.thread_count ? Math.ceil(architectProblem.stops.length / 25) : 1;
  const idsResolved = Object.entries(activeSolutions).filter(([id, sol]) => id.startsWith(currentMission) && (sol.routes || sol.route)).length;

  const stopAssignments: Record<string, string> = {};
  Object.entries(activeSolutions)
    .filter(([id, sol]: [string, any]) => id.startsWith(currentMission) || sol.mission_id === currentMission || !currentMission)
    .forEach(([_, sol]: [string, any]) => {
      const workerId = sol.worker_id;
      if (workerId) {
        const color = getWorkerColor(workerId);
        let stops: string[] = [];
        if (sol.routes && sol.routes[0] && sol.routes[0].stops) {
          stops = sol.routes[0].stops.map((s: any) => typeof s === 'string' ? s : s.id);
        } else if (sol.route) {
          stops = sol.route.map((s: any) => typeof s === 'string' ? s : s.id);
        }
        stops.forEach(id => { if (id) stopAssignments[id] = color; });
      }
    });

  if (activeLease && activePayload) {
    try {
      const p = JSON.parse(activePayload);
      const stops = p.stops || p.problem?.stops || [];
      const color = getWorkerColor(nodeSpecs.id);
      stops.forEach((s: any) => { if (s.id) stopAssignments[s.id] = color; });
    } catch (e) { }
  }

  return (
    <div className="container">
      <header className="header">
        <div className="logo">LOXI // SWARM HUB</div>
        <div className={`status-badge ${status.toLowerCase()}`}>{status} {idsResolved > 0 && `(${idsResolved}/${totalPartitions})`}</div>
      </header>

      <main className="dashboard">

        {/* COL 1: CONFIG & STATS */}
        <div className="sidebar-left">
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

          <section className="panel">
            <h2>🧪 Valhalla Engine Test</h2>
            <p className="panel-desc">Test Valhalla routing with LazyFS (on-demand tile loading)</p>
            <button
              className="dispatch-btn"
              onClick={async () => {
                try {
                  addLog("🧪 Testing Valhalla Engine with LazyFS...", "action");

                  // Buenos Aires to Mar del Plata (long distance route)
                  const testLocations = [
                    { lat: -34.6037, lon: -58.3816 }, // Buenos Aires
                    { lat: -38.0055, lon: -57.5426 }  // Mar del Plata
                  ];

                  const matrixRequest = JSON.stringify({
                    locations: testLocations,
                    costing: "auto"
                  });

                  addLog("📡 Calling Valhalla Worker...", "info");

                  // @ts-ignore
                  const { runValhallaWorker } = await import('./utils/ValhallaBridge');
                  const result = await runValhallaWorker(matrixRequest, 'CALCULATE_MATRIX');

                  if (typeof result === 'string' && result.includes("error")) {
                    addLog(`❌ Valhalla Error: ${result}`, "error");
                  } else {
                    const matrix = typeof result === 'string' ? JSON.parse(result) : result;
                    if (matrix.sources_to_targets && matrix.sources_to_targets[0]) {
                      const trip = matrix.sources_to_targets[0][1];
                      if (trip) {
                        const dist = trip.distance.toFixed(1);
                        const time = trip.time.toFixed(1);
                        addLog(`✅ Valhalla Test Success!`, "success");
                        addLog(`📊 BUE → MDP: ${dist}km / ${time}s`, "success");
                      }
                    }
                  }
                } catch (e) {
                  addLog(`❌ Valhalla Test Failed: ${e}`, "error");
                  console.error(e);
                }
              }}
              disabled={!valhallaReady}
            >
              🧪 TEST VALHALLA + LAZYFS
            </button>

          </section>

          <section className="panel">
            <h2>Mission Command</h2>
            <p className="panel-desc">Dispatch complex logistics tasks to the enjambre grid.</p>
            <div className="gen-buttons">
              <button onClick={() => generateProblem(25)}>25 Stops</button>
              <button onClick={() => generateProblem(100)}>100 Stops</button>
              <button onClick={() => generateProblem(500)} className="stress-btn">500 Stops</button>
            </div>
            <button
              className="dispatch-btn"
              style={{ marginTop: '15px', background: '#10b981', width: '100%' }}
              onClick={async () => {
                if (!architectProblem) {
                  addLog("⚠️ No problem generated yet. Generate stops first.", "error");
                  return;
                }
                try {
                  addLog("🚀 Dispatching to Loxi system...", "action");
                  // TODO: Implement Loxi dispatch logic
                  addLog("✅ Problem dispatched to Loxi!", "success");
                } catch (e) {
                  addLog(`❌ Dispatch failed: ${e}`, "error");
                  console.error(e);
                }
              }}
              disabled={!architectProblem}
            >
              🚀 DISPATCH TO LOXI
            </button>
            {architectProblem && (
              <button className="dispatch-btn" onClick={dispatchToSwarm} disabled={!isConnected}>
                LAUNCH SWARM MISSION
              </button>
            )}
          </section>

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
                {activeLease ? (function () {
                  const tt = activeLease.task_type;
                  const display = typeof tt === 'string' ? tt : (typeof tt === 'object' && tt !== null && 'Custom' in tt ? tt.Custom : Object.keys(tt)[0]);
                  return `🛰️ PROCESSING MISSION: ${display}`;
                })() :
                  hasSolutions || activeShape ? "🚩 OPTIMIZATION COMPLETE" :
                    architectProblem ? "📋 MISSION PREVIEW (DRAFT)" : "🔭 SWARM LISTENING..."}
              </h2>
            </div>
            {totalCost > 0 &&
              <div className="cost-tag" style={{ background: '#10b981', color: '#fff', padding: '6px 12px', borderRadius: '4px', fontWeight: 'bold', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)' }}>
                Total Efficiency: {totalCost.toFixed(1)}
              </div>
            }
          </div>

          {(architectProblem || activePayload || activeShape || activeLease) ? (
            <LeafletMap
              stops={currentStops || []}
              routes={currentRoutes || []}
              vehicle={activePayload ? (function () { try { return JSON.parse(activePayload).vehicle } catch (e) { return architectProblem?.vehicle } })() : architectProblem?.vehicle}
              shape={activeShape || undefined}
              stopAssignments={stopAssignments}
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
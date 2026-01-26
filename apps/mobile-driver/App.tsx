import React, { useState, useEffect, useRef } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Text, View, ScrollView, SafeAreaView, StyleSheet, TextInput, TouchableOpacity } from 'react-native';
import { WebView } from 'react-native-webview';
import { WASM_BASE64 } from './WasmData';

// DEFAULT CONFIG
const DEFAULT_URL = 'ws://localhost:3005';
const NODE_SPECS = {
  id: "mobile_sovereign_" + Math.floor(Math.random() * 1000),
  ram_mb: 4000,
  vram_mb: 0,
  thread_count: 4,
  is_webgpu_enabled: false,
  affinity_hashes: ["loxi_logistics_v1", "loxi_vrp_artifact_v1"],
  verified_capacity: 0
};

type Log = {
  id: string;
  time: string;
  message: string;
  type: 'info' | 'success' | 'error' | 'action';
};

export default function App() {
  const [serverUrl, setServerUrl] = useState(DEFAULT_URL);
  const [isConnected, setIsConnected] = useState(false);
  const [logs, setLogs] = useState<Log[]>([]);
  const [status, setStatus] = useState('Disconnected');
  const [assignment, setAssignment] = useState<any>(null);
  const [isWasmReady, setIsWasmReady] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const webViewRef = useRef<WebView | null>(null);
  const reqCache = useRef<any>(null);
  const activeAssignmentRef = useRef<any>(null); // Prevents concurrency
  const isBiddingRef = useRef<boolean>(false); // Prevents multi-bid concurrency

  const addLog = (message: string, type: Log['type'] = 'info') => {
    setLogs(prev => [{
      id: Date.now().toString() + "_" + Math.random().toString(36).substr(2, 9),
      time: new Date().toLocaleTimeString().split(' ')[0],
      message,
      type
    }, ...prev.slice(0, 50)]);
  };

  const wasmRuntimeHtml = `
  <html>
  <body>
    <script>
      let wasm;
      const TextEncoder = window.TextEncoder;
      const TextDecoder = window.TextDecoder;
      
      // LOGGING BRIDGE
      const originalLog = console.log;
      console.log = function(...args) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOG', message: args.join(' ') }));
          originalLog.apply(console, args);
      };
      const originalInfo = console.info;
      console.info = function(...args) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOG', message: '[INFO] ' + args.join(' ') }));
          originalInfo.apply(console, args);
      };
      const originalError = console.error;
      console.error = function(...args) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOG', message: '[ERROR] ' + args.join(' ') }));
          originalError.apply(console, args);
      };

      let cachedTextEncoder = new TextEncoder();
      let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
      
      let WASM_VECTOR_LEN = 0;
      let cachedUint8ArrayMemory0 = null;
      function getUint8ArrayMemory0() {
          if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
              cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
          }
          return cachedUint8ArrayMemory0;
      }

      function passStringToWasm0(arg, malloc, realloc) {
          const buf = cachedTextEncoder.encode(arg);
          const ptr = malloc(buf.length, 1) >>> 0;
          getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
          WASM_VECTOR_LEN = buf.length;
          return ptr;
      }

      function getStringFromWasm0(ptr, len) {
          ptr = ptr >>> 0;
          const ret = cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
          return ret;
      }

      async function init() {
          try {
            console.log("🚀 Starting WASM Init...");
            const binaryString = window.atob("${WASM_BASE64}");
            console.log("📦 Decoded " + binaryString.length + " bytes");
            
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }

            const imports = {
                "./loxi_vrp_artifact_bg.js": {
                    __wbg_error_7534b8e9a36f1ab4: console.error,
                    __wbg_new_8a6f238a6ece86ea: () => new Error(),
                    __wbg_stack_0ed75d68575b0f3c: () => {},
                    __wbindgen_init_externref_table: () => {}
                }
            };

            const result = await WebAssembly.instantiate(bytes, imports);
            wasm = result.instance.exports;
            if (wasm.__wbindgen_start) wasm.__wbindgen_start();
            
            console.log("✅ WASM Ready. Exports:", Object.keys(wasm));
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'READY' }));
          } catch (e) {
            console.error("Init Error:", e);
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ERROR', message: "Init: " + e.message }));
          }
      }

      function solveVrp(payload) {
          let deferred2_0, deferred2_1;
          try {
              console.log("🧠 solveVrp called. Payload len:", payload.length);
              
              if (!wasm.solve) throw new Error("wasm.solve function not found!");

              const ptr0 = passStringToWasm0(payload, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
              const len0 = WASM_VECTOR_LEN;
              
              console.log("Calling wasm.solve(", ptr0, len0, ")");
              const ret = wasm.solve(ptr0, len0);
              console.log("wasm.solve returned:", ret);

              // RET IS [ptr, len] due to cdylib return convention for String
              // IF ret is a number (pointer to struct) or pure pointer?
              // Standard bindgen returning String usually requires retptr argument.
              // IF the signature was 'solve(ptr, len) -> ptr_to_struct { ptr, len }'?
              // The original Code assumed array.
              
              return getStringFromWasm0(ret[0], ret[1]);
          } catch (e) {
              console.error("Solve Error:", e);
              return JSON.stringify({ error: e.message });
          }
      }

      window.addEventListener('message', async (event) => {
          const data = JSON.parse(event.data);
          if (data.type === 'SOLVE') {
              const solution = solveVrp(data.payload);
              window.ReactNativeWebView.postMessage(JSON.stringify({ 
                type: 'SOLUTION', 
                payload: JSON.parse(solution) 
              }));
          }
      });

      init();
    </script>
  </body>
  </html>
  `;

  const onWebViewMessage = (event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);

      if (data.type === 'LOG') {
        const msg = data.message;
        const type = msg.includes('ERROR') ? 'error' : 'info';
        addLog(`🔧 WASM: ${msg}`, type);
        return;
      }

      if (data.type === 'READY') {
        setIsWasmReady(true);
        addLog('📂 SDK: WASM Runtime Initialized', 'success');
      } else if (data.type === 'SOLUTION') {
        const solution = data.payload;
        addLog(`✅ SDK: Solution Found! Cost: ${solution.cost.toFixed(2)}`, 'success');

        const solutionMsg = {
          SubmitSolution: {
            auction_id: assignment?.auction_id || reqCache.current?.requirement?.id || "unknown",
            worker_id: NODE_SPECS.id,
            result_hash: "hash_" + Date.now(),
            cost: solution.cost,
            content_type: "application/json",
            payload: JSON.stringify(solution)
          }
        };
        wsRef.current?.send(JSON.stringify(solutionMsg));
        addLog(`🚀 SDK: Solution Submitted to Grid`, 'success');
        setStatus('Idle');
        setAssignment(null);
        activeAssignmentRef.current = null;
      } else if (data.type === 'ERROR') {
        addLog(`❌ WASM Error: ${data.message}`, 'error');
        setStatus('Idle');
        setAssignment(null);
        activeAssignmentRef.current = null;
      }
    } catch (e) {
      console.error(e);
    }
  };

  const connectToGrid = () => {
    if (!serverUrl) return;

    addLog(`Connecting to Loxi Swarm at ${serverUrl}...`);
    try {
      const ws = new WebSocket(serverUrl);
      wsRef.current = ws;

      ws.onopen = async () => {
        setIsConnected(true);
        setStatus('BENCHMARKING ⚡');
        addLog('Protocol: Verifying Hardware Passport...', 'info');

        const startTime = Date.now();
        let sum = 0;
        for (let i = 0; i < 5000000; i++) sum += Math.sqrt(i);
        const duration = Date.now() - startTime;
        const capacity = Math.floor((NODE_SPECS.thread_count * (NODE_SPECS.ram_mb / 1024) * 1000) / duration);
        NODE_SPECS.verified_capacity = capacity;

        setStatus('Connected (Sovereign Node)');
        addLog(`Score: ${capacity}`, 'success');

        const registerMsg = { RegisterNode: NODE_SPECS };
        ws.send(JSON.stringify(registerMsg));
        addLog(`Node Identity: ${NODE_SPECS.id}`, 'action');
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);

          if (msg.RequestLease) {
            const req = msg.RequestLease;
            console.log("📩 Mobile Rx Request:", req.domain_id);
            console.log("📦 Payload:", req.payload ? req.payload.length + " bytes" : "NULL");

            // TASK TYPE CHECK (Mobile only supports VRP 'solve')
            if (req.requirement?.task_type !== 'solve') {
              console.log(`⚠️ Ignoring Task Type: ${req.requirement?.task_type} (Only 'solve' supported)`);
              return;
            }

            // BUSY CHECK
            if (activeAssignmentRef.current || isBiddingRef.current) {
              console.log("⚠️ Ignoring: BUSY");
              return;
            }

            reqCache.current = req;
            addLog(`Opportunity: ${req.domain_id} [RAM: ${req.requirement.min_ram_mb}MB]`);

            const freeRamMb = NODE_SPECS.ram_mb * 0.7;
            if (req.requirement.min_ram_mb > freeRamMb) {
              addLog(`🛑 GUARDRAIL: RAM Exceeded. Declining.`, 'error');
              return;
            }

            if (NODE_SPECS.ram_mb >= req.requirement.min_ram_mb) {
              isBiddingRef.current = true;
              setTimeout(() => { if (!activeAssignmentRef.current) isBiddingRef.current = false; }, 3000);

              const bidMsg = {
                SubmitBid: {
                  auction_id: req.requirement.id || "unknown_auction",
                  worker_id: NODE_SPECS.id,
                  specs: NODE_SPECS,
                  price: 5
                }
              };
              ws.send(JSON.stringify(bidMsg));
              addLog(`⚡ Swarm: Bidding for Task...`, 'action');
            }
          }

          if (msg.LeaseAssignment) {
            isBiddingRef.current = false;
            if (activeAssignmentRef.current) return;

            const lease = msg.LeaseAssignment;
            activeAssignmentRef.current = lease;
            setStatus('EXECUTING 🧬');
            addLog(`🏆 WON LEASE! Artifact: ${lease.artifact_hash}`, 'success');
            setAssignment(lease);

            if (reqCache.current && reqCache.current.payload) {
              addLog(`⚡ SDK: Hot-Loading Artifact ${lease.artifact_hash}...`, 'action');

              if (isWasmReady) {
                webViewRef.current?.postMessage(JSON.stringify({
                  type: 'SOLVE',
                  payload: reqCache.current.payload
                }));
              } else {
                addLog('❌ SDK: Error - WASM Bootstrapping...', 'error');
              }
            }
          }

        } catch (err) {
          console.error(err);
        }
      };

      ws.onerror = () => {
        setStatus('Connection Error');
        setIsConnected(false);
      };

      ws.onclose = () => {
        setStatus('Disconnected');
        setIsConnected(false);
      };
    } catch (e) {
      addLog('Invalid Orchestrator URL', 'error');
    }
  };

  const disconnect = () => {
    wsRef.current?.close();
    setIsConnected(false);
    setAssignment(null);
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="auto" />

      {/* Headless WASM Engine */}
      <View style={{ width: 0, height: 0, opacity: 0 }}>
        <WebView
          ref={webViewRef}
          source={{ html: wasmRuntimeHtml }}
          onMessage={onWebViewMessage}
        />
      </View>

      {!isConnected ? (
        <View style={styles.centerContent}>
          <Text style={styles.title}>Loxi Sovereign Node</Text>
          <Text style={styles.subtitle}>Physical Compute Infrastructure</Text>
          <TextInput
            style={styles.input}
            value={serverUrl}
            onChangeText={setServerUrl}
            placeholder="ws://192.168.1.X:3005"
            autoCapitalize="none"
          />
          <TouchableOpacity style={styles.button} onPress={connectToGrid}>
            <Text style={styles.buttonText}>Join Compute Swarm</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={{ flex: 1 }}>
          <View style={styles.header}>
            <View>
              <Text style={styles.title}>Sovereign Scout</Text>
              <Text style={styles.subtitle}>{NODE_SPECS.id}</Text>
            </View>
            <TouchableOpacity style={styles.disconnectBtn} onPress={disconnect}>
              <Text style={styles.disconnectText}>Exit</Text>
            </TouchableOpacity>
          </View>

          <View style={[styles.badge, status.includes('EXECUTING') ? styles.badgeSuccess : styles.badgeNeutral]}>
            <Text style={styles.badgeText}>{status}</Text>
          </View>

          {assignment ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>🧬 Processing Artifact</Text>
              <Text style={{ fontFamily: 'monospace', fontSize: 12 }}>Hash: ${assignment.artifact_hash}</Text>
              <Text style={{ marginTop: 5 }}>Calculating Optimal Vector Field...</Text>
            </View>
          ) : (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>📡 Swarm Listening...</Text>
              <Text style={{ color: '#666' }}>Active on {serverUrl}</Text>
            </View>
          )}

          <Text style={styles.sectionHeader}>Grid Telemetry</Text>
          <ScrollView style={styles.logContainer}>
            {logs.map(log => (
              <View key={log.id} style={styles.logRow}>
                <Text style={styles.logTime}>{log.time}</Text>
                <Text style={[styles.logText, styles[`log_${log.type}`]]}>{log.message}</Text>
              </View>
            ))}
          </ScrollView>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f4f6f8' },
  centerContent: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  header: { padding: 20, paddingTop: 10, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#eee', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 24, fontWeight: '800', color: '#1a1a1a' },
  subtitle: { fontSize: 14, color: '#888', marginBottom: 10, fontFamily: 'monospace' },
  input: { width: '100%', padding: 15, backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#ddd', marginBottom: 20, fontSize: 16 },
  button: { width: '100%', padding: 15, backgroundColor: '#1a1a1a', borderRadius: 10, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  badge: { alignSelf: 'center', marginVertical: 10, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  badgeNeutral: { backgroundColor: '#e2e8f0' },
  badgeSuccess: { backgroundColor: '#dcfce7' },
  badgeText: { fontWeight: '600', fontSize: 12 },
  sectionHeader: { marginLeft: 20, marginTop: 10, marginBottom: 10, fontWeight: '700', color: '#4a5568' },
  card: { margin: 20, marginTop: 0, padding: 20, backgroundColor: '#fff', borderRadius: 12, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 10 },
  cardTitle: { fontSize: 18, fontWeight: '600', marginBottom: 10 },
  logContainer: { flex: 1, paddingHorizontal: 20 },
  logRow: { flexDirection: 'row', marginBottom: 8 },
  logTime: { width: 60, fontSize: 12, color: '#a0aec0', fontFamily: 'monospace' },
  logText: { flex: 1, fontSize: 13, fontFamily: 'monospace' },
  log_info: { color: '#4a5568' },
  log_success: { color: '#059669', fontWeight: '600' },
  log_error: { color: '#e53e3e' },
  log_action: { color: '#3182ce', fontWeight: '600' },
  disconnectBtn: { padding: 8 },
  disconnectText: { color: 'red', fontWeight: '600' }
});

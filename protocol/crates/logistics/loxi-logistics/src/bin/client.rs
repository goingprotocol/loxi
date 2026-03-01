use futures_util::{SinkExt, StreamExt};
use loxi_architect_sdk::DataServer;
use loxi_core::{DomainAuthority, Message as LoxiMessage};
use loxi_logistics::architect::{LogisticsArchitect, LogisticsArchitectProvider};
use std::collections::HashMap;
use std::path::Path;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message as WsMessage};
use url::Url;

// --- CONFIGURATION DEFAULTS ---
// For Production Releases, change these to the official Loxi Network endpoints.
const DEFAULT_ORCHESTRATOR_URL: &str = "ws://127.0.0.1:3005"; // e.g., "wss://api.loxi.network"
const DEFAULT_PUBLIC_URL: &str = "ws://localhost:3006"; // e.g., "wss://logistics.going.com"
const DOMAIN_ID: &str = "logistics";

#[tokio::main]
async fn main() {
    dotenv::dotenv().ok();

    // 1. Configuration: Env Vars > Defaults
    let connect_addr = std::env::var("LOXI_ORCHESTRATOR_URL")
        .unwrap_or_else(|_| DEFAULT_ORCHESTRATOR_URL.to_string());
    let url = Url::parse(&connect_addr).expect("Bad URL");

    println!("👑 Starting Logistics (The Conductor)...");
    println!("🔌 Connecting to Orchestrator at {}...", connect_addr);

    let (ws_stream, _) = loop {
        match connect_async(&url).await {
            Ok(stream) => break stream,
            Err(e) => {
                println!("⚠️ Connection failed: {}. Retrying in 2s...", e);
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
        }
    };
    println!("✅ Connected to Generic Grid Orchestrator");

    let (mut write, mut read) = ws_stream.split();

    // 1. Initialize Internal Logistics Architect
    let shared_cache = std::sync::Arc::new(dashmap::DashMap::new());
    let manager = LogisticsArchitect::new(&connect_addr, DOMAIN_ID, shared_cache);
    let manager_arc = std::sync::Arc::new(std::sync::Mutex::new(manager));

    // 2. Register as Authority with our PUBLIC DATA ADDRESS (The Sala)
    // This allows workers to discover where to download/push logs.
    let auth = DomainAuthority {
        domain_id: DOMAIN_ID.to_string(),
        authority_address: std::env::var("LOXI_PUBLIC_URL")
            .unwrap_or_else(|_| DEFAULT_PUBLIC_URL.to_string()),
    };
    let reg_msg = LoxiMessage::RegisterAuthority(auth);
    write
        .send(WsMessage::Text(serde_json::to_string(&reg_msg).unwrap()))
        .await
        .expect("Failed to register");
    println!("📝 Registered Logistics Authority (Data Port: 3006)");

    // 3. Create channel for ALL outgoing Orchestrator communication
    let (outgoing_tx, mut outgoing_rx) = tokio::sync::mpsc::channel::<WsMessage>(2048);
    let (tx, mut rx) = tokio::sync::mpsc::channel::<LoxiMessage>(1024);

    // 4. Background WS Writer Task
    let _outgoing_tx_for_http = outgoing_tx.clone();
    tokio::spawn(async move {
        while let Some(msg) = outgoing_rx.recv().await {
            if let Err(e) = write.send(msg).await {
                println!("❌ WebSocket Writer Error: {}", e);
                break;
            }
        }
    });

    // 5. Start the Direct Data Server in the background
    let provider = std::sync::Arc::new(LogisticsArchitectProvider { manager: manager_arc.clone() });
    let data_server = DataServer::new(provider, DOMAIN_ID.to_string());
    let tx_for_server = tx.clone();

    tokio::spawn(async move {
        if let Err(e) = data_server.start(3006, tx_for_server).await {
            println!("❌ Data Server Error: {}", e);
        }
    });

    // 6. Start HTTP Server for Problem Submission (from Web UI)
    let manager_for_http = manager_arc.clone();
    let tx_clone = tx.clone();

    tokio::spawn(async move {
        use warp::Filter;

        // CORS configuration for local development
        let cors = warp::cors()
            .allow_any_origin()
            .allow_methods(vec!["GET", "POST", "OPTIONS"])
            .allow_headers(vec![
                "Content-Type",
                "Range",
                "User-Agent",
                "Accept",
                "Origin",
                "X-Requested-With",
            ])
            .expose_headers(vec![
                "Content-Length",
                "Content-Range",
                "Accept-Ranges",
                "Content-Type",
                "Cross-Origin-Opener-Policy",
                "Cross-Origin-Embedder-Policy",
                "Cross-Origin-Resource-Policy",
            ]);

        // Security Headers for SharedArrayBuffer (Valhalla/WASM requirement)
        let coop = warp::reply::with::header("Cross-Origin-Opener-Policy", "same-origin");
        let coep = warp::reply::with::header("Cross-Origin-Embedder-Policy", "require-corp");
        let corp = warp::reply::with::header("Cross-Origin-Resource-Policy", "cross-origin");

        let manager_for_submit = manager_for_http.clone();
        let tx_for_submit = tx_clone.clone();

        let submit_problem = warp::post()
            .and(warp::path("submit-problem"))
            .and(warp::body::json())
            .and_then(move |problem: loxi_logistics::types::Problem| {
                let manager = manager_for_submit.clone();
                let tx = tx_for_submit.clone();
                async move {
                    let mission_id = format!(
                        "mission_{}",
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap()
                            .as_secs()
                    );

                    let (messages, ids) = {
                        let mut mg = manager.lock().unwrap();
                        println!("📥 HTTP: Received problem with {} stops", problem.stops.len());

                        mg.distribute_tasks(mission_id.clone(), &problem)
                    }; // MutexGuard dropped here

                    // Send all initial tasks through the internal message handler
                    for msg in messages {
                        if let Err(e) = tx.send(msg).await {
                            println!("❌ Failed to queue task: {}", e);
                        }
                    }

                    Ok::<_, warp::Rejection>(warp::reply::json(&serde_json::json!({
                        "status": "accepted",
                        "mission_id": mission_id,
                        "stops": problem.stops.len(),
                        "auction_ids": ids
                    })))
                }
            });

        let get_solution = warp::get()
            .and(warp::path("get-solution"))
            .and(warp::query::<std::collections::HashMap<String, String>>())
            .and_then(move |params: std::collections::HashMap<String, String>| {
                let manager = manager_for_http.clone();
                async move {
                    let mg = manager.lock().unwrap();

                    if let Some(mission_id) = params.get("mission_id") {
                        let solutions: std::collections::HashMap<String, serde_json::Value> = mg
                            .pending_problems
                            .iter()
                            .filter(|r| r.value().mission_id.as_deref() == Some(mission_id))
                            .map(|r| {
                                let id = r.key().clone();
                                let p = r.value();
                                let mut sol_json = serde_json::Value::Null;
                                if let Some(sol) = &p.solution {
                                    // INJECT ID and MISSION_ID for the UI
                                    let mut val = serde_json::to_value(sol).unwrap();
                                    if let Some(obj) = val.as_object_mut() {
                                        obj.insert(
                                            "id".to_string(),
                                            serde_json::Value::String(id.clone()),
                                        );
                                        if let Some(m_id) = &p.mission_id {
                                            obj.insert(
                                                "mission_id".to_string(),
                                                serde_json::Value::String(m_id.clone()),
                                            );
                                        }
                                        // NEW: Inject STOPS so UI can draw the route
                                        if let Ok(stops_val) = serde_json::to_value(&p.stops) {
                                            obj.insert("stops".to_string(), stops_val);
                                        }
                                    }
                                    sol_json = val;
                                }
                                (id, sol_json)
                            })
                            .filter(|(_, val)| !val.is_null())
                            .collect();
                        return Ok::<_, warp::Rejection>(warp::reply::json(&solutions));
                    }

                    if let Some(id) = params.get("auction_id") {
                        if let Some(problem_ref) = mg.pending_problems.get(id) {
                            let problem = problem_ref.value();
                            if let Some(ref solution) = problem.solution {
                                let mut val = serde_json::to_value(solution).unwrap();
                                if let Some(obj) = val.as_object_mut() {
                                    obj.insert(
                                        "id".to_string(),
                                        serde_json::Value::String(id.clone()),
                                    );
                                }
                                return Ok::<_, warp::Rejection>(warp::reply::json(&val));
                            }
                        }
                    }

                    Ok::<_, warp::Rejection>(warp::reply::json(&serde_json::json!({
                        "status": "pending"
                    })))
                }
            });

        // Bundle endpoint: Serve all files for an artifact in one request
        let bundle = warp::path!("artifacts" / "bundle" / String).and(warp::get()).and_then(
            |artifact_name: String| async move {
                #[derive(serde::Serialize)]
                struct ArtifactBundle {
                    main_js: String,
                    main_wasm: Vec<u8>,
                    dependencies: HashMap<String, Vec<u8>>,
                }

                let artifacts_dir = Path::new("./artifacts");

                // Define dependencies for each artifact
                let deps = match artifact_name.as_str() {
                    "loxi_matrix" => vec![
                        "valhalla.json",
                        "valhalla_engine.js",
                        "valhalla_engine.wasm",
                        "ValhallaResourceArchitect.js",
                    ],
                    "loxi_vrp" => vec!["env.js"],
                    "loxi_partitioner" => vec!["env.js"],
                    _ => vec![],
                };

                // Read main files
                let main_js_path = artifacts_dir.join(format!("{}.js", artifact_name));
                let main_wasm_path = artifacts_dir.join(format!("{}_bg.wasm", artifact_name));

                let main_js = match tokio::fs::read_to_string(&main_js_path).await {
                    Ok(content) => content,
                    Err(_) => return Err(warp::reject::not_found()),
                };

                let main_wasm = match tokio::fs::read(&main_wasm_path).await {
                    Ok(content) => content,
                    Err(_) => return Err(warp::reject::not_found()),
                };

                // Read dependencies
                let mut dependencies = HashMap::new();
                for dep in deps {
                    let dep_path = artifacts_dir.join(dep);
                    if let Ok(content) = tokio::fs::read(&dep_path).await {
                        dependencies.insert(dep.to_string(), content);
                    }
                }

                let bundle = ArtifactBundle { main_js, main_wasm, dependencies };

                Ok::<_, warp::Rejection>(warp::reply::json(&bundle))
            },
        );

        // Artifacts route - explicit directory serving
        let artifacts = warp::path("artifacts").and(warp::fs::dir("./artifacts"));

        let routes = submit_problem
            .or(get_solution)
            .or(bundle)
            .or(artifacts)
            .with(cors)
            .with(coop)
            .with(coep)
            .with(corp);
        println!("🌐 HTTP Server listening on: http://0.0.0.0:3007");
        warp::serve(routes).run(([0, 0, 0, 0], 3007)).await;
    });

    println!("📡 Awaiting tasks from the grid...");

    // 7. Independent Reader Loop
    let reader_manager_arc = manager_arc.clone();
    let reader_outgoing_tx = outgoing_tx.clone();
    let mut reader_handle = tokio::spawn(async move {
        while let Some(msg) = read.next().await {
            match msg {
                Ok(WsMessage::Text(text)) => match serde_json::from_str::<LoxiMessage>(&text) {
                    Ok(loxi_msg) => {
                        let manager = reader_manager_arc.clone();
                        let tx = reader_outgoing_tx.clone();
                        tokio::spawn(async move {
                            let next_msgs = {
                                let mut mg = manager.lock().unwrap();
                                mg.handle_incoming_message(loxi_msg)
                            };
                            for next_msg in next_msgs {
                                let payload = serde_json::to_string(&next_msg).unwrap();
                                let _ = tx.send(WsMessage::Text(payload)).await;
                            }
                        });
                    }
                    Err(e) => {
                        if text.contains("PostTask") || text.contains("Submit") {
                            println!(
                                "⚠️ Protocol Mismatch: {}\nText Preview: {}",
                                e,
                                &text[..std::cmp::min(100, text.len())]
                            );
                        }
                    }
                },
                Ok(WsMessage::Ping(p)) => {
                    let _ = reader_outgoing_tx.send(WsMessage::Pong(p)).await;
                }
                Err(e) => {
                    println!("❌ WebSocket Read Error: {}", e);
                    break;
                }
                _ => {}
            }
        }
    });

    // 8. Independent Internal Message Loop (from HTTP/DataServer)
    let _internal_manager_arc = manager_arc.clone();
    let internal_outgoing_tx = outgoing_tx.clone();
    let mut internal_handle = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let payload = serde_json::to_string(&msg).unwrap();
            if let Err(e) = internal_outgoing_tx.send(WsMessage::Text(payload)).await {
                println!("❌ Failed to queue internal message: {}", e);
                break;
            }
        }
    });

    // 9. Wait for either to fail
    tokio::select! {
        _ = &mut reader_handle => println!("💀 Reader loop terminated."),
        _ = &mut internal_handle => println!("💀 Internal loop terminated."),
    }

    println!("🔌 Connection closed. Exiting Conductor.");
}

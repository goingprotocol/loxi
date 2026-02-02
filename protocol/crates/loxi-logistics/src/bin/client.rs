use futures_util::{SinkExt, StreamExt};
use loxi_architect_sdk::DataServer;
use loxi_core::{DomainAuthority, Message as LoxiMessage};
use loxi_logistics::manager::{LogisticsDataProvider, LogisticsManager};
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message as WsMessage};
use url::Url;

// --- CONFIGURATION DEFAULTS ---
// For Production Releases, change these to the official Loxi Network endpoints.
const DEFAULT_ORCHESTRATOR_URL: &str = "ws://localhost:3005"; // e.g., "wss://api.loxi.network"
const DEFAULT_PUBLIC_URL: &str = "ws://localhost:3006"; // e.g., "wss://logistics.going.com"

#[tokio::main]
async fn main() {
    dotenv::dotenv().ok();

    // 1. Configuration: Env Vars > Defaults
    let connect_addr = std::env::var("LOXI_ORCHESTRATOR_URL")
        .unwrap_or_else(|_| DEFAULT_ORCHESTRATOR_URL.to_string());
    let url = Url::parse(&connect_addr).expect("Bad URL");

    println!("👑 Starting Logistics (The Conductor)...");
    println!("🔌 Connecting to Orchestrator at {}...", connect_addr);

    let (ws_stream, _) = connect_async(url).await.expect("Failed to connect");
    println!("✅ Connected to Generic Grid Orchestrator");

    let (mut write, mut read) = ws_stream.split();

    // 1. Initialize Internal Logistics Manager
    let manager = LogisticsManager::new(&connect_addr);
    let manager_arc = std::sync::Arc::new(tokio::sync::Mutex::new(manager));

    // 2. Register as Authority with our PUBLIC DATA ADDRESS (The Sala)
    // This allows workers to discover where to download/push logs.
    let auth = DomainAuthority {
        domain_id: "logistics".to_string(),
        authority_address: std::env::var("LOXI_PUBLIC_URL")
            .unwrap_or_else(|_| DEFAULT_PUBLIC_URL.to_string()),
    };
    let reg_msg = LoxiMessage::RegisterAuthority(auth);
    write
        .send(WsMessage::Text(serde_json::to_string(&reg_msg).unwrap()))
        .await
        .expect("Failed to register");
    println!("📝 Registered Logistics Authority (Data Port: 3006)");

    // 3. Create channel for Orchestrator communication
    let (tx, mut rx) = tokio::sync::mpsc::channel::<LoxiMessage>(32);

    // 4. Start the Direct Data Server in the background
    let provider = std::sync::Arc::new(LogisticsDataProvider { manager: manager_arc.clone() });
    let data_server = DataServer::new(provider, "logistics".to_string());
    let tx_for_server = tx.clone();

    tokio::spawn(async move {
        if let Err(e) = data_server.start(3006, tx_for_server).await {
            println!("❌ Data Server Error: {}", e);
        }
    });

    // 5. Start HTTP Server for Problem Submission (from Web UI)
    let manager_for_http = manager_arc.clone();
    let tx_clone = tx.clone();

    tokio::spawn(async move {
        use warp::Filter;

        // CORS configuration for local development
        let cors = warp::cors()
            .allow_any_origin()
            .allow_methods(vec!["GET", "POST", "OPTIONS"])
            .allow_headers(vec!["Content-Type"]);

        let manager_for_submit = manager_for_http.clone();
        let tx_for_submit = tx_clone.clone();

        let submit_problem = warp::post()
            .and(warp::path("submit-problem"))
            .and(warp::body::json())
            .and_then(move |problem: loxi_logistics::manager::types::Problem| {
                let manager = manager_for_submit.clone();
                let tx = tx_for_submit.clone();
                async move {
                    let mut mg = manager.lock().await;
                    println!("📥 HTTP: Received problem with {} stops", problem.stops.len());

                    let mission_id = format!(
                        "mission_{}",
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap()
                            .as_secs()
                    );
                    let (messages, ids) = mg.distribute_tasks(mission_id.clone(), &problem);

                    // Send all initial tasks through the channel
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
                    let mg = manager.lock().await;

                    if let Some(mission_id) = params.get("mission_id") {
                        let solutions: std::collections::HashMap<String, serde_json::Value> = mg
                            .pending_problems
                            .iter()
                            .filter(|(_, p)| p.mission_id.as_deref() == Some(mission_id))
                            .filter_map(|(id, p)| {
                                p.solution.as_ref().map(|sol| {
                                    // INJECT ID and MISSION_ID for the UI
                                    let mut val = serde_json::to_value(sol).unwrap();
                                    if let Some(obj) = val.as_object_mut() {
                                        obj.insert(
                                            "id".to_string(),
                                            serde_json::Value::String(id.clone()),
                                        );
                                        if let Some(ref m_id) = p.mission_id {
                                            obj.insert(
                                                "mission_id".to_string(),
                                                serde_json::Value::String(m_id.clone()),
                                            );
                                        }
                                    }
                                    (id.clone(), val)
                                })
                            })
                            .collect();
                        return Ok::<_, warp::Rejection>(warp::reply::json(&solutions));
                    }

                    if let Some(id) = params.get("auction_id") {
                        if let Some(problem) = mg.pending_problems.get(id) {
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

        let routes = submit_problem.or(get_solution).with(cors);

        println!("🌐 HTTP Server listening on: http://0.0.0.0:3007");
        warp::serve(routes).run(([0, 0, 0, 0], 3007)).await;
    });

    println!("📡 Awaiting tasks from the grid...");

    // 6. Main Event Loop: Handle both WebSocket messages and HTTP-queued tasks
    loop {
        tokio::select! {
            // Handle messages from Orchestrator
            Some(msg) = read.next() => {
                match msg {
                    Ok(WsMessage::Text(text)) => {
                        match serde_json::from_str::<LoxiMessage>(&text) {
                            Ok(loxi_msg) => {
                                let next_msgs = {
                                    let mut mg = manager_arc.lock().await;

                                    // The Conductor handles:
                                    // - PostTask (Adopts problems from web/others)
                                    // - SubmitSolution (Triggers next stages: Matrix -> Solve)
                                    // - PostTask (Adopts problems from web/others)
                                    // - SubmitSolution (Triggers next stages: Matrix -> Solve)
                                    mg.handle_incoming_message(loxi_msg)
                                }; // LOCK RELEASED

                                for next_msg in next_msgs {
                                    let payload = serde_json::to_string(&next_msg).unwrap();
                                    if let Err(e) = write.send(WsMessage::Text(payload)).await {
                                        println!("❌ Failed to send: {}", e);
                                        break;
                                    }
                                }
                                // Yield to allow Data Server (Sala) to acquire lock
                                tokio::task::yield_now().await;
                            }
                            Err(e) => {
                                // DEBUG: If it's a PostTask or SubmitSolution that we care about, show why it failed.
                                if text.contains("PostTask") || text.contains("Submit") {
                                    println!("⚠️ Protocol Mismatch: {}\nText Preview: {}", e, &text[..std::cmp::min(100, text.len())]);
                                }
                            }
                        }
                    }
                    Err(e) => {
                        println!("Disconnected: {}", e);
                        break;
                    }
                    _ => {}
                }
            }

            // Handle tasks queued from HTTP server
            Some(msg) = rx.recv() => {
                println!("📤 Sending HTTP-queued task to Orchestrator...");
                let payload = serde_json::to_string(&msg).unwrap();
                if let Err(e) = write.send(WsMessage::Text(payload)).await {
                    println!("❌ Failed to send HTTP-queued task: {}", e);
                    break;
                } else {
                    println!("✅ Task sent to Orchestrator");
                }
            }
        }
    }
}

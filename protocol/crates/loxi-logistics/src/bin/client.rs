use futures_util::{SinkExt, StreamExt};
use loxi_core::{DomainAuthority, Message as LoxiMessage};
use loxi_logistics::manager::LogisticsManager;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message as WsMessage};
use url::Url;

#[tokio::main]
async fn main() {
    let connect_addr = "ws://localhost:3005";
    let url = Url::parse(&connect_addr).expect("Bad URL");

    println!("👑 Starting Logistics (The Conductor)...");
    println!("🔌 Connecting to Orchestrator at {}...", connect_addr);

    let (ws_stream, _) = connect_async(url).await.expect("Failed to connect");
    println!("✅ Connected to Generic Grid Orchestrator");

    let (mut write, mut read) = ws_stream.split();

    // 1. Initialize Internal Logistics Manager
    let manager = LogisticsManager::new(connect_addr);
    let manager_arc = std::sync::Arc::new(tokio::sync::Mutex::new(manager));

    // 2. Register as Authority with our PUBLIC DATA ADDRESS (The Sala)
    // This allows workers to discover where to download/push logs.
    let auth = DomainAuthority {
        domain_id: "logistics".to_string(),
        authority_address: "ws://localhost:3006".to_string(), // Use localhost for local dev
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
    let manager_for_server = manager_arc.clone();
    let tx_for_server = tx.clone();
    tokio::spawn(async move {
        if let Err(e) =
            LogisticsManager::start_data_server(manager_for_server, 3006, tx_for_server).await
        {
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

        let submit_problem = warp::post()
            .and(warp::path("submit-problem"))
            .and(warp::body::json())
            .and_then(move |problem: loxi_logistics::manager::types::Problem| {
                let manager = manager_for_http.clone();
                let tx = tx_clone.clone();
                async move {
                    let mut mg = manager.lock().await;
                    println!("📥 HTTP: Received problem with {} stops", problem.stops.len());

                    // Start the pipeline by distributing tasks
                    let messages = mg.distribute_tasks(&problem);

                    // Send all initial tasks through the channel
                    for msg in messages {
                        if let Err(e) = tx.send(msg).await {
                            println!("❌ Failed to queue task: {}", e);
                        }
                    }

                    Ok::<_, warp::Rejection>(warp::reply::json(&serde_json::json!({
                        "status": "accepted",
                        "stops": problem.stops.len()
                    })))
                }
            })
            .with(cors);

        println!("🌐 HTTP Server listening on: http://0.0.0.0:3007");
        warp::serve(submit_problem).run(([0, 0, 0, 0], 3007)).await;
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
                                    println!("⚠️ Protocol Mismatch: {}\nText: {}", e, text);
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

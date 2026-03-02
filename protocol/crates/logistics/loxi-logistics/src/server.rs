use std::path::PathBuf;
use std::sync::Arc;

#[cfg(not(target_arch = "wasm32"))]
use std::sync::atomic::{AtomicUsize, Ordering};

#[cfg(not(target_arch = "wasm32"))]
use warp::Filter;

#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug)]
struct TooManyRequests;

#[cfg(not(target_arch = "wasm32"))]
impl warp::reject::Reject for TooManyRequests {}

#[cfg(not(target_arch = "wasm32"))]
async fn handle_rejection(err: warp::Rejection) -> Result<impl warp::Reply, warp::Rejection> {
    if err.find::<TooManyRequests>().is_some() {
        Ok(warp::reply::with_status(
            warp::reply::json(&serde_json::json!({"error": "rate limit exceeded"})),
            warp::http::StatusCode::TOO_MANY_REQUESTS,
        ))
    } else {
        Err(err)
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub async fn start_artifact_server(
    port: u16,
    artifact_dir: PathBuf,
    job_tx: tokio::sync::mpsc::UnboundedSender<crate::architect::LogisticsJob>,
    protocol_tx: tokio::sync::mpsc::UnboundedSender<loxi_core::Message>,
    shared_cache: Arc<dashmap::DashMap<String, crate::types::Problem>>,
    verify_ticket: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    node_count: Arc<AtomicUsize>,
) {
    let cache_filter = warp::any().map(move || shared_cache.clone());

    // Rate limiter: 20 req/s sustained, burst of 5, keyed by remote IP.
    // Applied to write endpoints only (submit-problem).
    let rate_limiter: Arc<governor::DefaultKeyedRateLimiter<std::net::IpAddr>> =
        Arc::new(governor::RateLimiter::keyed(
            governor::Quota::per_second(std::num::NonZeroU32::new(20).unwrap())
                .allow_burst(std::num::NonZeroU32::new(5).unwrap()),
        ));
    let rl = rate_limiter.clone();
    let rate_limit = warp::addr::remote().and_then(move |addr: Option<std::net::SocketAddr>| {
        let rl = rl.clone();
        async move {
            let ip =
                addr.map(|a| a.ip()).unwrap_or(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST));
            rl.check_key(&ip).map_err(|_| warp::reject::custom(TooManyRequests))
        }
    });

    let cors = warp::cors()
        .allow_any_origin()
        .allow_methods(vec!["GET", "POST", "OPTIONS", "HEAD", "PUT", "DELETE"])
        .allow_headers(vec![
            "Content-Type",
            "Range",
            "Origin",
            "Accept",
            "X-Requested-With",
            "Authorization",
        ])
        .expose_headers(vec![
            "Content-Range",
            "Content-Length",
            "Accept-Ranges",
            "Access-Control-Allow-Origin",
            "ETag",
            "Last-Modified",
        ])
        .max_age(3600);

    // POST /logistics/submit-problem
    let log_submit = warp::path!("logistics" / "submit-problem")
        .and(warp::post())
        .and(rate_limit)
        .and(warp::body::json())
        .and(cache_filter.clone())
        .map(
            move |_: (),
                  problem: crate::types::Problem,
                  cache: Arc<dashmap::DashMap<String, crate::types::Problem>>| {
                println!("📥 API: Received Logistics Problem Submission");
                let mission_id = uuid::Uuid::new_v4().to_string();

                let job = crate::architect::LogisticsJob {
                    id: mission_id.clone(),
                    problem: problem.clone(),
                };

                if let Err(e) = job_tx.send(job) {
                    eprintln!("❌ API Error: Failed to forward job to architect: {}", e);
                    return warp::reply::json(&serde_json::json!({
                        "status": "error",
                        "reason": "Internal Architect Offline"
                    }));
                }

                cache.insert(mission_id.clone(), problem);

                warp::reply::json(&serde_json::json!({
                    "status": "accepted",
                    "mission_id": mission_id
                }))
            },
        );

    // GET /get-solution/{problem_id}
    let log_solution_by_id = warp::path!("get-solution" / String)
        .and(warp::get())
        .and(cache_filter.clone())
        .map(|problem_id: String, cache: Arc<dashmap::DashMap<String, crate::types::Problem>>| {
            if let Some(problem_ref) = cache.get(&problem_id) {
                let problem = problem_ref.value().clone();
                if let Some(ref solution) = problem.solution {
                    return warp::reply::json(&serde_json::json!({
                        "status": "completed",
                        "problem": problem,
                        "solution": solution,
                        "metadata": {
                            "operation": "routes",
                            "valhalla_type": "polylines"
                        }
                    }));
                } else {
                    return warp::reply::json(&serde_json::json!({
                        "status": "processing",
                        "problem_id": problem_id,
                        "message": "Solution not yet available"
                    }));
                }
            }
            warp::reply::json(&serde_json::json!({
                "status": "error",
                "reason": "Problem not found"
            }))
        });

    // GET /workers/count
    let nc = node_count.clone();
    let workers_count_route = warp::path!("workers" / "count").and(warp::get()).map(move || {
        warp::reply::json(&serde_json::json!({
            "count": nc.load(Ordering::Relaxed)
        }))
    });

    // WebSocket Data Plane: /logistics/data
    let protocol_tx_clone = protocol_tx.clone();
    let vt = verify_ticket.clone();
    let log_data = warp::path!("logistics" / "data").and(warp::ws()).and(cache_filter.clone()).map(
        move |ws: warp::ws::Ws, cache: Arc<dashmap::DashMap<String, crate::types::Problem>>| {
            let protocol_tx = protocol_tx_clone.clone();
            let verify_fn = vt.clone();
            ws.on_upgrade(move |mut websocket| {
                let cache = cache.clone();
                let protocol_tx = protocol_tx.clone();
                let verify_fn = verify_fn.clone();
                async move {
                    use futures_util::{SinkExt, StreamExt};
                    while let Some(result) = websocket.next().await {
                        if let Ok(msg) = result {
                            if let Ok(text) = msg.to_str() {
                                if let Ok(json) = serde_json::from_str::<serde_json::Value>(text) {
                                    if let Some(claim) = json.get("ClaimTask") {
                                        let ticket = claim["ticket"].as_str().unwrap_or_default();
                                        if !verify_fn(ticket) {
                                            let _ = websocket
                                                .send(warp::ws::Message::text(
                                                    r#"{"error":"invalid ticket"}"#,
                                                ))
                                                .await;
                                            return;
                                        }
                                        let auction_id =
                                            claim["auction_id"].as_str().unwrap_or_default();
                                        println!(
                                            "🔌 Data Plane: Worker connecting for {}",
                                            auction_id
                                        );

                                        let problem_opt =
                                            cache.get(auction_id).map(|r| r.value().clone());
                                        if let Some(problem) = problem_opt {
                                            let payload_str =
                                                serde_json::to_string(&problem).unwrap();

                                            let response = loxi_core::Message::PostTask {
                                                auction_id: auction_id.to_string(),
                                                requirement: loxi_core::TaskRequirement {
                                                    id: "ignored".to_string(),
                                                    affinities: vec![],
                                                    min_ram_mb: 0,
                                                    min_cpu_threads: 0,
                                                    use_gpu: false,
                                                    task_type: loxi_core::TaskType::Compute,
                                                    priority_for_owner: None,
                                                    metadata: vec![],
                                                },
                                                payload: Some(payload_str),
                                            };

                                            let resp_json =
                                                serde_json::to_string(&response).unwrap();
                                            let _ = websocket
                                                .send(warp::ws::Message::text(resp_json))
                                                .await;
                                        }
                                    } else if let Ok(push) =
                                        serde_json::from_str::<loxi_core::Message>(text)
                                    {
                                        if matches!(push, loxi_core::Message::PushSolution { .. }) {
                                            let _ = protocol_tx.send(push);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            })
        },
    );

    let api_routes = log_submit
        .or(log_solution_by_id)
        .or(log_data)
        .or(workers_count_route)
        .with(cors.clone())
        .recover(handle_rejection);

    let logistics_static = warp::path("logistics").and(warp::fs::dir(artifact_dir)).with(cors);

    let routes = api_routes.or(logistics_static);

    println!("🌍 Loxi Artifact & API Server listening on 0.0.0.0:{}", port);
    warp::serve(routes).run(([0, 0, 0, 0], port)).await;
}

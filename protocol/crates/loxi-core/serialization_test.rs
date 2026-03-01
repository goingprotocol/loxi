use loxi_core::{TaskType, TaskRequirement};
use serde_json;

fn main() {
    let req_compute = TaskType::Compute;
    let req_custom = TaskType::Custom("partitioner".to_string());

    println!("Compute: {}", serde_json::to_string(&req_compute).unwrap());
    println!("Custom: {}", serde_json::to_string(&req_custom).unwrap());
}

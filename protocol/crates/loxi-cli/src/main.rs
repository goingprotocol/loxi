use anyhow::{Context, Result};
use clap::Parser;
use loxi_types::Problem;
use std::fs;
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(name = "loxi")]
#[command(about = "Loxi Grid CLI - Agnostic Task Management", long_about = None)]
struct Args {
    #[arg(short, long)]
    problem: PathBuf,

    #[arg(short, long)]
    verbose: bool,
}

fn main() -> Result<()> {
    let args = Args::parse();

    if args.verbose {
        eprintln!("Reading agnostic problem from: {}", args.problem.display());
    }

    let problem_json = fs::read_to_string(&args.problem)
        .with_context(|| format!("Failed to read problem file: {}", args.problem.display()))?;

    let problem: Problem =
        serde_json::from_str(&problem_json).context("Failed to parse Grid Problem JSON")?;

    if args.verbose {
        eprintln!("Agnostic Problem loaded:");
        eprintln!("  Auction: {}", problem.auction_id);
        eprintln!("  Domain: {}", problem.domain_id);
        eprintln!("  Payload size: {} bytes", problem.payload.as_ref().map_or(0, |p| p.len()));
    }

    println!("{}", serde_json::to_string_pretty(&problem)?);

    Ok(())
}

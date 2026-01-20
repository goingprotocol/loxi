use anyhow::{Context, Result};
use clap::Parser;
use loxi_heuristics::{Solver, SolverConfig};
use loxi_types::Problem;
use std::fs;
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(name = "loxi")]
#[command(about = "Loxi - Browser-first routing and logistics optimization", long_about = None)]
struct Args {
    #[arg(short, long)]
    problem: PathBuf,

    #[arg(short, long)]
    output: Option<PathBuf>,

    #[arg(short, long)]
    seed: Option<u64>,

    #[arg(long, default_value = "1000")]
    max_iterations: u32,

    #[arg(long)]
    pretty: bool,

    #[arg(short, long)]
    verbose: bool,
}

fn main() -> Result<()> {
    let args = Args::parse();

    if args.verbose {
        eprintln!("Reading problem from: {}", args.problem.display());
    }

    let problem_json = fs::read_to_string(&args.problem)
        .with_context(|| format!("Failed to read problem file: {}", args.problem.display()))?;

    let problem: Problem =
        serde_json::from_str(&problem_json).context("Failed to parse problem JSON")?;

    if args.verbose {
        eprintln!("Problem loaded: {} stops", problem.num_stops());
    }

    let config =
        SolverConfig { seed: args.seed, max_iterations: args.max_iterations, ..Default::default() };

    let mut solver = Solver::new(config);

    if args.verbose {
        eprintln!("Solving...");
    }

    let solution =
        solver.solve(&problem).map_err(|e| anyhow::anyhow!("Failed to solve problem: {}", e))?;

    if args.verbose {
        eprintln!("Solution found in {}ms", solution.metadata.solve_time_ms);
        eprintln!("Route length: {} stops", solution.num_stops());
        eprintln!("Total cost: {:.2}", solution.cost);
        eprintln!("Feasible: {}", solution.is_feasible());
    }

    let solution_json = if args.pretty {
        serde_json::to_string_pretty(&solution)?
    } else {
        serde_json::to_string(&solution)?
    };

    if let Some(output_path) = args.output {
        fs::write(&output_path, solution_json)
            .with_context(|| format!("Failed to write solution to: {}", output_path.display()))?;

        if args.verbose {
            eprintln!("Solution written to: {}", output_path.display());
        }
    } else {
        println!("{}", solution_json);
    }

    Ok(())
}

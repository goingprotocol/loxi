use criterion::{black_box, criterion_group, criterion_main, Criterion};
use loxi_bench::{benchmark_sizes, generate_problem};
use loxi_heuristics::{Solver, SolverConfig};

fn benchmark_solve(c: &mut Criterion) {
    let mut group = c.benchmark_group("solve");

    for &size in &benchmark_sizes() {
        group.bench_function(format!("{}_stops", size), |b| {
            let problem = generate_problem(size, 42);

            b.iter(|| {
                let config = SolverConfig { seed: Some(42), ..Default::default() };
                let mut solver = Solver::new(config);
                let solution = solver.solve(black_box(&problem)).unwrap();
                black_box(solution);
            });
        });
    }

    group.finish();
}

criterion_group!(benches, benchmark_solve);
criterion_main!(benches);

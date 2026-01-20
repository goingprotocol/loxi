use criterion::{black_box, criterion_group, criterion_main, Criterion};
use loxi_heuristics::Solver;
use loxi_types::{Location, Problem, Stop, TimeWindow, Vehicle};

fn create_problem(n: usize) -> Problem {
    let stops: Vec<Stop> = (0..n)
        .map(|i| {
            Stop::new(
                format!("stop{}", i),
                Location::new(40.0 + i as f64 * 0.01, -74.0 + i as f64 * 0.01),
                TimeWindow::new(0, 86400),
                300,
                5.0,
                1,
            )
        })
        .collect();

    Problem::new(stops, Vehicle::default())
}

fn bench_solver(c: &mut Criterion) {
    c.benchmark_group("solver").bench_function("solve_10_stops", |b| {
        let problem = create_problem(10);
        b.iter(|| {
            let mut solver = Solver::default();
            black_box(solver.solve(&problem).unwrap())
        });
    });
}

criterion_group!(benches, bench_solver);
criterion_main!(benches);

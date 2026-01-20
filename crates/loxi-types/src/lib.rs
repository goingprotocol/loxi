mod problem;
mod solution;
mod types;

pub use problem::{Problem, Vehicle};
pub use solution::{CostBreakdown, Solution, SolutionMetadata, Violation};
pub use types::{Location, Stop, TimeWindow};

pub mod prelude {
    pub use crate::{CostBreakdown, Location, Problem, Solution, Stop, TimeWindow, Vehicle};
}

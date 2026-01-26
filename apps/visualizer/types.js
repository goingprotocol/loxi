// @ts-check

/**
 * @typedef {{lat: number, lon: number}} Location
 * @typedef {{start: number, end: number}} TimeWindow
 * @typedef {{id: string, location: Location, time_window?: TimeWindow, service_time?: number, demand?: number, priority?: number}} Stop
 * @typedef {{capacity?: number, start_location?: Location, end_location?: Location, shift_window?: TimeWindow, speed_mps?: number}} Vehicle
 * @typedef {{stops: Stop[], vehicle: Vehicle}} Problem
 *
 * @typedef {{violation_type?: string, stop_id?: string, magnitude?: number} | string} Violation
 * @typedef {{total_distance?: number, total_time?: number, time_window_penalty?: number, capacity_penalty?: number, priority_cost?: number, [k: string]: unknown}} CostBreakdown
 * @typedef {{solver_version?: string, solve_time_ms?: number, seed?: unknown}} SolutionMetadata
 * @typedef {{route?: string[], cost?: number, cost_breakdown?: CostBreakdown, violations?: Violation[], metadata?: SolutionMetadata}} Solution
 */

export {};



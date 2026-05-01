from __future__ import annotations

from typing import Literal

from .schemas import OptimizedTripStop, OptimizeTripRequest, OptimizeTripResponse


def optimize_trip(req: OptimizeTripRequest) -> OptimizeTripResponse:
    if req.start_stop_id not in {stop.id for stop in req.stops}:
        return _optimize_trip_fallback(req, status="infeasible", reason="Start stop is missing.")
    if req.end_stop_id and req.end_stop_id not in {stop.id for stop in req.stops}:
        return _optimize_trip_fallback(req, status="infeasible", reason="End stop is missing.")

    ortools_response = _optimize_trip_with_ortools(req)
    if ortools_response:
        return ortools_response
    return _optimize_trip_fallback(req, status="fallback", reason="OR-Tools solver unavailable.")


def _optimize_trip_with_ortools(req: OptimizeTripRequest) -> OptimizeTripResponse | None:
    try:
        from ortools.constraint_solver import pywrapcp, routing_enums_pb2
    except Exception:
        return None

    stops = req.stops
    index_by_id = {stop.id: i for i, stop in enumerate(stops)}
    start = index_by_id[req.start_stop_id]
    end = index_by_id[req.end_stop_id] if req.end_stop_id else start
    duration = _duration_matrix(req)
    # OR-Tools >= 9.15: the 4-arg overload of RoutingIndexManager takes
    # vector<NodeIndex> for starts/ends, not bare ints. Wrap in single-
    # element lists to keep the per-vehicle start/end semantics.
    manager = pywrapcp.RoutingIndexManager(len(stops), 1, [start], [end])
    routing = pywrapcp.RoutingModel(manager)

    def cost_callback(from_index: int, to_index: int) -> int:
        from_node = manager.IndexToNode(from_index)
        to_node = manager.IndexToNode(to_index)
        return _weighted_leg_cost(req, stops[from_node], duration[from_node][to_node])

    cost_index = routing.RegisterTransitCallback(cost_callback)
    routing.SetArcCostEvaluatorOfAllVehicles(cost_index)

    def time_callback(from_index: int, to_index: int) -> int:
        from_node = manager.IndexToNode(from_index)
        to_node = manager.IndexToNode(to_index)
        return duration[from_node][to_node] + stops[from_node].duration_minutes

    time_index = routing.RegisterTransitCallback(time_callback)
    routing.AddDimension(time_index, 10080, 10080, True, "Time")
    time_dimension = routing.GetDimensionOrDie("Time")
    for node, stop in enumerate(stops):
        index = manager.NodeToIndex(node)
        if index < 0:
            continue
        time_dimension.CumulVar(index).SetRange(
            stop.earliest_start_minute,
            max(stop.earliest_start_minute, stop.latest_end_minute),
        )

    search = pywrapcp.DefaultRoutingSearchParameters()
    search.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    search.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    search.time_limit.seconds = req.max_solver_seconds
    solution = routing.SolveWithParameters(search)
    if solution is None:
        return None

    route = []
    node_order = []
    index = routing.Start(0)
    sequence = 0
    while not routing.IsEnd(index):
        node = manager.IndexToNode(index)
        node_order.append(node)
        stop = stops[node]
        arrival = int(solution.Min(time_dimension.CumulVar(index)))
        departure = min(10080, arrival + stop.duration_minutes)
        route.append(
            OptimizedTripStop(
                id=stop.id,
                label=stop.label,
                category=stop.category,
                sequence=sequence,
                arrival_minute=arrival,
                departure_minute=departure,
                wait_minutes=0,
            )
        )
        sequence += 1
        index = solution.Value(routing.NextVar(index))
    end_node = manager.IndexToNode(index)
    if not node_order or node_order[-1] != end_node:
        stop = stops[end_node]
        arrival = int(solution.Min(time_dimension.CumulVar(index)))
        node_order.append(end_node)
        route.append(
            OptimizedTripStop(
                id=stop.id,
                label=stop.label,
                category=stop.category,
                sequence=sequence,
                arrival_minute=arrival,
                departure_minute=arrival + stop.duration_minutes,
                wait_minutes=0,
            )
        )

    totals = _route_totals(req, node_order)
    return OptimizeTripResponse(
        status="ok",
        objective=req.objective,
        route=route,
        dropped_stop_ids=[],
        total_duration_minutes=totals["duration"],
        total_cost_usd=round(totals["cost"], 2),
        total_distance_km=round(totals["distance"], 1),
        solver="ortools-routing",
        _lumo_summary=f"Optimized {len(route)} trip stop{'s' if len(route) != 1 else ''}.",
    )


def _optimize_trip_fallback(
    req: OptimizeTripRequest,
    status: Literal["fallback", "infeasible"] = "fallback",
    reason: str = "Deterministic nearest-neighbor optimizer used.",
) -> OptimizeTripResponse:
    stops = req.stops
    start = next((i for i, stop in enumerate(stops) if stop.id == req.start_stop_id), 0)
    end = next((i for i, stop in enumerate(stops) if stop.id == req.end_stop_id), None)
    duration = _duration_matrix(req)
    remaining = set(range(len(stops)))
    remaining.discard(start)
    if end is not None:
        remaining.discard(end)
    order = [start]
    current = start
    while remaining:
        next_node = min(remaining, key=lambda node: duration[current][node])
        order.append(next_node)
        remaining.remove(next_node)
        current = next_node
    if end is not None and end != start:
        order.append(end)

    route = []
    minute = 0
    prev = None
    for sequence, node in enumerate(order):
        stop = stops[node]
        if prev is not None:
            minute += duration[prev][node]
        wait = max(0, stop.earliest_start_minute - minute)
        minute += wait
        arrival = minute
        departure = min(10080, arrival + stop.duration_minutes)
        route.append(
            OptimizedTripStop(
                id=stop.id,
                label=stop.label,
                category=stop.category,
                sequence=sequence,
                arrival_minute=arrival,
                departure_minute=departure,
                wait_minutes=wait,
            )
        )
        minute = departure
        prev = node

    totals = _route_totals(req, order)
    return OptimizeTripResponse(
        status=status,
        objective=req.objective,
        route=route,
        dropped_stop_ids=[],
        total_duration_minutes=totals["duration"],
        total_cost_usd=round(totals["cost"], 2),
        total_distance_km=round(totals["distance"], 1),
        solver="nearest-neighbor-fallback",
        _lumo_summary=reason,
    )


def _duration_matrix(req: OptimizeTripRequest) -> list[list[int]]:
    stops = req.stops
    n = len(stops)
    matrix = [
        [0 if i == j else _default_duration(stops[i].category, stops[j].category) for j in range(n)]
        for i in range(n)
    ]
    index_by_id = {stop.id: i for i, stop in enumerate(stops)}
    for leg in req.legs:
        from_idx = index_by_id.get(leg.from_id)
        to_idx = index_by_id.get(leg.to_id)
        if from_idx is None or to_idx is None:
            continue
        matrix[from_idx][to_idx] = max(0, leg.duration_minutes)
    return matrix


def _weighted_leg_cost(req: OptimizeTripRequest, from_stop, duration_minutes: int) -> int:
    service = from_stop.duration_minutes
    if req.objective == "fastest":
        return duration_minutes + service
    if req.objective == "comfort":
        priority_bonus = max(0, 10 - from_stop.priority) * 2
        return duration_minutes + service + priority_bonus
    if req.objective == "cheapest":
        return max(1, round((duration_minutes + service) * 0.8))
    return duration_minutes + service + max(0, 5 - from_stop.priority)


def _route_totals(req: OptimizeTripRequest, order: list[int]) -> dict[str, float]:
    stops = req.stops
    leg_by_pair = {(leg.from_id, leg.to_id): leg for leg in req.legs}
    duration_matrix = _duration_matrix(req)
    duration = sum(stops[node].duration_minutes for node in order)
    cost = 0.0
    distance = 0.0
    for a, b in zip(order, order[1:]):
        duration += duration_matrix[a][b]
        leg = leg_by_pair.get((stops[a].id, stops[b].id))
        if leg:
            cost += leg.cost_usd
            distance += leg.distance_km
        else:
            distance += max(1, duration_matrix[a][b] * 0.6)
            cost += max(0, duration_matrix[a][b] * 0.7)
    return {"duration": int(round(duration)), "cost": cost, "distance": distance}


def _default_duration(from_category: str, to_category: str) -> int:
    if from_category == to_category:
        return 15
    pair = {from_category, to_category}
    if "flight" in pair:
        return 90
    if "hotel" in pair:
        return 35
    if "charging" in pair:
        return 45
    if pair & {"food", "restaurant"}:
        return 25
    return 30

package dev.larattalabs.architect.api;

/**
 * (6c P0) A plan check's caps (docs/CONTRACT.md "Phase 6c slice P0" §7): A* expansions over every routed edge, routed legs, cells
 * evaluated, wall time and heap. Each at most its default; 0 (or anything over the default) means the default. Running out leaves
 * the parts without an answer {@code incomplete} and the check {@link PlanCheck.Overall#INCOMPLETE}, with no artifact. Count caps
 * are deterministic; a check that hit {@code maxMs} or {@code maxHeapMb} is never cached. Since 1.23.0.
 */
public record PlanBudget(int maxNodes, int maxEdges, long maxCells, int maxMs, int maxHeapMb) {
	public static final int MAX_NODES = 2_000_000;
	public static final int MAX_EDGES = 128;
	public static final long MAX_CELLS = 20_000_000L;
	public static final int MAX_MS = 120_000;
	public static final int MAX_HEAP_MB = 2048;

	/** The defaults. */
	public static PlanBudget defaults() {
		return new PlanBudget(0, 0, 0, 0, 0);
	}

	/** Each cap resolved: the request's when it is over 0 and under the default, else the default. */
	public PlanBudget resolved() {
		return new PlanBudget(maxNodes > 0 && maxNodes < MAX_NODES ? maxNodes : MAX_NODES, maxEdges > 0 && maxEdges < MAX_EDGES ? maxEdges : MAX_EDGES,
			maxCells > 0 && maxCells < MAX_CELLS ? maxCells : MAX_CELLS, maxMs > 0 && maxMs < MAX_MS ? maxMs : MAX_MS,
			maxHeapMb > 0 && maxHeapMb < MAX_HEAP_MB ? maxHeapMb : MAX_HEAP_MB);
	}
}

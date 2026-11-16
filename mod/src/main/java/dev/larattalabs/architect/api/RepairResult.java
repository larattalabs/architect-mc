package dev.larattalabs.architect.api;

import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * (DR) What {@link Sites#repair} did ({@code applied}) or would do (a dry run): cells written, ledger credits booked (item id -> count),
 * targets reopened, cells left (foreign, players' blocks), the durable repair record ({@code architect-repairs/<planId>.json}, null in a
 * dry run). A refusal has {@code applied} false, its {@code refused} reason and a message; nothing was written. Since NEXT.
 */
public record RepairResult(String planId, boolean applied, int written, Map<String, Integer> credited, List<String> reopened, int left,
	@Nullable String recordPath, @Nullable Reason refused, String message, List<String> sites) {
	public RepairResult {
		credited = Map.copyOf(credited);
		reopened = List.copyOf(reopened);
		sites = List.copyOf(sites);
	}
}

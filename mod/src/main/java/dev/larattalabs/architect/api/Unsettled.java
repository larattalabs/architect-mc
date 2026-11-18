package dev.larattalabs.architect.api;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import org.jspecify.annotations.Nullable;

/**
 * (8c, since NEXT; feature {@code "flowingWater"}) A plan check's {@code UNSETTLED} refusal of a part, read from its answer
 * ({@link PlanCheck#parts}): the part's flowing water would not settle within a cost limit (docs/CONTRACT.md "Phase 8c" §2.5, §2.6;
 * Steward's S-8c-2). The answer is deterministic: asking the same part again answers the same, so a caller never retries it on its own.
 * <ul>
 * <li>{@code say}: the player's line ("The river was too long to settle here; a shorter one fits", or "...; it waits").</li>
 * <li>{@code cap}: which limit was hit, an open enum: {@code rounds}, {@code cells} (4,096 per body), {@code chunks} (64 per body),
 * {@code regionCells} (32,768), {@code regionBodies} (8); {@code limit} its value (-1 unknown).</li>
 * <li>{@code regionWide}: a region's limit, which spans parts (repairing this part alone does not fix it).</li>
 * <li>{@code wouldFit}: the answer's fits (a shorter river, one more source reach), each a {@code {part, fragment, why, cells}}; empty
 * when the kit found none.</li>
 * </ul>
 */
public record Unsettled(String part, @Nullable String body, String say, String cap, long limit, boolean regionWide, int cells, int rounds,
	List<JsonObject> wouldFit) {
	/** The reason code. */
	public static final String CODE = "UNSETTLED";

	public Unsettled {
		wouldFit = wouldFit == null ? List.of() : List.copyOf(wouldFit);
		say = say == null ? "" : say;
		cap = cap == null ? "rounds" : cap;
	}

	/** The UNSETTLED reason of a part answer ({@code {part, class, reasons, wouldFit}}), if it has one. */
	public static Optional<Unsettled> of(JsonObject answer) {
		if (answer == null || !(answer.get("reasons") instanceof com.google.gson.JsonArray rs)) {
			return Optional.empty();
		}
		for (JsonElement e : rs) {
			if (!(e instanceof JsonObject r) || !CODE.equals(str(r, "code"))) {
				continue;
			}
			JsonObject ev = r.get("evidence") instanceof JsonObject o ? o : new JsonObject();
			List<JsonObject> fits = new ArrayList<>();
			if (answer.get("wouldFit") instanceof com.google.gson.JsonArray wf) {
				for (JsonElement w : wf) {
					if (w instanceof JsonObject wo) {
						fits.add(wo.deepCopy());
					}
				}
			}
			String part = str(answer, "part");
			return Optional.of(new Unsettled(part == null ? "" : part, str(ev, "body"), str(r, "say"), str(ev, "cap"), num(ev, "limit", -1),
				ev.get("regionWide") instanceof JsonElement rw && rw.isJsonPrimitive() && rw.getAsBoolean(), (int) num(ev, "cells", 0), (int) num(ev, "rounds", 0), fits));
		}
		return Optional.empty();
	}

	private static @Nullable String str(JsonObject o, String k) {
		return o.get(k) instanceof JsonElement e && e.isJsonPrimitive() ? e.getAsString() : null;
	}

	private static long num(JsonObject o, String k, long d) {
		return o.get(k) instanceof JsonElement e && e.isJsonPrimitive() && e.getAsJsonPrimitive().isNumber() ? e.getAsLong() : d;
	}
}

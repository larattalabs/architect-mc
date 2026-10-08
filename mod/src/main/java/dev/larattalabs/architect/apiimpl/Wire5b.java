package dev.larattalabs.architect.apiimpl;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.Cost;
import dev.larattalabs.architect.api.Critique;
import dev.larattalabs.architect.api.Estimate;
import dev.larattalabs.architect.api.Polish;
import dev.larattalabs.architect.api.PolishRequest;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import org.jspecify.annotations.Nullable;

/**
 * The phase 5b wire (docs/CONTRACT.md phase 5b "Sidecar protocol (2, additive)"): {@code design.polish}'s spec, a polish
 * design's {@code polish} record, the polish estimate. Pure: tested without a game.
 */
public final class Wire5b {
	private Wire5b() {
	}

	/** {@code design.polish {entryId, spec, owner?, ext?}}. Throws for an invalid request. */
	public static JsonObject polishMessage(PolishRequest r) {
		if (r.entryId() == null || r.entryId().isBlank()) {
			throw new IllegalArgumentException("a polish needs an entry");
		}
		if (r.notes() != null && r.notes().length() > 500) {
			throw new IllegalArgumentException("polish notes are at most 500 characters");
		}
		JsonObject m = new JsonObject();
		m.addProperty("type", "design.polish");
		m.addProperty("entryId", r.entryId());
		m.add("spec", spec(r));
		if (r.owner() != null) {
			m.addProperty("owner", r.owner());
		}
		if (r.ext().size() > 0) {
			m.add("ext", r.ext());
		}
		return m;
	}

	/** The request's {@code PolishSpec}. */
	public static JsonObject spec(PolishRequest r) {
		JsonObject s = new JsonObject();
		if (r.fromVersion() != null) {
			s.addProperty("fromVersion", r.fromVersion());
		}
		JsonObject t = new JsonObject();
		if (r.issues() != null) {
			JsonArray a = new JsonArray();
			r.issues().forEach(a::add);
			t.add("issues", a);
		}
		if (r.parts() != null) {
			JsonArray a = new JsonArray();
			r.parts().forEach(a::add);
			t.add("parts", a);
		}
		if (r.notes() != null && !r.notes().isBlank()) {
			t.addProperty("notes", r.notes());
		}
		if (t.size() > 0) {
			s.add("target", t);
		}
		s.addProperty("maxSteps", r.maxSteps());
		if (r.model() != null) {
			s.addProperty("model", r.model());
		}
		if (r.budgetUsd() != null) {
			s.addProperty("budgetUsd", r.budgetUsd());
		}
		if (r.apply() != null) {
			JsonObject a = new JsonObject();
			if (r.apply().siteIds().isEmpty()) {
				a.addProperty("sites", "all");
			} else {
				JsonArray ids = new JsonArray();
				r.apply().siteIds().forEach(ids::add);
				a.add("sites", ids);
			}
			a.addProperty("preview", r.apply().preview());
			s.add("apply", a);
		}
		return s;
	}

	/** A design record's {@code polish} (a polish design), or empty. */
	public static Optional<Polish> polish(@Nullable JsonElement e) {
		if (e == null || !e.isJsonObject()) {
			return Optional.empty();
		}
		JsonObject p = e.getAsJsonObject();
		List<Polish.Step> steps = new ArrayList<>();
		if (p.get("steps") instanceof JsonArray a) {
			for (JsonElement x : a) {
				if (!x.isJsonObject()) {
					continue;
				}
				JsonObject s = x.getAsJsonObject();
				Critique.Issue target = null;
				if (s.get("target") instanceof JsonObject t) {
					target = new Critique.Issue(Critique.Priority.of(Wire4b.str(t, "priority")), Wire4b.str(t, "part"), Wire4b.str(t, "view", ""), Wire4b.str(t,
						"what", ""), Wire4b.str(t, "fix", ""));
				}
				List<String> allowed = new ArrayList<>();
				if (s.get("allowedParts") instanceof JsonArray ap) {
					ap.forEach(v -> allowed.add(v.getAsString()));
				}
				Double overall = s.has("overall") && !s.get("overall").isJsonNull() ? s.get("overall").getAsDouble() : null;
				steps.add(new Polish.Step(s.has("n") ? s.get("n").getAsInt() : steps.size() + 1, target, allowed, s.has("accepted") && s.get("accepted")
					.getAsBoolean(), overall, s.has("changedCells") ? s.get("changedCells").getAsInt() : 0, s.get("cost") instanceof JsonObject c ? Cost
						.fromJson(c) : Cost.NONE, s.has("ms") ? s.get("ms").getAsLong() : 0L, s.has("failure") && !s.get("failure").isJsonNull() ? s.get(
							"failure").getAsString() : null));
			}
		}
		Integer installed = p.has("installedVersion") && !p.get("installedVersion").isJsonNull() ? p.get("installedVersion").getAsInt() : null;
		Cost total = p.get("cost") instanceof JsonObject c ? Cost.fromJson(c) : sum(steps);
		return Optional.of(new Polish(p.has("fromVersion") ? p.get("fromVersion").getAsInt() : 1, installed, steps, end(Wire4b.str(p, "end")), total));
	}

	static Cost sum(List<Polish.Step> steps) {
		double usd = 0;
		long in = 0;
		long out = 0;
		long cr = 0;
		long cw = 0;
		int turns = 0;
		for (Polish.Step s : steps) {
			usd += s.cost().usd();
			in += s.cost().inputTokens();
			out += s.cost().outputTokens();
			cr += s.cost().cacheReadTokens();
			cw += s.cost().cacheWriteTokens();
			turns += s.cost().turns();
		}
		return new Cost(usd, in, out, cr, cw, turns);
	}

	/** {@code polished | no_target | ...} -> the end; a polish still running reports POLISHED until its end is known. */
	public static Polish.End end(@Nullable String s) {
		if (s == null) {
			return Polish.End.POLISHED;
		}
		try {
			return Polish.End.valueOf(s.toUpperCase(Locale.ROOT));
		} catch (IllegalArgumentException e) {
			return Polish.End.CRITIC_FAILED;
		}
	}

	/** A polish estimate ({@code polishUsdLow..}) as an {@link Estimate} with its polish fields. */
	public static Estimate estimate(JsonObject r) {
		Estimate base = Wire5a.estimate(r);
		return new Estimate(base.usdLow(), base.usdHigh(), base.minutesLow(), base.minutesHigh(), base.basis(), base.critique(), base.critiqueUsdLow(), base
			.critiqueUsdHigh(), base.critiqueMinutesLow(), base.critiqueMinutesHigh(), base.items(), true, d(r, "polishUsdLow"), d(r, "polishUsdHigh"), d(r,
				"polishMinutesLow"), d(r, "polishMinutesHigh"));
	}

	private static double d(JsonObject o, String k) {
		Double v = Wire4b.dbl(o, k);
		return v == null ? 0 : v;
	}
}

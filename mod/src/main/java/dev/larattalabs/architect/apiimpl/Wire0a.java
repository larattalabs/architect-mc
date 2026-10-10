package dev.larattalabs.architect.apiimpl;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.ArchitectRefused;
import dev.larattalabs.architect.api.Estimate;
import dev.larattalabs.architect.api.EstimateRequest;
import dev.larattalabs.architect.api.Group;
import dev.larattalabs.architect.api.Reason;
import java.util.EnumMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/**
 * The phase 6c slice 0a wire (docs/CONTRACT.md "Phase 6c slice 0a"): operation keys, the group breakdown, estimates by kind.
 * Pure. Internal.
 */
public final class Wire0a {
	private Wire0a() {
	}

	/** A caller's operation key. */
	public static final Pattern OP_KEY = Pattern.compile("[A-Za-z0-9_.:-]{1,128}");
	/** The helper's ack error prefix for a re-used key with another body. */
	public static final String OP_KEY_CONFLICT = "op_key_conflict";

	/** Checks an opKey (null is fine); throws IllegalArgumentException when it does not match {@link #OP_KEY}. */
	public static @Nullable String opKey(@Nullable String k) {
		if (k != null && !OP_KEY.matcher(k).matches()) {
			throw new IllegalArgumentException("an opKey is [A-Za-z0-9_.:-]{1,128} (got \"" + (k.length() > 40 ? k.substring(0, 40) + "..." : k) + "\")");
		}
		return k;
	}

	/** The typed refusal for a helper ack error, or null when it is not one. */
	public static @Nullable ArchitectRefused refusal(@Nullable String ackError) {
		if (ackError != null && ackError.startsWith(OP_KEY_CONFLICT + ":")) {
			return new ArchitectRefused(Reason.OP_KEY_CONFLICT, ackError.substring(OP_KEY_CONFLICT.length() + 1).strip());
		}
		return null;
	}

	/** A group's breakdown ({@link Group.Breakdown#EMPTY} when absent). */
	public static Group.Breakdown breakdown(@Nullable JsonElement e) {
		if (e == null || !e.isJsonObject()) {
			return Group.Breakdown.EMPTY;
		}
		JsonObject o = e.getAsJsonObject();
		Map<Group.Breakdown.Stage, Group.Breakdown.Line> stages = new EnumMap<>(Group.Breakdown.Stage.class);
		Wire4b.obj(o, "stages").entrySet().forEach(en -> {
			if (!en.getValue().isJsonObject()) {
				return;
			}
			Group.Breakdown.Stage s;
			try {
				s = Group.Breakdown.Stage.valueOf(en.getKey().toUpperCase(Locale.ROOT));
			} catch (IllegalArgumentException x) {
				return; // a stage a newer helper added
			}
			JsonObject l = en.getValue().getAsJsonObject();
			stages.put(s, new Group.Breakdown.Line(d(l, "usd"), Wire4b.num(l, "ms"), (int) Wire4b.num(l, "count")));
		});
		return new Group.Breakdown(stages, d(o, "totalUsd"), Wire4b.num(o, "wallMs"), Wire4b.num(o, "firstDetailedMs"), Wire4b.strings(o, "bibleJobIds"));
	}

	/** An estimate's lines per kind (empty when absent). */
	public static Map<Estimate.Kind, Estimate.Item> byKind(JsonObject r) {
		Map<Estimate.Kind, Estimate.Item> out = new EnumMap<>(Estimate.Kind.class);
		Wire4b.obj(r, "byKind").entrySet().forEach(en -> {
			if (!en.getValue().isJsonObject()) {
				return;
			}
			Estimate.Kind k;
			try {
				k = Estimate.Kind.valueOf(en.getKey().toUpperCase(Locale.ROOT));
			} catch (IllegalArgumentException x) {
				return;
			}
			JsonObject l = en.getValue().getAsJsonObject();
			out.put(k, new Estimate.Item(en.getKey(), d(l, "usdLow"), d(l, "usdHigh"), d(l, "minutesLow"), d(l, "minutesHigh"), false, 0, 0, 0, 0));
		});
		return out;
	}

	/** {@code design.estimate {mix}}. */
	public static JsonObject mix(EstimateRequest r) {
		if (r.originals() < 0 || r.adapted() < 0 || r.copies() < 0) {
			throw new IllegalArgumentException("an estimate's counts are 0 or more");
		}
		JsonObject m = new JsonObject();
		if (r.group() != null) {
			m.add("group", Wire4b.group(r.group()));
		}
		m.addProperty("originals", r.originals());
		m.addProperty("adapted", r.adapted());
		m.addProperty("copies", r.copies());
		m.addProperty("newBible", r.newBible());
		m.addProperty("massingFirst", r.massingFirst());
		m.addProperty("reportCritique", r.reportCritique());
		if (r.model() != null) {
			m.addProperty("model", r.model());
		}
		return m;
	}

	/** The same estimate with its lines per kind. */
	public static Estimate withByKind(Estimate e, Map<Estimate.Kind, Estimate.Item> byKind) {
		return new Estimate(e.usdLow(), e.usdHigh(), e.minutesLow(), e.minutesHigh(), e.basis(), e.critique(), e.critiqueUsdLow(), e.critiqueUsdHigh(),
			e.critiqueMinutesLow(), e.critiqueMinutesHigh(), e.items(), e.polish(), e.polishUsdLow(), e.polishUsdHigh(), e.polishMinutesLow(),
			e.polishMinutesHigh(), byKind);
	}

	static List<String> none() {
		return List.of();
	}

	private static double d(JsonObject o, String k) {
		Double v = Wire4b.dbl(o, k);
		return v == null ? 0 : v;
	}
}

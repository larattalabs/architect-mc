package dev.larattalabs.architect.api;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.List;
import java.util.Objects;

/**
 * A pattern (docs/CONTRACT.md 6c slice MP §3): a per-cell material, wherever a single one is accepted (an op's material, a
 * material rule's clause, a bible role through the bible's {@code patterns}).
 * <pre>
 * {mix: [{w: 6, mat: "stone"}, {w: 3, mat: "andesite"}, {w: 1, mat: "cobblestone"}], seedLabel: "wall"}
 * {gradient: {by: "y" | "depth" | {field: "wet"}, stops: [{at: 60, mat: "sand"}, {at: 64, mat: "grass_block"}]}, dither: "ordered4"}
 * </pre>
 * A mix picks per cell by an integer hash of (the plan's seed, the label, x, y, z) over the weights; a gradient blends across
 * each stop interval with the ordered 4x4 Bayer dither. A {@code mat} is a role name or a block state (null: air). The spec is
 * checked by the kit's own schema ({@code kit/schemas/pattern.json}, bundled) plus its rule (stops strictly increasing), the same
 * check the kit runs. A bad spec throws {@link ArchitectRefused} ({@link Reason#FIELD_LIMIT}) with the path. Since 1.16.0.
 *
 * @param spec the pattern (copied; never changed)
 */
public record Pattern(JsonObject spec) {
	/** Checks the spec (the schema and the rule); throws {@link ArchitectRefused} ({@link Reason#FIELD_LIMIT}) on a bad one. */
	public Pattern {
		Objects.requireNonNull(spec, "spec");
		String why = error(spec);
		if (why != null) {
			throw new ArchitectRefused(Reason.FIELD_LIMIT, why);
		}
		spec = spec.deepCopy();
	}

	/** The spec as JSON text, or refused ({@link Reason#FIELD_LIMIT}) with the path. */
	public static Pattern parse(String text) {
		return new Pattern(SpecSchema.parseObject(text, "pattern"));
	}

	/** The spec as compact JSON text. */
	public String toText() {
		return spec.toString();
	}

	@Override
	public JsonObject spec() {
		return spec.deepCopy();
	}

	/** Why {@code spec} is not a pattern (the first error, "pattern...: message"), or null. */
	public static String error(JsonElement spec) {
		List<String> errs = SpecSchema.validate(SpecSchema.schema("pattern"), spec, "pattern", SpecSchema.schema("pattern"));
		if (!errs.isEmpty()) {
			return errs.get(0);
		}
		JsonObject o = spec.getAsJsonObject();
		if (o.has("gradient")) {
			var stops = o.getAsJsonObject("gradient").getAsJsonArray("stops");
			for (int i = 1; i < stops.size(); i++) {
				if (stops.get(i).getAsJsonObject().get("at").getAsBigDecimal().compareTo(stops.get(i - 1).getAsJsonObject().get("at").getAsBigDecimal()) <= 0) {
					return "pattern.gradient.stops[" + i + "].at must be over the stop before it";
				}
			}
		}
		return null;
	}
}

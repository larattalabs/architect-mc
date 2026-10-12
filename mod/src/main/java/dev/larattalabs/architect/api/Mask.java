package dev.larattalabs.architect.api;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.math.BigDecimal;
import java.util.List;
import java.util.Objects;

/**
 * A mask (docs/CONTRACT.md 6c slice MP §2): a pointwise cell selector the kit evaluates on an op, a scatter or a brush. A cell
 * the mask rejects is skipped. One term or a combinator:
 * <pre>
 * {block: ["#minecraft:dirt", "minecraft:grass_block"]}   the cell's frozen block (needs a frozen block volume)
 * {height: [60, 90]}     absolute y            {slope: [0, 2]}    the frozen ground's slope
 * {depth: [0, 3]}        cells below the frozen ground (0 = the ground cell)
 * {field: "wet", gte: 170}   a plan field      {noise: {kind, dims, scale, octaves, seed}, gte: 0.6}   seeded noise
 * {class: ["ROCK", "SOIL"]}  the cell's voxel class in the plan's frozen volumes
 * {all: [...]}  {any: [...]}  {not: m}
 * </pre>
 * The spec is checked by the kit's own schema ({@code kit/schemas/mask.json}, bundled) plus its rules (ranges ordered, gte under
 * lt, at most 8 deep and 64 nodes), the same check the kit runs (a test holds them equal). A bad spec throws
 * {@link ArchitectRefused} ({@link Reason#FIELD_LIMIT}) with the path ({@code mask.all[1].slope: [a, b] needs a <= b}).
 * Masks reach a plan through a program's params ({@code RegionPlanRequest.params}, as JSON) and brushes. Since 1.17.0.
 *
 * @param spec the mask (copied; never changed)
 */
public record Mask(JsonObject spec) {
	/** Combinators nest at most this deep. */
	public static final int MAX_DEPTH = 8;
	/** At most this many nodes (terms and combinators). */
	public static final int MAX_NODES = 64;
	private static final List<String> COMBINATORS = List.of("all", "any", "not");

	/** Checks the spec (the schema and the rules); throws {@link ArchitectRefused} ({@link Reason#FIELD_LIMIT}) on a bad one. */
	public Mask {
		Objects.requireNonNull(spec, "spec");
		String why = error(spec);
		if (why != null) {
			throw new ArchitectRefused(Reason.FIELD_LIMIT, why);
		}
		spec = spec.deepCopy();
	}

	/** The spec as JSON text, or refused ({@link Reason#FIELD_LIMIT}) with the path. */
	public static Mask parse(String text) {
		return new Mask(SpecSchema.parseObject(text, "mask"));
	}

	/** The spec as compact JSON text. */
	public String toText() {
		return spec.toString();
	}

	@Override
	public JsonObject spec() {
		return spec.deepCopy();
	}

	/** Why {@code spec} is not a mask (the first error, "mask...: message"), or null. */
	public static String error(JsonElement spec) {
		List<String> errs = SpecSchema.validate(SpecSchema.schema("mask"), spec, "mask", SpecSchema.schema("mask"));
		if (!errs.isEmpty()) {
			return errs.get(0);
		}
		int[] nodes = {0};
		return rules(spec.getAsJsonObject(), "mask", 1, nodes);
	}

	private static String rules(JsonObject m, String w, int depth, int[] nodes) {
		nodes[0]++;
		if (nodes[0] > MAX_NODES) {
			return "mask: more than " + MAX_NODES + " nodes";
		}
		if (depth > MAX_DEPTH) {
			return w + ": nested more than " + MAX_DEPTH + " deep";
		}
		String k = m.keySet().stream().filter(x -> COMBINATORS.contains(x) || List.of("block", "height", "slope", "depth", "field", "noise", "class").contains(
			x)).findFirst().orElse("");
		if (k.equals("all") || k.equals("any")) {
			var list = m.getAsJsonArray(k);
			for (int i = 0; i < list.size(); i++) {
				String e = rules(list.get(i).getAsJsonObject(), w + "." + k + "[" + i + "]", depth + 1, nodes);
				if (e != null) {
					return e;
				}
			}
			return null;
		}
		if (k.equals("not")) {
			return rules(m.getAsJsonObject("not"), w + ".not", depth + 1, nodes);
		}
		if (k.equals("height") || k.equals("slope") || k.equals("depth")) {
			var r = m.getAsJsonArray(k);
			if (r.get(0).getAsBigDecimal().compareTo(r.get(1).getAsBigDecimal()) > 0) {
				return w + "." + k + ": [a, b] needs a <= b";
			}
		}
		if ((k.equals("field") || k.equals("noise")) && m.has("gte") && m.has("lt")) {
			BigDecimal gte = m.get("gte").getAsBigDecimal();
			if (gte.compareTo(m.get("lt").getAsBigDecimal()) >= 0) {
				return w + ": gte must be under lt";
			}
		}
		return null;
	}
}

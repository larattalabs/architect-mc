package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.Locale;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import org.jspecify.annotations.Nullable;

/**
 * (7b) A port a site-bound design must meet: where the settlement graph (or the player) arrives (docs/CONTRACT.md "Phase 7b" §2,
 * SETTLEMENTS §7.5 {@code PortReq}). Since NEXT.
 *
 * @param name the port's name (unique in a {@link SiteSpec}), as the design's {@code bp.port(name, ...)}
 * @param kind {@link #WALK} ({@code architect:walk}, a walkable opening: a deck edge, a stair head, a hatch) or {@link #DOOR}
 * @param atDesign the port's cell in the design's own coordinates ({@link SiteFrame})
 * @param facing the way out of the design; {@link Direction#UP} and {@link Direction#DOWN} for a vertical walk port (a hatch, a
 *               ladder's head)
 * @param width the opening's width in cells (at least 1)
 * @param height the opening's clear height in cells (at least 1)
 * @param edge the settlement graph edge expected to arrive here (its id, as the link pass names it); null = any
 */
public record SitePort(String name, String kind, BlockPos atDesign, Direction facing, int width, int height, @Nullable String edge) {
	/** The standard walk port kind (new in 7b). */
	public static final String WALK = "architect:walk";
	/** A door port (the kit's existing kind). */
	public static final String DOOR = "door";

	public SitePort {
		java.util.Objects.requireNonNull(name, "name");
		java.util.Objects.requireNonNull(kind, "kind");
		java.util.Objects.requireNonNull(atDesign, "atDesign");
		java.util.Objects.requireNonNull(facing, "facing");
		width = Math.max(1, width);
		height = Math.max(1, height);
	}

	/** The wire form: {@code {name, kind, at: [x, y, z], facing, width, height, edge?}} ({@code facing} lowercase, e.g. {@code up}). */
	public JsonObject wire() {
		JsonObject o = new JsonObject();
		o.addProperty("name", name);
		o.addProperty("kind", kind);
		o.add("at", SiteSpec.pos(atDesign));
		o.addProperty("facing", facing.getSerializedName());
		o.addProperty("width", width);
		o.addProperty("height", height);
		if (edge != null) {
			o.addProperty("edge", edge);
		}
		return o;
	}

	/** The port of its wire form; {@link IllegalArgumentException} on a malformed one. */
	public static SitePort fromWire(JsonObject o) {
		String name = SiteSpec.str(o, "name", true);
		String kind = SiteSpec.str(o, "kind", true);
		if (!kind.equals(WALK) && !kind.equals(DOOR)) {
			throw new IllegalArgumentException("port " + name + ": kind must be " + WALK + " or " + DOOR);
		}
		if (!o.has("at") || !o.get("at").isJsonArray()) {
			throw new IllegalArgumentException("port " + name + ": at [x, y, z] is required");
		}
		Direction f = Direction.byName(SiteSpec.str(o, "facing", true).toLowerCase(Locale.ROOT));
		if (f == null) {
			throw new IllegalArgumentException("port " + name + ": unknown facing " + o.get("facing"));
		}
		int w = o.has("width") ? o.get("width").getAsInt() : 1;
		int h = o.has("height") ? o.get("height").getAsInt() : 2;
		if (w < 1 || h < 1) {
			throw new IllegalArgumentException("port " + name + ": width and height are at least 1");
		}
		return new SitePort(name, kind, SiteSpec.pos(o.getAsJsonArray("at"), "port " + name + ".at"), f, w, h, SiteSpec.str(o, "edge", false));
	}
}

package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.Locale;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Rotation;

/**
 * (7b) The frame of a site-bound design: how its own coordinates (the kit's: +x east, +y up, +z south, front south, the template's
 * minimum corner at 0,0,0) map to the world. Exactly the {@code (origin, rotation)} a {@link PlaceRequest} of that template takes:
 * {@code origin} is the rotated template box's minimum corner, {@code rotation} the vanilla template rotation. Not called
 * {@code Frame}: {@link Reason#FRAME_CHANGED} is a different thing. Since 1.53.0.
 *
 * @param origin the rotated template box's minimum corner in the world (as {@link PlaceRequest#origin()})
 * @param rotation the template's rotation (as {@link PlaceRequest#rotation()}); null reads as {@link Rotation#NONE}
 */
public record SiteFrame(BlockPos origin, Rotation rotation) {
	public SiteFrame {
		java.util.Objects.requireNonNull(origin, "origin");
		rotation = rotation == null ? Rotation.NONE : rotation;
	}

	/** The wire form: {@code {origin: [x, y, z], rotation: "none" | "clockwise_90" | "clockwise_180" | "counterclockwise_90"}}. */
	public JsonObject wire() {
		JsonObject o = new JsonObject();
		o.add("origin", SiteSpec.pos(origin));
		o.addProperty("rotation", rotationWire(rotation));
		return o;
	}

	/** The frame of its wire form; {@link IllegalArgumentException} on a malformed one. */
	public static SiteFrame fromWire(JsonObject o) {
		if (o == null || !o.has("origin") || !o.get("origin").isJsonArray()) {
			throw new IllegalArgumentException("frame: origin [x, y, z] is required");
		}
		return new SiteFrame(SiteSpec.pos(o.getAsJsonArray("origin"), "frame.origin"), rotationOf(o.has("rotation") ? o.get("rotation").getAsString() : "none"));
	}

	/** The wire name of a rotation: the lowercase Minecraft name ({@code none}, {@code clockwise_90}, {@code clockwise_180},
	 * {@code counterclockwise_90}), as a site's own record writes it. */
	public static String rotationWire(Rotation r) {
		return (r == null ? Rotation.NONE : r).name().toLowerCase(Locale.ROOT);
	}

	/** The rotation of a wire name (any case); {@link IllegalArgumentException} on an unknown one. */
	public static Rotation rotationOf(String w) {
		for (Rotation r : Rotation.values()) {
			if (r.name().equalsIgnoreCase(w == null ? "none" : w)) {
				return r;
			}
		}
		throw new IllegalArgumentException("frame: unknown rotation " + w);
	}
}

package dev.larattalabs.architect.site;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.placement.Anchors;
import org.jspecify.annotations.Nullable;

/**
 * A road or a cell site (docs/CONTRACT.md phase 4e "Roads as sites", "Cell sites"): the user-facing handle of a {@code road}
 * or {@code cells} journal entry. Persisted in the sites file's own {@code infra} array (0.7.0 never sees it; its saves drop
 * the array and 0.8.0 rebuilds the records from the entries' {@code meta}). Ids use their own prefixes ({@code r<n>},
 * {@code c<n>}) with counters in the journal index, so 0.7.0 can't reuse one. Pure data.
 *
 * @param kind {@code road} or {@code cells:<namespaced kind>}
 * @param box the box of every cell it changes
 * @param spec what made it (a road's points, width, surface...; a cell site's kind, policy and cell count)
 * @param construction (6c 0c, C16) a survival construction road's queue and crate ({@link RoadBuilder}); null for an instant one.
 *                     An older Architect ignores the field and reads the road as a finished instant one
 */
public record Infra(String id, String kind, @Nullable String owner, JsonObject ext, String dimension, Anchors.Bounds box, long placedAt,
	Site.@Nullable Member member, boolean placing, JsonObject spec, @Nullable Construction construction) {
	/** Without a construction (an instant road or a cell site). */
	public Infra(String id, String kind, @Nullable String owner, JsonObject ext, String dimension, Anchors.Bounds box, long placedAt,
		Site.@Nullable Member member, boolean placing, JsonObject spec) {
		this(id, kind, owner, ext, dimension, box, placedAt, member, placing, spec, null);
	}

	public static final String ROAD = "road";
	public static final String CELLS = "cells:";

	public Infra {
		ext = ext == null ? new JsonObject() : ext.deepCopy();
		spec = spec == null ? new JsonObject() : spec.deepCopy();
		owner = owner == null || owner.isBlank() ? null : owner;
	}

	public boolean road() {
		return ROAD.equals(kind);
	}

	public @Nullable String group() {
		return member == null ? null : member.group();
	}

	public Infra withPlacing(boolean p) {
		return new Infra(id, kind, owner, ext, dimension, box, placedAt, member, p, spec, construction);
	}

	public Infra withBox(Anchors.Bounds b) {
		return new Infra(id, kind, owner, ext, dimension, b, placedAt, member, placing, spec, construction);
	}

	public Infra withMember(Site.@Nullable Member m) {
		return new Infra(id, kind, owner, ext, dimension, box, placedAt, m, placing, spec, construction);
	}

	public Infra withConstruction(@Nullable Construction c) {
		return new Infra(id, kind, owner, ext, dimension, box, placedAt, member, placing, spec, c);
	}

	/** A construction road still building. */
	public boolean building() {
		return construction != null && construction.building();
	}

	@Override
	public JsonObject ext() {
		return ext.deepCopy();
	}

	/** "road r2", "cell site c1 (steward_mc:terrain)". */
	public String describe() {
		return road() ? "road " + id : "cell site " + id + " (" + kind.substring(CELLS.length()) + ")";
	}

	public JsonObject toJson() {
		JsonObject o = new JsonObject();
		o.addProperty("id", id);
		o.addProperty("kind", kind);
		if (owner != null) {
			o.addProperty("owner", owner);
		}
		if (ext.size() > 0) {
			o.add("ext", ext.deepCopy());
		}
		o.addProperty("dimension", dimension);
		o.add("box", Anchors.boundsJson(box));
		o.addProperty("placedAt", placedAt);
		if (member != null) {
			o.add("member", member.toJson());
		}
		if (placing) {
			o.addProperty("placing", true);
		}
		o.add("spec", spec.deepCopy());
		if (construction != null) {
			o.add("construction", construction.toJson());
		}
		return o;
	}

	public static Infra fromJson(JsonObject o) {
		return new Infra(o.get("id").getAsString(), o.get("kind").getAsString(), o.has("owner") ? o.get("owner").getAsString() : null,
			o.has("ext") && o.get("ext").isJsonObject() ? o.getAsJsonObject("ext") : new JsonObject(),
			o.has("dimension") ? o.get("dimension").getAsString() : Site.OVERWORLD, Anchors.boundsFromJson(o.getAsJsonObject("box")),
			o.has("placedAt") ? o.get("placedAt").getAsLong() : 0L,
			o.has("member") && o.get("member").isJsonObject() ? Site.Member.fromJson(o.getAsJsonObject("member")) : null,
			o.has("placing") && o.get("placing").getAsBoolean(), o.has("spec") && o.get("spec").isJsonObject() ? o.getAsJsonObject("spec") : new JsonObject(),
			o.has("construction") && o.get("construction").isJsonObject() ? Construction.fromJson(o.getAsJsonObject("construction")) : null);
	}
}

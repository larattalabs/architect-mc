package dev.larattalabs.architect.library;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.placement.Blueprint;
import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * What the Library tab shows for one entry: the design's sidecar ({@link Blueprint} plus the phase 2 keys read from its
 * raw JSON) with the user metadata applied. Pure.
 *
 * @param name what the card shows: {@code displayName}, else the design's {@code name}
 * @param baseName the design's own {@code name}
 * @param variantOf the library id this entry was made from (a variant or a remix), or null
 * @param imported made from an imported {@code .nbt} (no source, so no variants)
 * @param bundled shipped in the jar (read-only: metadata goes to the overlay, it cannot be deleted)
 * @param hasSource it has a parametric source ({@code source} names a file and it is not imported)
 * @param params the declared parameters ({@code params}), or null
 * @param values the parameter values the build used, or null
 * @param palette the palette inputs it was built with ({@code palette}), or null
 * @param request the DesignRequest it was made from, or null
 * @param bible the style bible it was designed or re-skinned with (phase 4b), or null; {@code bibleVersion} its version (0 when none)
 * @param group the design group it was made in (phase 4b), or null; {@code groupItem} its item key there
 */
public record LibraryCard(String id, String name, String baseName, String type, String description, List<String> tags, List<String> userTags,
	boolean favorite, int sizeX, int sizeY, int sizeZ, long createdAt, List<String> materials, @Nullable String variantOf, boolean imported,
	boolean bundled, boolean hasSource, @Nullable JsonObject params, @Nullable JsonObject values, @Nullable JsonObject palette,
	@Nullable JsonObject request, @Nullable String bible, int bibleVersion, @Nullable String group, @Nullable String groupItem) {

	public LibraryCard {
		tags = List.copyOf(tags);
		userTags = List.copyOf(userTags);
		materials = List.copyOf(materials);
	}

	/** Builds a card from a loaded sidecar, its raw JSON (for the phase 2 keys) and the user metadata in force. */
	public static LibraryCard of(Blueprint b, @Nullable JsonObject raw, LibraryMeta meta, boolean bundled) {
		JsonObject j = raw == null ? new JsonObject() : raw;
		boolean imported = j.has("imported") && j.get("imported").isJsonPrimitive() && j.get("imported").getAsBoolean();
		String variantOf = str(j.get("variantOf"));
		String name = meta.displayName() != null ? meta.displayName() : b.name();
		return new LibraryCard(b.id(), name, b.name(), b.type(), b.description(), b.tags(), meta.userTags(), meta.favorite(), b.sizeX(), b.sizeY(),
			b.sizeZ(), b.createdAt(), b.materials(), variantOf, imported, bundled, !imported && !b.source().isBlank(), obj(j.get("params")),
			obj(j.get("values")), obj(j.get("palette")), b.request(), bibleId(j), bibleVersion(j), str(j.get("group")), str(j.get("groupItem")));
	}

	private static @Nullable String bibleId(JsonObject j) {
		JsonObject b = obj(j.get("bible"));
		return b == null ? null : str(b.get("id"));
	}

	private static int bibleVersion(JsonObject j) {
		JsonObject b = obj(j.get("bible"));
		return b != null && b.has("version") && b.get("version").isJsonPrimitive() ? b.get("version").getAsInt() : 0;
	}

	/** The collections it belongs to ({@link LibraryQuery#collection}): {@code bible:<id>} and {@code group:<id>}. */
	public java.util.List<String> collections() {
		java.util.List<String> out = new java.util.ArrayList<>();
		if (bible != null) {
			out.add(LibraryQuery.BIBLE_PREFIX + bible);
		}
		if (group != null) {
			out.add(LibraryQuery.GROUP_PREFIX + group);
		}
		return out;
	}

	private static @Nullable String str(@Nullable JsonElement e) {
		return e != null && e.isJsonPrimitive() && !e.getAsString().isBlank() ? e.getAsString() : null;
	}

	private static @Nullable JsonObject obj(@Nullable JsonElement e) {
		return e != null && e.isJsonObject() ? e.getAsJsonObject() : null;
	}

	/** The volume, for the size sort. */
	public long volume() {
		return (long) sizeX * sizeY * sizeZ;
	}

	public String sizeText() {
		return sizeX + "×" + sizeY + "×" + sizeZ;
	}

	/** Variants need a source to re-run; imported entries and entries without one have none. */
	public boolean canVariant() {
		return hasSource && !imported;
	}

	/** Where it came from, one line: imported, a variant of X, generated (with the request's style), or bundled. */
	public String provenance(java.util.function.Function<String, String> nameOf) {
		if (imported) {
			return "imported from a structure file";
		}
		if (variantOf != null) {
			return (request != null && request.has("remix") ? "remix of " : "variant of ") + nameOf.apply(variantOf);
		}
		if (request != null) {
			String style = request.has("style") && request.get("style").isJsonPrimitive() ? request.get("style").getAsString() : "";
			return "generated with Claude" + (style.isBlank() ? "" : " (" + style + ")");
		}
		return bundled ? "bundled with Architect" : "in your library";
	}

	/** A short badge for the card, or null: VARIANT, IMPORTED. */
	public @Nullable String badge() {
		return imported ? "IMPORTED" : variantOf != null ? "VARIANT" : null;
	}
}

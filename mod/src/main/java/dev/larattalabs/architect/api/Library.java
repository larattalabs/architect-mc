package dev.larattalabs.architect.api;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.OptionalInt;
import java.util.concurrent.CompletableFuture;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/** The design library: bundled designs (in the jar) and the user's ({@code <gameDir>/architect/library/}). */
public interface Library {
	/** Every entry, sorted by id. Any thread. */
	List<Entry> list();

	Optional<Entry> get(String id);

	/** Reloads the library from disk (server thread; a no-op without a running server). */
	void reload();

	/**
	 * Makes a variant without Claude (the Library's Variants dialog): {@code variant.request} over the mod's sidecar link.
	 * Completes on the server thread with the new entry once it is installed and loaded; fails when the helper is not
	 * running, the source has no parametric source, or the build fails. {@code palette}: a preset name or
	 * {@code {wood?, stone?, roof?, accent?}}. Thread-safe.
	 */
	CompletableFuture<Entry> makeVariant(String entryId, @Nullable JsonElement palette, @Nullable JsonObject values, @Nullable String name);

	/**
	 * A variant built with a style bible's roles (a re-skin: free, no Claude; the design keeps its own components, which read
	 * the roles). {@code bible} excludes {@code palette} (both set: the future fails); null bible = {@link #makeVariant(String,
	 * JsonElement, JsonObject, String)}. The bible's latest version. Since 1.2.0.
	 */
	CompletableFuture<Entry> makeVariant(String entryId, @Nullable JsonElement palette, @Nullable JsonObject values, @Nullable String name,
		@Nullable String bible);

	/** As above, at a bible version (null = its latest). Since 1.2.0. */
	CompletableFuture<Entry> makeVariant(String entryId, @Nullable JsonElement palette, @Nullable JsonObject values, @Nullable String name,
		@Nullable String bible, @Nullable Integer bibleVersion);

	/**
	 * Re-skins a collection (docs/CONTRACT.md "Collections (R10)"): one variant per entry of {@code from} with the bible
	 * {@code bibleId} (at {@code version}, null = its latest). Only user entries with a parametric source are re-skinned
	 * (bundled and imported ones have none in the library folder). Completes on the server thread once every variant
	 * finished, with the new entries loaded; {@link SiteEvents#RESKIN_DONE} fires then too. Fails when the helper is not
	 * running or the collection has no entry with a source. Since 1.2.0.
	 */
	CompletableFuture<Reskin> reskinCollection(String bibleId, @Nullable Integer version, CollectionRef from);

	/** Moves a user entry to {@code architect/library-trash/} (as the UI does) and reloads. Bundled entries refuse (false). Thread-safe. */
	CompletableFuture<Boolean> delete(String entryId);

	/**
	 * Sets (or with null removes) one namespaced key ({@code "<modid>:<key>"}) of the entry's {@code ext}, in its blueprint JSON.
	 * Throws {@link IllegalArgumentException} for a bundled entry (read-only, in the jar), an unknown entry or a key without
	 * a namespace. Server thread.
	 */
	void setExt(String entryId, String key, @Nullable JsonElement value);

	/** Replaces the entry's user tags (normalised as the UI does: lower case, at most 12). Thread-safe. */
	void setTags(String entryId, List<String> userTags);

	// ------------------------------------------------------------------ phase 5b: versions (API 1.7.0)

	/**
	 * An entry's versions, oldest first ({@code pinned}: a standing site stands at it, or since 1.10.0 a caller pins it,
	 * {@link #pinVersion}). Empty for an unknown entry. Since 1.7.0.
	 */
	default List<EntryVersion> versions(String entryId) {
		throw new UnsupportedOperationException("Library.versions needs Architect API 1.7.0");
	}

	/** Version {@code version} of an entry as an {@link Entry} (its own files), or empty when it is gone. Since 1.7.0. */
	default Optional<Entry> entry(String entryId, int version) {
		throw new UnsupportedOperationException("Library.entry(id, version) needs Architect API 1.7.0");
	}

	/**
	 * The blueprint delta of two versions of an entry (computed by the mod, off the server thread; the part summary, no cell
	 * lists). Fails for an unknown entry or version. Since 1.7.0.
	 */
	default CompletableFuture<BlueprintDelta> delta(String entryId, int from, int to) {
		throw new UnsupportedOperationException("Library.delta needs Architect API 1.7.0");
	}

	/**
	 * Installs a new head version that is a byte copy of version {@code toVersion} ({@code by: "revert"}); placed sites are
	 * untouched (they show "update available"). Through the helper: fails when it is not running. Since 1.7.0.
	 */
	default CompletableFuture<Entry> revertEntry(String entryId, int toVersion) {
		throw new UnsupportedOperationException("Library.revertEntry needs Architect API 1.7.0");
	}

	// ------------------------------------------------------------------ phase 6c slice 0a: caller pins (API 1.10.0)

	/**
	 * Pins a version for a caller ({@code owner}, e.g. a settlement): the version is kept (not garbage-collected) while any
	 * caller pin or a standing site holds it, and {@link EntryVersion#pinned} is true. Pins are game-wide, like the library,
	 * and persist ({@code <gameDir>/architect/caller-pins.json}). Pinning a collected or unknown version fails
	 * {@link ArchitectRefused} {@link Reason#VERSION_GONE}. Pinning twice is fine. Since 1.10.0.
	 */
	default CompletableFuture<Void> pinVersion(String entryId, int version, String owner) {
		throw new UnsupportedOperationException("Library.pinVersion needs Architect API 1.10.0");
	}

	/** Removes a caller's pin (idempotent: an absent pin is fine). Since 1.10.0. */
	default CompletableFuture<Void> unpinVersion(String entryId, int version, String owner) {
		throw new UnsupportedOperationException("Library.unpinVersion needs Architect API 1.10.0");
	}

	/** The callers that pin a version, sorted. Since 1.10.0. */
	default List<String> pinOwners(String entryId, int version) {
		throw new UnsupportedOperationException("Library.pinOwners needs Architect API 1.10.0");
	}

	// ------------------------------------------------------------------ 6c slice SCH: Sponge schematics (API 1.18.0)

	/**
	 * Imports a Sponge Schematic (version 2 or 3, gzipped NBT; docs/CONTRACT.md "Phase 6c slice SCH") as a new library entry,
	 * like a {@code .nbt} import: a plain structure entry (no source, no variants), tagged {@code imported} and {@code schem},
	 * {@code ext["architect_mc:schem"]} holding the file's {@code Metadata} {@code Name} and {@code Author} (when present), its
	 * {@code Version} and {@code DataVersion}. The mod reads and validates the file and upgrades its block states and block-entity
	 * data to this game's version with vanilla's data fixers, then the helper checks, renders and installs it: fails when the
	 * helper is not running. Entities are skipped (counted in {@code ext["architect_mc:schem"].entitiesSkipped}); biomes are
	 * ignored. {@code groundY} is
	 * {@code -Offset.y} when that is a row of the schematic above its bottom row, else 1 (as a {@code .nbt} import).
	 *
	 * <p>Refusals ({@link ArchitectRefused}, nothing installed): {@link Reason#FORMAT} for a file that is not a Sponge
	 * schematic, an unknown {@code Version}, a {@code DataVersion} newer than the game's, corrupt data, or blocks this game does
	 * not know (listed; see {@link #importSchematic(Path, String, JsonObject)}); {@link Reason#TOO_LARGE} past the template
	 * cap (96 x 64 x 96). {@code name}: the entry's name (else the file's {@code Metadata.Name}, else its file name). Completes on
	 * the server thread with the installed entry. Since 1.18.0.
	 */
	default CompletableFuture<Entry> importSchematic(Path file, @Nullable String name) {
		throw new UnsupportedOperationException("Library.importSchematic needs Architect API 1.18.0");
	}

	/**
	 * {@link #importSchematic(Path, String)} with the request's {@code ext} (namespaced keys). {@code ext["architect_mc:unknownAs"]}
	 * (a block id, e.g. {@code "minecraft:stone"}) replaces every block this game does not know (another mod's) instead of
	 * refusing the file; the replaced ids are listed in {@code ext["architect_mc:schem"].replaced}. Default: none (refused).
	 * Since 1.18.0.
	 */
	default CompletableFuture<Entry> importSchematic(Path file, @Nullable String name, @Nullable JsonObject ext) {
		throw new UnsupportedOperationException("Library.importSchematic(ext) needs Architect API 1.18.0");
	}

	/**
	 * Exports an entry (at {@code version}, null = its head) as a Sponge Schematic version 3 file, {@code <dir>/<id>.schem}
	 * (or {@code <id>-v<version>.schem} when a version is given). Cells the template does not write are
	 * {@code minecraft:structure_void}, which an import maps back to "not written"; {@code Offset} puts the entry's
	 * {@code groundY} row at y 0; {@code Metadata} is {@code {Name, Author: "Architect", Date}} with the date the entry (version)
	 * was installed, so two exports of one entry are byte-identical. Fails {@link ArchitectRefused}
	 * {@link Reason#UNKNOWN_BLUEPRINT} for an unknown entry and {@link Reason#VERSION_GONE} for an unknown version. Runs on the
	 * server thread (no helper needed). Since 1.18.0.
	 */
	default CompletableFuture<Path> exportSchematic(String entryId, @Nullable Integer version, Path dir) {
		throw new UnsupportedOperationException("Library.exportSchematic needs Architect API 1.18.0");
	}

	/**
	 * A library entry.
	 *
	 * @param name the shown name (the user's display name when set)
	 * @param tags the design's tags plus the user's tags
	 * @param source the parametric source file name ({@code <id>.mjs}), absent for imports and hand-made templates
	 * @param ports named connectors (R5) in template coordinates (before rotation)
	 * @param ext namespaced extra data from the blueprint JSON (a copy)
	 * @param type a preset type or (since 1.2.0) an open type
	 * @param bible (since 1.2.0) the style bible it was designed or re-skinned with
	 * @param group (since 1.2.0) the design group it was made in
	 * @param groupItem (since 1.2.0) its item key in that group
	 * @param parts (since 1.2.0) its named parts (R3: {@code main, roof, wing_east, ...}) by name, template coordinates
	 * @param front (since 1.4.0) the direction the entrance faces in the unrotated template
	 * @param anchors (since 1.4.0) named template cells (unrotated): at least {@code entrance} and {@code spawn} when the design
	 *                has them (the cell holding the anchor's point)
	 * @param groundY (since 1.4.0) the template y of the entrance's feet row: the ground level the design expects
	 * @param approach (since 1.4.0) the entrance approach placement builds in front of the door
	 * @param critique (since 1.6.0) its latest verdict: from {@code critique.json} in its folder (a design's critique loop or a
	 *     report, {@link Designs#critique}), else from its blueprint JSON's {@code critique} summary. A {@code critique.json}
	 *     whose entry revision (the sha256 of the entry's {@code .nbt}) differs from the entry now is returned with
	 *     {@link Critique#stale()} true: it judged an older version and is not reused. Its rounds carry scores but not their
	 *     issues ({@link Critique.Round#issueCount}); the final {@code scores} and {@code openIssues} are complete. Empty for an
	 *     entry never critiqued (and for bundled entries)
	 * @param derivation (since 1.11.0) how it was derived from another entry: a player variant (VARIANT), a re-skin (RESKIN) or a
	 *     group copy (COPY, with the recipe that rebuilds it from any later source version); empty for designs and remixes.
	 *     Kept by new versions
	 * @param variantOfVersion (since 1.11.0) the version of {@link #variantOf} it was made from
	 * @param cells (since 1.30.0, C37b) the non-air blocks of the template's first palette: exactly the number
	 *     {@code Regions.realiseApproved} compares with the top of a lot's approved {@code costRange} (one shared function with
	 *     the plan-check's own count, so the two cannot diverge). <b>Not</b> the sum of {@link Part#cells()} (parts overlap and
	 *     count air-bounded boxes: a hollow room was 1,140 non-air blocks but 3,120 part cells). <b>0 means "unknown or
	 *     empty"</b>: a template that cannot be read, has no palette, or holds only air counts 0 (a lot then never fails the
	 *     cost-range check on this entry). Counted for this exact entry (version) when the view is made; 0 from the pre-1.30.0
	 *     constructors
	 */
	record Entry(String id, String name, String type, BlockSize size, List<String> tags, Optional<String> source, Map<String, JsonElement> params,
		Map<String, JsonElement> values, Optional<JsonObject> palette, Map<String, Port> ports, JsonObject ext, boolean bundled, boolean imported,
		Optional<String> variantOf, Optional<BiblePin> bible, Optional<String> group, Optional<String> groupItem, Map<String, Part> parts,
		Direction front, Map<String, BlockPos> anchors, int groundY, Approach approach, Optional<Critique> critique, int version,
		List<EntryVersion> versions, Optional<Derivation> derivation, OptionalInt variantOfVersion, long cells) {
		public Entry {
			critique = critique == null ? Optional.empty() : critique;
			version = version <= 0 ? 1 : version;
			versions = versions == null ? List.of() : List.copyOf(versions);
			derivation = derivation == null ? Optional.empty() : derivation;
			variantOfVersion = variantOfVersion == null ? OptionalInt.empty() : variantOfVersion;
		}

		/** The 1.11.0 constructor (no cell count: {@link #cells} 0). */
		public Entry(String id, String name, String type, BlockSize size, List<String> tags, Optional<String> source, Map<String, JsonElement> params,
			Map<String, JsonElement> values, Optional<JsonObject> palette, Map<String, Port> ports, JsonObject ext, boolean bundled, boolean imported,
			Optional<String> variantOf, Optional<BiblePin> bible, Optional<String> group, Optional<String> groupItem, Map<String, Part> parts,
			Direction front, Map<String, BlockPos> anchors, int groundY, Approach approach, Optional<Critique> critique, int version,
			List<EntryVersion> versions, Optional<Derivation> derivation, OptionalInt variantOfVersion) {
			this(id, name, type, size, tags, source, params, values, palette, ports, ext, bundled, imported, variantOf, bible, group, groupItem, parts,
				front, anchors, groundY, approach, critique, version, versions, derivation, variantOfVersion, 0L);
		}

		/** The 1.5.0 constructor (no derivation). */
		public Entry(String id, String name, String type, BlockSize size, List<String> tags, Optional<String> source, Map<String, JsonElement> params,
			Map<String, JsonElement> values, Optional<JsonObject> palette, Map<String, Port> ports, JsonObject ext, boolean bundled, boolean imported,
			Optional<String> variantOf, Optional<BiblePin> bible, Optional<String> group, Optional<String> groupItem, Map<String, Part> parts,
			Direction front, Map<String, BlockPos> anchors, int groundY, Approach approach, Optional<Critique> critique, int version,
			List<EntryVersion> versions) {
			this(id, name, type, size, tags, source, params, values, palette, ports, ext, bundled, imported, variantOf, bible, group, groupItem, parts,
				front, anchors, groundY, approach, critique, version, versions, Optional.empty(), OptionalInt.empty());
		}

		/** The 1.6.0 constructor (version 1, no lineage). */
		public Entry(String id, String name, String type, BlockSize size, List<String> tags, Optional<String> source, Map<String, JsonElement> params,
			Map<String, JsonElement> values, Optional<JsonObject> palette, Map<String, Port> ports, JsonObject ext, boolean bundled, boolean imported,
			Optional<String> variantOf, Optional<BiblePin> bible, Optional<String> group, Optional<String> groupItem, Map<String, Part> parts,
			Direction front, Map<String, BlockPos> anchors, int groundY, Approach approach, Optional<Critique> critique) {
			this(id, name, type, size, tags, source, params, values, palette, ports, ext, bundled, imported, variantOf, bible, group, groupItem, parts,
				front, anchors, groundY, approach, critique, 1, List.of());
		}

		/** The 1.4.0 constructor (no critique). */
		public Entry(String id, String name, String type, BlockSize size, List<String> tags, Optional<String> source, Map<String, JsonElement> params,
			Map<String, JsonElement> values, Optional<JsonObject> palette, Map<String, Port> ports, JsonObject ext, boolean bundled, boolean imported,
			Optional<String> variantOf, Optional<BiblePin> bible, Optional<String> group, Optional<String> groupItem, Map<String, Part> parts,
			Direction front, Map<String, BlockPos> anchors, int groundY, Approach approach) {
			this(id, name, type, size, tags, source, params, values, palette, ports, ext, bundled, imported, variantOf, bible, group, groupItem, parts,
				front, anchors, groundY, approach, Optional.empty());
		}
		/** The 1.2.0 constructor (no lot-fitting data: front south, no anchors, groundY 0, the default approach). */
		public Entry(String id, String name, String type, BlockSize size, List<String> tags, Optional<String> source, Map<String, JsonElement> params,
			Map<String, JsonElement> values, Optional<JsonObject> palette, Map<String, Port> ports, JsonObject ext, boolean bundled, boolean imported,
			Optional<String> variantOf, Optional<BiblePin> bible, Optional<String> group, Optional<String> groupItem, Map<String, Part> parts) {
			this(id, name, type, size, tags, source, params, values, palette, ports, ext, bundled, imported, variantOf, bible, group, groupItem, parts,
				Direction.SOUTH, Map.of(), 0, Approach.DEFAULT);
		}

		/** The 1.1.0 constructor (no bible, group or parts). */
		public Entry(String id, String name, String type, BlockSize size, List<String> tags, Optional<String> source, Map<String, JsonElement> params,
			Map<String, JsonElement> values, Optional<JsonObject> palette, Map<String, Port> ports, JsonObject ext, boolean bundled, boolean imported,
			Optional<String> variantOf) {
			this(id, name, type, size, tags, source, params, values, palette, ports, ext, bundled, imported, variantOf, Optional.empty(), Optional.empty(),
				Optional.empty(), Map.of());
		}
	}

	/**
	 * How an entry was derived from another (since 1.11.0, docs/CONTRACT.md 6c 0b §2.4). One representation with 7b and 6d.
	 *
	 * @param source the entry it was made from
	 * @param sourceVersion the source's version it was made from
	 * @param kind VARIANT (a player variant), RESKIN (a re-skin to another bible), COPY (a copy in a design group) or SITE
	 *     (reserved for 7b's site-adapted designs). Only COPY and SITE follow their source (6d)
	 * @param recipe what rebuilds it: a copy's {@code {shift, param, values, mirror, roles, bible, group, itemKey, ...}}; a
	 *     variant's palette and values; a re-skin's bible
	 */
	record Derivation(String source, int sourceVersion, Kind kind, JsonObject recipe) {
		public Derivation {
			recipe = recipe == null ? new JsonObject() : recipe;
		}

		/** New values are only ever appended. */
		public enum Kind {
			VARIANT, RESKIN, COPY, SITE;

			public static Kind of(@Nullable String s) {
				if (s == null) {
					return VARIANT;
				}
				return switch (s.toLowerCase(java.util.Locale.ROOT)) {
					case "reskin" -> RESKIN;
					case "copy" -> COPY;
					case "site" -> SITE;
					default -> VARIANT;
				};
			}
		}
	}

	/**
	 * A design's entrance approach (since 1.4.0): {@code length} rows out from the front face, {@code width} wide, plus up to
	 * {@code extendMax} more rows while the path has not met the ground. {@code length} 0 = no approach.
	 */
	record Approach(int length, int width, int extendMax) {
		public static final Approach DEFAULT = new Approach(6, 3, 8);
	}

	/**
	 * A named part of a design (R3, {@code bp.part(name, ...)}): the box its cells span (template coordinates, before
	 * rotation, inclusive) and how many cells it wrote. Names are stable across revisions; A6 delta apply diffs by them.
	 * Since 1.2.0.
	 */
	record Part(String name, BoundingBox box, int cells) {
	}

	/**
	 * A collection to re-skin: a design group, a bible (optionally one version of it), or explicit entries. Since 1.2.0.
	 */
	record CollectionRef(@Nullable String group, @Nullable String bible, @Nullable Integer bibleVersion, List<String> entries) {
		public CollectionRef {
			entries = entries == null ? List.of() : List.copyOf(entries);
			if (group == null && bible == null && entries.isEmpty()) {
				throw new IllegalArgumentException("a collection needs a group, a bible or entries");
			}
		}

		public static CollectionRef ofGroup(String groupId) {
			return new CollectionRef(groupId, null, null, List.of());
		}

		public static CollectionRef ofBible(String bibleId, @Nullable Integer version) {
			return new CollectionRef(null, bibleId, version, List.of());
		}

		public static CollectionRef ofEntries(List<String> entryIds) {
			return new CollectionRef(null, null, null, entryIds);
		}
	}

	/**
	 * A named connector of a design (R5): {@code kind} is one of {@code item_out, item_in, water_in, water_out, redstone_in,
	 * redstone_out, bed, door} or {@code <modid>:<kind>}; {@code offset} is the cell in template coordinates, {@code facing}
	 * horizontal.
	 */
	record Port(String name, String kind, BlockPos offset, Direction facing) {
	}
}

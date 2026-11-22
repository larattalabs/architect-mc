package dev.larattalabs.architect.apiimpl;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.BlockSize;
import dev.larattalabs.architect.api.Library;
import dev.larattalabs.architect.api.SiteView;
import dev.larattalabs.architect.api.State;
import dev.larattalabs.architect.library.LibraryMeta;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.Blueprint;
import dev.larattalabs.architect.placement.BlueprintTransform;
import dev.larattalabs.architect.placement.Blueprints;
import dev.larattalabs.architect.site.Builder;
import dev.larattalabs.architect.site.Site;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/** Internal records -> API views. Internal. */
public final class Views {
	private Views() {
	}

	public static BoundingBox box(Anchors.Bounds b) {
		return new BoundingBox(b.minX(), b.minY(), b.minZ(), b.maxX(), b.maxY(), b.maxZ());
	}

	public static Rotation rotation(String name) {
		return Rotation.values()[Math.max(0, BlueprintTransform.ROTATIONS.indexOf(name))];
	}

	public static ResourceKey<Level> dimension(String id) {
		Identifier key = Identifier.tryParse(id);
		return ResourceKey.create(Registries.DIMENSION, key == null ? Identifier.parse(Site.OVERWORLD) : key);
	}

	/** A site as the API sees it; {@code server} null = no progress counts. */
	/** (slice T4R, R3) {@code v} as a decided removal not yet settled: status removing, reason held(decided). */
	public static SiteView removingHeld(SiteView v) {
		dev.larattalabs.architect.api.BuildStatus st = new dev.larattalabs.architect.api.BuildStatus(dev.larattalabs.architect.api.BuildStatus.REMOVING,
			dev.larattalabs.architect.api.BuildStatus.HELD_DECIDED, null, java.util.Map.of(), 0, 0L, "being removed (held, decided): it finishes by itself",
			v.revision(), null);
		return new SiteView(v.id(), v.blueprintId(), v.owner(), v.ext(), v.box(), v.restoreBox(), v.rotation(), v.dimension(), v.state(), v.built(), v.queued(),
			v.group(), v.batchId(), v.itemKey(), v.kind(), v.policy(), v.covers(), v.coveredBy(), v.version(), v.headVersion(), v.deviations(), v.updating(),
			v.region(), v.siteWait(), st, v.part(), v.lot(), v.revision());
	}

	public static SiteView site(@Nullable MinecraftServer server, Site s) {
		int[] p = server == null || s.construction() == null ? new int[] {0, 0} : Builder.progress(server, s);
		if (s.placing()) {
			int[] q = dev.larattalabs.architect.site.Placement.progress(s.id());
			p = q == null ? new int[] {0, 0} : q;
		}
		Site.Member m = s.member();
		State st = s.placing() ? State.PLACING : s.building() ? State.BUILDING : State.BUILT;
		dev.larattalabs.architect.api.SiteWait sw = server == null || s.construction() == null ? null : dev.larattalabs.architect.site.SiteWaits.view(server, s.id());
		int rid = StatusViews.rid(s.ext());
		// (8b BS) one status from what the view already holds: its state, its wait (read once), its pause and its group's removal
		dev.larattalabs.architect.api.BuildStatus status = dev.larattalabs.architect.api.BuildStatus.ofTarget(s.id(), st, sw, s.construction() != null && s
			.construction().paused(), removing(m), rid);
		return new SiteView(s.id(), s.blueprint(), s.owner(), s.ext(), box(s.box()), box(s.restoreBox()), rotation(s.rotation()),
			dimension(s.dimension()), st, p[0], p[1], m == null ? null : m.group(),
			m == null ? null : m.batchId(), m == null ? null : m.itemKey(), "building", dev.larattalabs.architect.api.Policy.BOX,
			dev.larattalabs.architect.site.SiteJournal.coveredSites(s.id()), dev.larattalabs.architect.site.SiteJournal.related(s.id(), true),
			s.versioning().version() > 0 || server == null ? Math.max(1, s.versioning().version()) : Math.max(1,
				dev.larattalabs.architect.site.SiteDeltas.versionOf(server, s)), Math.max(1, dev.larattalabs.architect.site.SiteDeltas.headVersion(s
					.blueprint())), s.versioning().deviations(), s.versioning().updating() > 0 || s.versioning().reverting() > 0, regionOfGroup(m == null
						? null : m.group()), sw, status, StatusViews.part(s.ext()), StatusViews.str(s.ext(), StatusViews.EXT_LOT), rid);
	}

	/**
	 * (8b BS) A construction target's status by id (a site or a road), as its view has it, without building the whole view; null when the id
	 * is neither. Server thread.
	 */
	public static dev.larattalabs.architect.api.@Nullable BuildStatus targetStatus(MinecraftServer server, String id) {
		Site s = dev.larattalabs.architect.site.Sites.get(id);
		if (s != null) {
			State st = s.placing() ? State.PLACING : s.building() ? State.BUILDING : State.BUILT;
			var sw = s.construction() == null ? null : dev.larattalabs.architect.site.SiteWaits.statusView(server, id);
			return dev.larattalabs.architect.api.BuildStatus.ofTarget(id, st, sw, s.construction() != null && s.construction().paused(), removing(s.member()),
				StatusViews.rid(s.ext()));
		}
		dev.larattalabs.architect.site.Infra i = dev.larattalabs.architect.site.Infras.get(id);
		if (i == null) {
			return null;
		}
		State st = i.placing() ? State.PLACING : i.building() ? State.BUILDING : State.BUILT;
		var sw = i.construction() == null ? null : dev.larattalabs.architect.site.SiteWaits.statusView(server, id);
		return dev.larattalabs.architect.api.BuildStatus.ofTarget(id, st, sw, i.construction() != null && i.construction().paused(), removing(i.member()),
			StatusViews.rid(i.ext()));
	}

	/** (8b BS) Whether a member's group is being removed (its whole-group removal runs). */
	static boolean removing(Site.@Nullable Member m) {
		if (m == null || m.group() == null) {
			return false;
		}
		dev.larattalabs.architect.site.SiteGroupRec g = dev.larattalabs.architect.site.Sites.group(m.group());
		return g != null && dev.larattalabs.architect.site.SiteGroupRec.REMOVING.equals(g.state());
	}

	/** A road or cell site as the API sees it (phase 4e). */
	public static SiteView infra(dev.larattalabs.architect.site.Infra i) {
		Site.Member m = i.member();
		dev.larattalabs.architect.api.Policy policy = i.road() || !"BOX".equals(i.spec().has("policy") ? i.spec().get("policy").getAsString() : "CELL")
			? dev.larattalabs.architect.api.Policy.CELL : dev.larattalabs.architect.api.Policy.BOX;
		String region = i.spec().has("tile") ? i.spec().get("tile").getAsString().split("\\|")[0] : regionOfGroup(m == null ? null : m.group());
		int[] prog = dev.larattalabs.architect.site.RoadBuilder.progress(dev.larattalabs.architect.site.SiteDeltas.serverOrNull(), i); // 6c 0c (C16)
		State st = i.placing() ? State.PLACING : i.building() ? State.BUILDING : State.BUILT;
		MinecraftServer srv = dev.larattalabs.architect.site.SiteDeltas.serverOrNull();
		dev.larattalabs.architect.api.SiteWait sw = i.construction() == null || srv == null ? null : dev.larattalabs.architect.site.SiteWaits.view(srv, i.id());
		int rid = StatusViews.rid(i.ext());
		dev.larattalabs.architect.api.BuildStatus status = dev.larattalabs.architect.api.BuildStatus.ofTarget(i.id(), st, sw, i.construction() != null && i
			.construction().paused(), removing(m), rid);
		String roadPart = m != null && m.itemKey() != null && m.itemKey().startsWith("road:") ? m.itemKey().substring(5) : StatusViews.part(i.ext());
		return new SiteView(i.id(), i.kind(), i.owner(), i.ext(), box(i.box()), box(i.box()), Rotation.NONE, dimension(i.dimension()),
			st, prog[0], prog[1], m == null ? null : m.group(), m == null ? null
				: m.batchId(), m == null ? null : m.itemKey(),
			i.kind(), policy, dev.larattalabs.architect.site.SiteJournal.coveredSites(i.id()), dev.larattalabs.architect.site.SiteJournal.related(i.id(), true),
			1, 1, 0, false, region, sw, status, roadPart, StatusViews.str(i.ext(), StatusViews.EXT_LOT), rid);
	}

	/** (8b) {@link #regionOfGroup} for other packages. */
	public static @Nullable String regionOfGroupPublic(@Nullable String group) {
		return regionOfGroup(group);
	}

	/** Phase 6a: the region of a site group (its batch ext names it), or null. */
	static @org.jspecify.annotations.Nullable String regionOfGroup(@org.jspecify.annotations.Nullable String group) {
		var g = group == null ? null : dev.larattalabs.architect.site.Sites.group(group);
		return g != null && g.ext().has(dev.larattalabs.architect.site.RegionItems.EXT_REGION) ? g.ext().get(dev.larattalabs.architect.site.RegionItems
			.EXT_REGION).getAsString() : null;
	}

	// ------------------------------------------------------------------ phase 4d: batches, groups, stages

	public static dev.larattalabs.architect.api.BatchView batch(dev.larattalabs.architect.batch.QBatch b) {
		List<dev.larattalabs.architect.api.BatchView.ItemView> items = new ArrayList<>();
		for (dev.larattalabs.architect.batch.QItem i : b.items) {
			items.add(new dev.larattalabs.architect.api.BatchView.ItemView(i.key, i.stage,
				dev.larattalabs.architect.api.BatchView.ItemStatus.valueOf(i.status.name()), i.construction ? dev.larattalabs.architect.api.Mode.CONSTRUCTION
					: dev.larattalabs.architect.api.Mode.INSTANT, Optional.ofNullable(i.siteId), reason(i.reason), i.message, i.ext.deepCopy()));
		}
		return new dev.larattalabs.architect.api.BatchView(b.id, b.owner, b.ext.deepCopy(), b.group,
			dev.larattalabs.architect.api.BatchView.Status.valueOf(b.status.name()), items, b.stages, b.createdAt,
			b.doneAt > 0 ? Optional.of(b.doneAt) : Optional.empty(), Optional.ofNullable(b.opKey));
	}

	public static dev.larattalabs.architect.api.ItemEvent itemEvent(dev.larattalabs.architect.batch.QBatch b, dev.larattalabs.architect.batch.QItem i) {
		// (6c close-out A, §8) a region tile or road item queued before its tags: shown with them
		com.google.gson.JsonObject filled = dev.larattalabs.architect.site.RegionWaitTags.backfill(b, i);
		com.google.gson.JsonObject ext = filled != null ? filled : i.ext.deepCopy();
		// (8b, S-8b-8) the typed homes of the keys a caller read from the ext, and the item's status
		String region = StatusViews.str(ext, StatusViews.EXT_REGION);
		if (region == null) {
			region = regionOfGroup(b.group);
		}
		String part = StatusViews.part(ext);
		if (part == null && i.key.startsWith("road:")) {
			part = i.key.substring(5);
		}
		return new dev.larattalabs.architect.api.ItemEvent(b.id, i.key, ext, Optional.ofNullable(i.siteId), reason(i.reason), i.message, region, part,
			StatusViews.str(ext, StatusViews.EXT_LOT), StatusViews.rid(ext), StatusViews.item(i.key, i.status.name(), i.reason, i.siteId, ext));
	}

	public static Optional<dev.larattalabs.architect.api.Reason> reason(@Nullable String name) {
		if (name == null) {
			return Optional.empty();
		}
		try {
			return Optional.of(dev.larattalabs.architect.api.Reason.valueOf(name));
		} catch (IllegalArgumentException e) {
			return Optional.of(dev.larattalabs.architect.api.Reason.OTHER);
		}
	}

	public static dev.larattalabs.architect.api.Stage stage(dev.larattalabs.architect.site.SiteGroupRec.StageRec st) {
		return new dev.larattalabs.architect.api.Stage(st.name(), st.items(), st.state(), st.sites(), st.batchId());
	}

	/** A group's stockpile (R6): its shared crate's ledger, and every building site's outstanding bill. */
	public static dev.larattalabs.architect.api.Stock stock(MinecraftServer server, String groupId) {
		dev.larattalabs.architect.site.SiteGroupRec g = dev.larattalabs.architect.site.Sites.group(groupId);
		if (g == null) {
			throw new IllegalArgumentException("no site group " + groupId);
		}
		Builder.GroupStock st = Builder.groupStock(server, g);
		Map<String, Map<Item, Integer>> bySite = new LinkedHashMap<>();
		st.outstandingBySite().forEach((id, m) -> bySite.put(id, items(m)));
		return new dev.larattalabs.architect.api.Stock(groupId, items(st.delivered()), items(st.credit()), bySite, items(st.outstanding()),
			st.crate() == null ? Optional.empty() : Optional.of(st.crate()));
	}

	/** 6c Y (C24): a stockpile's view. */
	public static dev.larattalabs.architect.api.Stockpile stockpile(dev.larattalabs.architect.site.Stockpiles.View v) {
		Map<String, Map<Item, Integer>> byT = new LinkedHashMap<>();
		v.outstandingByTarget().forEach((id, m) -> byT.put(id, items(m)));
		Identifier dim = Identifier.tryParse(v.dimension());
		return new dev.larattalabs.architect.api.Stockpile(v.owner(), net.minecraft.resources.ResourceKey.create(net.minecraft.core.registries.Registries.DIMENSION,
			dim == null ? Identifier.fromNamespaceAndPath("minecraft", "overworld") : dim), v.crates(), v.capacityStacks(), v.usedStacks(), items(v.stock()), items(v
				.reserved()), items(v.credit()), items(v.delivered()), items(v.consumed()), items(v.returned()), items(v.withdrawn()), items(v.dropped()),
			items(v.refundOverflow()), byT, items(v.outstanding()), v.feedOrder(), v.waiting(), v.missingCrates());
	}

	/** Items -> item ids (the API's maps going in). */
	public static Map<String, Integer> ids(Map<Item, Integer> items) {
		Map<String, Integer> out = new java.util.TreeMap<>();
		if (items != null) {
			items.forEach((it, n) -> {
				if (it != null && n != null && n > 0) {
					out.merge(BuiltInRegistries.ITEM.getKey(it).toString(), n, Integer::sum);
				}
			});
		}
		return out;
	}

	public static dev.larattalabs.architect.api.SiteGroup group(dev.larattalabs.architect.site.SiteGroupRec g) {
		dev.larattalabs.architect.api.SiteGroup.State state = switch (g.state()) {
			case dev.larattalabs.architect.site.SiteGroupRec.REMOVING -> dev.larattalabs.architect.api.SiteGroup.State.REMOVING;
			case dev.larattalabs.architect.site.SiteGroupRec.REMOVED -> dev.larattalabs.architect.api.SiteGroup.State.REMOVED;
			default -> dev.larattalabs.architect.api.SiteGroup.State.ACTIVE;
		};
		return new dev.larattalabs.architect.api.SiteGroup(g.id(), g.owner(), g.ext(), g.sites(), g.stages().stream().map(Views::stage).toList(), state,
			g.crate() == null ? Optional.empty() : Optional.of(new BlockPos(g.crate().x(), g.crate().y(), g.crate().z())),
			g.removedAt() > 0 ? Optional.of(g.removedAt()) : Optional.empty(), stopOf(g.id()), causeOf(g.id()));
	}

	private static dev.larattalabs.architect.api.RemovalStop stopOf(String group) {
		var st = dev.larattalabs.architect.site.Groups.lastStop(group);
		return st == null ? dev.larattalabs.architect.api.RemovalStop.NONE : st.stop();
	}

	private static dev.larattalabs.architect.api.@Nullable RemovalStopCause causeOf(String group) {
		var st = dev.larattalabs.architect.site.Groups.lastStop(group);
		return st == null ? null : st.cause();
	}

	/** Item ids -> items (unknown ids dropped). */
	/** A snapshot ({refund, owedParts, restored, kept, handed, cascaded}) as a dev.larattalabs.architect.api.RemoveResult. */
	public static dev.larattalabs.architect.api.RemoveResult resultOf(com.google.gson.JsonObject r) {
		Map<String, Integer> refund = new java.util.TreeMap<>();
		r.getAsJsonObject("refund").entrySet().forEach(e -> refund.put(e.getKey(), e.getValue().getAsInt()));
		Map<String, Integer> handed = new java.util.TreeMap<>();
		r.getAsJsonObject("handed").entrySet().forEach(e -> handed.put(e.getKey(), e.getValue().getAsInt()));
		List<String> cascaded = new java.util.ArrayList<>();
		r.getAsJsonArray("cascaded").forEach(x -> cascaded.add(x.getAsString()));
		List<String> owed = new java.util.ArrayList<>();
		List<com.google.gson.JsonObject> parts = new java.util.ArrayList<>();
		r.getAsJsonArray("owedParts").forEach(x -> {
			owed.add(x.getAsJsonObject().get("key").getAsString());
			parts.add(x.getAsJsonObject());
		});
		return new dev.larattalabs.architect.api.RemoveResult(true, List.of(), items(refund), r.get("restored").getAsInt(), r.get("kept").getAsInt(), handed, cascaded, owed, owedParts(parts));
	}

	/** (slice T4R-D) A result's owed parts ({key, recipient, reason, items}) as the API's. */
	public static List<dev.larattalabs.architect.api.OwedPart> owedParts(List<com.google.gson.JsonObject> parts) {
		List<dev.larattalabs.architect.api.OwedPart> out = new java.util.ArrayList<>();
		for (com.google.gson.JsonObject p : parts) {
			Map<String, Integer> m = new java.util.TreeMap<>();
			p.getAsJsonObject("items").entrySet().forEach(e -> m.put(e.getKey(), e.getValue().getAsInt()));
			out.add(new dev.larattalabs.architect.api.OwedPart(p.get("key").getAsString(), p.get("recipient").getAsString(), p.get("reason").getAsString(),
				items(m)));
		}
		return out;
	}

	public static Map<Item, Integer> items(Map<String, Integer> byId) {
		Map<Item, Integer> out = new LinkedHashMap<>();
		byId.forEach((id, n) -> {
			Identifier key = Identifier.tryParse(id);
			Item it = key == null ? null : BuiltInRegistries.ITEM.getOptional(key).orElse(null);
			if (it != null && it != Items.AIR && n != null && n > 0) {
				out.merge(it, n, Integer::sum);
			}
		});
		return out;
	}

	/** A library entry as the API sees it, with the user metadata in force ({@code meta}: the overlay for bundled entries). */
	public static Library.Entry entry(Blueprints.Entry e, LibraryMeta meta) {
		Blueprint bp = e.blueprint();
		JsonObject j = e.json();

		LinkedHashSet<String> tags = new LinkedHashSet<>(bp.tags());
		tags.addAll(meta.userTags());
		String name = meta.displayName() != null ? meta.displayName() : bp.name();
		return new Library.Entry(bp.id(), name, bp.type(), new BlockSize(bp.sizeX(), bp.sizeY(), bp.sizeZ()), List.copyOf(tags),
			Optional.ofNullable(str(j, "source")), map(j, "params"), map(j, "values"),
			j.has("palette") && j.get("palette").isJsonObject() ? Optional.of(j.getAsJsonObject("palette").deepCopy()) : Optional.empty(),
			ports(j), j.has("ext") && j.get("ext").isJsonObject() ? j.getAsJsonObject("ext").deepCopy() : new JsonObject(), e.bundled(),
			j.has("imported") && j.get("imported").isJsonPrimitive() && j.get("imported").getAsBoolean(), Optional.ofNullable(str(j, "variantOf")),
			Wire4b.pin(j.get("bible")), Optional.ofNullable(str(j, "group")), Optional.ofNullable(str(j, "groupItem")), Wire4b.parts(j),
			direction(bp.front()), anchorCells(bp), bp.groundY(), approach(bp), Wire5a.entry(e.dir(), bp.id(), j),
			dev.larattalabs.architect.library.EntryVersions.version(j), entryVersions(bp.id(), j), Wire0b.derivation(j), Wire0b.variantOfVersion(j),
			Blueprints.nonAirCells(e.template()));
	}

	/** An entry's lineage for the API, with each version's pin (a standing site stands at it). */
	public static List<dev.larattalabs.architect.api.EntryVersion> entryVersions(String id, JsonObject j) {
		java.util.Set<Integer> pinned = new java.util.HashSet<>();
		for (dev.larattalabs.architect.site.Site s : dev.larattalabs.architect.site.Sites.all()) {
			if (s.blueprint().equals(id)) {
				pinned.add(s.versioning().version() > 0 ? s.versioning().version() : dev.larattalabs.architect.library.EntryVersions.version(j));
			}
		}
		// (6c 0a) or a caller pins it
		pinned.addAll(CallerPins.pinned().getOrDefault(id, java.util.Set.of()));
		List<dev.larattalabs.architect.api.EntryVersion> out = new ArrayList<>();
		boolean adopted = dev.larattalabs.architect.site.Adopt.isAdoptedEntry(j);
		for (var l : dev.larattalabs.architect.library.EntryVersions.lineage(j, null)) {
			// (6c PT2, SQ-PT2-3) an adopted entry's versions: how many of v1's captured cells each changes or removes
			int[] cap = adopted ? dev.larattalabs.architect.site.Adopt.captured(dev.larattalabs.architect.site.SiteDeltas.serverOrNull(), id, l.n())
				: new int[2];
			out.add(new dev.larattalabs.architect.api.EntryVersion(l.n(), l.createdAt(), l.by(), l.parent(), l.designId(), l.summary(), l.nbtSha256(),
				pinned.contains(l.n()), cap[0], cap[1]));
		}
		return out;
	}

	/** The blueprint delta for the API (the mod's TemplateDelta, the kit's summary). */
	public static dev.larattalabs.architect.api.BlueprintDelta blueprintDelta(String id, int from, int to,
		dev.larattalabs.architect.delta.TemplateDelta.Result r) {
		Map<String, dev.larattalabs.architect.api.PartDelta> parts = new LinkedHashMap<>();
		r.parts().forEach((n, p) -> parts.put(n, partDelta(p)));
		return new dev.larattalabs.architect.api.BlueprintDelta(id, from, to, r.frameKept(), r.approximate(), parts, r.added().size(), r.removed().size(),
			r.changed().size(), r.unchanged(), r.notes());
	}

	/** {@code north/east/south/west} -> the Direction (south when unknown). */
	public static Direction direction(String name) {
		Direction d = Direction.byName(name);
		return d == null || d.getAxis().isVertical() ? Direction.SOUTH : d;
	}

	/** The blueprint's anchors as template cells (the cell holding each anchor's point), cameras left out. Pure. */
	public static Map<String, BlockPos> anchorCells(Blueprint bp) {
		Map<String, BlockPos> out = new LinkedHashMap<>();
		bp.anchors().forEach((name, a) -> {
			if (!name.startsWith(Blueprint.CAM_PREFIX)) {
				out.put(name, new BlockPos((int) Math.floor(a.x()), (int) Math.floor(a.y()), (int) Math.floor(a.z())));
			}
		});
		return out;
	}

	/** The design's approach for the API ({@code length} 0 when it has none). */
	public static Library.Approach approach(Blueprint bp) {
		return new Library.Approach(bp.approach().enabled() ? bp.approach().length() : 0, bp.approach().width(),
			dev.larattalabs.architect.placement.Approach.EXTEND);
	}

	private static @Nullable String str(JsonObject j, String k) {
		return j.has(k) && j.get(k).isJsonPrimitive() ? j.get(k).getAsString() : null;
	}

	private static Map<String, JsonElement> map(JsonObject j, String k) {
		Map<String, JsonElement> out = new LinkedHashMap<>();
		if (j.has(k) && j.get(k).isJsonObject()) {
			j.getAsJsonObject(k).entrySet().forEach(en -> out.put(en.getKey(), en.getValue().deepCopy()));
		}
		return out;
	}

	/**
	 * The blueprint JSON's {@code ports}: {@code [{name, kind, x, y, z, facing}]} (or an object keyed by name). Invalid ones are
	 * skipped (the kit's checker reports them).
	 */
	public static Map<String, Library.Port> ports(JsonObject j) {
		Map<String, Library.Port> out = new LinkedHashMap<>();
		if (!j.has("ports")) {
			return out;
		}
		List<JsonObject> list = new ArrayList<>();
		JsonElement p = j.get("ports");
		if (p.isJsonArray()) {
			p.getAsJsonArray().forEach(x -> {
				if (x.isJsonObject()) {
					list.add(x.getAsJsonObject());
				}
			});
		} else if (p.isJsonObject()) {
			p.getAsJsonObject().entrySet().forEach(en -> {
				if (en.getValue().isJsonObject()) {
					JsonObject o = en.getValue().getAsJsonObject().deepCopy();
					if (!o.has("name")) {
						o.addProperty("name", en.getKey());
					}
					list.add(o);
				}
			});
		}
		for (JsonObject o : list) {
			try {
				Direction d = Direction.byName(o.get("facing").getAsString());
				if (d == null || d.getAxis().isVertical()) {
					continue;
				}
				String name = o.get("name").getAsString();
				out.put(name, new Library.Port(name, o.get("kind").getAsString(), new BlockPos(o.get("x").getAsInt(), o.get("y").getAsInt(),
					o.get("z").getAsInt()), d));
			} catch (RuntimeException ignored) {
				// skipped: the checker reports it
			}
		}
		return out;
	}

	// ------------------------------------------------------------------ phase 5b: deltas

	public static dev.larattalabs.architect.api.DeltaVerdict deltaVerdict(dev.larattalabs.architect.site.SiteDeltas.@Nullable Check c,
		List<dev.larattalabs.architect.api.Refusal> extra, boolean instant) {
		dev.larattalabs.architect.api.Mode mode = instant ? dev.larattalabs.architect.api.Mode.INSTANT : dev.larattalabs.architect.api.Mode.CONSTRUCTION;
		if (c == null) {
			return new dev.larattalabs.architect.api.DeltaVerdict(false, extra, 0, 0, 0, java.util.Map.of(), List.of(), List.of(), java.util.Map.of(),
				java.util.Map.of(), new BoundingBox(0, 0, 0, 0, 0, 0), mode, List.of());
		}
		List<dev.larattalabs.architect.api.Refusal> rs = new ArrayList<>(extra);
		for (dev.larattalabs.architect.site.SiteDeltas.Refusal r : c.refusals()) {
			rs.add(new dev.larattalabs.architect.api.Refusal(r.reason(), r.message(), r.builds()));
		}
		java.util.Map<String, dev.larattalabs.architect.api.PartDelta> parts = new java.util.LinkedHashMap<>();
		c.parts().forEach((n, p) -> parts.put(n, partDelta(p)));
		List<dev.larattalabs.architect.api.Overlap> ov = new ArrayList<>();
		c.overlaps().forEach((sid, n) -> ov.add(new dev.larattalabs.architect.api.Overlap(sid, dev.larattalabs.architect.site.Sites.ownerOf(sid), n,
			false)));
		BoundingBox box = c.box() != null ? box(c.box()) : new BoundingBox(0, 0, 0, 0, 0, 0);
		// (6c PT2, SQ-PT2-3) an adopted site: how many of v1's captured cells the target version changes or removes
		dev.larattalabs.architect.site.Site site = dev.larattalabs.architect.site.Sites.get(c.siteId());
		int[] cap = site != null && dev.larattalabs.architect.site.Adopt.isAdopted(site) && c.to() > 0 ? dev.larattalabs.architect.site.Adopt.captured(
			dev.larattalabs.architect.site.SiteDeltas.serverOrNull(), site.blueprint(), c.to()) : new int[2];
		return new dev.larattalabs.architect.api.DeltaVerdict(rs.isEmpty(), rs, c.added(), c.removed(), c.changed(), parts, kept(c.kept()), ov, items(c
			.bom()), items(c.refund()), box, mode, c.notes(), cap[0], cap[1]);
	}

	public static dev.larattalabs.architect.api.PartDelta partDelta(dev.larattalabs.architect.delta.TemplateDelta.Part p) {
		return new dev.larattalabs.architect.api.PartDelta(p.name(), dev.larattalabs.architect.api.PartStatus.valueOf(p.status().name()), p.added(), p
			.removed(), p.changed(), designBox(p.boxFrom()), designBox(p.boxTo()));
	}

	static @Nullable BoundingBox designBox(int @Nullable [] b) {
		return b == null ? null : new BoundingBox(b[0], b[1], b[2], b[3], b[4], b[5]);
	}

	static List<dev.larattalabs.architect.api.KeptCell> kept(List<dev.larattalabs.architect.delta.DeltaPlanner.Kept> kept) {
		List<dev.larattalabs.architect.api.KeptCell> out = new ArrayList<>();
		for (dev.larattalabs.architect.delta.DeltaPlanner.Kept k : kept) {
			out.add(new dev.larattalabs.architect.api.KeptCell(net.minecraft.core.BlockPos.of(k.pos()), dev.larattalabs.architect.journal.WorldJournal
				.state(k.found()), dev.larattalabs.architect.journal.WorldJournal.state(k.planned())));
		}
		return out;
	}

	public static dev.larattalabs.architect.api.DeltaResult deltaResult(dev.larattalabs.architect.site.SiteDeltas.Result r) {
		List<dev.larattalabs.architect.api.Refusal> rs = new ArrayList<>();
		for (dev.larattalabs.architect.site.SiteDeltas.Refusal x : r.refusals()) {
			rs.add(new dev.larattalabs.architect.api.Refusal(x.reason(), x.message(), x.builds()));
		}
		return new dev.larattalabs.architect.api.DeltaResult(r.applied(), r.siteId(), r.from(), r.to(), r.written(), kept(r.kept()), items(r.refund()),
			r.reshaped(), rs, r.notes());
	}

	public static dev.larattalabs.architect.api.DeltaResult deltaFailed(String siteId, dev.larattalabs.architect.api.Refusal why) {
		return new dev.larattalabs.architect.api.DeltaResult(false, siteId, 0, 0, 0, List.of(), java.util.Map.of(), 0, List.of(why), List.of());
	}
}

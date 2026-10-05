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
	public static SiteView site(@Nullable MinecraftServer server, Site s) {
		int[] p = server == null || s.construction() == null ? new int[] {0, 0} : Builder.progress(server, s);
		if (s.placing()) {
			int[] q = dev.larattalabs.architect.site.Placement.progress(s.id());
			p = q == null ? new int[] {0, 0} : q;
		}
		Site.Member m = s.member();
		return new SiteView(s.id(), s.blueprint(), s.owner(), s.ext(), box(s.box()), box(s.restoreBox()), rotation(s.rotation()),
			dimension(s.dimension()), s.placing() ? State.PLACING : s.building() ? State.BUILDING : State.BUILT, p[0], p[1], m == null ? null : m.group(),
			m == null ? null : m.batchId(), m == null ? null : m.itemKey(), "building", dev.larattalabs.architect.api.Policy.BOX,
			dev.larattalabs.architect.site.SiteJournal.coveredSites(s.id()), dev.larattalabs.architect.site.SiteJournal.related(s.id(), true));
	}

	/** A road or cell site as the API sees it (phase 4e). */
	public static SiteView infra(dev.larattalabs.architect.site.Infra i) {
		Site.Member m = i.member();
		dev.larattalabs.architect.api.Policy policy = i.road() || !"BOX".equals(i.spec().has("policy") ? i.spec().get("policy").getAsString() : "CELL")
			? dev.larattalabs.architect.api.Policy.CELL : dev.larattalabs.architect.api.Policy.BOX;
		return new SiteView(i.id(), i.kind(), i.owner(), i.ext(), box(i.box()), box(i.box()), Rotation.NONE, dimension(i.dimension()),
			i.placing() ? State.PLACING : State.BUILT, 0, 0, m == null ? null : m.group(), m == null ? null : m.batchId(), m == null ? null : m.itemKey(),
			i.kind(), policy, dev.larattalabs.architect.site.SiteJournal.coveredSites(i.id()), dev.larattalabs.architect.site.SiteJournal.related(i.id(), true));
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
			b.doneAt > 0 ? Optional.of(b.doneAt) : Optional.empty());
	}

	public static dev.larattalabs.architect.api.ItemEvent itemEvent(dev.larattalabs.architect.batch.QBatch b, dev.larattalabs.architect.batch.QItem i) {
		return new dev.larattalabs.architect.api.ItemEvent(b.id, i.key, i.ext.deepCopy(), Optional.ofNullable(i.siteId), reason(i.reason), i.message);
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

	public static dev.larattalabs.architect.api.SiteGroup group(dev.larattalabs.architect.site.SiteGroupRec g) {
		dev.larattalabs.architect.api.SiteGroup.State state = switch (g.state()) {
			case dev.larattalabs.architect.site.SiteGroupRec.REMOVING -> dev.larattalabs.architect.api.SiteGroup.State.REMOVING;
			case dev.larattalabs.architect.site.SiteGroupRec.REMOVED -> dev.larattalabs.architect.api.SiteGroup.State.REMOVED;
			default -> dev.larattalabs.architect.api.SiteGroup.State.ACTIVE;
		};
		return new dev.larattalabs.architect.api.SiteGroup(g.id(), g.owner(), g.ext(), g.sites(), g.stages().stream().map(Views::stage).toList(), state,
			g.crate() == null ? Optional.empty() : Optional.of(new BlockPos(g.crate().x(), g.crate().y(), g.crate().z())));
	}

	/** Item ids -> items (unknown ids dropped). */
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
			direction(bp.front()), anchorCells(bp), bp.groundY(), approach(bp));
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
}

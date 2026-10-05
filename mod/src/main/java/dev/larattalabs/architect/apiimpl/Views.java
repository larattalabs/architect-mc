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
		return new SiteView(s.id(), s.blueprint(), s.owner(), s.ext(), box(s.box()), box(s.restoreBox()), rotation(s.rotation()),
			dimension(s.dimension()), s.building() ? State.BUILDING : State.BUILT, p[0], p[1]);
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
			j.has("imported") && j.get("imported").isJsonPrimitive() && j.get("imported").getAsBoolean(), Optional.ofNullable(str(j, "variantOf")));
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

package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.journal.JournalStore;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.placement.Blueprints;
import dev.larattalabs.architect.site.Site;
import dev.larattalabs.architect.site.Sites;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Objects;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.NbtAccounter;
import net.minecraft.nbt.NbtIo;
import net.minecraft.nbt.NbtUtils;
import net.minecraft.world.Container;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.storage.LevelResource;

/**
 * Phase 6c slice PT2 DevBridge hooks (docs/DEVBRIDGE.md; CONTRACT PT2 §10): an adopted entry read back, its version compared with
 * the world cell by cell, the site's journal entries with their files' versions. Adoption itself goes through the public API
 * (apitest {@code adopt}). Pure server work: generated for the headless server too.
 */
public final class SlicePT2Dev {
	private SlicePT2Dev() {
	}

	static int[] ints(com.google.gson.JsonElement e) {
		JsonArray a = e.getAsJsonArray();
		int[] o = new int[a.size()];
		for (int i = 0; i < o.length; i++) {
			o[i] = a.get(i).getAsInt();
		}
		return o;
	}

	/** Whether a block-entity compound holds an inventory (the keys an adoption drops). */
	static int inventory(CompoundTag t) {
		int n = 0;
		for (String k : new String[] {"Items", "Item", "RecordItem", "Book"}) {
			if (t.get(k) instanceof ListTag l) {
				n += l.size();
			} else if (t.get(k) instanceof CompoundTag c && !c.isEmpty()) {
				n++;
			}
		}
		return n;
	}

	public static void init() {
		DevBridge.register("dev.pt2.entry", 30_000, "{entry} - (6c PT2) an entry read back: its blueprint JSON, folder, version folders, template cells, "
			+ "block entities and the inventories they hold", (req, mc) -> {
				String id = Fields.of(req).str("entry");
				return ServerTasks.callAsPlayer((level, bot) -> {
					JsonObject o = new JsonObject();
					Blueprints.Entry e = Blueprints.entry(id);
					o.addProperty("found", e != null);
					if (e == null) {
						return o;
					}
					o.add("json", e.json().deepCopy());
					o.addProperty("dir", e.dir() == null ? "" : e.dir().toString());
					o.addProperty("head", Blueprints.headVersion(e));
					o.addProperty("versionFolders", e.dir() == null ? 0 : dev.larattalabs.architect.library.EntryVersions.complete(e.dir()).size());
					CompoundTag t = e.template().save(new CompoundTag());
					ListTag blocks = t.getListOrEmpty("blocks");
					int be = 0;
					int inv = 0;
					for (int i = 0; i < blocks.size(); i++) {
						CompoundTag b = blocks.getCompoundOrEmpty(i);
						if (b.getCompound("nbt").isPresent()) {
							be++;
							inv += inventory(b.getCompound("nbt").get());
						}
					}
					o.addProperty("cells", blocks.size());
					o.addProperty("blockEntities", be);
					o.addProperty("inventoryItems", inv);
					o.addProperty("mjs", e.dir() == null ? false : Files.exists(e.dir().resolve(id + ".mjs")));
					return o;
				});
			});
		DevBridge.register("dev.pt2.compare", 60_000, "{site, version?: 1} - (6c PT2) a site's entry version against the world over its box (rotation "
			+ "none): matched and mismatched cells (state, block-entity data without inventories), the void cells, the world's containers and "
			+ "what the entry holds there", (req, mc) -> {
				Fields f = Fields.of(req);
				String sid = f.str("site");
				int ver = f.optInt("version", 1, 1, 1000);
				return ServerTasks.callAsPlayer((level, bot) -> {
					Site s = Sites.get(sid);
					JsonObject o = new JsonObject();
					if (s == null) {
						o.addProperty("found", false);
						return o;
					}
					Blueprints.Version v = Blueprints.version(level.getServer(), s.blueprint(), ver);
					if (v == null) {
						o.addProperty("found", false);
						return o;
					}
					o.addProperty("found", true);
					CompoundTag t = v.raw();
					ListTag pal = t.getListOrEmpty("palette");
					ListTag blocks = t.getListOrEmpty("blocks");
					int matched = 0;
					int mismatched = 0;
					JsonArray sample = new JsonArray();
					java.util.Set<Long> cells = new java.util.HashSet<>();
					JsonArray containers = new JsonArray();
					for (int i = 0; i < blocks.size(); i++) {
						CompoundTag b = blocks.getCompoundOrEmpty(i);
						ListTag pos = b.getListOrEmpty("pos");
						BlockPos p = new BlockPos(s.box().minX() + pos.getIntOr(0, 0), s.box().minY() + pos.getIntOr(1, 0), s.box().minZ() + pos.getIntOr(2, 0));
						cells.add(p.asLong());
						BlockState want = NbtUtils.readBlockState(BuiltInRegistries.BLOCK, pal.getCompoundOrEmpty(b.getIntOr("state", 0)));
						BlockState now = level.getBlockState(p);
						CompoundTag wn = b.getCompound("nbt").orElse(null);
						CompoundTag nn = dev.larattalabs.architect.site.Adopt.captured(WorldJournal.beNbt(level, p));
						boolean ok = want == now && Objects.equals(wn, nn);
						if (ok) {
							matched++;
						} else {
							mismatched++;
							if (sample.size() < 12) {
								sample.add(p.toShortString() + " want " + want + (wn == null ? "" : " " + wn) + " found " + now + (nn == null ? "" : " " + nn));
							}
						}
						BlockEntity e = level.getBlockEntity(p);
						if (e instanceof Container c && !c.isEmpty()) {
							JsonObject x = new JsonObject();
							x.addProperty("pos", p.toShortString());
							int items = 0;
							for (int k = 0; k < c.getContainerSize(); k++) {
								items += c.getItem(k).getCount();
							}
							x.addProperty("worldItems", items);
							x.addProperty("entryItems", wn == null ? 0 : inventory(wn));
							containers.add(x);
						}
					}
					var bx = s.box();
					long vol = (long) (bx.maxX() - bx.minX() + 1) * (bx.maxY() - bx.minY() + 1) * (bx.maxZ() - bx.minZ() + 1);
					o.addProperty("cells", blocks.size());
					o.addProperty("matched", matched);
					o.addProperty("mismatched", mismatched);
					o.add("sample", sample);
					o.addProperty("void", vol - cells.size());
					o.add("containers", containers);
					o.addProperty("box", bx.minX() + "," + bx.minY() + "," + bx.minZ() + "," + bx.maxX() + "," + bx.maxY() + "," + bx.maxZ());
					return o;
				});
			});
		DevBridge.register("dev.pt2.journal", 30_000, "{site} - (6c PT2) a site's journal entries (any status): id, kind, status, policy, cells, and "
			+ "the version of each of its files on disk", (req, mc) -> {
				String sid = Fields.of(req).str("site");
				return ServerTasks.callAsPlayer((level, bot) -> {
					JsonObject o = new JsonObject();
					JsonArray es = new JsonArray();
					JournalStore js = WorldJournal.storeOrNull();
					Path root = level.getServer().getWorldPath(LevelResource.ROOT).resolve("architect-journal").resolve("e");
					if (js != null) {
						for (JournalStore.Meta m : js.find(x -> x.site().equals(sid))) {
							JsonObject e = new JsonObject();
							e.addProperty("id", m.id());
							e.addProperty("kind", m.kind());
							e.addProperty("status", m.status().name());
							e.addProperty("policy", m.policy().name());
							e.addProperty("cells", m.cells());
							JsonArray vs = new JsonArray();
							Path d = root.resolve(m.id());
							if (Files.isDirectory(d)) {
								try (var files = Files.list(d)) {
									for (Path p : files.sorted().toList()) {
										if (!p.toString().endsWith(".nbt")) {
											continue;
										}
										CompoundTag t = NbtIo.readCompressed(p, NbtAccounter.unlimitedHeap());
										vs.add(p.getFileName() + "=" + t.getIntOr("version", 0));
									}
								} catch (java.io.IOException ex) {
									vs.add("error " + ex.getMessage());
								}
							}
							e.add("files", vs);
							es.add(e);
						}
					}
					o.add("entries", es);
					return o;
				});
			});
	}
}

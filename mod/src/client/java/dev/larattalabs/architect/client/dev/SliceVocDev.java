package dev.larattalabs.architect.client.dev;

import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.client.world.ServerTasks;
import java.io.InputStream;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.packs.resources.Resource;
import net.minecraft.tags.TagKey;
import net.minecraft.world.flag.FeatureFlags;
import net.minecraft.world.level.EmptyBlockGetter;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.FallingBlock;
import net.minecraft.world.level.block.FireBlock;
import net.minecraft.world.level.block.LiquidBlockContainer;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.level.material.FlowingFluid;
import net.minecraft.world.level.material.Fluids;

/**
 * Phase 6c slice VOC DevBridge hooks (docs/DEVBRIDGE.md; CONTRACT VOC §7, §8 items 2, 9, 10): the live registry dump the registry step
 * compares with kit/lib/blocks.mjs and the generator's digests, random ticks at named cells (the drift probe), and the fluid-interaction
 * probes of kit/vocab/hazards.json. Server work only (the headless server generates them too: devserver genHooks).
 */
public final class SliceVocDev {
	private SliceVocDev() {
	}

	/** The resource kinds whose vanilla-pack bytes are digested (gen-vocab.mjs's `digests`, kit/tools/vocab-scan.mjs). */
	static final String[] KINDS = { "recipe", "loot_table", "tags/block", "tags/item" };

	public static void init() {
		DevBridge.register("dev.vocab.registry", 300_000, "{file?: 'architect/vocab-registry.json'} - (6c VOC) the live registry: every block's id, property "
			+ "domains, default state, light per state, random ticking, item, falling, fluid-stopping, flammable, required features; the enabled "
			+ "features; the digests of the vanilla pack's recipes, loot tables and tags and of the loaded ones -> {file, sha256, blocks, other, "
			+ "features, digests, loaded} (the dump itself is the file)", (req, mc) -> {
				String f = req.has("file") ? req.get("file").getAsString() : "architect/vocab-registry.json";
				return ServerTasks.callOnServer(s -> {
					try {
						return registry(s, f);
					} catch (Exception e) {
						throw new DevBridge.DevException("vocab registry: " + e);
					}
				});
			});
		DevBridge.register("dev.vocab.tick", 60_000, "{cells: [[x,y,z]], n?: 1} - (6c VOC) n random ticks at each cell (vanilla's randomTick, only for a "
			+ "randomly ticking state) -> {cells: [{at, before, after, ticks}]}", (req, mc) -> {
				JsonArray cells = req.getAsJsonArray("cells");
				int n = req.has("n") ? req.get("n").getAsInt() : 1;
				return ServerTasks.callAsPlayer((level, player) -> {
					JsonArray out = new JsonArray();
					for (var c : cells) {
						JsonArray q = c.getAsJsonArray();
						BlockPos p = new BlockPos(q.get(0).getAsInt(), q.get(1).getAsInt(), q.get(2).getAsInt());
						JsonObject o = new JsonObject();
						o.add("at", q);
						o.addProperty("before", level.getBlockState(p).toString());
						int t = 0;
						for (int i = 0; i < n; i++) {
							BlockState st = level.getBlockState(p);
							if (!st.isRandomlyTicking()) {
								break;
							}
							st.randomTick(level, p, level.getRandom());
							t++;
						}
						o.addProperty("after", level.getBlockState(p).toString());
						o.addProperty("ticks", t);
						out.add(o);
					}
					JsonObject o = new JsonObject();
					o.add("cells", out);
					return o;
				});
			});
		DevBridge.register("dev.vocab.probe", 30_000, "{kind: concrete_powder|sponge|sponge_cap|magma|soul_sand|fire|soul_fire|lava, at: [x,y,z], "
			+ "phase: setup|read|both, d?: [dx,dy,dz] (fire, soul_fire, lava: where the flammable post is), n?: 8 (sponge: the trench length)} - "
			+ "(6c VOC) the kit/vocab/hazards.json rows in game: setup builds the case at `at` (a clear area, its own blocks only) and returns the "
			+ "cells it watches; read returns their states now -> {watch: [[x,y,z]], states: [state]}", (req, mc) -> {
				String kind = req.get("kind").getAsString();
				JsonArray a = req.getAsJsonArray("at");
				BlockPos at = new BlockPos(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt());
				String phase = req.has("phase") ? req.get("phase").getAsString() : "setup";
				// both: setup and read in one server task (the same tick: a sponge's drain before any water flows back)
				boolean setup = !"read".equals(phase);
				int[] d = { 0, 0, 0 };
				if (req.has("d")) {
					JsonArray q = req.getAsJsonArray("d");
					for (int i = 0; i < 3; i++) {
						d[i] = q.get(i).getAsInt();
					}
				}
				int n = req.has("n") ? req.get("n").getAsInt() : 8;
				return ServerTasks.callAsPlayer((level, player) -> {
					List<BlockPos> watch = probe(level, kind, at, d, n, setup);
					JsonObject o = new JsonObject();
					JsonArray w = new JsonArray();
					JsonArray st = new JsonArray();
					for (BlockPos p : watch) {
						JsonArray q = new JsonArray();
						q.add(p.getX());
						q.add(p.getY());
						q.add(p.getZ());
						w.add(q);
						st.add(stateString(level.getBlockState(p)));
					}
					o.add("watch", w);
					o.add("states", st);
					return o;
				});
			});
	}

	/** `minecraft:name[k=v,...]` (properties in the state's own order), as the kit writes states. */
	@SuppressWarnings({ "rawtypes", "unchecked" })
	static String stateString(BlockState s) {
		StringBuilder b = new StringBuilder(BuiltInRegistries.BLOCK.getKey(s.getBlock()).toString());
		List<String> ps = new ArrayList<>();
		for (Property p : s.getProperties()) {
			ps.add(p.getName() + "=" + p.getName(s.getValue(p)));
		}
		if (!ps.isEmpty()) {
			b.append('[').append(String.join(",", ps)).append(']');
		}
		return b.toString();
	}

	static void set(ServerLevel level, BlockPos p, BlockState s, int flags) {
		level.setBlock(p, s, flags);
	}

	/** Clears a box to air (no updates), floors it with stone. */
	static void clear(ServerLevel level, BlockPos at, int r, int below, int above) {
		for (int x = -r; x <= r; x++) {
			for (int z = -r; z <= r; z++) {
				for (int y = -below; y <= above; y++) {
					set(level, at.offset(x, y, z), y == -below ? Blocks.STONE.defaultBlockState() : Blocks.AIR.defaultBlockState(), 2);
				}
			}
		}
	}

	/** Builds (setup) or reads a probe; returns the cells it watches. */
	static List<BlockPos> probe(ServerLevel level, String kind, BlockPos at, int[] d, int n, boolean setup) {
		List<BlockPos> watch = new ArrayList<>();
		switch (kind) {
			case "concrete_powder" -> {
				// powder beside a water source (face): it sets; a second powder 2 away from the water: it doesn't
				BlockPos p = at, w = at.east(), far = at.east(3);
				watch.add(p);
				watch.add(far);
				if (setup) {
					clear(level, at, 4, 1, 3);
					for (int x = -1; x <= 4; x++) {
						for (int z = -1; z <= 1; z++) {
							set(level, at.offset(x, -1, z), Blocks.GLASS.defaultBlockState(), 2);
						}
					}
					set(level, p, BuiltInRegistries.BLOCK.getValue(Identifier.withDefaultNamespace("white_concrete_powder")).defaultBlockState(), 3);
					set(level, far, BuiltInRegistries.BLOCK.getValue(Identifier.withDefaultNamespace("white_concrete_powder")).defaultBlockState(), 3);
					// a glass pen keeps the water in one cell
					for (BlockPos q : new BlockPos[] { w.north(), w.south(), w.east(), w.below() }) {
						set(level, q, Blocks.GLASS.defaultBlockState(), 3);
					}
					set(level, w, Blocks.WATER.defaultBlockState(), 3);
				}
			}
			case "sponge", "sponge_cap" -> {
				// sponge: a sponge at the head of a 1-wide trench of n water sources along +x (the reach); sponge_cap: a pool of
				// 11 x 11 x 2 sources (242) beside the sponge (the count cap)
				boolean cap = kind.equals("sponge_cap");
				// sponge: the sponge at the head of a 1-wide trench of n water sources along +x (the reach); sponge_cap: the sponge in the
				// middle of an 11 x 7 x 11 pool of sources in a glass shell (more cells within its reach than it can take: the cap)
				if (setup) {
					clear(level, at, cap ? 7 : n + 2, cap ? 5 : 2, cap ? 5 : 3);
					if (!cap) {
						for (int x = 1; x <= n; x++) {
							for (BlockPos q : new BlockPos[] { at.offset(x, 0, -1), at.offset(x, 0, 1), at.offset(x, -1, 0) }) {
								set(level, q, Blocks.GLASS.defaultBlockState(), 2);
							}
							set(level, at.offset(x, 0, 0), Blocks.WATER.defaultBlockState(), 2);
						}
						set(level, at.offset(n + 1, 0, 0), Blocks.GLASS.defaultBlockState(), 2);
						set(level, at.below(), Blocks.GLASS.defaultBlockState(), 2);
					} else {
						for (int x = -6; x <= 6; x++) {
							for (int z = -6; z <= 6; z++) {
								for (int y = -4; y <= 4; y++) {
									boolean shell = Math.abs(x) == 6 || Math.abs(z) == 6 || Math.abs(y) == 4;
									set(level, at.offset(x, y, z), (shell ? Blocks.GLASS : Blocks.WATER).defaultBlockState(), 2);
								}
							}
						}
					}
					set(level, at, Blocks.SPONGE.defaultBlockState(), 3);
				}
				watch.add(at);
				if (!cap) {
					for (int x = 1; x <= n; x++) {
						watch.add(at.offset(x, 0, 0));
					}
				} else {
					for (int x = -5; x <= 5; x++) {
						for (int z = -5; z <= 5; z++) {
							for (int y = -3; y <= 3; y++) {
								if (x != 0 || y != 0 || z != 0) {
									watch.add(at.offset(x, y, z));
								}
							}
						}
					}
				}
			}
			case "magma", "soul_sand" -> {
				// the block with a water source directly above (and glass around the water): the bubble column
				BlockPos w = at.above();
				watch.add(at);
				watch.add(w);
				if (setup) {
					clear(level, at, 2, 1, 3);
					for (BlockPos q : new BlockPos[] { w.north(), w.south(), w.east(), w.west(), w.above().north(), w.above().south(), w.above().east(),
						w.above().west() }) {
						set(level, q, Blocks.GLASS.defaultBlockState(), 2);
					}
					set(level, at, (kind.equals("magma") ? Blocks.MAGMA_BLOCK : Blocks.SOUL_SAND).defaultBlockState(), 3);
					set(level, w, Blocks.WATER.defaultBlockState(), 3);
				}
			}
			case "fire", "soul_fire", "lava" -> {
				// a fire source on netherrack (fire, which then never burns out), on soul soil (soul_fire), or a lava source in a netherrack
				// basin, and one oak-planks post at `d` from it, floating (nothing else flammable near): does the post catch?
				BlockPos post = at.offset(d[0], d[1], d[2]);
				watch.add(at);
				watch.add(post);
				if (setup) {
					clear(level, at, 7, 4, 8);
					if (kind.equals("lava")) {
						for (BlockPos q : new BlockPos[] { at.below(), at.north(), at.south(), at.east(), at.west() }) {
							set(level, q, Blocks.NETHERRACK.defaultBlockState(), 2);
						}
						set(level, at, Blocks.LAVA.defaultBlockState(), 3);
					} else {
						set(level, at.below(), (kind.equals("fire") ? Blocks.NETHERRACK : Blocks.SOUL_SOIL).defaultBlockState(), 2);
						set(level, at, (kind.equals("fire") ? Blocks.FIRE : Blocks.SOUL_FIRE).defaultBlockState(), 3);
					}
					set(level, post, Blocks.OAK_PLANKS.defaultBlockState(), 3);
				}
			}
			default -> throw new DevBridge.DevException("unknown probe kind " + kind);
		}
		return watch;
	}

	static String sha(byte[] b) throws Exception {
		return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(b));
	}

	/** FlowingFluid.canHoldSpecificFluid(BlockGetter, BlockPos, BlockState, Fluid) by reflection (private static), as BlockDump reads it. */
	static Method canHold() {
		for (Method m : FlowingFluid.class.getDeclaredMethods()) {
			Class<?>[] p = m.getParameterTypes();
			if (m.getName().equals("canHoldSpecificFluid") && p.length == 4 && Modifier.isStatic(m.getModifiers())) {
				m.setAccessible(true);
				return m;
			}
		}
		return null;
	}

	static int odds(String name, BlockState s) {
		try {
			Method m = FireBlock.class.getDeclaredMethod(name, BlockState.class);
			m.setAccessible(true);
			return (Integer) m.invoke(Blocks.FIRE, s);
		} catch (Throwable t) {
			return -1;
		}
	}

	@SuppressWarnings({ "rawtypes", "unchecked" })
	static JsonObject registry(MinecraftServer s, String file) throws Exception {
		Method hold = canHold();
		var g = EmptyBlockGetter.INSTANCE;
		TagKey<Block> washed = TagKey.create(Registries.BLOCK, Identifier.withDefaultNamespace("washed_away_by_fluids"));
		JsonObject blocks = new JsonObject();
		JsonArray other = new JsonArray();
		TreeMap<String, Block> sorted = new TreeMap<>();
		for (Block b : BuiltInRegistries.BLOCK) {
			sorted.put(BuiltInRegistries.BLOCK.getKey(b).toString(), b);
		}
		for (var e : sorted.entrySet()) {
			String id = e.getKey();
			Block b = e.getValue();
			if (!id.startsWith("minecraft:")) {
				other.add(id);
				continue;
			}
			JsonObject o = new JsonObject();
			JsonObject props = new JsonObject();
			BlockState d = b.defaultBlockState();
			JsonObject def = new JsonObject();
			for (Property p : d.getProperties()) {
				JsonArray v = new JsonArray();
				for (Object x : p.getPossibleValues()) {
					v.add(p.getName((Comparable) x));
				}
				props.add(p.getName(), v);
				def.addProperty(p.getName(), p.getName(d.getValue(p)));
			}
			o.add("props", props);
			o.add("defaults", def);
			JsonArray light = new JsonArray();
			for (BlockState st : b.getStateDefinition().getPossibleStates()) {
				if (st.getLightEmission() > 0) {
					JsonArray l = new JsonArray();
					l.add(stateString(st));
					l.add(st.getLightEmission());
					light.add(l);
				}
			}
			o.add("light", light);
			o.addProperty("rt", d.isRandomlyTicking());
			o.addProperty("item", BuiltInRegistries.ITEM.getKey(b.asItem()).toString());
			o.addProperty("g", b instanceof FallingBlock);
			boolean container = b instanceof LiquidBlockContainer;
			boolean holdsAny = container || d.is(washed);
			boolean holdsW, holdsL;
			try {
				holdsW = (Boolean) hold.invoke(null, g, BlockPos.ZERO, d, Fluids.FLOWING_WATER);
				holdsL = (Boolean) hold.invoke(null, g, BlockPos.ZERO, d, Fluids.FLOWING_LAVA);
			} catch (Throwable t) {
				holdsW = true;
				holdsL = true;
			}
			o.addProperty("fs", !(holdsAny && holdsW) && !(holdsAny && holdsL));
			o.addProperty("fl", d.ignitedByLava() || odds("getIgniteOdds", d) > 0);
			JsonArray ff = new JsonArray();
			TreeSet<String> fs = new TreeSet<>();
			for (var x : FeatureFlags.REGISTRY.toNames(b.requiredFeatures())) {
				fs.add(x.toString());
			}
			fs.remove("minecraft:vanilla");
			fs.forEach(ff::add);
			o.add("ff", ff);
			blocks.add(id, o);
		}
		JsonArray features = new JsonArray();
		new TreeSet<>(FeatureFlags.REGISTRY.toNames(s.getWorldData().enabledFeatures()).stream().map(Object::toString).toList()).forEach(features::add);
		// the vanilla pack's resource bytes, per kind (the server's resource manager, the pack the bytes came from: "vanilla")
		JsonObject digests = new JsonObject();
		var rm = s.getResourceManager();
		for (String k : KINDS) {
			TreeMap<String, String> lines = new TreeMap<>();
			for (Map.Entry<Identifier, List<Resource>> e : rm.listResourceStacks(k, id -> id.getPath().endsWith(".json")).entrySet()) {
				if (!e.getKey().getNamespace().equals("minecraft")) {
					continue;
				}
				for (Resource r : e.getValue()) {
					if (!"vanilla".equals(r.sourcePackId())) {
						continue;
					}
					try (InputStream in = r.open()) {
						lines.put(e.getKey().getPath(), sha(in.readAllBytes()));
					}
				}
			}
			StringBuilder b = new StringBuilder();
			for (var e : lines.entrySet()) {
				if (b.length() > 0) {
					b.append('\n');
				}
				b.append(e.getKey()).append(' ').append(e.getValue());
			}
			JsonObject o = new JsonObject();
			o.addProperty("files", lines.size());
			o.addProperty("sha256", sha(b.toString().getBytes(StandardCharsets.UTF_8)));
			digests.add(k, o);
		}
		// the loaded block tags, resolved (minecraft tags, minecraft members: Architect's crate and other mods' blocks left out)
		TreeMap<String, String> tagLines = new TreeMap<>();
		BuiltInRegistries.BLOCK.getTags().forEach(named -> {
			Identifier tid = named.key().location();
			if (!tid.getNamespace().equals("minecraft")) {
				return;
			}
			TreeSet<String> m = new TreeSet<>();
			named.forEach(h -> {
				String bid = BuiltInRegistries.BLOCK.getKey(h.value()).toString();
				if (bid.startsWith("minecraft:")) {
					m.add(bid);
				}
			});
			tagLines.put(tid.toString(), String.join(" ", m));
		});
		StringBuilder tb = new StringBuilder();
		for (var e : tagLines.entrySet()) {
			if (tb.length() > 0) {
				tb.append('\n');
			}
			tb.append(e.getKey()).append(' ').append(e.getValue());
		}
		JsonObject bt = new JsonObject();
		bt.addProperty("tags", tagLines.size());
		bt.addProperty("sha256", sha(tb.toString().getBytes(StandardCharsets.UTF_8)));
		digests.add("blockTagsResolved", bt);
		// the loaded recipes and loot tables (minecraft ids): what the server parsed, not only the files
		JsonObject loaded = new JsonObject();
		TreeSet<String> rids = new TreeSet<>();
		for (var h : s.getRecipeManager().getRecipes()) {
			Identifier id = h.id().identifier();
			if (id.getNamespace().equals("minecraft")) {
				rids.add(id.toString());
			}
		}
		TreeSet<String> lids = new TreeSet<>();
		s.reloadableRegistries().lookup().lookupOrThrow(Registries.LOOT_TABLE).listElementIds().forEach(k -> {
			Identifier id = k.identifier();
			if (id.getNamespace().equals("minecraft")) {
				lids.add(id.toString());
			}
		});
		for (var e : Map.of("recipes", rids, "lootTables", lids).entrySet()) {
			JsonObject o = new JsonObject();
			o.addProperty("count", e.getValue().size());
			o.addProperty("sha256", sha(String.join("\n", e.getValue()).getBytes(StandardCharsets.UTF_8)));
			loaded.add(e.getKey(), o);
		}
		JsonObject dump = new JsonObject();
		dump.add("blocks", blocks);
		dump.add("other", other);
		dump.add("features", features);
		dump.add("digests", digests);
		dump.add("loaded", loaded);
		byte[] text = new GsonBuilder().disableHtmlEscaping().create().toJson(dump).getBytes(StandardCharsets.UTF_8);
		Path out = Path.of(file);
		if (!out.isAbsolute()) {
			out = FabricLoader.getInstance().getGameDir().resolve(out);
		}
		Files.createDirectories(out.getParent());
		Files.write(out, text);
		JsonObject r = new JsonObject();
		r.addProperty("file", out.toAbsolutePath().toString());
		r.addProperty("sha256", sha(text));
		r.addProperty("blocks", blocks.size());
		r.add("other", other);
		r.add("features", features);
		r.add("digests", digests);
		r.add("loaded", loaded);
		return r;
	}
}

package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mojang.authlib.GameProfile;
import dev.larattalabs.architect.api.ArchitectRefused;
import dev.larattalabs.architect.api.Build;
import dev.larattalabs.architect.api.BuildHit;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.placed.BuildViews;
import dev.larattalabs.architect.placed.Builds;
import dev.larattalabs.architect.placed.Placed;
import dev.larattalabs.architect.placed.PlacedChunk;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Locale;
import java.util.UUID;
import net.fabricmc.fabric.api.entity.FakePlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.NbtIo;
import net.minecraft.resources.Identifier;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

/**
 * Phase 6c slice PT DevBridge hooks (docs/DEVBRIDGE.md; CONTRACT PT §11): a fake player's item use through
 * {@code ServerPlayerGameMode.useItemOn} / {@code useItem} (never {@code setBlock}, which would skip the recording hook), breaks
 * through {@code destroyBlock}, the set and the index read back, the classifier driven, the cost numbers. Pure server work:
 * generated for the headless server too.
 */
public final class SlicePTDev {
	private SlicePTDev() {
	}

	/** A named fake player (its UUID is the offline one for the name, so a placer is stable across runs). */
	static ServerPlayer fake(ServerLevel level, ServerPlayer bot, String who) {
		if (who == null || who.isEmpty() || "bot".equals(who)) {
			return bot;
		}
		UUID u = UUID.nameUUIDFromBytes(("OfflinePlayer:" + who).getBytes(StandardCharsets.UTF_8));
		return FakePlayer.get(level, new GameProfile(u, who));
	}

	static int[] ints(JsonElement e) {
		JsonArray a = e.getAsJsonArray();
		int[] o = new int[a.size()];
		for (int i = 0; i < o.length; i++) {
			o[i] = a.get(i).getAsInt();
		}
		return o;
	}

	static JsonObject rec(ServerLevel level, BlockPos p) {
		JsonObject o = new JsonObject();
		Placed.Rec r = Placed.record(level, p);
		o.addProperty("tracked", r != null);
		if (r != null) {
			o.addProperty("placer", r.placer().toString());
			if (r.build() != null) {
				o.addProperty("build", r.build());
			}
		}
		return o;
	}

	/** One use: {item, at, on?, face?, use?: on|item, placer?, yaw?, pitch?}. */
	static JsonObject use(ServerLevel level, ServerPlayer bot, JsonObject op) {
		Fields f = Fields.of(op);
		String item = f.nonBlank("item");
		int[] at = ints(op.get("at"));
		BlockPos target = new BlockPos(at[0], at[1], at[2]);
		BlockPos on = op.has("on") ? new BlockPos(ints(op.get("on"))[0], ints(op.get("on"))[1], ints(op.get("on"))[2]) : target;
		Direction face = Direction.byName(f.optStr("face", "up"));
		ServerPlayer p = fake(level, bot, f.optStr("placer", "PTPlacer"));
		ItemStack stack = new ItemStack(BuiltInRegistries.ITEM.getValue(Identifier.parse(item)), 64);
		float yaw = (float) f.optNum("yaw", 0, -360, 360);
		float pitch = (float) f.optNum("pitch", "item".equals(f.optStr("use", "on")) ? 90 : 0, -90, 90);
		// stand over the target, looking at it (a bucket's raycast and the facing of doors and beds follow the look)
		if (p != bot) {
			p.absSnapTo(target.getX() + 0.5, target.getY() + ("item".equals(f.optStr("use", "on")) ? 2.2 : 1.0), target.getZ() + 0.5 - ("item".equals(f.optStr(
				"use", "on")) ? 0 : 2.5), yaw, pitch);
		}
		p.setItemInHand(InteractionHand.MAIN_HAND, stack);
		InteractionResult r;
		if ("item".equals(f.optStr("use", "on"))) {
			r = p.gameMode.useItem(p, level, stack, InteractionHand.MAIN_HAND);
		} else {
			BlockHitResult hit = new BlockHitResult(Vec3.atCenterOf(on).relative(face, 0.5), face, on, false);
			r = p.gameMode.useItemOn(p, level, stack, InteractionHand.MAIN_HAND, hit);
		}
		JsonObject o = rec(level, target);
		o.addProperty("result", r.getClass().getSimpleName());
		BlockState s = level.getBlockState(target);
		o.addProperty("state", BuiltInRegistries.BLOCK.getKey(s.getBlock()).toString());
		o.addProperty("placerUuid", p.getUUID().toString());
		return o;
	}

	static JsonObject cells(ServerLevel level, int[] b, boolean list) throws Exception {
		MessageDigest md = MessageDigest.getInstance("SHA-256");
		JsonArray out = new JsonArray();
		int n = 0;
		int incidental = 0;
		for (int cx = b[0] >> 4; cx <= b[3] >> 4; cx++) {
			for (int cz = b[2] >> 4; cz <= b[5] >> 4; cz++) {
				LevelChunk c = level.getChunkSource().getChunkNow(cx, cz);
				if (c == null) {
					continue;
				}
				for (int y = b[1]; y <= b[4]; y++) {
					for (int z = Math.max(b[2], cz << 4); z <= Math.min(b[5], (cz << 4) + 15); z++) {
						for (int x = Math.max(b[0], cx << 4); x <= Math.min(b[3], (cx << 4) + 15); x++) {
							Placed.Rec r = Placed.record(c, x, y, z);
							if (r == null) {
								continue;
							}
							n++;
							String kept = Placed.build(level, c, x, y, z);
							if (kept == null) {
								incidental++;
							}
							String line = x + "," + y + "," + z + "=" + r.placer() + "/" + (r.build() == null ? "-" : r.build());
							md.update(line.getBytes(StandardCharsets.UTF_8));
							if (list && out.size() < 20_000) {
								JsonArray a = new JsonArray();
								a.add(x);
								a.add(y);
								a.add(z);
								a.add(r.placer().toString());
								a.add(r.build());
								a.add(kept);
								out.add(a);
							}
						}
					}
				}
			}
		}
		JsonObject o = new JsonObject();
		o.addProperty("tracked", n);
		o.addProperty("incidental", incidental);
		o.addProperty("sha256", HexFormat.of().formatHex(md.digest()));
		if (list) {
			o.add("cells", out);
		}
		return o;
	}

	static JsonObject build(Build b) {
		JsonObject o = new JsonObject();
		o.addProperty("buildId", b.id()); // never "id": a top-level answer's "id" is the request's (DevBridge routes answers by it)
		o.addProperty("dimension", b.dimension().identifier().toString());
		JsonArray bb = new JsonArray();
		bb.add(b.bounds().minX());
		bb.add(b.bounds().minY());
		bb.add(b.bounds().minZ());
		bb.add(b.bounds().maxX());
		bb.add(b.bounds().maxY());
		bb.add(b.bounds().maxZ());
		o.add("bounds", bb);
		o.addProperty("kind", b.kind().name());
		o.addProperty("confidence", b.confidence());
		o.addProperty("cells", b.cells());
		o.addProperty("state", b.state().name());
		o.addProperty("revision", b.revision());
		JsonObject pl = new JsonObject();
		b.placers().forEach((u, n) -> pl.addProperty(u.toString(), n));
		o.add("placers", pl);
		JsonArray en = new JsonArray();
		for (var e : b.entrances()) {
			JsonObject x = new JsonObject();
			x.addProperty("pos", e.pos().getX() + " " + e.pos().getY() + " " + e.pos().getZ());
			x.addProperty("facing", e.facing().getSerializedName());
			x.addProperty("block", e.blockId());
			en.add(x);
		}
		o.add("entrances", en);
		JsonArray fp = new JsonArray();
		for (int v : b.footprint()) {
			fp.add(v);
		}
		o.add("footprint", fp);
		return o;
	}

	static JsonArray hits(java.util.List<BuildHit> hs) {
		JsonArray a = new JsonArray();
		for (BuildHit h : hs) {
			JsonObject o = new JsonObject();
			o.addProperty("buildId", h.buildId());
			o.addProperty("kind", h.kind().name());
			o.addProperty("blocking", h.blocking());
			JsonArray f = new JsonArray();
			for (var c : h.first()) {
				f.add(c.pos().getX() + " " + c.pos().getY() + " " + c.pos().getZ() + " " + c.blockId());
			}
			o.add("first", f);
			a.add(o);
		}
		return a;
	}

	static JsonObject refused(Throwable e) {
		Throwable c = e instanceof java.util.concurrent.CompletionException && e.getCause() != null ? e.getCause() : e;
		JsonObject o = new JsonObject();
		if (c instanceof ArchitectRefused r) {
			o.addProperty("reason", r.reason().name());
			o.addProperty("refused", r.reason() + ": " + r.getMessage());
			o.add("builds", hits(r.builds()));
		} else {
			o.addProperty("refused", String.valueOf(c));
		}
		return o;
	}

	public static void init() {
		DevBridge.register("dev.pt.uses", 600_000, "{ops: [{item, at: [x,y,z], on?: [x,y,z], face?: up, use?: on|item, placer?: <name>|bot, yaw?, pitch?}]}"
			+ " - (6c PT) item uses through ServerPlayerGameMode.useItemOn/useItem of a named fake player (or the bot) -> {results: [{tracked, placer, "
			+ "build, state, result}]}", (req, mc) -> {
				JsonArray ops = req.getAsJsonArray("ops");
				return ServerTasks.callAsPlayer((level, bot) -> {
					JsonArray res = new JsonArray();
					for (JsonElement e : ops) {
						res.add(use(level, bot, e.getAsJsonObject()));
					}
					JsonObject o = new JsonObject();
					o.add("results", res);
					return o;
				});
			});
		DevBridge.register("dev.pt.breaks", 600_000, "{at: [[x,y,z]...], placer?} - (6c PT) breaks through ServerPlayerGameMode.destroyBlock -> {broken}",
			(req, mc) -> {
				JsonArray at = req.getAsJsonArray("at");
				String who = Fields.of(req).optStr("placer", "PTBreaker");
				return ServerTasks.callAsPlayer((level, bot) -> {
					ServerPlayer p = fake(level, bot, who);
					int n = 0;
					for (JsonElement e : at) {
						int[] a = ints(e);
						n += p.gameMode.destroyBlock(new BlockPos(a[0], a[1], a[2])) ? 1 : 0;
					}
					JsonObject o = new JsonObject();
					o.addProperty("broken", n);
					return o;
				});
			});
		DevBridge.register("dev.pt.cells", 120_000, "{box: [x0,y0,z0,x1,y1,z1], list?: false} - (6c PT) the tracked cells of a box: count, incidental, sha256 "
			+ "over (pos, placer, build), the list", (req, mc) -> {
				int[] b = ints(req.get("box"));
				boolean list = Fields.of(req).optBool("list", false);
				return ServerTasks.callAsPlayer((level, bot) -> {
					try {
						return cells(level, b, list);
					} catch (Exception e) {
						throw new RuntimeException(e);
					}
				});
			});
		DevBridge.register("dev.pt.keptHash", 120_000, "{box} - (6c PT) SHA-256 over the kept build cells of a box: position, block state and record "
			+ "(a lost or changed build cell changes it) -> {cells, sha256}", (req, mc) -> {
				int[] b = ints(req.get("box"));
				return ServerTasks.callAsPlayer((level, bot) -> {
					try {
						MessageDigest md = MessageDigest.getInstance("SHA-256");
						int n = 0;
						for (int y = b[1]; y <= b[4]; y++) {
							for (int z = b[2]; z <= b[5]; z++) {
								for (int x = b[0]; x <= b[3]; x++) {
									BlockPos p = new BlockPos(x, y, z);
									String k = Placed.build(level, null, p);
									if (k == null) {
										continue;
									}
									n++;
									Placed.Rec r = Placed.record(level, p);
									md.update((x + "," + y + "," + z + "=" + level.getBlockState(p) + "/" + r.placer() + "/" + k).getBytes(StandardCharsets.UTF_8));
								}
							}
						}
						JsonObject o = new JsonObject();
						o.addProperty("cells", n);
						o.addProperty("sha256", HexFormat.of().formatHex(md.digest()));
						return o;
					} catch (Exception e) {
						throw new RuntimeException(e);
					}
				});
			});
		DevBridge.register("dev.pt.at", 10_000, "{at: [x,y,z]} - (6c PT) one cell's record (placer, build, kept build)", (req, mc) -> {
			int[] a = ints(req.get("at"));
			return ServerTasks.callAsPlayer((level, bot) -> {
				BlockPos p = new BlockPos(a[0], a[1], a[2]);
				JsonObject o = rec(level, p);
				String k = Placed.build(level, null, p);
				if (k != null) {
					o.addProperty("kept", k);
				}
				o.addProperty("state", BuiltInRegistries.BLOCK.getKey(level.getBlockState(p).getBlock()).toString());
				return o;
			});
		});
		DevBridge.register("dev.pt.builds", 60_000, "{box?: [x0,y0,z0,x1,y1,z1], drain?: true} - (6c PT) the builds (Sites.builds), after the classifier "
			+ "ran everything due (drain: ignoring the debounce) -> {builds: [...], pending}", (req, mc) -> {
				Fields f = Fields.of(req);
				boolean drain = f.optBool("drain", false);
				int[] b = req.has("box") ? ints(req.get("box")) : null;
				return ServerTasks.callAsPlayer((level, bot) -> {
					if (drain) {
						Builds.drain(level.getServer(), true);
					}
					JsonArray a = new JsonArray();
					for (Build x : BuildViews.builds(level.dimension(), b == null ? null : new BoundingBox(b[0], b[1], b[2], b[3], b[4], b[5]))) {
						JsonObject j = build(x);
						j.addProperty("id", x.id()); // in a list: no clash with the request id
						a.add(j);
					}
					JsonObject o = new JsonObject();
					o.add("builds", a);
					o.addProperty("pending", Builds.pending());
					o.addProperty("pendingNow", Builds.pendingNow());
					return o;
				});
			});
		DevBridge.register("dev.pt.build", 10_000, "{build} - (6c PT) one build (Sites.build: an alias resolves to its survivor) -> {found, buildId, ...}", (req, mc) -> {
			String id = Fields.of(req).nonBlank("build");
			return ServerTasks.callAsPlayer((level, bot) -> {
				var b = BuildViews.build(id);
				JsonObject o = b.isPresent() ? build(b.get()) : new JsonObject();
				o.addProperty("found", b.isPresent());
				return o;
			});
		});
		DevBridge.register("dev.pt.box", 60_000, "{box} - (6c PT) Sites.playerPlaced(dim, box): tracked, incidental, byPlacer, builds", (req, mc) -> {
			int[] b = ints(req.get("box"));
			return ServerTasks.callAsPlayer((level, bot) -> {
				var pb = BuildViews.box(level, new BoundingBox(b[0], b[1], b[2], b[3], b[4], b[5]));
				JsonObject o = new JsonObject();
				o.addProperty("tracked", pb.tracked());
				o.addProperty("incidental", pb.incidental());
				JsonObject by = new JsonObject();
				pb.byPlacer().forEach((u, n) -> by.addProperty(u.toString(), n));
				o.add("byPlacer", by);
				o.add("builds", hits(pb.builds()));
				return o;
			});
		});
		DevBridge.register("dev.pt.claim", 120_000, "{box, actor?: bot|console|<fake name>} - (6c PT) Sites.claimBuild (the console: the command's path)",
			(req, mc) -> {
				int[] b = ints(req.get("box"));
				String actor = Fields.of(req).optStr("actor", "bot");
				return ServerTasks.callAsPlayer((level, bot) -> {
					try {
						Build x = BuildViews.claim(level, new BoundingBox(b[0], b[1], b[2], b[3], b[4], b[5]), "console".equals(actor) ? null : fake(level, bot, actor),
							"console".equals(actor));
						return build(x);
					} catch (RuntimeException e) {
						return refused(e);
					}
				});
			});
		DevBridge.register("dev.pt.release", 30_000, "{build, actor?: bot|console|<fake name>} - (6c PT) Sites.releaseBuild -> {buildId, state, ...}", (req, mc) -> {
			String id = Fields.of(req).nonBlank("build");
			String actor = Fields.of(req).optStr("actor", "bot");
			return ServerTasks.callAsPlayer((level, bot) -> {
				try {
					return build(BuildViews.release(id, "console".equals(actor) ? null : fake(level, bot, actor), "console".equals(actor)));
				} catch (RuntimeException e) {
					return refused(e);
				}
			});
		});
		DevBridge.register("dev.pt.uuid", 10_000, "{name} - (6c PT) a fake placer's UUID", (req, mc) -> {
			String n = Fields.of(req).nonBlank("name");
			JsonObject o = new JsonObject();
			o.addProperty("uuid", ("bot".equals(n) ? "" : UUID.nameUUIDFromBytes(("OfflinePlayer:" + n).getBytes(StandardCharsets.UTF_8)).toString()));
			return java.util.concurrent.CompletableFuture.completedFuture(o);
		});
		DevBridge.register("dev.pt.rule", 10_000, "{name?, value?} - (6c PT) the world rules (architect.playerTracking, promote, ...)", (req, mc) -> {
			Fields f = Fields.of(req);
			String name = f.optStr("name", "");
			String value = f.optStr("value", "");
			return ServerTasks.callAsPlayer((level, bot) -> {
				try {
					Builds.Rules r = Builds.rules();
					if (!name.isEmpty()) {
						var fld = Builds.Rules.class.getField(name);
						if (!value.isEmpty()) {
							if (fld.getType() == boolean.class) {
								fld.setBoolean(r, Boolean.parseBoolean(value));
							} else if (fld.getType() == int.class) {
								fld.setInt(r, Integer.parseInt(value));
							} else {
								fld.setLong(r, Long.parseLong(value));
							}
							Builds.applyRules();
						}
					}
					JsonObject o = new JsonObject();
					o.addProperty("on", Placed.on());
					o.addProperty("rules", com.google.gson.JsonParser.parseString(new com.google.gson.Gson().toJson(r)).toString());
					return o;
				} catch (ReflectiveOperationException e) {
					throw new RuntimeException(e);
				}
			});
		});
		DevBridge.register("dev.pt.stats", 600_000, "{box?, bench?: 0, reset?: false} - (6c PT §11 item 15, recorded) the set's cost: chunks with a set, tracked cells, "
			+ "NBT bytes (the attachment, uncompressed and gzip), heap bytes, sections; the classifier's own CPU per tick max; with bench n the hook's "
			+ "added ns per call (median of 20 rounds of n/20, a tracked and an untracked chunk)", (req, mc) -> {
				Fields f = Fields.of(req);
				int bench = f.optInt("bench", 0, 0, 10_000_000);
				boolean reset = f.optBool("reset", false);
				int[] b = req.has("box") ? ints(req.get("box")) : null;
				return ServerTasks.callAsPlayer((level, bot) -> {
					try {
						JsonObject o = stats(level, b, bench);
						if (reset) {
							Builds.resetMax(); // the classifier's maxima start again (after a warm-up)
						}
						return o;
					} catch (Exception e) {
						throw new RuntimeException(e);
					}
				});
			});
		DevBridge.register("dev.pt.expecting", 10_000, "{} - (6c PT) open tracking scopes and pending classifier work", (req, mc) -> ServerTasks.callAsPlayer(
			(level, bot) -> {
				JsonObject o = new JsonObject();
				o.addProperty("pending", Builds.pending());
				o.addProperty("pendingNow", Builds.pendingNow());
				o.addProperty("maxTickNs", Builds.maxTickNs());
				return o;
			}));
	}

	static JsonObject stats(ServerLevel level, int[] b, int bench) throws Exception {
		JsonObject o = new JsonObject();
		int chunks = 0;
		long tracked = 0;
		long raw = 0;
		long gz = 0;
		long heap = 0;
		int sections = 0;
		if (b != null) {
			for (int cx = b[0] >> 4; cx <= b[3] >> 4; cx++) {
				for (int cz = b[2] >> 4; cz <= b[5] >> 4; cz++) {
					LevelChunk c = level.getChunkSource().getChunkNow(cx, cz);
					PlacedChunk pc = c == null ? null : c.getAttached(Placed.TYPE);
					if (pc == null) {
						continue;
					}
					chunks++;
					tracked += pc.size();
					sections += pc.sectionYs().length;
					heap += pc.heapBytes();
					var tag = pc.write();
					java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
					NbtIo.write(tag, new java.io.DataOutputStream(bo));
					raw += bo.size();
					java.io.ByteArrayOutputStream go = new java.io.ByteArrayOutputStream();
					NbtIo.writeCompressed(tag, go);
					gz += go.size();
				}
			}
		}
		o.addProperty("chunks", chunks);
		o.addProperty("tracked", tracked);
		o.addProperty("sections", sections);
		o.addProperty("nbtBytes", raw);
		o.addProperty("nbtGzipBytes", gz);
		o.addProperty("heapBytes", heap);
		o.addProperty("bytesPerBlock", tracked == 0 ? 0 : (double) raw / tracked);
		o.addProperty("bytesPerSection", sections == 0 ? 0 : (double) raw / sections);
		o.addProperty("heapPerBlock", tracked == 0 ? 0 : (double) heap / tracked);
		o.addProperty("classifierMaxTickNs", Builds.maxTickNs());
		JsonObject ph = new JsonObject();
		Builds.phaseMax().forEach(ph::addProperty);
		o.add("classifierPhaseMaxNs", ph);
		if (bench > 0) {
			o.add("hookNs", bench(level, b, bench));
		}
		return o;
	}

	/**
	 * The hook's added cost: {@code Placed.changed} on a block-to-block change (the common case: no record moves) in a chunk with a
	 * set and one without, n calls each, median of 20 rounds (ns per call).
	 */
	static JsonObject bench(ServerLevel level, int[] b, int n) {
		JsonObject o = new JsonObject();
		LevelChunk tracked = null;
		BlockPos tp = null;
		if (b != null) {
			for (int cx = b[0] >> 4; cx <= b[3] >> 4 && tracked == null; cx++) {
				for (int cz = b[2] >> 4; cz <= b[5] >> 4 && tracked == null; cz++) {
					LevelChunk c = level.getChunkSource().getChunkNow(cx, cz);
					if (c != null && c.getAttached(Placed.TYPE) != null) {
						tracked = c;
						tp = new BlockPos((cx << 4) + 8, b[1], (cz << 4) + 8);
					}
				}
			}
		}
		LevelChunk plain = null;
		BlockPos pp = null;
		int ox = b == null ? 0 : b[0] >> 4;
		int oz = b == null ? 0 : b[2] >> 4;
		for (int r = 1; r <= 8 && plain == null; r++) {
			for (int cx = ox - r; cx <= ox + r && plain == null; cx++) {
				for (int cz = oz - r; cz <= oz + r && plain == null; cz++) {
					LevelChunk c = level.getChunkSource().getChunkNow(cx, cz);
					if (c != null && c.getAttached(Placed.TYPE) == null) {
						plain = c;
						pp = new BlockPos((cx << 4) + 8, 70, (cz << 4) + 8);
					}
				}
			}
		}
		BlockState a = net.minecraft.world.level.block.Blocks.STONE.defaultBlockState();
		BlockState c2 = net.minecraft.world.level.block.Blocks.GRANITE.defaultBlockState();
		if (tracked != null) {
			o.addProperty("tracked", median(tracked, tp, a, c2, n));
		}
		if (plain != null) {
			o.addProperty("untracked", median(plain, pp, a, c2, n));
		}
		// the baseline: an empty call of the same shape (the JIT's loop cost)
		o.addProperty("baselineNote", "ns per Placed.changed call on a block-to-block change (no record moves); the baseline loop is subtracted");
		return o;
	}

	static double median(LevelChunk c, BlockPos p, BlockState a, BlockState b, int n) {
		int rounds = 20;
		int per = Math.max(1, n / rounds);
		double[] r = new double[rounds];
		for (int k = 0; k < rounds; k++) {
			long t0 = System.nanoTime();
			for (int i = 0; i < per; i++) {
				Placed.changed(c, p, (i & 1) == 0 ? a : b, (i & 1) == 0 ? b : a);
			}
			long t1 = System.nanoTime();
			for (int i = 0; i < per; i++) {
				blackhole ^= ((i & 1) == 0 ? a : b).hashCode();
			}
			long t2 = System.nanoTime();
			r[k] = Math.max(0, (double) (t1 - t0) - (t2 - t1)) / per;
		}
		java.util.Arrays.sort(r);
		return Math.round(r[rounds / 2] * 10) / 10.0;
	}

	static volatile int blackhole;

	static String lower(String s) {
		return s.toLowerCase(Locale.ROOT);
	}
}

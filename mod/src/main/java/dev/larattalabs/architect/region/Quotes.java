package dev.larattalabs.architect.region;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.PlanArtifact;
import dev.larattalabs.architect.api.Quote;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.batch.QItem;
import dev.larattalabs.architect.placement.Blueprint;
import dev.larattalabs.architect.placement.Blueprints;
import dev.larattalabs.architect.site.EntranceStyle;
import dev.larattalabs.architect.site.SiteFit;
import dev.larattalabs.architect.site.Sites;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;
import java.util.concurrent.CompletableFuture;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Rotation;
import org.jspecify.annotations.Nullable;

/**
 * (M5 QT, docs/CONTRACT.md "M5 support", Steward's S-M5-7) {@link dev.larattalabs.architect.api.Regions#quote} and
 * {@link dev.larattalabs.architect.api.Regions#quoteApproved}: what a survival realise of a plan takes from its owner's stockpile, read
 * without writing. Each piece mirrors the path that charges it:
 * <ul>
 * <li>the region's paid cells: the kit's per-group bill over the plan survey ({@code planned.survivalBom}, the plan check's own cells
 * bill), which RegionTargets' runs pay cell by cell;
 * <li>each bound lot: {@link RegionsImpl#lotItemOf} (the realise's own fit, LotMask and site binding), then the put-down's dry-run
 * verdict (Batches: construction, LAYER, the region's entrance style, no protected-area check; a site lot under {@link SiteFit#with}), then
 * {@link Sites#quoteBill} (C26's full bill less the masked cells), with the plan's own 4e roads standing ({@link Sites#QUOTE_ROADS});
 * <li>each 4e road: checkRoad over the land now and {@code RoadBuilder.bom} (the plan check's call);
 * <li>a first realise's gate mechanisms (MechCharges charges them whole; a revision queues none);
 * <li>the fluids' charge: once per region ({@code survival.chargedAt}), so a revision of a region charged already has none.
 * </ul>
 * Nothing here writes: no journal, record, plan, artifact, pin, retention touch or world change; no chunk is loaded (the plan cache may
 * read a plan file into memory, as every reader does). Server thread.
 */
public final class Quotes {
	private Quotes() {
	}

	/** {@link dev.larattalabs.architect.api.Regions#quote}. */
	static CompletableFuture<Quote> quote(String planId, Map<String, String> lotEntries) {
		MinecraftServer s = RegionsImpl.server();
		if (s == null) {
			return CompletableFuture.failedFuture(RegionsImpl.refusal(Reason.NOT_LOADED, "no world"));
		}
		return onServer(s, () -> {
			RegionsImpl.PlanRec p = planId == null ? null : RegionsImpl.planRec(planId);
			if (p == null) {
				throw RegionsImpl.refusal(Reason.PLAN_STALE, "no plan " + planId + " (unknown or discarded): plan it again");
			}
			return of(s, p, null, lotEntries == null ? Map.of() : lotEntries);
		});
	}

	/** {@link dev.larattalabs.architect.api.Regions#quoteApproved}: the artifact's plan with realiseApproved's merge of the entries. */
	static CompletableFuture<Quote> quoteApproved(String sha, Map<String, String> lotEntries) {
		MinecraftServer s = RegionsImpl.server();
		if (s == null) {
			return CompletableFuture.failedFuture(RegionsImpl.refusal(Reason.NOT_LOADED, "no world"));
		}
		return onServer(s, () -> {
			Optional<PlanArtifact> a = sha == null ? Optional.empty() : PlanChecks.artifact(sha);
			if (a.isEmpty() || a.get().removed() || a.get().body() == null) {
				throw RegionsImpl.refusal(Reason.ARTIFACT_UNAPPROVED, a.isPresent() ? "artifact " + sha.substring(0, 12) + " was removed (its tombstone): check again"
					: "no artifact " + sha);
			}
			JsonObject body = a.get().body();
			RegionsImpl.PlanRec p = RegionsImpl.planRec(a.get().planId());
			if (p == null) {
				throw RegionsImpl.refusal(Reason.ARTIFACT_UNAPPROVED, "artifact " + sha.substring(0, 12) + ": its plan " + a.get().planId() + " is gone");
			}
			if (!(body.get("region") instanceof JsonObject rg) || !p.irSha().equals(RegionsImpl.str(rg, "irSha", ""))) {
				throw RegionsImpl.refusal(Reason.ARTIFACT_STALE, "artifact " + sha.substring(0, 12) + ": its plan's IR is not the artifact's");
			}
			boolean checkedSurvival = body.get("survival") instanceof JsonElement sv && sv.isJsonPrimitive() && sv.getAsBoolean();
			if (checkedSurvival != RegionSurvival.on(s)) {
				throw RegionsImpl.refusal(Reason.ARTIFACT_STALE, "artifact " + sha.substring(0, 12) + " was checked in " + (checkedSurvival ? "survival" : "creative")
					+ " and this world realises in " + (checkedSurvival ? "creative" : "survival") + ": check the plan again");
			}
			return of(s, p, sha, PaletteRules.bound(body, lotEntries == null ? Map.of() : lotEntries));
		});
	}

	private static <T> CompletableFuture<T> onServer(MinecraftServer s, java.util.function.Supplier<T> f) {
		if (s.isSameThread()) {
			try {
				return CompletableFuture.completedFuture(f.get());
			} catch (RuntimeException e) {
				return CompletableFuture.failedFuture(e);
			}
		}
		return RegionsImpl.onServer(s, f);
	}

	/** The quote of a plan with these entries (already merged). Server thread. */
	static Quote of(MinecraftServer s, RegionsImpl.PlanRec p, @Nullable String sha, Map<String, String> entries) {
		Ir ir = p.ir();
		JsonObject irJson = ir.json();
		Map<String, String> bound = new LinkedHashMap<>();
		List<String> notes = new ArrayList<>();
		if (!RegionSurvival.planned(irJson)) {
			notes.add("an INSTANT (creative) plan: its realise takes nothing from a stockpile");
			for (Ir.Lot lot : ir.lots()) {
				if (entries.containsKey(lot.id())) {
					bound.put(lot.id(), entries.get(lot.id()));
				}
			}
			return new Quote(p.planId(), sha, revisionRegion(p), false, new JsonObject(), new JsonObject(), bound, true, notes);
		}
		if (!(p.planned().get("survivalBom") instanceof JsonObject tiles)) {
			throw RegionsImpl.refusal(Reason.PLAN_STALE, "plan " + p.planId() + " was planned before quotes (no_bill: it keeps no bill of its cells): plan it again");
		}
		ServerLevel level = Sites.levelOf(s, p.dimension());
		if (level == null) {
			throw RegionsImpl.refusal(Reason.NOT_LOADED, p.dimension() + " is not loaded");
		}
		Bill bill = new Bill();
		// 1. the region's paid cells, per target group (the kit's)
		// ((SA, A11) the kit bills every paid cell it writes; in game a cell the land already holds (a grade's dirt over dirt) is skipped,
		// never written, billed or consumed. (BC, A11) the plan keeps its paid terrain cells by position (survivalTerrain): the ones the
		// world holds now are left out, so the quote is what the realise consumes; what no kept cell covers stays an upper bound)
		Standing standing = standing(level, p.planned().get("survivalTerrain") instanceof JsonObject t ? t : new JsonObject());
		for (var g : tiles.entrySet()) {
			Map<String, Integer> its = items(g.getValue());
			Map<String, Integer> off = standing.off().getOrDefault(g.getKey(), Map.of());
			off.forEach((k, v) -> its.merge(k, -v, Integer::sum));
			bill.add("tiles:" + g.getKey(), its);
		}
		if (standing.offCells() > 0) {
			notes.add("tiles: " + standing.offCells() + " paid terrain cell(s) already stand in the land (" + standing.offText() + "): a realise skips "
				+ "them, so they are not billed");
		}
		if (standing.unloaded() > 0) {
			bill.exact = false;
			notes.add("tiles: " + standing.unloaded() + " paid terrain cell(s) are in chunks not loaded: billed (they may already stand: consumed "
				+ "at most this quote)");
		}
		Map<String, Integer> terrain = standing.terrain(); // (QL) clamped to the whole bom below
		// (QL-b) the paid terrain cells an earlier write always covers first (plan.json's survivalTerrainWritten): always paid, never standing
		String mayHold = mayAlreadyHold(tiles, withWritten(standing.covered(), p.planned().get("survivalTerrainWritten") instanceof JsonObject w ? w : null));
		if (mayHold != null) {
			bill.exact = false;
			notes.add(mayHold);
		}
		// the region the lots go into: a revision's standing one (its record, read only), else a record of the plan as a realise makes it
		boolean revision = Revisions.isRevision(p);
		RegionRec rec;
		RegionsImpl.Live live = null;
		if (revision) {
			String id = revisionRegion(p);
			live = id == null ? null : RegionsImpl.live(id);
			if (live == null) {
				throw RegionsImpl.refusal(Reason.OTHER, "revision plan " + p.planId() + ": no region " + id + " (re-plan)");
			}
			rec = live.rec();
		} else {
			rec = new RegionRec("quote", p.planId(), p.irSha(), p.owner(), new JsonObject(), p.dimension(), ir.claim(), 0L);
			JsonObject sv = new JsonObject();
			sv.addProperty("on", true);
			rec.survival = sv;
		}
		EntranceStyle style = revision ? EntranceStyle.region(rec.id) : EntranceStyle.ofIr(irJson, null);
		it.unimi.dsi.fastutil.longs.LongOpenHashSet roadCells = new it.unimi.dsi.fastutil.longs.LongOpenHashSet();
		// (QL-c) every cell the plan's roads write (air included): the land the lots go down on has them (a graded road, its surface block)
		it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap<net.minecraft.world.level.block.state.BlockState> roadStates = new it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap<>();
		// 2. the 4e roads, over the land now (the plan check's call); their surface cells stand when the lots go down
		for (Ir.Road road : ir.roads()) {
			List<BlockPos> pts = new ArrayList<>();
			road.points().forEach(pt -> pts.add(new BlockPos(pt[0], pt[1], pt[2])));
			try {
				var c = dev.larattalabs.architect.site.InfraPlace.checkRoad(level, pts, road.width(), road.surface(), null, road.lanterns(), false, p.owner(), true,
					true, null, road.lamp(), revision ? rec.groupId : null);
				if (c.ok()) {
					bill.add("road:" + road.id(), dev.larattalabs.architect.site.RoadBuilder.bom(level, c.positions(), c.values()));
					for (int i = 0; i < c.positions().length; i++) {
						if (c.values()[i] != null) {
							roadStates.put(c.positions()[i], dev.larattalabs.architect.journal.WorldJournal.state(c.values()[i]));
						}
						String n = c.values()[i] == null ? null : c.values()[i].name();
						if (n != null && !n.equals("minecraft:air") && !dev.larattalabs.architect.site.roads.RoadPlan.isLampBlock(n)) {
							roadCells.add(c.positions()[i]); // as Roads.roadCells reads a standing road's journal entry
						}
					}
				} else {
					bill.exact = false;
					notes.add("road " + road.id() + ": its check refuses over the land now (" + c.refusals().get(0).message() + "): not billed");
				}
			} catch (RuntimeException e) {
				bill.exact = false;
				notes.add("road " + road.id() + ": its bill could not be read (" + e + ")");
			}
		}
		// (QL-c) each lot's approach ground (plan.json's approachGround: the tiles' writes before it in its approach window); null: a plan made
		// before QL-c, whose lots' approaches are planned over the land now (inexact, named)
		JsonObject approachGround = p.planned().get("approachGround") instanceof JsonObject ag ? ag : null;
		Land land = new Land(roadStates, approachGround, p.planId(), revision ? rec.groupId : null);
		// 3. the lots: a revision's refills (from the effective IR, each needs its entry as the realise does), then the plan's own lots
		if (revision) {
			Ir eff = Ir.lenient(Revisions.effective(live), rec.claim);
			for (String lotId : Revisions.refills(irJson)) {
				String entry = entries.get(lotId);
				if (entry == null) {
					throw RegionsImpl.refusal(Reason.NOT_ALLOWED, "revision plan " + p.planId() + " refills lot " + lotId + ": no entry for it (lotEntries)");
				}
				Ir.Lot lot = eff.lots().stream().filter(x -> x.id().equals(lotId)).findFirst().orElse(null);
				if (lot != null) {
					lot(level, rec, eff, lot, entry, entries, style, roadCells, land, bill, notes, false);
					bound.put(lotId, entry);
				}
			}
		}
		for (Ir.Lot lot : ir.lots()) {
			String entry = entries.get(lot.id());
			if (entry == null) {
				continue; // a pad: its paid cells are the tiles'
			}
			lot(level, rec, ir, lot, entry, entries, style, roadCells, land, bill, notes, !revision);
			bound.put(lot.id(), entry);
		}
		// 4. a first realise's K1 swing gates (a revision queues no mechanism item)
		if (!revision) {
			for (JsonObject gw : GateMech.gateWrites(ir)) {
				bill.add("mech:" + RegionsImpl.str(gw, "gate", ""), GateMech.plan(gw, null, null, 0, 0, 0).bill());
			}
		}
		// 5. the fluids' charge: once per region
		boolean charged = revision && rec.survival != null && rec.survival.has("chargedAt");
		Map<String, Integer> fluids = charged ? Map.of() : RegionSurvival.fluidCharge(irJson);
		if (!fluids.isEmpty()) {
			bill.add("fluids", fluids);
			bill.exact = false;
			notes.add("fluids: a lava bucket per lava source and an iron bars per grate cell of every body (an upper bound: a body drained or held "
				+ "upstream is not charged); each lava bucket's bucket comes back");
		} else if (charged && !RegionSurvival.fluidCharge(irJson).isEmpty()) {
			notes.add("fluids: region " + rec.id + " charged its fluids already (once per region): this revision's bodies take nothing");
		}
		notes.add("the region's cells are the kit's bill over the plan survey; lots and roads are measured over the land now (loaded chunks), "
			+ "before the plan's own tiles write");
		JsonObject bom = bill.bom();
		return new Quote(p.planId(), sha, revision ? rec.id : null, true, bom, bill.parts, bound, bill.exact, notes, clamp(terrain, bom),
			stagedCells(p.planned().get("survivalStaged") instanceof JsonObject st ? st : null));
	}

	/**
	 * (8a QX, docs/CONTRACT.md "Phase 8a" §5) {@link Quote#terrainCells} from plan.json's {@code survivalStaged} (group -> the staged terrain
	 * cells over the plan survey, ARTL class 3): the time side only, so nothing here touches the bill. A group with no positive count is left
	 * out; a plan planned before QX (no field) gives an empty map, not a refusal. The world is not read: an upper bound, as {@code survival.cells}.
	 */
	static Map<String, Long> stagedCells(@org.jspecify.annotations.Nullable JsonObject staged) {
		Map<String, Long> out = new TreeMap<>();
		if (staged == null) {
			return out;
		}
		for (var e : staged.entrySet()) {
			if (e.getValue() instanceof JsonElement v && v.isJsonPrimitive() && v.getAsJsonPrimitive().isNumber() && v.getAsLong() > 0) {
				out.put(e.getKey(), v.getAsLong());
			}
		}
		return out;
	}

	/**
	 * (BC, S-M5-9) A realise with a {@code maxBill}: refused {@link Reason#BILL_CAP} when its bill at put-down (this plan's quote with the
	 * realise's entries, read now) is past the cap for an item (an item the cap does not name: 0). Server thread, before any write.
	 */
	static void capRefusal(MinecraftServer s, RegionsImpl.PlanRec p, dev.larattalabs.architect.api.RealiseRequest r) {
		Map<String, Integer> cap = r.maxBill();
		if (cap == null) {
			return;
		}
		Quote q = of(s, p, null, r.lotEntries());
		List<String> over = overCap(q.bom(), cap);
		if (!over.isEmpty()) {
			throw RegionsImpl.refusal(Reason.BILL_CAP, "the realise's bill at put-down is past its maxBill (" + String.join(", ", over) + ")" + (q.exact() ? ""
				: "; the bill is an upper bound: " + String.join("; ", q.notes().stream().filter(n -> n.contains("upper bound") || n.contains("not loaded")
					|| n.contains("may")).toList())));
		}
	}

	/** (BC) The items of a bill past a cap ({@code item n > cap}; an item the cap does not name: 0), sorted. */
	static List<String> overCap(JsonObject bom, Map<String, Integer> cap) {
		List<String> over = new ArrayList<>();
		for (var e : new TreeMap<>(bom.asMap()).entrySet()) {
			int n = e.getValue().getAsInt(), c = cap.getOrDefault(e.getKey(), 0);
			if (n > c) {
				over.add(e.getKey().replace("minecraft:", "") + " " + n + " > " + c);
			}
		}
		return over;
	}

	/**
	 * (QL, a gate hook's reader) Up to {@code max} of a plan's kept paid terrain cells (plan.json's {@code survivalTerrain}), in the plan's
	 * order: {group, state, x, y, z, standing (the world holds the state now), loaded}. Read-only. Server thread.
	 */
	public static com.google.gson.JsonArray devTerrainCells(MinecraftServer s, String planId, int max) {
		com.google.gson.JsonArray out = new com.google.gson.JsonArray();
		RegionsImpl.PlanRec p = planId == null ? null : RegionsImpl.planRec(planId);
		ServerLevel level = p == null ? null : Sites.levelOf(s, p.dimension());
		if (level == null || !(p.planned().get("survivalTerrain") instanceof JsonObject t)) {
			return out;
		}
		for (var g : new TreeMap<>(t.asMap()).entrySet()) {
			if (!(g.getValue() instanceof com.google.gson.JsonArray rows)) {
				continue;
			}
			for (JsonElement row : rows) {
				if (!(row instanceof JsonObject r) || !(r.get("state") instanceof JsonElement se) || !(r.get("cells") instanceof JsonElement ce)) {
					continue;
				}
				java.nio.ByteBuffer b = java.nio.ByteBuffer.wrap(java.util.Base64.getDecoder().decode(ce.getAsString())).order(java.nio.ByteOrder.LITTLE_ENDIAN);
				while (b.remaining() >= 12 && out.size() < max) {
					int x = b.getInt(), y = b.getInt(), z = b.getInt();
					JsonObject c = new JsonObject();
					c.addProperty("group", g.getKey());
					c.addProperty("state", se.getAsString());
					if (r.get("items") instanceof JsonElement ie) {
						c.add("items", ie.deepCopy());
					}
					c.addProperty("x", x);
					c.addProperty("y", y);
					c.addProperty("z", z);
					boolean loaded = level.hasChunk(x >> 4, z >> 4);
					c.addProperty("loaded", loaded);
					boolean standing = false;
					if (loaded) {
						try {
							standing = builderHolds(level.getBlockState(new BlockPos(x, y, z)), Packed.parse(se.getAsString()));
						} catch (RuntimeException e) {
							standing = false;
						}
					}
					c.addProperty("standing", standing);
					out.add(c);
				}
			}
		}
		return out;
	}

	/** (QL) {@link Quote#terrain}: each terrain count clamped to [0, its bom count] (a 0 key stays: the item is still a terrain item). */
	static Map<String, Integer> clamp(Map<String, Integer> terrain, JsonObject bom) {
		Map<String, Integer> out = new TreeMap<>();
		terrain.forEach((k, v) -> out.put(k, Math.max(0, Math.min(v, bom.get(k) instanceof JsonElement e && e.isJsonPrimitive() ? e.getAsInt() : 0))));
		return out;
	}

	/** (SA, A11) The common terrain blocks, besides the tag rule ({@link CellCond#natural}): a grade's or a fill's usual materials. */
	private static final java.util.Set<net.minecraft.world.level.block.Block> TERRAIN = java.util.Set.of(net.minecraft.world.level.block.Blocks.DIRT,
		net.minecraft.world.level.block.Blocks.GRASS_BLOCK, net.minecraft.world.level.block.Blocks.COARSE_DIRT, net.minecraft.world.level.block.Blocks.ROOTED_DIRT,
		net.minecraft.world.level.block.Blocks.PODZOL, net.minecraft.world.level.block.Blocks.MYCELIUM, net.minecraft.world.level.block.Blocks.DIRT_PATH,
		net.minecraft.world.level.block.Blocks.MUD, net.minecraft.world.level.block.Blocks.STONE, net.minecraft.world.level.block.Blocks.DEEPSLATE,
		net.minecraft.world.level.block.Blocks.GRANITE, net.minecraft.world.level.block.Blocks.DIORITE, net.minecraft.world.level.block.Blocks.ANDESITE,
		net.minecraft.world.level.block.Blocks.TUFF, net.minecraft.world.level.block.Blocks.SAND, net.minecraft.world.level.block.Blocks.RED_SAND,
		net.minecraft.world.level.block.Blocks.GRAVEL, net.minecraft.world.level.block.Blocks.CLAY, net.minecraft.world.level.block.Blocks.SANDSTONE,
		net.minecraft.world.level.block.Blocks.RED_SANDSTONE, net.minecraft.world.level.block.Blocks.NETHERRACK, net.minecraft.world.level.block.Blocks.SNOW_BLOCK,
		net.minecraft.world.level.block.Blocks.FARMLAND); // (QL-b) farmland too (it bills dirt)

	/**
	 * (SA, A11) The region's paid cells that may already stand in the land: per target group, the items of natural terrain blocks
	 * ({@link CellCond#natural}: dirt, stone, sand, ...) in the kit's bill ({@code tiles}: group -> {item: n}). A realise skips a cell
	 * whose block the world already holds, so those cells can bill less, never more. Null when there are none (the quote stays exact).
	 */
	static @Nullable String mayAlreadyHold(JsonObject tiles) {
		return mayAlreadyHold(tiles, Map.of());
	}

	/**
	 * (BC, A11) As {@link #mayAlreadyHold(JsonObject)}, less what the plan's kept terrain cells cover ({@code covered}: group -> {item: n},
	 * every kept cell; an unloaded one has its own note): only the rest may still stand unread.
	 */
	static @Nullable String mayAlreadyHold(JsonObject tiles, Map<String, Map<String, Integer>> covered) {
		List<String> parts = new ArrayList<>();
		int total = 0;
		for (var g : new java.util.TreeMap<>(tiles.asMap()).entrySet()) {
			if (!(g.getValue() instanceof JsonObject bom)) {
				continue;
			}
			List<String> its = new ArrayList<>();
			for (var e : new java.util.TreeMap<>(bom.asMap()).entrySet()) {
				net.minecraft.resources.Identifier id = net.minecraft.resources.Identifier.tryParse(e.getKey());
				var b = id == null ? null : net.minecraft.core.registries.BuiltInRegistries.BLOCK.getOptional(id).orElse(null);
				if (b == null || b == net.minecraft.world.level.block.Blocks.AIR || !e.getValue().isJsonPrimitive()) {
					continue;
				}
				var st = b.defaultBlockState();
				if (!st.isAir() && (TERRAIN.contains(b) || CellCond.natural(st, dev.larattalabs.architect.placement.TerrainFit.flags(st)))) {
					int n = e.getValue().getAsInt() - covered.getOrDefault(g.getKey(), Map.of()).getOrDefault(e.getKey(), 0);
					if (n <= 0) {
						continue;
					}
					total += n;
					its.add(n + " " + e.getKey().replace("minecraft:", ""));
				}
			}
			if (!its.isEmpty()) {
				parts.add(g.getKey() + " (" + String.join(", ", its) + ")");
			}
		}
		if (parts.isEmpty()) {
			return null;
		}
		return "tiles: " + total + " paid cell(s) of natural terrain may already stand in the land (" + String.join("; ", parts) + "): a realise "
			+ "skips a cell that already holds its block, so the region's cells are an upper bound: consumed is at most this quote, never more";
	}

	/**
	 * (QL-b) {@code covered} plus plan.json's {@code survivalTerrainWritten} (group -> {item: n}: the paid terrain cells an earlier evaluation
	 * of their tile key always writes first with another state, so a realise always writes and pays them): neither may already stand.
	 */
	static Map<String, Map<String, Integer>> withWritten(Map<String, Map<String, Integer>> covered, @Nullable JsonObject written) {
		if (written == null || written.isEmpty()) {
			return covered;
		}
		Map<String, Map<String, Integer>> out = new TreeMap<>();
		covered.forEach((g, its) -> out.put(g, new TreeMap<>(its)));
		for (var g : written.entrySet()) {
			Map<String, Integer> its = out.computeIfAbsent(g.getKey(), k -> new TreeMap<>());
			items(g.getValue()).forEach((k, v) -> its.merge(k, v, Integer::sum));
		}
		return out;
	}

	/**
	 * (BC, A11) The plan's kept paid terrain cells read against the world now: per group the items of the cells whose block already stands
	 * ({@code off}: a realise skips them), the items of every kept cell ({@code covered}) and how many could not be read (chunk not loaded).
	 */
	record Standing(Map<String, Map<String, Integer>> off, Map<String, Map<String, Integer>> covered, int offCells, int unloaded) {
		/**
		 * (QL) The units the kept cells bill, per item over every group: covered less off (a standing cell in neither), every covered item a
		 * key, 0 included. Not yet clamped to the bom ({@link Quotes#clamp}).
		 */
		Map<String, Integer> terrain() {
			Map<String, Integer> out = new TreeMap<>();
			covered.forEach((g, its) -> its.forEach((k, v) -> {
				int n = v - off.getOrDefault(g, Map.of()).getOrDefault(k, 0);
				out.merge(k, Math.max(0, n), Integer::sum);
			}));
			return out;
		}

		String offText() {
			List<String> out = new ArrayList<>();
			off.forEach((g, its) -> {
				List<String> s = new ArrayList<>();
				its.forEach((k, v) -> s.add(v + " " + k.replace("minecraft:", "")));
				out.add(g + " (" + String.join(", ", s) + ")");
			});
			return String.join("; ", out);
		}
	}

	/** (BC, A11) {@link Standing} over plan.json's {@code survivalTerrain} (group -> [{state, items, cells}]; see the kit's survivalTerrainOf). */
	static Standing standing(ServerLevel level, JsonObject terrain) {
		return standing(terrain, (x, y, z) -> {
			BlockPos bp = new BlockPos(x, y, z);
			if (!level.hasChunk(x >> 4, z >> 4)) {
				return null;
			}
			return level.getBlockState(bp);
		});
	}

	/** The world at a cell: its block, or null when its chunk is not loaded. */
	interface World {
		net.minecraft.world.level.block.state.@Nullable BlockState at(int x, int y, int z);
	}

	/**
	 * (QL-c) Whether a realise consumes nothing at a kept cell that holds {@code now} where the plan writes {@code want}: the region run's own
	 * test while a target builds ({@code Builder.Run#matches} with {@code soilSame} off: the block, or another stage of its copper chain), not
	 * the whole state. TileCheck queues a cell of another state (farmland of another moisture), and the run then marks it built unwritten and
	 * unpaid. Another block (grass where the plan writes dirt) is written and paid.
	 */
	static boolean builderHolds(net.minecraft.world.level.block.state.BlockState now, net.minecraft.world.level.block.state.BlockState want) {
		return now == want || dev.larattalabs.architect.journal.Copper.is(now, want.getBlock());
	}

	static Standing standing(JsonObject terrain, World world) {
		Map<String, Map<String, Integer>> off = new TreeMap<>(), covered = new TreeMap<>();
		int offCells = 0, unloaded = 0;
		for (var g : new TreeMap<>(terrain.asMap()).entrySet()) {
			if (!(g.getValue() instanceof com.google.gson.JsonArray rows)) {
				continue;
			}
			for (JsonElement row : rows) {
				if (!(row instanceof JsonObject r) || !(r.get("state") instanceof JsonElement se) || !(r.get("cells") instanceof JsonElement ce)) {
					continue;
				}
				net.minecraft.world.level.block.state.BlockState want;
				try {
					want = Packed.parse(se.getAsString());
				} catch (RuntimeException e) {
					continue; // an unknown state: its cells stay billed (and uncovered: the upper-bound note names them)
				}
				Map<String, Integer> its = items(r.get("items"));
				java.nio.ByteBuffer b = java.nio.ByteBuffer.wrap(java.util.Base64.getDecoder().decode(ce.getAsString())).order(java.nio.ByteOrder.LITTLE_ENDIAN);
				while (b.remaining() >= 12) {
					int x = b.getInt(), y = b.getInt(), z = b.getInt();
					var now = world.at(x, y, z);
					Map<String, Integer> cv = covered.computeIfAbsent(g.getKey(), k -> new TreeMap<>());
					its.forEach((k, v) -> cv.merge(k, v, Integer::sum)); // a kept cell: the unloaded note names it when it can't be read
					if (now == null) {
						unloaded++;
						continue;
					}
					if (builderHolds(now, want)) {
						offCells++;
						Map<String, Integer> o = off.computeIfAbsent(g.getKey(), k -> new TreeMap<>());
						its.forEach((k, v) -> o.merge(k, v, Integer::sum));
					}
				}
			}
		}
		return new Standing(off, covered, offCells, unloaded);
	}

	/**
	 * (QL-c) A lot's land: the plan's writes before it, the path tiles' walk cells, why it is not fully known (null: it is), and, when some
	 * tile writes can't be decided here ({@code undecided}: a kept player build's cell, whose consent is the realise's), the same land with
	 * those writes made ({@code ifWritten}); the realise's land is one of the two at those cells.
	 */
	record LandOf(dev.larattalabs.architect.site.QuoteLand land, it.unimi.dsi.fastutil.longs.LongOpenHashSet walk, @Nullable String gap, int undecided,
		@Nullable LandOf ifWritten) {
		LandOf(dev.larattalabs.architect.site.QuoteLand land, it.unimi.dsi.fastutil.longs.LongOpenHashSet walk, @Nullable String gap) {
			this(land, walk, gap, 0, null);
		}
	}

	/**
	 * (QL-c) The world a lot's approach ground is decided over, as TileCheck reads it: each cell's state (null: not loaded), its journal owner
	 * and whether it is an incidental or a kept player-placed cell. The defaults: no owner, no player cell (the unit tests' plain world).
	 */
	interface Reads extends World {
		/** 0: no entry, 1: one of the region's own tile entries (ours), 2: another entry (held). */
		default int owner(long pos) {
			return 0;
		}

		/** The cell is in a kept player build (TileCheck's BUILD, unless the realise's consent names it: not known to a quote). */
		default boolean kept(int x, int y, int z) {
			return false;
		}

		/** The cell is an incidental player-placed one ({@code Placed.naturalForWrites} with no consent). */
		default boolean incidental(int x, int y, int z) {
			return false;
		}
	}

	/** (QL-c) {@link Reads} over a level: its loaded chunks, the journal's stacks, the placed-block tracker; {@code group}: the region's own. */
	static Reads reads(ServerLevel level, @Nullable String group) {
		String dim = Sites.dimensionId(level);
		return new Reads() {
			@Override
			public net.minecraft.world.level.block.state.@Nullable BlockState at(int x, int y, int z) {
				return level.hasChunk(x >> 4, z >> 4) ? level.getBlockState(new BlockPos(x, y, z)) : null;
			}

			@Override
			public int owner(long pos) {
				if (dev.larattalabs.architect.journal.WorldJournal.storeOrNull() == null) {
					return 0;
				}
				int o = 0;
				try {
					for (var l : dev.larattalabs.architect.journal.WorldJournal.stack(dim, pos)) {
						var m = l.meta();
						if (m.kind().equals(dev.larattalabs.architect.journal.WorldJournal.LEAVES)) {
							continue;
						}
						boolean mine = (m.kind().equals(dev.larattalabs.architect.site.RegionKinds.TERRAIN) || m.kind().equals(
							dev.larattalabs.architect.site.RegionKinds.PATH)) && group != null && !group.isEmpty() && group.equals(m.group());
						if (!mine) {
							return 2; // another entry's: TileCheck checks others first
						}
						o = 1;
					}
				} catch (java.io.IOException e) {
					return 2; // unreadable: held, as TileCheck refuses to write it
				}
				return o;
			}

			@Override
			public boolean kept(int x, int y, int z) {
				return dev.larattalabs.architect.placed.Placed.build(level, null, x, y, z) != null;
			}

			@Override
			public boolean incidental(int x, int y, int z) {
				return dev.larattalabs.architect.placed.Placed.naturalForWrites(level, null, x, y, z, dev.larattalabs.architect.placed.Placed.Consent.NONE);
			}
		};
	}

	/** (QL-c) The plan's roads' writes and its lots' approach ground (plan.json's approachGround; null for a plan made before QL-c). */
	static final class Land {
		final it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap<net.minecraft.world.level.block.state.BlockState> roads;
		final @Nullable JsonObject ground;
		final String planId;
		final @Nullable String group;

		Land(it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap<net.minecraft.world.level.block.state.BlockState> roads, @Nullable JsonObject ground, String planId) {
			this(roads, ground, planId, null);
		}

		Land(it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap<net.minecraft.world.level.block.state.BlockState> roads, @Nullable JsonObject ground, String planId,
			@Nullable String group) {
			this.roads = roads;
			this.ground = ground;
			this.planId = planId;
			this.group = group;
		}

		LandOf of(ServerLevel level, String lotId) {
			return of(lotId, reads(level, group), CellCond::passes);
		}

		LandOf of(String lotId, Reads world, Realised.CondTest cond) {
			dev.larattalabs.architect.site.QuoteLand land = new dev.larattalabs.architect.site.QuoteLand();
			land.states().putAll(roads);
			it.unimi.dsi.fastutil.longs.LongOpenHashSet walk = new it.unimi.dsi.fastutil.longs.LongOpenHashSet();
			if (ground == null) {
				return new LandOf(land, walk, "the plan was made before QL-c (no approach ground: plan it again)");
			}
			if (!(ground.get(lotId) instanceof JsonObject lg)) {
				return new LandOf(land, walk, null); // no tile writes in its approach window
			}
			if (lg.has("capped")) {
				return new LandOf(land, walk, "the plan's tiles write too many cells in its approach window to keep (" + lg.get("capped").getAsInt() + " column runs)");
			}
			int[] undecided = {0};
			int gaps = apply(lg, world, cond, land, walk, false, undecided);
			String gap = gaps == 0 ? null : gaps + " cell(s) of the tiles' writes in its approach window can't be read (a chunk not loaded, an unknown state)";
			if (undecided[0] == 0) {
				return new LandOf(land, walk, gap);
			}
			dev.larattalabs.architect.site.QuoteLand land2 = new dev.larattalabs.architect.site.QuoteLand();
			land2.states().putAll(roads);
			it.unimi.dsi.fastutil.longs.LongOpenHashSet walk2 = new it.unimi.dsi.fastutil.longs.LongOpenHashSet();
			apply(lg, world, cond, land2, walk2, true, new int[1]);
			return new LandOf(land, walk, gap, undecided[0], new LandOf(land2, walk2, gap));
		}
	}

	/** A write condition over a cell's state ({@link CellCond#passes}; a seam for the unit test). */
	interface Cond extends Realised.CondTest {
	}

	/**
	 * (QL-c) One lot's approach ground ({seqs: [[[state, cond, walk], ...]], runs: base64 int32 [x, z, y0, y1, seq]}) over the world (and the roads
	 * already in {@code land}): per cell its writes in order, each decided by TileCheck's own {@link Realised#decideCell}
	 * (a road's or another entry's cell held, a kept build's skipped, the condition, an incidental player cell, the cell's own state a no-op,
	 * ALWAYS_OURS over the region's own); a written one makes the cell the region's own, its tile's entry owns it, a walk write's cell joins
	 * {@code walk}. A kept build's cell is the realise's consent's to decide: counted in {@code undecided}, and written only when
	 * {@code assumeWritten} (as with consent: incidental). Returns how many cells could not be read.
	 */
	static int apply(JsonObject lg, Reads world, Realised.CondTest cond, dev.larattalabs.architect.site.QuoteLand land,
		it.unimi.dsi.fastutil.longs.LongOpenHashSet walk, boolean assumeWritten, int[] undecided) {
		if (!(lg.get("seqs") instanceof com.google.gson.JsonArray seqs) || !(lg.get("runs") instanceof JsonElement re)) {
			return 0;
		}
		List<net.minecraft.world.level.block.state.@Nullable BlockState[]> st = new ArrayList<>();
		List<int[]> cd = new ArrayList<>();
		List<boolean[]> wk = new ArrayList<>();
		for (JsonElement q : seqs) {
			com.google.gson.JsonArray w = q.getAsJsonArray();
			net.minecraft.world.level.block.state.BlockState[] a = new net.minecraft.world.level.block.state.BlockState[w.size()];
			int[] c = new int[w.size()];
			boolean[] k = new boolean[w.size()];
			for (int i = 0; i < w.size(); i++) {
				com.google.gson.JsonArray e = w.get(i).getAsJsonArray();
				try {
					a[i] = Packed.parse(e.get(0).getAsString());
				} catch (RuntimeException ex) {
					a[i] = null; // an unknown state: the cell is a gap
				}
				c[i] = e.get(1).getAsInt();
				k[i] = e.size() > 2 && e.get(2).getAsInt() != 0;
			}
			st.add(a);
			cd.add(c);
			wk.add(k);
		}
		it.unimi.dsi.fastutil.longs.LongOpenHashSet roadCells = new it.unimi.dsi.fastutil.longs.LongOpenHashSet(land.states().keySet());
		int gaps = 0;
		java.nio.ByteBuffer b = java.nio.ByteBuffer.wrap(java.util.Base64.getDecoder().decode(re.getAsString())).order(java.nio.ByteOrder.LITTLE_ENDIAN);
		while (b.remaining() >= 20) {
			int x = b.getInt(), z = b.getInt(), y0 = b.getInt(), y1 = b.getInt(), k = b.getInt();
			if (k < 0 || k >= st.size()) {
				continue;
			}
			for (int y = y0; y <= y1; y++) {
				long pos = BlockPos.asLong(x, y, z);
				var now = world.at(x, y, z);
				if (now == null) {
					gaps++;
					continue;
				}
				// the cell's owner at put-down: a planned road's or another entry's (held), the region's own tile's (ours), or none
				int owner = roadCells.contains(pos) ? 2 : world.owner(pos);
				boolean kept = owner != 2 && world.kept(x, y, z);
				if (kept && !assumeWritten) {
					undecided[0]++;
				}
				boolean buildKept = kept && !assumeWritten;
				final int fx = x, fy = y, fz = z;
				java.util.function.BooleanSupplier incidental = () -> kept || world.incidental(fx, fy, fz); // consent given: a kept build's cell passes as natural
				var cur = now;
				boolean ours = owner == 1, gap = false;
				for (int i = 0; i < st.get(k).length; i++) {
					var w = st.get(k)[i];
					if (w == null) {
						gap = true;
						break;
					}
					byte c = Realised.decideCell(owner == 2, buildKept, cur, false, false, incidental, cd.get(k)[i], ours, w, cond);
					if (c != Realised.WRITTEN) {
						continue; // HELD, BUILD, COND or NOOP
					}
					cur = w;
					ours = true;
					land.tiles().add(pos);
					if (wk.get(k)[i]) {
						walk.add(pos);
					}
				}
				if (gap) {
					gaps++;
				}
				if (cur != now) {
					land.states().put(pos, cur);
					land.changedByTiles().add(pos);
				}
			}
		}
		return gaps;
	}

	/** (QL-b, a gate hook) When set, each lot's bill taken apart ({@link dev.larattalabs.architect.site.LotBillDebug}) by lot id. */
	static final ThreadLocal<@Nullable JsonObject> DEBUG_LOTS = new ThreadLocal<>();

	/** (QL-b, a gate hook's reader) {@link #quote}'s quote of a plan, with each lot's bill taken apart. Read-only. Server thread. */
	public static JsonObject devLotBill(MinecraftServer s, String planId, Map<String, String> entries) {
		RegionsImpl.PlanRec p = planId == null ? null : RegionsImpl.planRec(planId);
		JsonObject o = new JsonObject();
		if (p == null) {
			o.addProperty("refused", "no plan " + planId);
			return o;
		}
		JsonObject lots = new JsonObject();
		DEBUG_LOTS.set(lots);
		try {
			Quote q = of(s, p, null, entries);
			o.add("bom", q.bom());
			o.add("bomParts", q.bomParts());
			o.addProperty("exact", q.exact());
			com.google.gson.JsonArray n = new com.google.gson.JsonArray();
			q.notes().forEach(n::add);
			o.add("notes", n);
		} catch (RuntimeException e) {
			o.addProperty("refused", String.valueOf(e.getMessage()));
		} finally {
			DEBUG_LOTS.remove();
		}
		o.add("lots", lots);
		return o;
	}

	/** A bound lot's bill (and, on a first realise, its gate mechanism's), as the realise puts it down. */
	private static void lot(ServerLevel level, RegionRec rec, Ir ir, Ir.Lot lot, String entry, Map<String, String> entries, @Nullable EntranceStyle style,
		it.unimi.dsi.fastutil.longs.LongSet roadCells, Land land, Bill bill, List<String> notes, boolean mech) {
		QItem q = RegionsImpl.lotItemOf(level, rec, ir, lot, entry, new ArrayList<>(), entries, null);
		if (q == null) {
			return;
		}
		if (q.status == QItem.Status.FAILED) {
			Reason r;
			try {
				r = Reason.valueOf(q.reason);
			} catch (RuntimeException e) {
				r = Reason.OTHER;
			}
			throw RegionsImpl.refusal(r, "lot " + lot.id() + " (" + entry + "): " + q.message);
		}
		Blueprint bp = Blueprints.get(q.blueprint);
		if (bp == null) {
			throw RegionsImpl.refusal(Reason.UNKNOWN_BLUEPRINT, "No design " + q.blueprint + " in the library");
		}
		BlockPos origin = new BlockPos(q.x, q.y, q.z);
		Rotation rot = Rotation.values()[Math.floorMod(q.turns, 4)];
		JsonObject lotJson = dev.larattalabs.architect.site.SiteLots.lotJson(ir.json(), lot.id());
		dev.larattalabs.architect.api.SiteSpec site = dev.larattalabs.architect.site.SiteLots.isSiteLot(lotJson) ? dev.larattalabs.architect.site.SiteLots.siteOf(
			ir.json(), lot.id()) : null;
		Sites.Verdict v;
		// (QL-c) the lot over the land the plan's roads and earlier tiles leave: their states, the tiles' cells as the style's region ground (a
		// first realise's style then has a group, as the realise's does), the path tiles' walk cells as road cells (Roads.roadCells)
		LandOf lo = land.of(level, lot.id());
		v = verdictOver(level, bp, origin, rot, q, rec, site, style, roadCells, land, lo);
		Sites.BomFull b = Sites.quoteBill(level, bp, v, dev.larattalabs.architect.site.LotMask.cells(q.ext));
		if (DEBUG_LOTS.get() instanceof JsonObject dbg) { // (QL-b, a gate hook's reader) the lot bill taken apart
			JsonObject d = dev.larattalabs.architect.site.LotBillDebug.of(level, bp, v, dev.larattalabs.architect.site.LotMask.cells(q.ext));
			if (d != null) {
				d.addProperty("entry", entry);
				d.addProperty("origin", q.x + "," + q.y + "," + q.z + " turns " + q.turns);
				dbg.add(lot.id(), d);
			}
		}
		if (b == null) {
			bill.exact = false;
			notes.add("lot " + lot.id() + " (" + entry + "): no construction plan over the land now" + (v.typed().isEmpty() ? "" : " (" + v.typed().get(0)
				.message() + ")") + ": not billed");
			return;
		}
		Map<String, Integer> lotItems = b.items();
		if (lo.ifWritten() != null) {
			// (QL-c) tile writes over a kept player build's cells: the realise writes them only when its consent names the build (not known here).
			// Both lands are planned and the larger count of each item billed: an upper bound over the two (each such cell written, or none)
			Sites.Verdict v2 = verdictOver(level, bp, origin, rot, q, rec, site, style, roadCells, land, lo.ifWritten());
			Sites.BomFull b2 = Sites.quoteBill(level, bp, v2, dev.larattalabs.architect.site.LotMask.cells(q.ext));
			Map<String, Integer> both = new TreeMap<>(lotItems);
			if (b2 != null) {
				b2.items().forEach((k, n) -> both.merge(k, n, Math::max));
			}
			lotItems = both;
			bill.exact = false;
			notes.add("lot " + lot.id() + " (" + entry + "): the plan's tiles write " + lo.undecided() + " cell(s) of a kept player build where its entrance "
				+ "approach is planned (the realise writes them only with the build's consent): its approach is planned both ways and the larger of each "
				+ "item billed (an upper bound when those cells are all written or none" + (b2 == null ? "; the written way has no construction plan" : "")
				+ ")");
		}
		bill.add("lot:" + lot.id(), lotItems);
		if (lo.gap() != null) {
			// (QL-c) the land the realise finds in front of the lot is not fully known here: its approach can be planned longer or shorter
			bill.exact = false;
			notes.add("lot " + lot.id() + " (" + entry + "): " + lo.gap() + ": its approach is planned over the land now and may differ (longer or shorter): "
				+ "not an upper bound (with a maxBill set, the realise waits bill_cap; callers that set none can consume past the quote)");
		} else {
			int touched = Sites.approachTilesTouching(v, lo.land());
			if (touched > 0) {
				// (QL-c) planned over the land the plan's tiles leave, as the realise plans it; named inexact all the same (the tiles' writes are the
				// plan survey's, applied by their conditions over the land now)
				bill.exact = false;
				notes.add("lot " + lot.id() + " (" + entry + "): the plan's tiles change " + touched + " cell(s) where its entrance approach is planned: "
					+ "the approach is planned over the land they leave, as the realise plans it (inexact: the tiles' writes are the plan survey's)");
			}
		}
		if (b.standingOutside() > 0) {
			// (QL-b) fill or approach cells whose block the land already holds are billed (the conversion pays every queued cell), but the realise
			// plans its fill and approach over the land as the plan's own tiles leave it: it can plan fewer (a street stops the approach sooner)
			bill.exact = false;
			notes.add("lot " + lot.id() + " (" + entry + "): " + b.standingOutside() + " fill or approach cell(s) already hold their block: billed (an upper "
				+ "bound: the realise plans its approach over the land as the plan's tiles leave it, and pays each cell it plans)");
		}
		if (!b.exact()) {
			bill.exact = false;
			List<String> why = new ArrayList<>(b.inexactBecause());
			if (!b.driftCells().isEmpty()) {
				why.add(b.driftCells().size() + " drift cell(s), e.g. " + b.driftCells().get(0));
			}
			if (!v.typed().isEmpty()) {
				why.add(v.typed().get(0).message());
			}
			notes.add("lot " + lot.id() + " (" + entry + ") may differ: " + String.join("; ", why));
		}
		// (M5 FK, S-M5-3) a given-program entry's declared containers' fill items: billed once at the fill, exact
		dev.larattalabs.architect.site.Fills.Spec fill = dev.larattalabs.architect.site.Fills.ofEntry(bp.id());
		if (fill != null && !fill.billed().isEmpty()) {
			bill.add("fill:" + lot.id(), fill.billed()); // (FK-b) the provided items are never billed
		}
		if (mech && site == null) {
			String bpId = entry.contains("@") ? entry.substring(0, entry.indexOf('@')) : entry;
			bill.add("mech:" + lot.id(), PlanChecks.mechanismBill(ir, lot.id(), bpId));
		}
	}

	/** (QL-c) A lot's dry-run verdict over {@code lo}'s land (its states, its tiles as region ground, its walk cells as road cells). */
	private static Sites.Verdict verdictOver(ServerLevel level, Blueprint bp, BlockPos origin, Rotation rot, QItem q, RegionRec rec,
		dev.larattalabs.architect.api.@Nullable SiteSpec site, @Nullable EntranceStyle style, it.unimi.dsi.fastutil.longs.LongSet roadCells, Land land, LandOf lo) {
		it.unimi.dsi.fastutil.longs.LongOpenHashSet roads = new it.unimi.dsi.fastutil.longs.LongOpenHashSet(roadCells);
		roads.addAll(lo.walk());
		EntranceStyle lotStyle = style != null && style.regionGroup() == null && !lo.land().tiles().isEmpty() ? new EntranceStyle(style.path(), style.foundation(),
			"quote:" + land.planId) : style;
		Sites.QUOTE_ROADS.set(roads);
		dev.larattalabs.architect.site.QuoteLand.QUOTE.set(lo.land());
		try {
			return SiteFit.with(site, rec.groupId, () -> Sites.verdict(level, bp, origin, rot, q.force, null, true, true, true, rec.owner, lotStyle, false));
		} finally {
			Sites.QUOTE_ROADS.remove();
			dev.larattalabs.architect.site.QuoteLand.QUOTE.remove();
		}
	}

	private static @Nullable String revisionRegion(RegionsImpl.PlanRec p) {
		return p.planned().get("revisionOf") instanceof JsonObject ro ? RegionsImpl.str(ro, "region", "") : null;
	}

	private static Map<String, Integer> items(JsonElement e) {
		Map<String, Integer> out = new TreeMap<>();
		if (e instanceof JsonObject o) {
			o.entrySet().forEach(x -> out.put(x.getKey(), x.getValue().getAsInt()));
		}
		return out;
	}

	/** The pieces and their sum. */
	static final class Bill {
		final JsonObject parts = new JsonObject();
		private final Map<String, Integer> sum = new TreeMap<>();
		boolean exact = true;

		void add(String part, Map<String, Integer> items) {
			if (items.isEmpty()) {
				return;
			}
			JsonObject o = parts.get(part) instanceof JsonObject q ? q : new JsonObject();
			new TreeMap<>(items).forEach((k, v) -> {
				if (v != 0) {
					o.addProperty(k, (o.has(k) ? o.get(k).getAsInt() : 0) + v);
					sum.merge(k, v, Integer::sum);
				}
			});
			if (!o.isEmpty()) {
				parts.add(part, o);
			}
		}

		JsonObject bom() {
			JsonObject o = new JsonObject();
			sum.forEach((k, v) -> {
				if (v != 0) {
					o.addProperty(k, v);
				}
			});
			return o;
		}
	}
}

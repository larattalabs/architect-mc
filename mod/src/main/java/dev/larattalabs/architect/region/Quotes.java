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
		String mayHold = mayAlreadyHold(tiles, standing.covered());
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
					lot(level, rec, eff, lot, entry, entries, style, roadCells, bill, notes, false);
					bound.put(lotId, entry);
				}
			}
		}
		for (Ir.Lot lot : ir.lots()) {
			String entry = entries.get(lot.id());
			if (entry == null) {
				continue; // a pad: its paid cells are the tiles'
			}
			lot(level, rec, ir, lot, entry, entries, style, roadCells, bill, notes, !revision);
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
		return new Quote(p.planId(), sha, revision ? rec.id : null, true, bill.bom(), bill.parts, bound, bill.exact, notes);
	}

	/** (SA, A11) The common terrain blocks, besides the tag rule ({@link CellCond#natural}): a grade's or a fill's usual materials. */
	private static final java.util.Set<net.minecraft.world.level.block.Block> TERRAIN = java.util.Set.of(net.minecraft.world.level.block.Blocks.DIRT,
		net.minecraft.world.level.block.Blocks.GRASS_BLOCK, net.minecraft.world.level.block.Blocks.COARSE_DIRT, net.minecraft.world.level.block.Blocks.ROOTED_DIRT,
		net.minecraft.world.level.block.Blocks.PODZOL, net.minecraft.world.level.block.Blocks.MYCELIUM, net.minecraft.world.level.block.Blocks.DIRT_PATH,
		net.minecraft.world.level.block.Blocks.MUD, net.minecraft.world.level.block.Blocks.STONE, net.minecraft.world.level.block.Blocks.DEEPSLATE,
		net.minecraft.world.level.block.Blocks.GRANITE, net.minecraft.world.level.block.Blocks.DIORITE, net.minecraft.world.level.block.Blocks.ANDESITE,
		net.minecraft.world.level.block.Blocks.TUFF, net.minecraft.world.level.block.Blocks.SAND, net.minecraft.world.level.block.Blocks.RED_SAND,
		net.minecraft.world.level.block.Blocks.GRAVEL, net.minecraft.world.level.block.Blocks.CLAY, net.minecraft.world.level.block.Blocks.SANDSTONE,
		net.minecraft.world.level.block.Blocks.RED_SANDSTONE, net.minecraft.world.level.block.Blocks.NETHERRACK, net.minecraft.world.level.block.Blocks.SNOW_BLOCK);

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
	 * (BC, A11) The plan's kept paid terrain cells read against the world now: per group the items of the cells whose block already stands
	 * ({@code off}: a realise skips them), the items of every kept cell ({@code covered}) and how many could not be read (chunk not loaded).
	 */
	record Standing(Map<String, Map<String, Integer>> off, Map<String, Map<String, Integer>> covered, int offCells, int unloaded) {
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
					if (now == want) {
						offCells++;
						Map<String, Integer> o = off.computeIfAbsent(g.getKey(), k -> new TreeMap<>());
						its.forEach((k, v) -> o.merge(k, v, Integer::sum));
					}
				}
			}
		}
		return new Standing(off, covered, offCells, unloaded);
	}

	/** A bound lot's bill (and, on a first realise, its gate mechanism's), as the realise puts it down. */
	private static void lot(ServerLevel level, RegionRec rec, Ir ir, Ir.Lot lot, String entry, Map<String, String> entries, @Nullable EntranceStyle style,
		it.unimi.dsi.fastutil.longs.LongSet roadCells, Bill bill, List<String> notes, boolean mech) {
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
		Sites.QUOTE_ROADS.set(roadCells);
		try {
			v = SiteFit.with(site, rec.groupId, () -> Sites.verdict(level, bp, origin, rot, q.force, null, true, true, true, rec.owner, style, false));
		} finally {
			Sites.QUOTE_ROADS.remove();
		}
		Sites.BomFull b = Sites.quoteBill(level, bp, v, dev.larattalabs.architect.site.LotMask.cells(q.ext));
		if (b == null) {
			bill.exact = false;
			notes.add("lot " + lot.id() + " (" + entry + "): no construction plan over the land now" + (v.typed().isEmpty() ? "" : " (" + v.typed().get(0)
				.message() + ")") + ": not billed");
			return;
		}
		bill.add("lot:" + lot.id(), b.items());
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
		if (fill != null) {
			bill.add("fill:" + lot.id(), fill.items());
		}
		if (mech && site == null) {
			String bpId = entry.contains("@") ? entry.substring(0, entry.indexOf('@')) : entry;
			bill.add("mech:" + lot.id(), PlanChecks.mechanismBill(ir, lot.id(), bpId));
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

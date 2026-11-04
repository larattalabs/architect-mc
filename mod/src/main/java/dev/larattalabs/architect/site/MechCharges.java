package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.batch.QBatch;
import dev.larattalabs.architect.batch.QItem;
import dev.larattalabs.architect.region.RegionsImpl;
import it.unimi.dsi.fastutil.longs.LongLinkedOpenHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.piston.PistonMovingBlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

/**
 * (7a GM-a2, docs/CONTRACT.md "Slice GM" §16 item 1, as built) A survival region's gate mechanisms, by the RS fluids charge's model
 * (RegionFluids §7.3): the mechanism item ({@code mech:<lot>}, a region cell site, INSTANT) is <b>held</b> until its gatehouse lot's
 * construction site is built, then until its exact bill (picked at bind: {@code GateMech.Plan.bill}) is in the owner's stockpile; then the
 * bill is <b>charged</b> at once and the settled rest state written in one go with no update (a construction queue could not build a circuit
 * cell by cell without firing it). The region record keeps {@code survival.mech {<lot>: {bill, charged?, chargedAt?}}}.
 *
 * <ul>
 * <li><b>Outstanding:</b> an uncharged bill is the stockpile's need ({@code <region>:mech:<lot>}), so it accepts the items and lists them.</li>
 * <li><b>Standing:</b> a charged mechanism's items as they stand in the world (the audit's paid standing): its written cells and the closed
 * state's lane cells, counted as an item multiset (a moving piston as the block it carries, a piston head nothing, the dynamic properties
 * ignored), capped per item at the charge.</li>
 * <li><b>Refund:</b> at the group removal's rule 7 (before the undo), the standing tally, credited once its restore is written (keyed
 * {@code region:<id>@<createdAt>:mech:<lot>}, once). A block the player mined is not refunded (the no-dupe rule): nothing touched, the
 * refund equals the charge.</li>
 * </ul>
 * Server thread.
 */
public final class MechCharges {
	private MechCharges() {
	}

	/** The survival record's member. */
	public static final String KEY = "mech";
	/** (GM-b) A K1 swing gate's mechanism item and site: the gate's id (a gatehouse's names its lot, {@code architect_mc:lot}). */
	public static final String EXT_GATE = "architect_mc:gate";
	/** (GM-b) A K1 swing gate's mechanism item: its columns [x0, z0, x1, z1] (RegionTargets' stage wait reads them). */
	public static final String EXT_ROI = "architect_mc:roi";
	/** A region gate mechanism's cell site kind. */
	public static final String KIND = Infra.CELLS + "architect:mechanism";

	static @Nullable JsonObject entry(RegionsImpl.@Nullable Live l, @Nullable String lot) {
		if (l == null || lot == null || l.rec().survival == null || !(l.rec().survival.get(KEY) instanceof JsonObject m)) {
			return null;
		}
		return m.get(lot) instanceof JsonObject e ? e : null;
	}

	static Map<String, Integer> items(@Nullable JsonElement o) {
		Map<String, Integer> out = new TreeMap<>();
		if (o instanceof JsonObject j) {
			j.entrySet().forEach(e -> out.put(e.getKey(), e.getValue().getAsInt()));
		}
		return out;
	}

	private static JsonObject json(Map<String, Integer> m) {
		JsonObject o = new JsonObject();
		new TreeMap<>(m).forEach(o::addProperty);
		return o;
	}

	/** What written states cost in survival ({@link Cells#cost}), summed per item, in code-point order. */
	public static java.util.SortedMap<String, Integer> billOf(BlockState[] states) {
		TreeMap<String, Integer> out = new TreeMap<>();
		for (BlockState s : states) {
			for (var c : Cells.cost(s)) {
				out.merge(c.item(), c.count(), Integer::sum);
			}
		}
		return out;
	}

	/** The refund's credit key. */
	static String creditKey(RegionsImpl.Live l, String lot) {
		return "region:" + l.rec().id + "@" + l.rec().createdAt + ":mech:" + lot;
	}

	/**
	 * The hold ({@code Batches.tryStart0}, after the region's stage wait): true while the mechanism item waits, SITE_BUSY, for its lot to be
	 * built (with C25's waitsFor, the lot as its target) or for its bill in the stockpile (naming what it lacks). When both hold, the bill
	 * is charged and recorded (saved before the write, so a restart never charges twice) and the item goes on to its INSTANT write.
	 */
	static boolean hold(MinecraftServer srv, QBatch b, QItem i) {
		if (!"cells".equals(i.itemKind) || i.key == null || !i.key.startsWith("mech:")) {
			return false;
		}
		String region = RegionItems.regionOf(b);
		RegionsImpl.Live l = region == null ? null : RegionsImpl.live(region);
		String lot = i.key.substring(5);
		JsonObject e = entry(l, lot);
		if (l == null || !l.rec().survival() || e == null || e.has("chargedAt")) {
			return false;
		}
		QItem li = b.item("lot:" + lot);
		Site site = li == null || li.siteId == null ? null : Sites.get(li.siteId);
		if (li == null && i.ext.has(EXT_GATE)) {
			// ((GM-b) a K1 swing gate: no lot; the stage wait (RegionTargets, the item's roi) has held it until the wall's tiles round it are
			// built; here, until they are all put down)
			for (String k : i.after) {
				QItem a = b.item(k);
				if (a != null && a.status != QItem.Status.PLACED) {
					Batches.waitFor(b, i, Reason.SITE_BUSY, "the gate mechanism of gate " + lot + " waits for " + k
						+ " to be built: a survival region writes a gate's swing once, after the wall it stands in");
					return true;
				}
			}
		} else if (li == null || li.status != QItem.Status.PLACED || site == null || site.placing() || site.building()) {
			String target = li != null && li.siteId != null ? li.siteId : "lot:" + lot;
			RegionTargets.waitFor(b, i, target, "lot " + lot, Batches::waitFor, "the gate mechanism of lot " + lot + " waits for its gatehouse (" + target
				+ ") to be built: a survival region writes a gate's circuit once, after the building it stands in");
			return true;
		}
		if (i.ext.has(RegionTargets.EXT_WAITS_FOR)) {
			i.ext.remove(RegionTargets.EXT_WAITS_FOR);
		}
		Map<String, Integer> bill = items(e.get("bill"));
		String owner = l.rec().owner;
		if (!Stockpiles.charge(srv, owner, bill)) {
			Batches.waitFor(b, i, Reason.SITE_BUSY, "the gate mechanism of " + (li == null ? "gate " : "lot ") + lot + " waits for " + Stockpiles.chargeShort(owner, bill)
				+ " in the stockpile of " + (owner == null ? "the player" : owner) + " (its whole bill is charged at once, then it is written in one go)");
			return true;
		}
		e.add("charged", json(bill));
		ServerLevel level = Sites.levelOf(srv, i.dimension);
		e.addProperty("chargedAt", level == null ? 0L : level.getGameTime());
		RegionsImpl.saveRec(l);
		dev.larattalabs.architect.Architect.LOGGER.info("Region {}: the gate mechanism of lot {} took its bill {} from the stockpile of {}", l.rec().id, lot,
			bill, owner);
		return false;
	}

	/** Per {@code <region>:mech:<lot>}, the bills an owner's survival regions still have to charge (the stockpile's need). */
	public static Map<String, Map<String, Integer>> pendingCharges(@Nullable String owner) {
		Map<String, Map<String, Integer>> out = new TreeMap<>();
		for (RegionsImpl.Live l : RegionsImpl.all()) {
			if (!l.rec().survival() || !Objects.equals(owner, l.rec().owner) || l.rec().state == dev.larattalabs.architect.api.RegionState.REMOVING || l.rec().state
				== dev.larattalabs.architect.api.RegionState.REMOVED || !(l.rec().survival.get(KEY) instanceof JsonObject m)) {
				continue;
			}
			for (var en : m.entrySet()) {
				if (en.getValue() instanceof JsonObject e && !e.has("chargedAt")) {
					Map<String, Integer> bill = items(e.get("bill"));
					if (!bill.isEmpty()) {
						out.put(l.rec().id + ":mech:" + en.getKey(), bill);
					}
				}
			}
		}
		return out;
	}

	/** What an owner's survival regions' charged mechanisms hold as they stand (the audit's paid standing). Loaded chunks only. */
	public static Map<String, Integer> standing(MinecraftServer srv, @Nullable String owner) {
		Map<String, Integer> out = new TreeMap<>();
		for (RegionsImpl.Live l : RegionsImpl.all()) {
			if (!l.rec().survival() || !Objects.equals(owner, l.rec().owner) || !(l.rec().survival.get(KEY) instanceof JsonObject m)) {
				continue;
			}
			ServerLevel level = l.level(srv);
			if (level == null) {
				continue;
			}
			for (var en : m.entrySet()) {
				if (!(en.getValue() instanceof JsonObject e) || !e.has("charged") || e.has("refunded")) {
					continue;
				}
				Infra inf = siteOf(l, en.getKey());
				if (inf != null) {
					tally(level, l, en.getKey(), inf, items(e.get("charged"))).forEach((k, v) -> out.merge(k, v, Integer::sum));
				}
			}
		}
		return out;
	}

	/** The region's standing mechanism site of {@code lot} (its record, or one being removed), or null. */
	static @Nullable Infra siteOf(RegionsImpl.Live l, String lot) {
		String group = l.rec().groupId;
		for (Infra inf : Infras.all()) {
			if (KIND.equals(inf.kind()) && Objects.equals(group, inf.group()) && lot.equals(idOf(inf))) {
				return inf;
			}
		}
		return null;
	}

	/** A mechanism site's lot (a gatehouse's) or gate (GM-b, a K1 swing gate's) id, or null. */
	static @Nullable String idOf(Infra inf) {
		if (inf.ext().get("architect_mc:lot") instanceof JsonPrimitive p) {
			return p.getAsString();
		}
		return inf.ext().get(EXT_GATE) instanceof JsonPrimitive g ? g.getAsString() : null;
	}

	/**
	 * The items a mechanism holds as it stands: over its written cells and its closed state's lane cells, each block's survival cost (a
	 * moving piston as the block it carries; a piston head nothing), summed, capped per item at {@code cap}. Pure but for the reads.
	 */
	static Map<String, Integer> tally(ServerLevel level, RegionsImpl.Live l, String lot, Infra inf, @Nullable Map<String, Integer> cap) {
		LongLinkedOpenHashSet cells = new LongLinkedOpenHashSet();
		JsonObject e = entry(l, lot);
		if (e != null && e.get("cells") instanceof JsonArray a) {
			for (int k = 0; k + 2 < a.size(); k += 3) {
				cells.add(BlockPos.asLong(a.get(k).getAsInt(), a.get(k + 1).getAsInt(), a.get(k + 2).getAsInt()));
			}
		}
		for (long p : closedCells(l, lot)) {
			cells.add(p);
		}
		Map<String, Integer> got = new TreeMap<>();
		for (long p : cells) {
			BlockPos bp = BlockPos.of(p);
			if (!level.isLoaded(bp)) {
				continue;
			}
			BlockState s = level.getBlockState(bp);
			if (s.is(Blocks.MOVING_PISTON)) {
				s = level.getBlockEntity(bp) instanceof PistonMovingBlockEntity m ? m.getMovedState() : Blocks.AIR.defaultBlockState();
			}
			for (var c : Cells.cost(s)) {
				got.merge(c.item(), c.count(), Integer::sum);
			}
		}
		if (cap == null) {
			return got;
		}
		Map<String, Integer> out = new TreeMap<>();
		cap.forEach((k, v) -> {
			int n = Math.min(v, got.getOrDefault(k, 0));
			if (n > 0) {
				out.put(k, n);
			}
		});
		return out;
	}

	/**
	 * (DevBridge {@code dev.gm.state}) A region's gate mechanism of {@code lot}: its record ({@code survival.mech.<lot>}), its site, its cell
	 * count and what stands of it now, uncapped ({@code built}). Null when the region is gone.
	 */
	public static @Nullable JsonObject view(MinecraftServer srv, String region, String lot) {
		RegionsImpl.Live l = RegionsImpl.live(region);
		if (l == null) {
			return null;
		}
		JsonObject o = new JsonObject();
		JsonObject e = entry(l, lot);
		if (e != null) {
			JsonObject r = e.deepCopy();
			r.remove("cells");
			o.add("record", r);
		}
		QBatch b = l.rec().batchId == null ? null : Batches.get(l.rec().batchId);
		QItem i = b == null ? null : b.item("mech:" + lot);
		if (i != null) {
			JsonObject it = new JsonObject();
			it.addProperty("status", i.status.name());
			if (i.reason != null) {
				it.addProperty("reason", i.reason);
			}
			it.addProperty("message", String.valueOf(i.message));
			if (i.ext.get(RegionTargets.EXT_WAITS_FOR) instanceof JsonObject w) {
				it.add("waitsFor", w.deepCopy());
			}
			o.add("item", it);
		}
		Infra inf = siteOf(l, lot);
		ServerLevel level = l.level(srv);
		if (inf != null && level != null) {
			o.addProperty("site", inf.id());
			o.addProperty("cells", e != null && e.get("cells") instanceof JsonArray a ? a.size() / 3 : 0);
			o.add("built", json(tally(level, l, lot, inf, null)));
		}
		return o;
	}

	/** The IR lot's {@code onWall.passage.mechanism.states.closed} cells (world, flat runs [x, z, y0, y1]). */
	static List<Long> closedCells(RegionsImpl.Live l, String lot) {
		List<Long> out = new java.util.ArrayList<>();
		if (l.ir().json().get("lots") instanceof JsonArray lots) {
			for (JsonElement e : lots) {
				if (e instanceof JsonObject lo && lo.get("id") instanceof JsonPrimitive id && lot.equals(id.getAsString()) && lo.get("onWall") instanceof JsonObject w
					&& w.get("passage") instanceof JsonObject p && p.get("mechanism") instanceof JsonObject m && m.get("states") instanceof JsonObject st
					&& st.get("closed") instanceof JsonArray r) {
					for (int i = 0; i + 3 < r.size(); i += 4) {
						for (int y = r.get(i + 2).getAsInt(); y <= r.get(i + 3).getAsInt(); y++) {
							out.add(BlockPos.asLong(r.get(i).getAsInt(), y, r.get(i + 1).getAsInt()));
						}
					}
				}
			}
		}
		return out;
	}

	/**
	 * The group removal's rule 7 for a region gate mechanism's cell site (before the undo is planned): its refund, the standing tally
	 * capped at the charge, credited under its key once its restore is written; null when it is not one, or nothing was charged.
	 */
	static Groups.@Nullable Credit refund(ServerLevel level, Infra inf) {
		String lot = KIND.equals(inf.kind()) ? idOf(inf) : null;
		if (lot == null) {
			return null;
		}
		RegionsImpl.Live l = null;
		for (RegionsImpl.Live x : RegionsImpl.all()) {
			if (Objects.equals(x.rec().groupId, inf.group())) {
				l = x;
			}
		}
		JsonObject e = entry(l, lot);
		if (l == null || e == null || !e.has("charged")) {
			return null;
		}
		Map<String, Integer> items = tally(level, l, lot, inf, items(e.get("charged")));
		e.add("refund", json(items));
		e.addProperty("refunded", true);
		RegionsImpl.saveRec(l);
		BlockPos at = BlockPos.containing(inf.box().minX(), inf.box().maxY() + 1, inf.box().minZ());
		dev.larattalabs.architect.Architect.LOGGER.info("Region {}: the gate mechanism of lot {} refunds {} (charged {})", l.rec().id, lot, items, e.get(
			"charged"));
		return new Groups.Credit(l.rec().owner == null ? "" : l.rec().owner, creditKey(l, lot), Map.copyOf(items), at.asLong());
	}
}

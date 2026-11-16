package dev.larattalabs.architect.site;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.survival.StockLedger;
import dev.larattalabs.architect.survival.SurvivalItems;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import org.jspecify.annotations.Nullable;

/**
 * (BC, S-M5-9; BC-d) A survival realise's {@code maxBill} while it builds. Since BC-d a cap covers only the realise or revision it came with:
 * the region record keeps one per rid ({@code survival.caps.<rid>.maxBill}; rid 0 is the first realise), and a target of the region's group
 * is held to the cap of its own rid (its ext {@code architect_mc:revision.rid}; none: 0). A rid's draws are its own targets' paid records in
 * the stockpile ledger (net of a swap's or a removal's refunds) and (BC-c) the region's own charges made for that rid (its fluids'
 * {@code survival.charged} with {@code chargedRid}, its gate mechanisms' charged bills); an item the cap does not name may not be drawn. Past it,
 * the stockpile purse answers no stock: the target waits STARVED, typed {@link dev.larattalabs.architect.api.SiteWait#BILL_CAP}. A revision
 * without a maxBill has no cap (its rid's entry is cleared at its realise), however its siblings were realised. A record from before BC-d
 * (one region-wide {@code survival.maxBill}, {@code billBase}) is read as the cap of rid 0 when its base is empty (a first realise), else of
 * the region's head revision, counting that rid's own draws (the old base no longer applies).
 */
public final class BillCaps {
	private BillCaps() {
	}

	/**
	 * A cap: the most its rid's targets may draw, a base (empty since BC-d: a rid counts its own draws), and (BC-c) the region's own charges counted in its draws
	 * ({@code charged}: its fluids' and gate mechanisms' charges made for that rid).
	 */
	public record Cap(String region, String group, int rid, Map<String, Integer> max, Map<String, Integer> base, Map<String, Integer> charged) {
		public Cap(String region, String group, Map<String, Integer> max, Map<String, Integer> base) {
			this(region, group, 0, max, base, Map.of());
		}

		/** What the rid's targets may still draw of {@code item}, given its draws {@code drawn} ({@link #drawn(StockLedger, Cap)}). */
		public int left(Map<String, Integer> drawn, String item) {
			return Math.max(0, room(drawn, item));
		}

		/** (BC-c) {@link #left} unclamped: negative by the units the draws are past the cap (a reconcile's standing cells). */
		public int room(Map<String, Integer> drawn, String item) {
			int used = drawn.getOrDefault(item, 0) - base.getOrDefault(item, 0);
			return max.getOrDefault(item, 0) - Math.max(0, used);
		}

		/** (BC-c) The items the draws are past the cap, with the units over; empty within it. */
		public Map<String, Integer> overshoot(Map<String, Integer> drawn) {
			Map<String, Integer> out = new TreeMap<>();
			java.util.Set<String> items = new java.util.TreeSet<>(drawn.keySet());
			items.addAll(max.keySet());
			for (String k : items) {
				int r = room(drawn, k);
				if (r < 0) {
					out.put(k, -r);
				}
			}
			return out;
		}
	}

	/** (BC-d) The region record's per-rid caps: {@code survival.caps {<rid>: {maxBill}}}. */
	static final String CAPS = "caps";
	/** (BC-c) The rid the region's fluids were charged for ({@code survival.chargedRid}; absent: 0). */
	public static final String CHARGED_RID = "chargedRid";

	/**
	 * (BC-d) The cap of realise or revision {@code rid}: {@code cap} recorded under its rid, or, null, its rid's cap cleared (a revision without a
	 * maxBill is uncapped). A record from before BC-d is moved to its rid first ({@code headRid}: the region's head before this realise).
	 */
	public static void record(JsonObject survival, int rid, @Nullable Map<String, Integer> cap, int headRid) {
		migrate(survival, headRid);
		JsonObject caps = survival.get(CAPS) instanceof JsonObject c ? c : new JsonObject();
		if (cap == null) {
			caps.remove(Integer.toString(rid));
		} else {
			JsonObject e = new JsonObject();
			e.add("maxBill", json(cap));
			caps.add(Integer.toString(rid), e);
		}
		if (caps.size() == 0) {
			survival.remove(CAPS);
		} else {
			survival.add(CAPS, caps);
		}
	}

	/**
	 * (BC-d) A record from before BC-d (one region-wide maxBill) moved to its rid's entry; no change otherwise. (fix b5b, review P2) Run when
	 * the record loads ({@code RegionRec.fromJson}, with the head it was saved with), so the cap's owner is fixed once: a later head change (an
	 * undo, a revision) never moves it. Returns whether it moved one.
	 */
	public static boolean migrate(JsonObject survival, int headRid) {
		if (!(survival.get("maxBill") instanceof JsonObject mb)) {
			return false;
		}
		int rid = legacyRid(survival, headRid);
		JsonObject caps = survival.get(CAPS) instanceof JsonObject c ? c : new JsonObject();
		if (!caps.has(Integer.toString(rid))) {
			JsonObject e = new JsonObject();
			e.add("maxBill", mb.deepCopy());
			caps.add(Integer.toString(rid), e);
		}
		survival.add(CAPS, caps);
		survival.remove("maxBill");
		survival.remove("billBase");
		return true;
	}

	private static int legacyRid(JsonObject survival, int headRid) {
		return survival.get("billBase") instanceof JsonObject b && b.size() > 0 ? headRid : 0;
	}

	/** (BC-d) The cap entries a region record keeps, per rid (a record from before BC-d read in place). */
	static Map<Integer, JsonObject> entries(@Nullable JsonObject survival, int headRid) {
		Map<Integer, JsonObject> out = new TreeMap<>();
		if (survival == null) {
			return out;
		}
		if (survival.get(CAPS) instanceof JsonObject caps) {
			for (var e : caps.entrySet()) {
				if (e.getValue() instanceof JsonObject x) {
					out.put(Integer.parseInt(e.getKey()), x);
				}
			}
		}
		if (survival.get("maxBill") instanceof JsonObject mb) {
			JsonObject e = new JsonObject();
			e.add("maxBill", mb);
			out.putIfAbsent(legacyRid(survival, headRid), e);
		}
		return out;
	}

	/**
	 * (BC-c) A survival region's own charges made for {@code rid}, out of its record: its fluids' charge ({@code survival.charged}, once per
	 * region, for {@code chargedRid}) and each gate mechanism's charged bill not refunded ({@code survival.mech.<lot>.charged}, for its
	 * {@code rid}; absent: 0). Neither is a target's paid record in the ledger.
	 */
	public static Map<String, Integer> regionCharged(@Nullable JsonObject survival, int rid) {
		Map<String, Integer> out = new TreeMap<>();
		if (survival == null) {
			return out;
		}
		if (ridIn(survival.get(CHARGED_RID)) == rid) {
			items(survival.get("charged")).forEach((k, v) -> out.merge(k, v, Integer::sum));
		}
		if (survival.get(MechCharges.KEY) instanceof JsonObject m) {
			for (var e : m.entrySet()) {
				if (e.getValue() instanceof JsonObject x && x.has("charged") && !x.has("refunded") && ridIn(x.get("rid")) == rid) {
					items(x.get("charged")).forEach((k, v) -> out.merge(k, v, Integer::sum));
				}
			}
		}
		return out;
	}

	private static int ridIn(@Nullable JsonElement e) {
		return e != null && e.isJsonPrimitive() ? e.getAsInt() : 0;
	}

	private static JsonObject json(Map<String, Integer> m) {
		JsonObject o = new JsonObject();
		new TreeMap<>(m).forEach(o::addProperty);
		return o;
	}

	private static Map<String, Integer> items(@Nullable JsonElement e) {
		Map<String, Integer> out = new TreeMap<>();
		if (e instanceof JsonObject o) {
			o.entrySet().forEach(x -> out.put(x.getKey(), x.getValue().getAsInt()));
		}
		return out;
	}

	/** The group of a construction target (a lot site or a region's road or cell target), or null. */
	static @Nullable String groupOf(Object t) {
		Site.Member m = t instanceof Site s ? s.member() : t instanceof Infra i ? i.member() : null;
		return m == null ? null : m.group();
	}

	/** (BC-d) The rid of a target: its ext's {@code architect_mc:revision.rid} (a revision's site, road or cell target), else 0. */
	public static int ridOf(@Nullable JsonObject ext) {
		return ext != null && ext.get(dev.larattalabs.architect.region.Revisions.EXT_REVISION) instanceof JsonObject rv ? ridIn(rv.get("rid")) : 0;
	}

	static int ridOf(Object t) {
		return ridOf(t instanceof Site s ? s.ext() : t instanceof Infra i ? i.ext() : null);
	}

	/** The cap over target {@code t} (its region's cap for its own rid), or null (no region, no cap for its rid, creative). */
	static @Nullable Cap of(Object t) {
		String group = groupOf(t);
		var g = group == null ? null : Sites.group(group);
		String region = g != null && g.ext().has(RegionItems.EXT_REGION) ? g.ext().get(RegionItems.EXT_REGION).getAsString() : null;
		var live = region == null ? null : dev.larattalabs.architect.region.RegionsImpl.live(region);
		return live == null ? null : capOf(region, group, ridOf(t), live.rec().survival, live.rec().headRid);
	}

	/** (BC-d) The cap a region record keeps for {@code rid}, or null. */
	public static @Nullable Cap ofRegionRecord(String region, String group, int rid, @Nullable JsonObject sv, int headRid) {
		return capOf(region, group, rid, sv, headRid);
	}

	static @Nullable Cap capOf(String region, String group, int rid, @Nullable JsonObject sv, int headRid) {
		JsonObject e = entries(sv, headRid).get(rid);
		if (e == null || !(e.get("maxBill") instanceof JsonObject mb)) {
			return null;
		}
		// (BC-d) a rid's own draws: an old record's base (the group's draws at the revision) no longer applies
		return new Cap(region, group, rid, items(mb), Map.of(), regionCharged(sv, rid));
	}

	/** (BC-c, BC-d) A live region's cap for {@code rid}, or null (no cap, creative). */
	public static @Nullable Cap ofRegion(dev.larattalabs.architect.region.RegionsImpl.@Nullable Live live, int rid) {
		return live == null ? null : capOf(live.rec().id, live.rec().groupId, rid, live.rec().survival, live.rec().headRid);
	}

	/** (BC-c, BC-d) A rid's draws as its cap counts them: its own targets' paid records and the region's own charges for it. */
	public static Map<String, Integer> drawn(StockLedger ledger, Cap cap) {
		Map<String, Integer> out = drawn(ledger, cap.group(), cap.rid());
		cap.charged().forEach((k, v) -> out.merge(k, v, Integer::sum));
		return out;
	}

	/**
	 * (BC-c) Whether a region charge of {@code bill} fits its cap now (the region's fluids or a gate mechanism, charged at once): the items past
	 * it with the units over, empty when it fits (or there is no cap). Nothing is charged here.
	 */
	public static Map<String, Integer> chargeOver(@Nullable Cap cap, @Nullable StockLedger ledger, Map<String, Integer> bill) {
		Map<String, Integer> out = new TreeMap<>();
		if (cap == null || ledger == null) {
			return out;
		}
		Map<String, Integer> d = drawn(ledger, cap);
		bill.forEach((k, v) -> {
			int o = v - cap.left(d, k);
			if (v > 0 && o > 0) {
				out.put(k, o);
			}
		});
		return out;
	}

	/**
	 * What the targets of {@code group} have drawn from {@code ledger}, net (their paid records: {@code site:<id>@<t>}, {@code road:<id>@<t>}).
	 */
	public static Map<String, Integer> drawn(StockLedger ledger, String group) {
		Map<String, Integer> out = new TreeMap<>();
		ledger.paid().forEach((key, its) -> {
			if (group.equals(groupOfKey(key))) {
				its.forEach((k, v) -> out.merge(k, v, Integer::sum));
			}
		});
		return out;
	}

	/** (BC-d) What the targets of {@code group} with rid {@code rid} have drawn from {@code ledger}, net. */
	public static Map<String, Integer> drawn(StockLedger ledger, String group, int rid) {
		Map<String, Integer> out = new TreeMap<>();
		ledger.paid().forEach((key, its) -> {
			Object t = targetOfKey(key);
			if (t != null && group.equals(groupOf(t)) && ridOf(t) == rid) {
				its.forEach((k, v) -> out.merge(k, v, Integer::sum));
			}
		});
		return out;
	}

	/** The group of a paid record's key, or null when its target is gone. */
	static @Nullable String groupOfKey(String key) {
		Object t = targetOfKey(key);
		return t == null ? null : groupOf(t);
	}

	/** A paid record's target ({@code site:<id>@<t>}, {@code road:<id>@<t>}), or null when it is gone. */
	static @Nullable Object targetOfKey(String key) {
		int c = key.indexOf(':'), at = key.lastIndexOf('@');
		if (c < 0 || at <= c) {
			return null;
		}
		String id = key.substring(c + 1, at);
		return key.startsWith("site:") ? Sites.get(id) : Infras.get(id);
	}

	/**
	 * The capped items a run's unbuilt cells still need past what the cap leaves (item -> units over), for the wait's {@code nextNeeded}; empty
	 * when the cap does not hold it back.
	 */
	static Map<String, Integer> over(Builder.Run r, Cap cap, Map<String, Integer> drawn) {
		Map<String, Integer> need = new TreeMap<>();
		for (int i = r.built.nextClearBit(0); i < r.size(); i = r.built.nextClearBit(i + 1)) {
			List<SurvivalItems.Cost> c = r.cost.get(i);
			for (SurvivalItems.Cost x : c) {
				need.merge(x.item(), x.count(), Integer::sum);
			}
		}
		r.fillOwed.forEach((k, v) -> need.merge(k, v, Integer::sum));
		Map<String, Integer> out = new TreeMap<>();
		need.forEach((k, v) -> {
			int o = v - cap.room(drawn, k); // (BC-c) past the cap (a reconcile's standing cells): the units the cap must rise to finish
			if (o > 0) {
				out.put(k, o);
			}
		});
		return out;
	}

	/**
	 * (TEST, {@code dev.bc.cap}) A region's cap state for one rid ({@code rid}; default: the highest rid with a cap, else 0): its cap, its
	 * draws (paid records and the region's own charges), its overshoot, every rid's cap, and every target of the group with its rid and wait;
	 * with {@code set}, that rid's cap is replaced first (the gate's stand-in for draws that pass the approved bound). Server thread.
	 */
	public static JsonObject devState(net.minecraft.server.MinecraftServer srv, String region, @Nullable Integer ridArg, @Nullable Map<String, Integer> set) {
		JsonObject o = new JsonObject();
		var live = dev.larattalabs.architect.region.RegionsImpl.live(region);
		if (live == null || live.rec().survival == null) {
			o.addProperty("refused", "no survival region " + region);
			return o;
		}
		var rec = live.rec();
		Map<Integer, JsonObject> all0 = entries(rec.survival, rec.headRid);
		int rid = ridArg != null ? ridArg : all0.isEmpty() ? 0 : ((TreeMap<Integer, JsonObject>) all0).lastKey();
		if (set != null) {
			record(rec.survival, rid, set, rec.headRid);
			dev.larattalabs.architect.region.RegionsImpl.saveRec(live);
		}
		Cap cap = capOf(region, rec.groupId, rid, rec.survival, rec.headRid);
		o.addProperty("rid", rid);
		o.addProperty("createdAt", rec.createdAt); // (fix b5b) the record's identity: a gate's expected caps are this record's
		o.add("maxBill", cap == null ? null : json(cap.max()));
		o.add("billBase", cap == null ? null : json(cap.base()));
		JsonObject caps = new JsonObject();
		entries(rec.survival, rec.headRid).forEach((k, v) -> caps.add(Integer.toString(k), v.deepCopy()));
		o.add("caps", caps);
		var pile = Stockpiles.get(rec.owner);
		Map<String, Integer> paid = pile == null ? Map.of() : drawn(pile.ledger(), rec.groupId, rid);
		o.add("paid", json(paid)); // the rid's own targets' paid records alone
		o.add("regionCharged", json(regionCharged(rec.survival, rid))); // (BC-c) the region's own charges for the rid (fluids, gate mechanisms)
		Map<String, Integer> sum = cap == null || pile == null ? paid : drawn(pile.ledger(), cap);
		o.add("drawn", json(sum));
		o.add("overshoot", json(cap == null ? Map.of() : cap.overshoot(sum)));
		com.google.gson.JsonArray ts = new com.google.gson.JsonArray();
		java.util.List<Object> targets = new java.util.ArrayList<>(Sites.all());
		targets.addAll(Infras.all());
		for (Object t : targets) {
			if (!rec.groupId.equals(groupOf(t))) {
				continue;
			}
			String id = t instanceof Site st ? st.id() : ((Infra) t).id();
			var w = SiteWaits.view(srv, id);
			if (w == null) {
				continue;
			}
			JsonObject x = SiteWaits.json(w, null);
			x.addProperty("id", id);
			x.addProperty("rid", ridOf(t));
			ts.add(x);
		}
		o.add("targets", ts);
		return o;
	}
}

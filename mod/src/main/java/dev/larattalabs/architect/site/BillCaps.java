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
 * (BC, S-M5-9) A survival realise's {@code maxBill} while it builds: the region record keeps the cap ({@code survival.maxBill}) and what
 * its group had drawn when it was realised ({@code survival.billBase}: empty for a new region, the standing draws for a revision). A target
 * of the region's group may draw an item only while the group's draws since then (its targets' paid records in the stockpile ledger, net
 * of a swap's or a removal's refunds) stay within the cap; an item the cap does not name may not be drawn. Past it, the stockpile purse
 * answers no stock: the target waits STARVED, typed {@link dev.larattalabs.architect.api.SiteWait#BILL_CAP}.
 */
public final class BillCaps {
	private BillCaps() {
	}

	/**
	 * A region's cap: the most its group may draw, what it had drawn at the realise, and (BC-c) the region's own charges counted in its draws
	 * ({@code charged}: its fluids' and gate mechanisms' charges, for a cap recorded since BC-c; empty for an older one, whose base left them out).
	 */
	public record Cap(String region, String group, Map<String, Integer> max, Map<String, Integer> base, Map<String, Integer> charged) {
		public Cap(String region, String group, Map<String, Integer> max, Map<String, Integer> base) {
			this(region, group, max, base, Map.of());
		}

		/** What the group may still draw of {@code item}, given its draws {@code drawn} ({@link #drawn(StockLedger, Cap)}). */
		public int left(Map<String, Integer> drawn, String item) {
			return Math.max(0, room(drawn, item));
		}

		/** (BC-c) {@link #left} unclamped: negative by the units the group's draws are past the cap (a reconcile's standing cells). */
		public int room(Map<String, Integer> drawn, String item) {
			int used = drawn.getOrDefault(item, 0) - base.getOrDefault(item, 0);
			return max.getOrDefault(item, 0) - Math.max(0, used);
		}

		/** (BC-c) The items the group's draws are past the cap, with the units over; empty within it. */
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

	/** (BC-c) The region record's member that says its draws count the region's own charges (and its base, for a revision, includes them). */
	static final String REGION_CHARGES = "billRegion";

	/** The region record's survival members for a cap ({@code survival.maxBill}, {@code survival.billBase}, BC-c's {@code billRegion}). */
	public static void record(JsonObject survival, Map<String, Integer> cap, Map<String, Integer> base) {
		survival.add("maxBill", json(cap));
		survival.add("billBase", json(base));
		survival.addProperty(REGION_CHARGES, true);
	}

	/**
	 * (BC-c) A survival region's own charges, out of its record: its fluids' charge ({@code survival.charged}, once per region) and each gate
	 * mechanism's charged bill not refunded ({@code survival.mech.<lot>.charged}). Neither is a target's paid record in the ledger.
	 */
	public static Map<String, Integer> regionCharged(@Nullable JsonObject survival) {
		Map<String, Integer> out = new TreeMap<>();
		if (survival == null) {
			return out;
		}
		items(survival.get("charged")).forEach((k, v) -> out.merge(k, v, Integer::sum));
		if (survival.get(MechCharges.KEY) instanceof JsonObject m) {
			for (var e : m.entrySet()) {
				if (e.getValue() instanceof JsonObject x && x.has("charged") && !x.has("refunded")) {
					items(x.get("charged")).forEach((k, v) -> out.merge(k, v, Integer::sum));
				}
			}
		}
		return out;
	}

	/** (BC-c) A revision's base: its group's draws now, the region's own charges with them. */
	public static Map<String, Integer> base(StockLedger ledger, String group, @Nullable JsonObject survival) {
		Map<String, Integer> out = drawn(ledger, group);
		regionCharged(survival).forEach((k, v) -> out.merge(k, v, Integer::sum));
		return out;
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

	/** The cap over target {@code t}'s region, or null (no region, no cap, creative). */
	static @Nullable Cap of(Object t) {
		String group = groupOf(t);
		var g = group == null ? null : Sites.group(group);
		String region = g != null && g.ext().has(RegionItems.EXT_REGION) ? g.ext().get(RegionItems.EXT_REGION).getAsString() : null;
		var live = region == null ? null : dev.larattalabs.architect.region.RegionsImpl.live(region);
		JsonObject sv = live == null ? null : live.rec().survival;
		return capOf(region, group, sv);
	}

	/** (BC-c) The cap a region record keeps ({@code survival.maxBill}), or null. */
	public static @Nullable Cap ofRegionRecord(String region, String group, @Nullable JsonObject sv) {
		return capOf(region, group, sv);
	}

	static @Nullable Cap capOf(String region, String group, @Nullable JsonObject sv) {
		if (sv == null || !(sv.get("maxBill") instanceof JsonObject mb)) {
			return null;
		}
		boolean counts = sv.has(REGION_CHARGES) && sv.get(REGION_CHARGES).getAsBoolean();
		return new Cap(region, group, items(mb), items(sv.get("billBase")), counts ? regionCharged(sv) : Map.of());
	}

	/** (BC-c) A live region's cap, or null (no cap, creative). */
	public static @Nullable Cap ofRegion(dev.larattalabs.architect.region.RegionsImpl.@Nullable Live live) {
		return live == null ? null : capOf(live.rec().id, live.rec().groupId, live.rec().survival);
	}

	/** (BC-c) The group's draws as its cap counts them: its targets' paid records and the region's own charges. */
	public static Map<String, Integer> drawn(StockLedger ledger, Cap cap) {
		Map<String, Integer> out = drawn(ledger, cap.group());
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

	/** The group of a paid record's key, or null when its target is gone. */
	static @Nullable String groupOfKey(String key) {
		int c = key.indexOf(':'), at = key.lastIndexOf('@');
		if (c < 0 || at <= c) {
			return null;
		}
		String id = key.substring(c + 1, at);
		Object t = key.startsWith("site:") ? Sites.get(id) : Infras.get(id);
		return t == null ? null : groupOf(t);
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
	 * (TEST, {@code dev.bc.cap}) A region's cap state: its cap and base, its group's draws, and every target of the group with its wait; with
	 * {@code set}, the region's cap is replaced first (the gate's stand-in for draws that pass the approved bound). Server thread.
	 */
	public static JsonObject devState(net.minecraft.server.MinecraftServer srv, String region, @Nullable Map<String, Integer> set) {
		JsonObject o = new JsonObject();
		var live = dev.larattalabs.architect.region.RegionsImpl.live(region);
		if (live == null || live.rec().survival == null) {
			o.addProperty("refused", "no survival region " + region);
			return o;
		}
		var rec = live.rec();
		if (set != null) {
			Map<String, Integer> base = items(rec.survival.get("billBase"));
			record(rec.survival, set, base);
			dev.larattalabs.architect.region.RegionsImpl.saveRec(live);
		}
		o.add("maxBill", rec.survival.get("maxBill") == null ? null : rec.survival.get("maxBill").deepCopy());
		o.add("billBase", rec.survival.get("billBase") == null ? null : rec.survival.get("billBase").deepCopy());
		var pile = Stockpiles.get(rec.owner);
		Cap cap = capOf(region, rec.groupId, rec.survival);
		Map<String, Integer> paid = pile == null ? Map.of() : drawn(pile.ledger(), rec.groupId);
		o.add("paid", json(paid)); // (BC-c) the group's paid records alone
		o.add("regionCharged", json(regionCharged(rec.survival))); // (BC-c) the region's own charges (fluids, gate mechanisms)
		o.addProperty("countsRegion", cap != null && rec.survival.has(REGION_CHARGES));
		Map<String, Integer> sum = cap == null || pile == null ? paid : drawn(pile.ledger(), cap);
		o.add("drawn", json(sum));
		o.add("overshoot", json(cap == null ? Map.of() : cap.overshoot(sum)));
		com.google.gson.JsonArray ts = new com.google.gson.JsonArray();
		java.util.List<Object> all = new java.util.ArrayList<>(Sites.all());
		all.addAll(Infras.all());
		for (Object t : all) {
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
			ts.add(x);
		}
		o.add("targets", ts);
		return o;
	}
}

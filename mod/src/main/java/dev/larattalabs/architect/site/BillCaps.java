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

	/** A region's cap: the most its group may draw, and what it had drawn at the realise. */
	public record Cap(String region, String group, Map<String, Integer> max, Map<String, Integer> base) {
		/** What the group may still draw of {@code item}, given its draws {@code drawn} (ledger paid, summed over the group). */
		public int left(Map<String, Integer> drawn, String item) {
			int used = drawn.getOrDefault(item, 0) - base.getOrDefault(item, 0);
			return Math.max(0, max.getOrDefault(item, 0) - Math.max(0, used));
		}
	}

	/** The region record's survival members for a cap ({@code survival.maxBill}, {@code survival.billBase}). */
	public static void record(JsonObject survival, Map<String, Integer> cap, Map<String, Integer> base) {
		survival.add("maxBill", json(cap));
		survival.add("billBase", json(base));
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
		if (sv == null || !(sv.get("maxBill") instanceof JsonObject mb)) {
			return null;
		}
		return new Cap(region, group, items(mb), items(sv.get("billBase")));
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
			int o = v - cap.left(drawn, k);
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
		o.add("drawn", json(pile == null ? Map.of() : drawn(pile.ledger(), rec.groupId)));
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

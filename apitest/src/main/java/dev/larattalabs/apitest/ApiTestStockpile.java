package dev.larattalabs.apitest;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.ArchitectRefused;
import dev.larattalabs.architect.api.RemoveResult;
import dev.larattalabs.architect.api.SiteEvents;
import dev.larattalabs.architect.api.Sites;
import dev.larattalabs.architect.api.Stockpile;
import dev.larattalabs.architect.api.StockpileRequest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.world.item.Item;

/**
 * The 6c slice Y1 API checks (docs/CONTRACT.md "Phase 6c slice Y", C24, API 1.17.0), through dev.larattalabs.architect.api only:
 * <pre>
 * apiy1                                  version, the features, Limits.STOCKPILE_CRATES
 * pcreate {owner, crates: [[x,y,z]...]}    Sites.createStockpile (the player's dimension)
 * paddcrate &lt;owner&gt; &lt;x&gt; &lt;y&gt; &lt;z&gt;           Sites.addStockpileCrate
 * premove &lt;owner&gt; &lt;x&gt; &lt;y&gt; &lt;z&gt; [force]     Sites.removeStockpileCrate
 * pstate &lt;owner&gt;                          Sites.stockpile (null when none)
 * porder &lt;owner&gt; [ids...]                 Sites.setFeedOrder with ids, else Sites.feedOrder
 * pwithdraw &lt;owner&gt; {item: n}              Sites.withdraw to the player
 * padopt &lt;owner&gt;                          Sites.adoptCrates
 * pdissolve &lt;owner&gt; [player]               Sites.dissolveStockpile (to the player, else dropped)
 * apic29                                 (C29) version and features
 * ppause &lt;targetId&gt; &lt;true|false&gt;           (C29) Sites.pause; answers {paused}
 * </pre>
 * Refusals answer {@code {refused: {reason, message}}}. STOCKPILE_CHANGED is recorded in {@code /apitest events}.
 */
final class ApiTestStockpile {
	private ApiTestStockpile() {
	}

	static void register() {
		SiteEvents.STOCKPILE_CHANGED.register(owner -> {
			JsonObject o = new JsonObject();
			o.addProperty("owner", owner);
			ApiTest.event("STOCKPILE_CHANGED", o);
		});
	}

	static JsonElement step(CommandSourceStack src, String[] a) {
		ArchitectApi api = ArchitectApi.get();
		Sites sites = api.sites(src.getServer());
		try {
			switch (a[0]) {
				case "apiy1": {
					JsonObject o = new JsonObject();
					o.addProperty("version", ArchitectApi.VERSION);
					JsonArray f = new JsonArray();
					api.features().stream().sorted().forEach(f::add);
					o.add("features", f);
					o.addProperty("stockpileCrates", dev.larattalabs.architect.api.Limits.STOCKPILE_CRATES);
					return o;
				}
				case "pcreate": {
					JsonObject j = JsonParser.parseString(a[1]).getAsJsonObject();
					List<BlockPos> crates = new ArrayList<>();
					j.getAsJsonArray("crates").forEach(e -> {
						JsonArray p = e.getAsJsonArray();
						crates.add(new BlockPos(p.get(0).getAsInt(), p.get(1).getAsInt(), p.get(2).getAsInt()));
					});
					return pile(sites.createStockpile(new StockpileRequest(j.get("owner").getAsString(), src.getLevel().dimension(), crates)));
				}
				case "paddcrate":
					return pile(sites.addStockpileCrate(a[1], src.getLevel().dimension(), new BlockPos(Integer.parseInt(a[2]), Integer.parseInt(a[3]), Integer
						.parseInt(a[4]))));
				case "premove": {
					RemoveResult r = sites.removeStockpileCrate(a[1], new BlockPos(Integer.parseInt(a[2]), Integer.parseInt(a[3]), Integer.parseInt(a[4])),
						a.length > 5 && a[5].equals("force"));
					JsonObject o = new JsonObject();
					o.addProperty("removed", r.removed());
					JsonArray b = new JsonArray();
					r.blockers().forEach(b::add);
					o.add("blockers", b);
					o.add("refund", items(r.refund()));
					return o;
				}
				case "pstate":
					return sites.stockpile(a[1]).map(ApiTestStockpile::pile).orElse(null);
				case "porder": {
					List<String> order = a.length > 2 ? sites.setFeedOrder(a[1], List.of(java.util.Arrays.copyOfRange(a, 2, a.length))) : sites.feedOrder(a[1]);
					JsonArray o = new JsonArray();
					order.forEach(o::add);
					return o;
				}
				case "pwithdraw": {
					Map<Item, Integer> want = new LinkedHashMap<>();
					JsonParser.parseString(a[2]).getAsJsonObject().entrySet().forEach(e -> want.put(item(e.getKey()), e.getValue().getAsInt()));
					return items(sites.withdraw(a[1], want, src.getPlayerOrException()));
				}
				case "padopt":
					return pile(sites.adoptCrates(a[1]));
				case "pdissolve":
					return items(sites.dissolveStockpile(a[1], a.length > 2 && a[2].equals("player") ? src.getPlayerOrException() : null));
				case "apic29": {
					JsonObject o = new JsonObject();
					o.addProperty("version", ArchitectApi.VERSION);
					JsonArray f = new JsonArray();
					api.features().stream().sorted().forEach(f::add);
					o.add("features", f);
					return o;
				}
				case "ppause": {
					boolean on = a.length < 3 || !a[2].equals("false");
					sites.pause(a[1], on);
					JsonObject o = new JsonObject();
					o.addProperty("paused", on);
					return o;
				}
				default:
					throw new IllegalArgumentException("unknown stockpile step " + a[0]);
			}
		} catch (ArchitectRefused e) {
			JsonObject o = new JsonObject();
			JsonObject r = new JsonObject();
			r.addProperty("reason", e.reason().name());
			r.addProperty("message", e.getMessage());
			o.add("refused", r);
			return o;
		} catch (com.mojang.brigadier.exceptions.CommandSyntaxException e) {
			throw new IllegalStateException(e.getMessage());
		}
	}

	static Item item(String id) {
		return BuiltInRegistries.ITEM.getValue(Identifier.parse(id));
	}

	static JsonObject items(Map<Item, Integer> m) {
		Map<String, Integer> s = new TreeMap<>();
		m.forEach((k, v) -> s.put(BuiltInRegistries.ITEM.getKey(k).toString(), v));
		JsonObject o = new JsonObject();
		s.forEach(o::addProperty);
		return o;
	}

	static JsonArray pos(List<BlockPos> ps) {
		JsonArray a = new JsonArray();
		for (BlockPos p : ps) {
			JsonArray x = new JsonArray();
			x.add(p.getX());
			x.add(p.getY());
			x.add(p.getZ());
			a.add(x);
		}
		return a;
	}

	static JsonObject pile(Stockpile p) {
		JsonObject o = new JsonObject();
		o.addProperty("owner", p.owner());
		o.addProperty("dimension", p.dimension().identifier().toString());
		o.add("crates", pos(p.crates()));
		o.addProperty("capacityStacks", p.capacityStacks());
		o.addProperty("usedStacks", p.usedStacks());
		o.add("stock", items(p.stock()));
		o.add("reserved", items(p.reserved()));
		o.add("credit", items(p.credit()));
		o.add("delivered", items(p.delivered()));
		o.add("consumed", items(p.consumed()));
		o.add("returned", items(p.returned()));
		o.add("withdrawn", items(p.withdrawn()));
		o.add("dropped", items(p.dropped()));
		o.add("refundOverflow", items(p.refundOverflow()));
		JsonObject byT = new JsonObject();
		p.outstandingByTarget().forEach((k, v) -> byT.add(k, items(v)));
		o.add("outstandingByTarget", byT);
		o.add("outstanding", items(p.outstanding()));
		JsonArray f = new JsonArray();
		p.feedOrder().forEach(f::add);
		o.add("feedOrder", f);
		o.addProperty("waiting", p.waiting().size());
		o.add("missingCrates", pos(p.missingCrates()));
		return o;
	}
}

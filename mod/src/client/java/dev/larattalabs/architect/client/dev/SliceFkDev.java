package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.site.Fills;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.Container;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.entity.BlockEntity;

/**
 * M5 slice FK DevBridge hooks (docs/DEVBRIDGE.md "M5 FK"): a filled-container site's state, and a player's hand in a container (take
 * from it, add to it) as a gate needs. Headless (genHooks). Kill points FK1..FK4 and FKC1..FKC2 are armed with {@code dev.journal.killAt}.
 */
public final class SliceFkDev {
	private SliceFkDev() {
	}

	public static void init() {
		DevBridge.register("dev.fk.state", 30_000, "{site} - (M5 FK) a fill site: {phase, hasFill, key, filled, custody, paid, fillItems, containers: [{at, declared, "
			+ "holds}], locks: [{at, state}]}", (req, mc) -> {
				String id = Fields.of(req).nonBlank("site");
				return ServerTasks.callOnServer(s -> Fills.stateJson(s, id));
			});
		DevBridge.register("dev.fk.container", 30_000, "{pos: [x, y, z], take?: {item: count}, add?: {item: count}, clear?: bool} - (M5 FK) TEST: a player's "
			+ "hand in the container at pos (takes from any slot; adds into free slots); answers {holds: {item: count}}", (req, mc) -> {
				JsonElement pe = req.get("pos");
				if (pe == null || !pe.isJsonArray() || pe.getAsJsonArray().size() != 3) {
					throw new DevBridge.DevException("pos must be [x, y, z]");
				}
				JsonArray pa = pe.getAsJsonArray();
				BlockPos p = new BlockPos(pa.get(0).getAsInt(), pa.get(1).getAsInt(), pa.get(2).getAsInt());
				return ServerTasks.callOnServer(s -> {
					ServerLevel level = s.overworld();
					BlockEntity be = level.getBlockEntity(p);
					if (!(be instanceof Container c)) {
						JsonObject o = new JsonObject();
						o.addProperty("error", "no container at " + p.toShortString());
						return o;
					}
					if (req.has("clear") && req.get("clear").getAsBoolean()) {
						c.clearContent();
					}
					if (req.has("take")) {
						for (var e : req.getAsJsonObject("take").entrySet()) {
							int left = e.getValue().getAsInt();
							for (int i = 0; i < c.getContainerSize() && left > 0; i++) {
								ItemStack st = c.getItem(i);
								if (!st.isEmpty() && BuiltInRegistries.ITEM.getKey(st.getItem()).toString().equals(e.getKey())) {
									int n = Math.min(left, st.getCount());
									st.shrink(n);
									c.setItem(i, st.isEmpty() ? ItemStack.EMPTY : st);
									left -= n;
								}
							}
						}
					}
					if (req.has("add")) {
						for (var e : req.getAsJsonObject("add").entrySet()) {
							var item = BuiltInRegistries.ITEM.getValue(Identifier.parse(e.getKey()));
							int left = e.getValue().getAsInt();
							for (int i = 0; i < c.getContainerSize() && left > 0; i++) {
								ItemStack st = c.getItem(i);
								if (st.isEmpty()) {
									int n = Math.min(left, item.getDefaultMaxStackSize());
									c.setItem(i, new ItemStack(item, n));
									left -= n;
								} else if (st.is(item) && st.getCount() < st.getMaxStackSize()) {
									int n = Math.min(left, st.getMaxStackSize() - st.getCount());
									st.grow(n);
									left -= n;
								}
							}
						}
					}
					be.setChanged();
					Map<String, Integer> holds = new TreeMap<>();
					for (int i = 0; i < c.getContainerSize(); i++) {
						ItemStack st = c.getItem(i);
						if (!st.isEmpty()) {
							holds.merge(BuiltInRegistries.ITEM.getKey(st.getItem()).toString(), st.getCount(), Integer::sum);
						}
					}
					JsonObject o = new JsonObject();
					JsonObject h = new JsonObject();
					holds.forEach(h::addProperty);
					o.add("holds", h);
					return o;
				});
			});
	}
}

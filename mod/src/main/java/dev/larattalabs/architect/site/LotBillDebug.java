package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.placement.Blueprint;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

/**
 * (QL-b, a gate hook's reader) {@link Sites#quoteBill}'s lot bill taken apart, to find which cells move it between two quotes: the bill per
 * piece (template cells, TerrainFit fill, approach fill/path/slabs), every template cell whose billed state is not its template state (a
 * shape update, a cut, the mask), the fill and cut cells with the world at each, and the mobs on or near the box. Read-only. Server thread.
 */
public final class LotBillDebug {
	private LotBillDebug() {
	}

	/** At most this many cells are listed per list. */
	static final int MAX = 64;

	public static @Nullable JsonObject of(ServerLevel level, Blueprint bp, Sites.Verdict v, it.unimi.dsi.fastutil.longs.@Nullable LongSet masked) {
		if (v.plan() == null || !v.construction()) {
			return null;
		}
		FullBom.Inputs in = FullBom.inputs(level, bp, v.plan());
		FullBom.Result r = FullBom.of(level, bp, v.plan());
		if (r == null) {
			return null;
		}
		JsonObject o = new JsonObject();
		java.util.Set<Long> tpl = new java.util.HashSet<>(), fill = new java.util.HashSet<>(), appr = new java.util.HashSet<>();
		Map<String, Integer> tplItems = new TreeMap<>(), fillItems = new TreeMap<>(), apprItems = new TreeMap<>(), otherItems = new TreeMap<>();
		JsonArray changed = new JsonArray();
		int maskedTpl = 0;
		for (int i = 0; i < in.templateStates().length; i++) {
			long p = BlockPos.asLong(in.templateXyz()[3 * i], in.templateXyz()[3 * i + 1], in.templateXyz()[3 * i + 2]);
			tpl.add(p);
			BlockState want = in.templateStates()[i].rotate(in.rotation());
			if (want.isAir()) {
				continue;
			}
			boolean m = masked != null && masked.contains(p);
			if (m) {
				maskedTpl++;
				continue;
			}
			BlockState fin = r.states().get(p);
			if (fin == null || fin != want) {
				if (changed.size() < MAX) {
					JsonObject c = cell(level, p);
					c.addProperty("template", Packed(want));
					c.addProperty("billed", fin == null ? "(not billed: air)" : Packed(fin));
					changed.add(c);
				}
			}
		}
		add(in.fill(), fill);
		add(in.approachFill(), appr);
		add(in.approachPath(), appr);
		add(in.approachSlabs(), appr);
		for (var e : r.states().entrySet()) {
			long p = e.getKey();
			if (masked != null && masked.contains(p)) {
				continue;
			}
			Map<String, Integer> to = tpl.contains(p) ? tplItems : fill.contains(p) ? fillItems : appr.contains(p) ? apprItems : otherItems;
			for (dev.larattalabs.architect.survival.SurvivalItems.Cost k : Cells.cost(RegionTargets.dry(e.getValue()))) {
				to.merge(k.item(), k.count(), Integer::sum);
			}
		}
		o.add("template", obj(tplItems));
		o.add("fill", obj(fillItems));
		o.add("approach", obj(apprItems));
		o.add("other", obj(otherItems));
		o.addProperty("maskedTemplateCells", maskedTpl);
		o.add("changed", changed);
		o.add("fillCells", cells(level, in.fill()));
		o.add("cutCells", cells(level, in.clear()));
		o.add("approachPath", cells(level, in.approachPath()));
		o.add("approachFill", cells(level, in.approachFill()));
		o.add("approachClear", cells(level, in.approachClear()));
		o.addProperty("exact", r.exact() && v.refusals().isEmpty());
		JsonArray why = new JsonArray();
		r.inexactBecause().forEach(why::add);
		r.driftCells().forEach(d -> why.add("drift " + d));
		v.refusals().forEach(x -> why.add("refusal " + x));
		o.add("why", why);
		var box = v.plan().box();
		JsonArray mobs = new JsonArray();
		net.minecraft.world.phys.AABB bb = new net.minecraft.world.phys.AABB(box.minX() - 4, box.minY() - 2, box.minZ() - 4, box.maxX() + 5, box.maxY() + 3, box.maxZ() + 5);
		for (Entity e : level.getEntities((Entity) null, bb, e -> e.isAlive() && !(e instanceof net.minecraft.world.entity.player.Player))) {
			BlockPos b = e.blockPosition();
			mobs.add(net.minecraft.core.registries.BuiltInRegistries.ENTITY_TYPE.getKey(e.getType()).getPath() + "@" + b.getX() + "," + b.getY() + "," + b.getZ());
		}
		o.add("mobs", mobs);
		JsonArray bx = new JsonArray();
		for (int n : new int[] {box.minX(), box.minY(), box.minZ(), box.maxX(), box.maxY(), box.maxZ()}) {
			bx.add(n);
		}
		o.add("box", bx);
		return o;
	}

	private static String Packed(BlockState s) {
		return net.minecraft.commands.arguments.blocks.BlockStateParser.serialize(s);
	}

	private static void add(int[] xyz, java.util.Set<Long> to) {
		for (int i = 0; i + 2 < xyz.length; i += 3) {
			to.add(BlockPos.asLong(xyz[i], xyz[i + 1], xyz[i + 2]));
		}
	}

	private static JsonObject cell(ServerLevel level, long p) {
		JsonObject c = new JsonObject();
		BlockPos b = BlockPos.of(p);
		c.addProperty("at", b.getX() + "," + b.getY() + "," + b.getZ());
		c.addProperty("world", level.hasChunk(b.getX() >> 4, b.getZ() >> 4) ? Packed(level.getBlockState(b)) : "(not loaded)");
		c.addProperty("above", level.hasChunk(b.getX() >> 4, b.getZ() >> 4) ? Packed(level.getBlockState(b.above())) : "(not loaded)");
		return c;
	}

	private static JsonObject cells(ServerLevel level, int[] xyz) {
		JsonObject o = new JsonObject();
		o.addProperty("n", xyz.length / 3);
		JsonArray a = new JsonArray();
		for (int i = 0; i + 2 < xyz.length && a.size() < MAX; i += 3) {
			a.add(cell(level, BlockPos.asLong(xyz[i], xyz[i + 1], xyz[i + 2])));
		}
		o.add("cells", a);
		return o;
	}

	private static JsonObject obj(Map<String, Integer> m) {
		JsonObject o = new JsonObject();
		m.forEach(o::addProperty);
		return o;
	}
}

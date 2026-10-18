package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.batch.QBatch;
import dev.larattalabs.architect.batch.QItem;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.site.Batches;
import dev.larattalabs.architect.site.RegionItems;
import it.unimi.dsi.fastutil.longs.Long2IntOpenHashMap;
import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.commands.arguments.blocks.BlockStateParser;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.FallingBlock;
import net.minecraft.world.level.block.LiquidBlock;
import net.minecraft.world.level.block.LiquidBlockContainer;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.Fluid;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.level.material.Fluids;
import net.minecraft.world.phys.AABB;
import org.jspecify.annotations.Nullable;

/**
 * The {@code fluids} stage of a region (docs/CONTRACT.md "Phase 6c slice H" §2.3-§4): its bodies (the IR's {@code fluid} ops) are
 * written as tiles of the last stage, and this class does what surrounds them. Server thread throughout.
 * <ul>
 * <li><b>The gate</b> ({@link #gate}, before any tile of the stage starts): a body is never written over an entity (a player in a body's
 * box grown by 1 waits PLAYER_IN_BOX, a villager or an animal OCCUPIED, a hostile mob is removed); then the realise-time containment
 * check (§2.4): every shell cell holds what its tile wrote (the region's own top journal cell, or, a cell the tile found already so,
 * natural fluid-stopping ground no protected area covers), no gravity block, and every join is still a water source. A body that
 * fails is never written (its cells leave the stage's tiles, {@link #filter}) and is reported {@code drained} with the reason
 * {@code uncontained} and up to 16 cells. Before a source is written, every passing body's cells, ice cap, spill and watched cells
 * (the single breach's reach) have their states captured, and the fluids of the watch set (its cells, shell, spill and watched cells
 * grown by 2): the region's {@code fluids.json}, saved first.</li>
 * <li><b>The forced tick</b> (§3.2): once every tile of the stage is placed, one fluid tick on every source and every face neighbour of
 * one (writes skip updates: without it a leaky basin would never leak).</li>
 * <li><b>Settle and census</b> (§3.3): a body is settled when no fluid tick is scheduled in its watch set and the census equals the
 * prediction exactly (every source where planned, every flowing cell at its predicted level, no other fluid that was not there before
 * the write); the region's batch holds ({@link #holding}) until every body is settled or drained, so PLACED waits for the water.</li>
 * <li><b>The escape guard</b> (§3.4): fluid outside the body's cells, spill and joins, or no settle within 2 x settleTicks: the body is
 * drained at once ({@link #drain}: its sources and ice back to their before states, the watched cells holding new fluid restored) and
 * reported {@code drained}, the region PARTIAL.</li>
 * <li><b>The removal</b> (§4.1, {@link #removalGate}, before a group undo is planned): every body drained first, in reverse plan order,
 * then one settle bound with no fluid tick scheduled in any watch set, then the group undo of the solids, shells included. The phase is
 * saved, so a crash between the drain and the solids resumes the wait (kill point {@code FL3}).</li>
 * </ul>
 * The report: the region's ext {@code architect_mc:fluids}, {@code [{part, body, state: "settled" | "drained", reason, at, sources,
 * spill, settledAt}]} per body that ended (Steward's S-H-6 shape plus extras).
 */
public final class RegionFluids {
	public static final String STAGE = "fluids";
	/** RegionView ext key (Architect's): the per-body report. */
	public static final String EXT = "architect_mc:fluids";
	/** At most this many cells are named in a body's report. */
	static final int NAMED = 16;
	/** The watch set: the body's cells, shell, spill and watched cells grown by this much (Chebyshev). */
	static final int WATCH_GROW = 2;
	/** How often (ticks) a settling body's census runs. */
	static final int CENSUS_EVERY = 5;
	/** DevBridge {@code dev.fluid.bypass} (gate item 2's negative control): the containment check is not run (every body is written). */
	public static volatile boolean bypassCheck;
	/** DevBridge {@code dev.fluid.beforeGate} (gate item 3): run once, at the next fluids gate, right before its containment check. */
	public static volatile java.util.function.@Nullable Consumer<ServerLevel> beforeCheck;
	private static final Map<String, Regional> STATE = new HashMap<>();

	private RegionFluids() {
	}

	/** One body of a region's IR. */
	static final class Body {
		String id = "";
		@Nullable String part;
		boolean lava;
		int level;
		long[] cells = new long[0];
		long[] ice = new long[0];
		long[] shell = new long[0];
		long[] spill = new long[0];
		long[] joins = new long[0];
		long[] watch = new long[0];
		final Long2IntOpenHashMap predicted = new Long2IntOpenHashMap();
		int settleTicks;
		@Nullable LongOpenHashSet watchSet;

		Fluid source() {
			return lava ? Fluids.LAVA : Fluids.WATER;
		}

		LongOpenHashSet watchSet() {
			if (watchSet == null) {
				LongOpenHashSet base = new LongOpenHashSet();
				for (long[] a : new long[][] {cells, shell, spill, watch}) {
					for (long p : a) {
						base.add(p);
					}
				}
				LongOpenHashSet out = new LongOpenHashSet();
				for (long p : base) {
					int x = BlockPos.getX(p), y = BlockPos.getY(p), z = BlockPos.getZ(p);
					for (int dx = -WATCH_GROW; dx <= WATCH_GROW; dx++) {
						for (int dy = -WATCH_GROW; dy <= WATCH_GROW; dy++) {
							for (int dz = -WATCH_GROW; dz <= WATCH_GROW; dz++) {
								out.add(BlockPos.asLong(x + dx, y + dy, z + dz));
							}
						}
					}
				}
				watchSet = out;
			}
			return watchSet;
		}

		LongOpenHashSet declared() {
			LongOpenHashSet s = new LongOpenHashSet();
			for (long[] a : new long[][] {cells, spill, joins}) {
				for (long p : a) {
					s.add(p);
				}
			}
			return s;
		}
	}

	/** A body's progress, saved. */
	static final class BodyState {
		String state = "pending"; // pending | written | settled | drained
		@Nullable String reason;
		final List<long[]> at = new ArrayList<>();
		long settledAt = -1;
		int sources;
		int spill;
		boolean escaped;
		/** Before the write: the cells', ice cap's, spill's and watched cells' states. */
		final Long2ObjectOpenHashMap<String> before = new Long2ObjectOpenHashMap<>();

		boolean ended() {
			return "settled".equals(state) || "drained".equals(state);
		}
	}

	/** A region's fluids: its bodies (from the IR) and its saved progress. */
	static final class Regional {
		final List<Body> bodies;
		String phase = "gate"; // gate | writing | settling | done
		long forcedAt = -1;
		final Map<String, BodyState> states = new LinkedHashMap<>();
		/** The watch sets' fluids before the write (state strings by position). */
		final Long2ObjectOpenHashMap<String> fluidBefore = new Long2ObjectOpenHashMap<>();
		/** The removal: null (not started), drained (waiting for the settle bound until {@link #until}), done. */
		@Nullable String removal;
		long until = -1;
		long lastCensus;
		/** This session drained already (a removal resumed after a stop drains again first). */
		boolean redrained;

		Regional(List<Body> bodies) {
			this.bodies = bodies;
			for (Body b : bodies) {
				states.put(b.id, new BodyState());
			}
		}

		/**
		 * The cells the region's other standing bodies plan (their sources, ice and predicted flow): a fountain's spout stands in its basin,
		 * so one body's census and drain leave them to their own body (never an escape, never drained for another body).
		 */
		LongOpenHashSet othersOf(Body b) {
			LongOpenHashSet out = new LongOpenHashSet();
			for (Body o : bodies) {
				BodyState os = states.get(o.id);
				if (o == b || os != null && "drained".equals(os.state)) {
					continue;
				}
				for (long p : o.cells) {
					out.add(p);
				}
				for (long p : o.ice) {
					out.add(p);
				}
				out.addAll(o.predicted.keySet());
			}
			return out;
		}
	}

	// ------------------------------------------------------------------ the bodies of an IR

	/** The IR's fluid bodies, in plan order (the fluids stage's parts' fluid ops). */
	static List<Body> bodiesOf(JsonObject ir) {
		List<Body> out = new ArrayList<>();
		if (!(ir.get("parts") instanceof JsonArray parts)) {
			return out;
		}
		for (JsonElement pe : parts) {
			JsonObject p = pe.getAsJsonObject();
			if (!(p.get("ops") instanceof JsonArray ops)) {
				continue;
			}
			for (JsonElement oe : ops) {
				JsonObject o = oe.getAsJsonObject();
				if (!"fluid".equals(RegionsImpl.str(o, "op", ""))) {
					continue;
				}
				Body b = new Body();
				b.id = RegionsImpl.str(o, "id", "body");
				b.part = o.get("part") instanceof JsonElement pp && pp.isJsonPrimitive() ? pp.getAsString() : null;
				b.lava = "lava".equals(RegionsImpl.str(o, "fluid", "water"));
				b.level = o.has("level") ? o.get("level").getAsInt() : 0;
				b.cells = runs(o.get("cells"));
				b.ice = runs(o.get("ice"));
				b.shell = runs(o.get("shell"));
				b.spill = runs(o.get("spill"));
				b.joins = runs(o.get("joins"));
				b.watch = runs(o.get("watch"));
				if (o.get("predicted") instanceof JsonArray pr) {
					for (JsonElement q : pr) {
						JsonArray c = q.getAsJsonArray();
						b.predicted.put(BlockPos.asLong(c.get(0).getAsInt(), c.get(1).getAsInt(), c.get(2).getAsInt()), c.get(3).getAsInt());
					}
				}
				b.settleTicks = o.has("settleTicks") ? o.get("settleTicks").getAsInt() : 100;
				out.add(b);
			}
		}
		return out;
	}

	/** Column runs [[x, z, y0, y1], ...] as packed positions. */
	static long[] runs(@Nullable JsonElement e) {
		if (!(e instanceof JsonArray a)) {
			return new long[0];
		}
		it.unimi.dsi.fastutil.longs.LongArrayList out = new it.unimi.dsi.fastutil.longs.LongArrayList();
		for (JsonElement r : a) {
			JsonArray q = r.getAsJsonArray();
			int x = q.get(0).getAsInt(), z = q.get(1).getAsInt(), y0 = q.get(2).getAsInt(), y1 = q.get(3).getAsInt();
			for (int y = y0; y <= y1; y++) {
				out.add(BlockPos.asLong(x, y, z));
			}
		}
		return out.toLongArray();
	}

	/** The region's fluids (loaded on first use), or null when its IR has no body. */
	static @Nullable Regional of(RegionsImpl.Live l) {
		Regional st = STATE.get(l.rec().id);
		if (st != null) {
			return st.bodies.isEmpty() ? null : st;
		}
		st = new Regional(bodiesOf(l.ir().json()));
		if (!st.bodies.isEmpty()) {
			load(l, st);
		}
		STATE.put(l.rec().id, st);
		return st.bodies.isEmpty() ? null : st;
	}

	/** Whether the region has fluid bodies. */
	public static boolean hasBodies(RegionsImpl.Live l) {
		return of(l) != null;
	}

	// ------------------------------------------------------------------ the gate

	/**
	 * Server thread (Batches, for a region batch whose running stage is approved): false while the {@code fluids} stage may not start
	 * (an entity in a body's box, or the check running); true for any other stage, a region without bodies, or once the stage is
	 * checked.
	 */
	public static boolean gate(MinecraftServer s, QBatch b, @Nullable String stage) {
		if (!STAGE.equals(stage) || !RegionItems.isRegion(b)) {
			return true;
		}
		RegionsImpl.Live l = RegionsImpl.live(b.ext.get(RegionItems.EXT_REGION).getAsString());
		Regional st = l == null ? null : of(l);
		if (st == null || !"gate".equals(st.phase)) {
			return true;
		}
		ServerLevel level = l.level(s);
		if (level == null) {
			return false;
		}
		// a body is never written over an entity (§2.3): players wait, hostile mobs go, the others wait
		for (Body body : st.bodies) {
			AABB box = boxOf(body.cells).inflate(1);
			for (ServerPlayer p : level.getEntitiesOfClass(ServerPlayer.class, box)) {
				if (!p.isSpectator()) {
					RegionItems.waitStage(b, STAGE, Reason.PLAYER_IN_BOX, "a player is in or next to fluid body " + body.id + " (" + p.getName().getString() + ")");
					return false;
				}
			}
			List<String> in = new ArrayList<>();
			for (Entity e : level.getEntities((Entity) null, box, e -> e instanceof LivingEntity && !(e instanceof ServerPlayer))) {
				if (e instanceof Enemy && !e.hasCustomName()) {
					e.discard();
					continue;
				}
				in.add(e.getType().getDescriptionId().replaceAll("^entity\\.minecraft\\.", ""));
			}
			if (!in.isEmpty()) {
				RegionItems.waitStage(b, STAGE, Reason.OCCUPIED, "in fluid body " + body.id + "'s box: " + String.join(", ", in) + " (move them out)");
				return false;
			}
		}
		// the realise-time containment check (§2.4), then the before states, saved before any source is written
		var hook = beforeCheck;
		if (hook != null) {
			beforeCheck = null;
			hook.accept(level);
		}
		for (Body body : st.bodies) {
			BodyState bs = st.states.get(body.id);
			if (!"pending".equals(bs.state)) {
				continue;
			}
			List<long[]> bad = bypassCheck ? List.of() : check(level, l, body);
			if (!bad.isEmpty()) {
				bs.state = "drained";
				bs.reason = "uncontained: " + bad.size() + "+ shell or join cell(s) do not hold what the body was checked against";
				bs.at.addAll(bad.subList(0, Math.min(NAMED, bad.size())));
				Architect.LOGGER.info("Region {}: fluid body {} is not written ({}): {}", l.rec().id, body.id, bs.reason, cells(bs.at));
				continue;
			}
			for (long[] a : new long[][] {body.cells, body.ice, body.spill, body.watch}) {
				for (long p : a) {
					bs.before.put(p, stateString(level.getBlockState(BlockPos.of(p))));
				}
			}
			for (long p : body.watchSet()) {
				BlockState w = level.getBlockState(BlockPos.of(p));
				if (!w.getFluidState().isEmpty()) {
					st.fluidBefore.put(p, stateString(w));
				}
			}
		}
		st.phase = "writing";
		save(l, st);
		report(l, st);
		WorldJournal.kill("FL1"); // the check and the before states saved, no source written
		Architect.LOGGER.info("Region {}: fluids stage checked ({} bod{}, {} not written)", l.rec().id, st.bodies.size(), st.bodies.size() == 1 ? "y" : "ies", st
			.states.values().stream().filter(x -> "drained".equals(x.state)).count());
		return true;
	}

	/**
	 * The containment check of one body (§2.4): the shell cells and joins that fail, as [x, y, z] (empty: it holds). A shell cell holds
	 * when the region's own top journal cell there holds in the world, or (a cell its tile found already so) no entry has a cell there,
	 * no protected area of the owner covers it, and the world holds natural, fluid-stopping, non-gravity ground; a join holds when it is
	 * still a water source.
	 */
	static List<long[]> check(ServerLevel level, RegionsImpl.Live l, Body body) {
		List<long[]> bad = new ArrayList<>();
		String dim = l.rec().dimension;
		var areas = dev.larattalabs.architect.site.Protected.of(dim, l.rec().owner);
		for (long p : body.shell) {
			BlockPos bp = BlockPos.of(p);
			BlockState now = level.getBlockState(bp);
			boolean ok;
			if (areas.stream().anyMatch(a -> a.contains(bp.getX(), bp.getZ()))) {
				bad.add(new long[] {bp.getX(), bp.getY(), bp.getZ()}); // a protected area marked since: never written against
				continue;
			}
			try {
				List<WorldJournal.Layer> stack = WorldJournal.stack(dim, p);
				if (!stack.isEmpty()) {
					WorldJournal.Layer top = stack.get(stack.size() - 1);
					ok = java.util.Objects.equals(top.meta().group(), l.rec().groupId) && top.cell().after() != null && WorldJournal.holds(level, p, top.cell()
						.after());
				} else {
					boolean protectedHere = areas.stream().anyMatch(a -> a.contains(bp.getX(), bp.getZ()));
					ok = !protectedHere && !now.hasBlockEntity() && dev.larattalabs.architect.placement.TerrainFit.flags(now) != 0;
				}
			} catch (IOException e) {
				ok = false;
			}
			if (ok) {
				ok = fluidStopping(level, bp, now) && !(now.getBlock() instanceof FallingBlock);
			}
			if (!ok) {
				bad.add(new long[] {bp.getX(), bp.getY(), bp.getZ()});
			}
		}
		for (long p : body.joins) {
			FluidState f = level.getBlockState(BlockPos.of(p)).getFluidState();
			if (!(f.isSource() && f.getType().isSame(Fluids.WATER))) {
				bad.add(new long[] {BlockPos.getX(p), BlockPos.getY(p), BlockPos.getZ(p)});
			}
		}
		return bad;
	}

	/**
	 * Fluid-stopping (26.3's FlowingFluid.canHoldFluid refuses it for flowing water and flowing lava): a liquid container that takes
	 * neither flowing fluid, or any other block outside the tag washed_away_by_fluids that holds no fluid (air and plants are in it).
	 */
	public static boolean fluidStopping(ServerLevel level, BlockPos p, BlockState s) {
		if (s.getBlock() instanceof LiquidBlockContainer c) {
			return !c.canPlaceLiquid(null, level, p, s, Fluids.FLOWING_WATER) && !c.canPlaceLiquid(null, level, p, s, Fluids.FLOWING_LAVA);
		}
		return !s.isAir() && !s.is(BlockTags.WASHED_AWAY_BY_FLUIDS) && s.getFluidState().isEmpty();
	}

	/** Server thread (RegionItems): a fluids-stage tile's cells without the cells of a body that is not written. */
	public static Packed.Tile filter(RegionsImpl.Live l, String stage, Packed.Tile t) {
		if (!STAGE.equals(stage)) {
			return t;
		}
		Regional st = of(l);
		if (st == null) {
			return t;
		}
		LongOpenHashSet drop = new LongOpenHashSet();
		for (Body b : st.bodies) {
			BodyState bs = st.states.get(b.id);
			if ("drained".equals(bs.state) && bs.before.isEmpty()) { // not contained at the gate: never written
				for (long p : b.cells) {
					drop.add(p);
				}
				for (long p : b.ice) {
					drop.add(p);
				}
			}
		}
		if (drop.isEmpty()) {
			return t;
		}
		int n = 0;
		for (long p : t.pos()) {
			if (!drop.contains(p)) {
				n++;
			}
		}
		long[] pos = new long[n];
		int[] state = new int[n];
		byte[] cond = new byte[n];
		boolean[] walk = new boolean[n];
		int k = 0;
		for (int i = 0; i < t.size(); i++) {
			if (drop.contains(t.pos()[i])) {
				continue;
			}
			pos[k] = t.pos()[i];
			state[k] = t.state()[i];
			cond[k] = t.cond()[i];
			walk[k] = t.walk()[i];
			k++;
		}
		return new Packed.Tile(pos, state, cond, walk, t.states(), t.stateIds(), t.sha());
	}

	/** Whether the fluids stage's tiles may be checked ahead (the gate ran): a tile of a body not written must leave its cells first. */
	public static boolean checkedAhead(RegionsImpl.Live l, String stage) {
		if (!STAGE.equals(stage)) {
			return true;
		}
		Regional st = of(l);
		return st == null || !"gate".equals(st.phase);
	}

	// ------------------------------------------------------------------ the forced tick, settle and census

	/** Server tick: the forced ticks once the stage's tiles are placed, then each settling body's census. */
	public static void tick(MinecraftServer s) {
		for (RegionsImpl.Live l : RegionsImpl.all()) {
			if (l.rec().state == dev.larattalabs.architect.api.RegionState.REMOVING || l.rec().state == dev.larattalabs.architect.api.RegionState.REMOVED) {
				continue;
			}
			Regional st = of(l);
			if (st == null) {
				continue;
			}
			ServerLevel level = l.level(s);
			if (level == null) {
				continue;
			}
			if ("writing".equals(st.phase) && stageWritten(l)) {
				force(level, l, st);
			}
			if ("settling".equals(st.phase) && level.getGameTime() - st.lastCensus >= CENSUS_EVERY) {
				st.lastCensus = level.getGameTime();
				settle(level, l, st);
			}
		}
	}

	/** Whether every item of the region's fluids stage ended (placed or failed). */
	static boolean stageWritten(RegionsImpl.Live l) {
		QBatch b = Batches.get(l.rec().batchId);
		if (b == null) {
			return false;
		}
		List<QItem> items = b.inStage(STAGE);
		return !items.isEmpty() && items.stream().allMatch(i -> i.status.terminal());
	}

	/** §3.2: one fluid tick on every source and every face neighbour of one that is no body cell. */
	static void force(ServerLevel level, RegionsImpl.Live l, Regional st) {
		int n = 0;
		for (Body b : st.bodies) {
			BodyState bs = st.states.get(b.id);
			if (!"pending".equals(bs.state)) {
				continue;
			}
			LongOpenHashSet own = new LongOpenHashSet(b.cells);
			Fluid f = b.source();
			for (long p : b.cells) {
				BlockPos bp = BlockPos.of(p);
				level.scheduleTick(bp, f, 1);
				n++;
				for (net.minecraft.core.Direction d : net.minecraft.core.Direction.values()) {
					BlockPos q = bp.relative(d);
					if (!own.contains(q.asLong())) {
						level.scheduleTick(q, f, 1);
						n++;
					}
				}
			}
			bs.state = "written";
			bs.sources = b.cells.length;
			bs.spill = b.spill.length;
		}
		st.phase = "settling";
		st.forcedAt = level.getGameTime();
		save(l, st);
		WorldJournal.kill("FL2"); // the sources written and ticked, settling
		Architect.LOGGER.info("Region {}: fluids written; {} forced fluid tick(s), settling", l.rec().id, n);
	}

	/** A body's census now (§3.3): what differs from the prediction, and where fluid escaped. */
	record Census(boolean ticking, List<long[]> mismatch, List<long[]> escaped, int fluidCells) {
	}

	static Census census(ServerLevel level, Body b, Long2ObjectOpenHashMap<String> fluidBefore) {
		return census(level, b, fluidBefore, new LongOpenHashSet());
	}

	static Census census(ServerLevel level, Body b, Long2ObjectOpenHashMap<String> fluidBefore, LongOpenHashSet others) {
		Fluid src = b.source();
		LongOpenHashSet own = new LongOpenHashSet(b.cells);
		LongOpenHashSet ice = new LongOpenHashSet(b.ice);
		LongOpenHashSet declared = b.declared();
		boolean ticking = false;
		List<long[]> mismatch = new ArrayList<>();
		List<long[]> escaped = new ArrayList<>();
		int fluidCells = 0;
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		for (long p : b.watchSet()) {
			m.set(p);
			if (!level.isLoaded(m)) {
				continue;
			}
			BlockState s = level.getBlockState(m);
			FluidState f = s.getFluidState();
			if (!ticking && (level.getFluidTicks().hasScheduledTick(m, Fluids.WATER) || level.getFluidTicks().hasScheduledTick(m, Fluids.FLOWING_WATER) || level
				.getFluidTicks().hasScheduledTick(m, Fluids.LAVA) || level.getFluidTicks().hasScheduledTick(m, Fluids.FLOWING_LAVA))) {
				ticking = true;
			}
			if (!f.isEmpty()) {
				fluidCells++;
			}
			long[] c = {m.getX(), m.getY(), m.getZ()};
			if (ice.contains(p)) {
				if (!s.is(Blocks.ICE)) {
					mismatch.add(c);
				}
				continue;
			}
			if (own.contains(p)) {
				if (!(f.isSource() && f.getType().isSame(src))) {
					mismatch.add(c);
				}
				continue;
			}
			if (b.predicted.containsKey(p)) {
				int want = b.predicted.get(p);
				if (!(s.getBlock() instanceof LiquidBlock && f.getType().isSame(src) && s.getValue(LiquidBlock.LEVEL) == want)) {
					mismatch.add(c);
				}
				continue;
			}
			if (f.isEmpty() || fluidBefore.containsKey(p) || others.contains(p)) {
				continue;
			}
			// fluid where none was before and none is predicted: in the declared spill or joins it is a mismatch (not settled), outside them
			// it escaped
			if (declared.contains(p)) {
				mismatch.add(c);
			} else {
				escaped.add(c);
			}
		}
		return new Census(ticking, mismatch, escaped, fluidCells);
	}

	static void settle(ServerLevel level, RegionsImpl.Live l, Regional st) {
		boolean changed = false;
		long now = level.getGameTime();
		for (Body b : st.bodies) {
			BodyState bs = st.states.get(b.id);
			if (!"written".equals(bs.state)) {
				continue;
			}
			Census c = census(level, b, st.fluidBefore, st.othersOf(b));
			if (!c.escaped().isEmpty()) {
				escape(level, l, st, b, bs, "escaped", c.escaped());
				changed = true;
			} else if (!c.ticking() && c.mismatch().isEmpty()) {
				bs.state = "settled";
				bs.settledAt = now - st.forcedAt;
				changed = true;
				Architect.LOGGER.info("Region {}: fluid body {} settled in {} ticks (bound {})", l.rec().id, b.id, bs.settledAt, b.settleTicks);
			} else if (now - st.forcedAt > 2L * b.settleTicks) {
				escape(level, l, st, b, bs, "unsettled", c.mismatch());
				changed = true;
			}
		}
		if (st.states.values().stream().allMatch(BodyState::ended)) {
			st.phase = "done";
			changed = true;
		}
		if (changed) {
			save(l, st);
			report(l, st);
		}
	}

	/** §3.4: the escape guard: drain the body now, report it drained with the cells. */
	static void escape(ServerLevel level, RegionsImpl.Live l, Regional st, Body b, BodyState bs, String why, List<long[]> at) {
		int n = drain(level, st, b, bs, true, st.othersOf(b));
		bs.state = "drained";
		bs.escaped = "escaped".equals(why);
		bs.reason = why + ": " + at.size() + " cell(s) " + ("escaped".equals(why) ? "outside the body's cells, spill and joins" : "not as predicted after 2 x "
			+ b.settleTicks + " ticks");
		bs.at.clear();
		bs.at.addAll(at.subList(0, Math.min(NAMED, at.size())));
		Architect.LOGGER.warn("Region {}: fluid body {} drained ({}; {} cell(s) restored): {}", l.rec().id, b.id, bs.reason, n, cells(bs.at));
	}

	/**
	 * §4: a body back to its before states: its sources and ice cap (where they still hold a fluid or ice), the spill and watched cells
	 * that hold a fluid they did not hold before; with {@code strays}, any other cell of the watch set holding the body's fluid where none
	 * was before (an escape) goes to air. Writes skip updates (nothing flows). Returns the cells written.
	 */
	static int drain(ServerLevel level, Regional st, Body b, BodyState bs, boolean strays) {
		return drain(level, st, b, bs, strays, new LongOpenHashSet());
	}

	/** {@code others}: cells another standing body plans, left alone (the escape guard drains one body of several). */
	static int drain(ServerLevel level, Regional st, Body b, BodyState bs, boolean strays, LongOpenHashSet others) {
		int n = 0;
		Fluid src = b.source();
		for (long[] a : new long[][] {b.ice, b.cells}) {
			for (long p : a) {
				BlockPos bp = BlockPos.of(p);
				BlockState now = level.getBlockState(bp);
				if (now.getFluidState().isEmpty() && !now.is(Blocks.ICE) && !now.is(Blocks.FROSTED_ICE)) {
					continue;
				}
				String before = bs.before.get(p);
				BlockState to = before == null ? Blocks.AIR.defaultBlockState() : parse(before);
				if (now != to) {
					dev.larattalabs.architect.placed.Placed.set(level, bp, to, Block.UPDATE_CLIENTS | Block.UPDATE_SKIP_ALL_SIDEEFFECTS);
					n++;
				}
			}
		}
		for (long[] a : new long[][] {b.spill, b.watch}) {
			for (long p : a) {
				BlockPos bp = BlockPos.of(p);
				BlockState now = level.getBlockState(bp);
				FluidState f = now.getFluidState();
				if (f.isEmpty() || others.contains(p)) {
					continue;
				}
				String before = bs.before.get(p);
				BlockState was = before == null ? Blocks.AIR.defaultBlockState() : parse(before);
				if (!was.getFluidState().isEmpty() && was.getFluidState().getType().isSame(f.getType())) {
					continue; // it held that fluid before (a natural cell): not the body's doing
				}
				dev.larattalabs.architect.placed.Placed.set(level, bp, was, Block.UPDATE_CLIENTS | Block.UPDATE_SKIP_ALL_SIDEEFFECTS);
				n++;
			}
		}
		if (strays) {
			LongOpenHashSet own = new LongOpenHashSet(b.cells);
			for (long p : b.watchSet()) {
				if (own.contains(p) || st.fluidBefore.containsKey(p) || others.contains(p)) {
					continue;
				}
				BlockPos bp = BlockPos.of(p);
				BlockState now = level.getBlockState(bp);
				if (now.getBlock() instanceof LiquidBlock && now.getFluidState().getType().isSame(src)) {
					dev.larattalabs.architect.placed.Placed.set(level, bp, Blocks.AIR.defaultBlockState(), Block.UPDATE_CLIENTS | Block.UPDATE_SKIP_ALL_SIDEEFFECTS);
					n++;
				}
			}
		}
		return n;
	}

	/** Server thread (Batches): the region's batch holds its end while a written body settles (PLACED waits for the water, §3.3). */
	public static boolean holding(QBatch b) {
		if (!RegionItems.isRegion(b) || b.cancelling) {
			return false;
		}
		RegionsImpl.Live l = RegionsImpl.live(b.ext.get(RegionItems.EXT_REGION).getAsString());
		Regional st = l == null ? null : of(l);
		return st != null && ("writing".equals(st.phase) || "settling".equals(st.phase)) && stageWritten(l);
	}

	/** Whether a body of the region was not written or was drained (the region ends PARTIAL, §2.4, §3.4). */
	public static boolean anyDrained(RegionsImpl.Live l) {
		Regional st = of(l);
		return st != null && !"gate".equals(st.phase) && st.states.values().stream().anyMatch(x -> "drained".equals(x.state));
	}

	// ------------------------------------------------------------------ the removal

	/**
	 * Server thread (Groups, before a whole group's undo is planned): false while the region's bodies drain and settle (§4.1): every body
	 * drained (sources and ice back to their before states, the watched cells holding new fluid restored), saved, then one settle bound
	 * (the longest body's) with no fluid tick scheduled in any watch set. True for a group with no region bodies, and once done.
	 */
	public static boolean removalGate(MinecraftServer s, String group) {
		RegionsImpl.Live l = null;
		for (RegionsImpl.Live x : RegionsImpl.all()) {
			if (group.equals(x.rec().groupId)) {
				l = x;
				break;
			}
		}
		Regional st = l == null ? null : of(l);
		if (st == null || "done".equals(st.removal)) {
			return true;
		}
		ServerLevel level = l.level(s);
		if (level == null) {
			return true;
		}
		if (st.removal == null) {
			int n = 0;
			for (int i = st.bodies.size() - 1; i >= 0; i--) {
				Body b = st.bodies.get(i);
				BodyState bs = st.states.get(b.id);
				if (bs.before.isEmpty()) {
					continue; // never written (not checked, or not contained): nothing of it stands
				}
				n += drain(level, st, b, bs, true);
			}
			int bound = st.bodies.stream().mapToInt(b -> b.settleTicks).max().orElse(0);
			st.removal = "drained";
			st.redrained = true;
			st.until = level.getGameTime() + bound;
			save(l, st);
			Architect.LOGGER.info("Region {}: removal drained {} fluid cell(s); the solids wait one settle bound ({} ticks)", l.rec().id, n, bound);
			WorldJournal.kill("FL3"); // drained (step 2), before the solids (step 3)
			return false;
		}
		if (!st.redrained) {
			// (§3.5) a removal resumed after a stop: the drain again (idempotent: what the stop lost of it, unsaved chunks, is written now)
			st.redrained = true;
			int n = 0;
			for (int i = st.bodies.size() - 1; i >= 0; i--) {
				Body b = st.bodies.get(i);
				BodyState bs = st.states.get(b.id);
				if (!bs.before.isEmpty()) {
					n += drain(level, st, b, bs, true);
				}
			}
			if (n > 0) {
				Architect.LOGGER.info("Region {}: the resumed removal drained {} fluid cell(s) again", l.rec().id, n);
			}
		}
		if (level.getGameTime() < st.until) {
			return false;
		}
		for (Body b : st.bodies) {
			if (census(level, b, st.fluidBefore).ticking()) {
				return false;
			}
		}
		st.removal = "done";
		save(l, st);
		Architect.LOGGER.info("Region {}: fluids drained and settled; the solids are restored next", l.rec().id);
		return true;
	}

	// ------------------------------------------------------------------ the report and the record

	/** The report in the region's ext: one entry per body that ended (S-H-6), in plan order. */
	static void report(RegionsImpl.Live l, Regional st) {
		JsonArray a = new JsonArray();
		for (Body b : st.bodies) {
			BodyState bs = st.states.get(b.id);
			if (!bs.ended()) {
				continue;
			}
			JsonObject o = new JsonObject();
			o.addProperty("part", b.part != null ? b.part : b.id);
			o.addProperty("body", b.id);
			o.addProperty("state", bs.state);
			if (bs.reason != null) {
				o.addProperty("reason", bs.reason);
			}
			JsonArray at = new JsonArray();
			for (long[] c : bs.at) {
				JsonArray q = new JsonArray();
				q.add(c[0]);
				q.add(c[1]);
				q.add(c[2]);
				at.add(q);
			}
			o.add("at", at);
			o.addProperty("sources", bs.sources);
			o.addProperty("spill", bs.spill);
			if (bs.settledAt >= 0) {
				o.addProperty("settledAt", bs.settledAt);
			}
			o.addProperty("escaped", bs.escaped);
			a.add(o);
		}
		l.rec().ext.add(EXT, a);
		RegionsImpl.save(l);
	}

	/** The region's fluids record as JSON (DevBridge {@code dev.fluid.state}). */
	public static JsonObject stateJson(RegionsImpl.Live l) {
		Regional st = of(l);
		JsonObject o = new JsonObject();
		if (st == null) {
			o.addProperty("bodies", 0);
			return o;
		}
		o.addProperty("phase", st.phase);
		o.addProperty("forcedAt", st.forcedAt);
		if (st.removal != null) {
			o.addProperty("removal", st.removal);
			o.addProperty("until", st.until);
		}
		JsonArray bodies = new JsonArray();
		for (Body b : st.bodies) {
			BodyState bs = st.states.get(b.id);
			JsonObject x = new JsonObject();
			x.addProperty("id", b.id);
			x.addProperty("state", bs.state);
			if (bs.reason != null) {
				x.addProperty("reason", bs.reason);
			}
			x.addProperty("cells", b.cells.length);
			x.addProperty("spill", b.spill.length);
			x.addProperty("watch", b.watch.length);
			x.addProperty("settleTicks", b.settleTicks);
			x.addProperty("settledAt", bs.settledAt);
			x.addProperty("captured", bs.before.size());
			bodies.add(x);
		}
		o.add("bodies", bodies);
		return o;
	}

	private static Path file(RegionsImpl.Live l) {
		return RegionStore.region(l.world(), l.rec().id).resolve("fluids.json");
	}

	static void save(RegionsImpl.Live l, Regional st) {
		JsonObject o = new JsonObject();
		o.addProperty("phase", st.phase);
		o.addProperty("forcedAt", st.forcedAt);
		if (st.removal != null) {
			o.addProperty("removal", st.removal);
		}
		o.addProperty("until", st.until);
		JsonObject bodies = new JsonObject();
		for (var e : st.states.entrySet()) {
			BodyState bs = e.getValue();
			JsonObject b = new JsonObject();
			b.addProperty("state", bs.state);
			if (bs.reason != null) {
				b.addProperty("reason", bs.reason);
			}
			JsonArray at = new JsonArray();
			for (long[] c : bs.at) {
				at.add(c[0] + "," + c[1] + "," + c[2]);
			}
			b.add("at", at);
			b.addProperty("settledAt", bs.settledAt);
			b.addProperty("sources", bs.sources);
			b.addProperty("spill", bs.spill);
			b.addProperty("escaped", bs.escaped);
			b.add("before", packStates(bs.before));
			bodies.add(e.getKey(), b);
		}
		o.add("bodies", bodies);
		o.add("fluidBefore", packStates(st.fluidBefore));
		try {
			RegionStore.writeJson(file(l), o);
		} catch (IOException e) {
			Architect.LOGGER.warn("Region {}: fluids.json could not be saved: {}", l.rec().id, e.toString());
		}
	}

	static void load(RegionsImpl.Live l, Regional st) {
		Path f = file(l);
		if (!Files.isRegularFile(f)) {
			return;
		}
		try {
			JsonObject o = RegionStore.readJson(f);
			st.phase = RegionsImpl.str(o, "phase", "gate");
			st.forcedAt = o.has("forcedAt") ? o.get("forcedAt").getAsLong() : -1;
			st.removal = o.get("removal") instanceof JsonElement r && r.isJsonPrimitive() ? r.getAsString() : null;
			st.until = o.has("until") ? o.get("until").getAsLong() : -1;
			if (o.get("bodies") instanceof JsonObject bodies) {
				for (var e : bodies.entrySet()) {
					BodyState bs = st.states.get(e.getKey());
					if (bs == null) {
						continue;
					}
					JsonObject b = e.getValue().getAsJsonObject();
					bs.state = RegionsImpl.str(b, "state", "pending");
					bs.reason = b.get("reason") instanceof JsonElement r && r.isJsonPrimitive() ? r.getAsString() : null;
					if (b.get("at") instanceof JsonArray at) {
						for (JsonElement c : at) {
							String[] q = c.getAsString().split(",");
							bs.at.add(new long[] {Long.parseLong(q[0]), Long.parseLong(q[1]), Long.parseLong(q[2])});
						}
					}
					bs.settledAt = b.has("settledAt") ? b.get("settledAt").getAsLong() : -1;
					bs.sources = b.has("sources") ? b.get("sources").getAsInt() : 0;
					bs.spill = b.has("spill") ? b.get("spill").getAsInt() : 0;
					bs.escaped = b.has("escaped") && b.get("escaped").getAsBoolean();
					unpackStates(b.get("before"), bs.before);
				}
			}
			unpackStates(o.get("fluidBefore"), st.fluidBefore);
			// (§3.5) a crash while the sources were written but before every tile was: the stage's tiles run again (idempotent per cell),
			// then the forced ticks; a crash while settling: the census goes on (the scheduled fluid ticks were saved with their chunks)
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("Region {}: fluids.json unreadable ({}): starting the fluids record again", l.rec().id, e.toString());
		}
	}

	/** {"state string": [x, y, z, ...]} grouped by state. */
	private static JsonObject packStates(Long2ObjectOpenHashMap<String> m) {
		Map<String, JsonArray> by = new java.util.TreeMap<>();
		long[] keys = m.keySet().toLongArray();
		java.util.Arrays.sort(keys);
		for (long p : keys) {
			JsonArray a = by.computeIfAbsent(m.get(p), k -> new JsonArray());
			a.add(BlockPos.getX(p));
			a.add(BlockPos.getY(p));
			a.add(BlockPos.getZ(p));
		}
		JsonObject o = new JsonObject();
		by.forEach(o::add);
		return o;
	}

	private static void unpackStates(@Nullable JsonElement e, Long2ObjectOpenHashMap<String> into) {
		if (!(e instanceof JsonObject o)) {
			return;
		}
		for (var en : o.entrySet()) {
			JsonArray a = en.getValue().getAsJsonArray();
			for (int i = 0; i + 2 < a.size(); i += 3) {
				into.put(BlockPos.asLong(a.get(i).getAsInt(), a.get(i + 1).getAsInt(), a.get(i + 2).getAsInt()), en.getKey());
			}
		}
	}

	static String stateString(BlockState s) {
		return BlockStateParser.serialize(s);
	}

	static BlockState parse(String s) {
		try {
			return Packed.parse(s);
		} catch (RuntimeException e) {
			return Blocks.AIR.defaultBlockState();
		}
	}

	static AABB boxOf(long[] cells) {
		int x0 = Integer.MAX_VALUE, y0 = Integer.MAX_VALUE, z0 = Integer.MAX_VALUE, x1 = Integer.MIN_VALUE, y1 = Integer.MIN_VALUE, z1 = Integer.MIN_VALUE;
		for (long p : cells) {
			x0 = Math.min(x0, BlockPos.getX(p));
			y0 = Math.min(y0, BlockPos.getY(p));
			z0 = Math.min(z0, BlockPos.getZ(p));
			x1 = Math.max(x1, BlockPos.getX(p));
			y1 = Math.max(y1, BlockPos.getY(p));
			z1 = Math.max(z1, BlockPos.getZ(p));
		}
		return new AABB(x0, y0, z0, x1 + 1, y1 + 1, z1 + 1);
	}

	static String cells(List<long[]> at) {
		StringBuilder b = new StringBuilder();
		for (long[] c : at) {
			if (b.length() > 0) {
				b.append("; ");
			}
			b.append('(').append(c[0]).append(", ").append(c[1]).append(", ").append(c[2]).append(')');
		}
		return b.toString();
	}

	/** The region was removed or forgotten: its record leaves memory. */
	public static void forget(@Nullable String regionId) {
		if (regionId == null) {
			STATE.clear();
		} else {
			STATE.remove(regionId);
		}
	}

	/** DevBridge {@code dev.fluid.census}: every fluid cell of a box and every scheduled fluid tick there. */
	public static JsonObject censusOf(ServerLevel level, int x0, int y0, int z0, int x1, int y1, int z1) {
		JsonArray fluids = new JsonArray();
		JsonArray ticks = new JsonArray();
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		for (int x = x0; x <= x1; x++) {
			for (int z = z0; z <= z1; z++) {
				for (int y = y0; y <= y1; y++) {
					m.set(x, y, z);
					BlockState s = level.getBlockState(m);
					if (!s.getFluidState().isEmpty() || s.is(Blocks.ICE)) {
						JsonArray c = new JsonArray();
						c.add(x);
						c.add(y);
						c.add(z);
						c.add(stateString(s));
						fluids.add(c);
					}
					if (level.getFluidTicks().hasScheduledTick(m, Fluids.WATER) || level.getFluidTicks().hasScheduledTick(m, Fluids.FLOWING_WATER) || level
						.getFluidTicks().hasScheduledTick(m, Fluids.LAVA) || level.getFluidTicks().hasScheduledTick(m, Fluids.FLOWING_LAVA)) {
						JsonArray c = new JsonArray();
						c.add(x);
						c.add(y);
						c.add(z);
						ticks.add(c);
					}
				}
			}
		}
		JsonObject o = new JsonObject();
		o.add("fluids", fluids);
		o.add("ticks", ticks);
		return o;
	}
}

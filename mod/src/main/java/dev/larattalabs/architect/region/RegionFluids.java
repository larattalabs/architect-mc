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
import dev.larattalabs.architect.site.DurableFile;
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
import net.minecraft.server.level.TicketType;
import net.minecraft.world.level.ChunkPos;
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
 * <p>
 * (6c HY, "Phase 6c slice HY" §3, §4) A course is a chain of bodies (reaches {@code <part>_r<k>}) whose ops carry {@code after} (the plan
 * bodies a body's spill lands in), plan joins ({@code joins} entries {@code {body, cells}}), {@code lining} and {@code grate}. A region
 * holding any such op is <b>ordered</b>:
 * <ul>
 * <li><b>Write order</b> ({@link #writeOrder}): downstream first, each body after every body in its {@code after} (ties: plan order). The
 * stage's tiles still write every source (journaled, so the cells are the region's); before any forced tick, every body not yet due is
 * cleared back to its before states, and each body is written again and forced once every body it lands in has settled, so every fall
 * lands in standing water. Kill point {@code FL4} between two of those writes.</li>
 * <li><b>The upstream closure</b> ({@link #upstreamOf}): when a body drains (escaped, unsettled, or not written at the gate: uncontained),
 * every body whose spill lands in it, transitively, drains in the same tick, upstream first, reported {@code drained} with
 * {@code reason: "upstream of <body>"} (one not yet written is never written). Downstream bodies stand.</li>
 * <li><b>The removal</b> drains in the exact reverse of the write order (the head first), kill point {@code FL5} after the first body.</li>
 * <li>(slice DF, CONTRACT 8c §4.4, rule 3) <b>The record is durable first</b>: {@code fluids.json} is written through T0's
 * {@link DurableFile} (temp, force, rename, the folder chain forced: OK, REFUSED or IN_DOUBT). A save that is not OK leaves the record
 * {@link Regional#owed owed}: at the gate the stage waits SITE_BUSY and writes no source (kill point {@code FL1r}); past it no forced tick,
 * wave, census or hand-down to the solids happens and the batch does not end until a fresh forced write is OK. A removal's
 * {@code draining} phase is durable before its first write (kill point {@code FL3d}); a start that reads it drains again.</li>
 * </ul>
 * An H-only region has none of these members: its bodies are written by the tiles and forced together, in plan order, as before.
 * <p>
 * (6c F3-c, "Phase 6c slice F3" §3.4, §6, §7) A body op's {@code decor} set ({@code [{state, cells: runs}]}: the coral a {@code form.coral}
 * part grew in the body) is the body's own cells: waterlogged plants, fans, wall fans and sea pickles in body cells (each still a cell of
 * the body: the census and the escape guard count it as a source, its water is its own) and live coral blocks in bed cells (shell floor
 * cells). The write order is the bed (the shell's stage), then the stage's tiles write the sources with the decor, the decor winning
 * its cells (the kit's evaluator, as a grate's bars); a re-write ({@link #writeBody}) never puts water over a decor cell. The gate's
 * check reads a decor cell holding its decor as open, a body that is not written leaves its decor too ({@link #filter}); the removal's
 * drain leaves the decor (it drains the sources, then the group undo restores the decor and the bed: H's order; a coral that died
 * meanwhile is still the entry's, {@code StillOurs} via {@code Coral.canonical}), while every other drain (escape, unsettled, upstream,
 * recheck, a wave's clear) takes water decor back with the sources. Not a course member: a coral pond is not ordered.
 * <p>
 * (7a LF, "Phase 7a slice LF" §4, Since 1.43.0) A body op's {@code bubble} set ({@code [{state, cells: runs}]}: a lift's column) is the body's
 * own cells written as {@code bubble_column} states (drag=false over soul sand, drag=true over magma) instead of water sources: the
 * stage's tiles write them (the kit's evaluator, as a grate's bars), a re-write ({@link #writeBody}) writes them again where the cell is
 * open, and the forced tick gives them a block tick (vanilla keeps the column over its base) instead of a fluid tick (their face
 * neighbours outside the body still get H's fluid tick). The census counts a bubble cell as a source of the body only as a bubble column
 * of its drag; the gate's check reads a bubble cell holding a bubble column as open; every drain takes it back with the sources (the
 * removal's too: the shaft's cells first, then after the settle bound the shell, doors and base: H §4.1). Not a course member.
 */
public final class RegionFluids {
	public static final String STAGE = "fluids";
	/** RegionView ext key (Architect's): the per-body report. */
	public static final String EXT = "architect_mc:fluids";
	/**
	 * (the H batch) RegionView ext key: {@code {state: "capped", note, ticks}} when the removal's settle wait hit its cap (2 x the settle
	 * bound after the drain) and the solids were restored with fluid still ticking in a watch set (a river's flow, say). Absent otherwise.
	 */
	public static final String EXT_REMOVAL = "architect_mc:fluidsRemoval";
	/**
	 * (8cF, Steward's S-8c-3) RegionView ext key: {@code [{part, body, phase: "writing" | "draining", box: [x0, y0, z0, x1, y1, z1]}]}, every
	 * body while its water is being written and settling, or drained by a removal (the box: its watch set's, cells, shell, spill, watch,
	 * lining and (a flowing body) predicted cells grown by {@link #WATCH_GROW}). Absent when no body is in either phase.
	 */
	public static final String EXT_WATCH = "architect_mc:fluidsWatch";
	/** (8cF) At most this many foreign cells are named on a capped removal's rows (with the count). */
	static final int FOREIGN_NAMED = 64;
	/**
	 * (8cF) Whether this mod writes, drains and recovers flowing water by 8c's rules (slice WU): until then {@code flowingWater} is not
	 * advertised (ApiRules), and a flowing body is drained as H's.
	 */
	static final boolean FLOWING_BUILD = !Boolean.getBoolean("architect.noFlowingWater"); // (8c WU) -Darchitect.noFlowingWater=true: H's drain, not advertised

	/**
	 * (8c WU) The item entities spawned this session in a flowing body's own or predicted cells (a wash the gate missed, a mint), by the
	 * record's key: never saved (a test counter, {@code dev.fluid.river}); a crash test counts the box too.
	 */
	static final Map<String, Integer> ITEMS = new java.util.concurrent.ConcurrentHashMap<>();

	/**
	 * (8c WU, §4.4 "0 new item entities") Server thread (ServerEntityEvents.ENTITY_LOAD): a newly spawned item entity (age 0, its first
	 * tick) in a flowing body's own or predicted cells is counted against that body's record. Only items from the body's own cells: a
	 * farm beside the river is not counted.
	 */
	public static void itemSpawned(Entity e) {
		if (!(e instanceof net.minecraft.world.entity.item.ItemEntity it) || it.getAge() > 1 || STATE.isEmpty()) {
			return;
		}
		long p = e.blockPosition().asLong();
		for (var en : STATE.entrySet()) {
			Regional st = en.getValue(); // (counted whether this mod builds rivers or not: the failing-first runs count the mint too)
			for (Body b : st.bodies) {
				if (b.flowing() && (b.predicted.containsKey(p) || b.ownSet().contains(p))) {
					ITEMS.merge(en.getKey(), 1, Integer::sum);
					Architect.LOGGER.warn("Region {}: an item entity spawned in fluid body {}'s cells at {}", en.getKey(), b.id, BlockPos.of(p).toShortString());
					return;
				}
			}
		}
	}

	/** (8c WU) Whether a cell is in a standing flowing body's watch set (E-normal's {@code refed} never applies there: E-flat does). */
	public static boolean watchedByFlowing(long p) {
		for (Regional st : STATE.values()) {
			for (Body b : st.bodies) {
				if (b.flowing() && b.watchSet().contains(p)) {
					return true;
				}
			}
		}
		return false;
	}

	/** (8c WU) The items counted for a region's record (its id), kept after the region is removed. */
	public static int itemsOf(String regionId) {
		return ITEMS.getOrDefault(regionId, 0);
	}

	/** (8cF) Whether this mod builds 8c's flowing water ({@link #FLOWING_BUILD}). */
	public static boolean flowingBuild() {
		return FLOWING_BUILD;
	}
	/** (the H batch) The capped removals' notes by region id, kept after the record is forgotten (DevBridge {@code dev.fluid.state}); at most 64. */
	private static final Map<String, String> REMOVAL_NOTES = java.util.Collections.synchronizedMap(new LinkedHashMap<>() {
		@Override
		protected boolean removeEldestEntry(Map.Entry<String, String> e) {
			return size() > 64;
		}
	});

	/** The note a capped removal left for a region (its record may be gone), else null. */
	public static @Nullable String removalNoteOf(String regionId) {
		return REMOVAL_NOTES.get(regionId);
	}

	/** The removal's settle wait (§4.1): wait, done (nothing ticking after the bound), or capped (still ticking at 2 x the bound). */
	enum RemovalWait {
		WAIT, DONE, CAPPED
	}

	/**
	 * (the H batch) The removal's wait after the drain, pure: {@code until} is the drain's time + the bound. Before it, wait; then done when
	 * no fluid ticks in any watch set; still ticking at {@code until + bound} (2 x the bound after the drain), capped: a natural flowing
	 * source in a watch set never stops ticking, and must not hold the removal forever.
	 */
	static RemovalWait removalWait(long now, long until, int bound, boolean ticking) {
		if (now < until) {
			return RemovalWait.WAIT;
		}
		if (!ticking) {
			return RemovalWait.DONE;
		}
		return now >= until + Math.max(0, bound) ? RemovalWait.CAPPED : RemovalWait.WAIT;
	}
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
	/**
	 * The bodies' chunks stay loaded and simulated (fluid ticks run) while the stage writes and settles and while a removal waits its
	 * settle bound, as a forced chunk (level 31), whoever is near: a census never judges a cell it cannot see. Not persisted: a restart
	 * takes it again from the saved phase.
	 */
	static final class Ticket {
		/** Registered at mod init (RegionsMod), in its own holder so the record's other code loads without the registry. */
		static final TicketType TICKET = net.minecraft.core.Registry.register(net.minecraft.core.registries.BuiltInRegistries.TICKET_TYPE, Architect.id(
			"region_fluids"), new TicketType(0L, TicketType.FLAG_LOADING | TicketType.FLAG_SIMULATION));

		private Ticket() {
		}
	}
	/** The forced chunk's ticket radius (ChunkMap.FORCED_TICKET_LEVEL 31 = 33 - 2). */
	static final int TICKET_RADIUS = 2;

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
		/** (6c HY) The plan bodies written before this one (its spill lands in them), in the op's order. */
		List<String> after = List.of();
		/** (6c HY) Joins into other bodies of the plan: their landing cells (that body's sources). */
		List<PlanJoin> planJoins = List.of();
		/** (6c HY) Containment beyond the shell (a step's lining, a weir's second course): checked at the gate as the shell is. */
		long[] lining = new long[0];
		/** (6c HY) Body cells written as {@link #GRATE} (a water gate's grate). */
		long[] grate = new long[0];
		/** (6c F3-c) The decor set's cells (body cells and bed cells), and each one's state string. */
		long[] decor = new long[0];
		final Long2ObjectOpenHashMap<String> decorState = new Long2ObjectOpenHashMap<>();
		@Nullable LongOpenHashSet decorSet;

		@Nullable LongOpenHashSet grateSet;
		/** (7a LF) Body cells written as bubble columns, and each one's drag (true: down, over magma). */
		final it.unimi.dsi.fastutil.longs.Long2BooleanOpenHashMap bubble = new it.unimi.dsi.fastutil.longs.Long2BooleanOpenHashMap();
		/**
		 * (8cF) The op's {@code flow} (an open enum: "current", a river's long current from few sources; "level"), else null. With
		 * {@link #lip} "form" it makes the body 8c's ({@link #flowing}). Unknown values are kept and noted, never refused.
		 */
		@Nullable String flow;
		/** (8cF) The op's body {@code kind} (an open enum: "reach", "pool", "basin", "header", ...), else null. */
		@Nullable String kind;
		/** (8cF) The op's {@code lip} ("form": a fall off a plan form, its host the part {@link #on}), else null. */
		@Nullable String lip;
		/** (8cF) A {@code lip: "form"} fall's host form part, else null. */
		@Nullable String on;
		/** (8cF, §2.4) The wash clears: natural washable cells in the predicted flow an earlier stage cleared to air (journaled). */
		long[] wash = new long[0];
		/** (8cF, §2.2) The predicted conversions the planner lifted into written sources (each one of {@link #cells}). */
		long[] converted = new long[0];

		@Nullable LongOpenHashSet ownSet;

		/** (8c WU) The body's own cells as a set. */
		LongOpenHashSet ownSet() {
			if (ownSet == null) {
				ownSet = new LongOpenHashSet(cells);
			}
			return ownSet;
		}

		/** (8cF) Whether the body is 8c's flowing water: a {@code flow} member or {@code lip: "form"}. */
		boolean flowing() {
			return flow != null || "form".equals(lip);
		}

		/** (6c HY) Whether a cell is a grate cell. */
		boolean gratePos(long p) {
			if (grateSet == null) {
				grateSet = new LongOpenHashSet(grate);
			}
			return grateSet.contains(p);
		}

		/** (6c F3-c) The decor set's cells. */
		LongOpenHashSet decorSet() {
			if (decorSet == null) {
				decorSet = new LongOpenHashSet(decor);
			}
			return decorSet;
		}

		/** (6c HY) Whether the op is a course's (any course member): its region writes in dependency order. */
		boolean course() {
			return !after.isEmpty() || !planJoins.isEmpty() || lining.length > 0 || grate.length > 0;
		}

		Fluid source() {
			return lava ? Fluids.LAVA : Fluids.WATER;
		}

		LongOpenHashSet watchSet() {
			if (watchSet == null) {
				LongOpenHashSet base = new LongOpenHashSet();
				for (long[] a : new long[][] {cells, shell, spill, watch, lining}) {
					for (long p : a) {
						base.add(p);
					}
				}
				if (flowing()) {
					base.addAll(predicted.keySet()); // (8cF) a river's current is watched wherever the planner predicts it (its spill holds it too)
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

		/** (8cF) The watch set's box [x0, y0, z0, x1, y1, z1]: the cells it grows from, grown by {@link #WATCH_GROW}. */
		int[] watchBox() {
			int[] b = {Integer.MAX_VALUE, Integer.MAX_VALUE, Integer.MAX_VALUE, Integer.MIN_VALUE, Integer.MIN_VALUE, Integer.MIN_VALUE};
			java.util.function.LongConsumer add = p -> {
				int x = BlockPos.getX(p), y = BlockPos.getY(p), z = BlockPos.getZ(p);
				b[0] = Math.min(b[0], x);
				b[1] = Math.min(b[1], y);
				b[2] = Math.min(b[2], z);
				b[3] = Math.max(b[3], x);
				b[4] = Math.max(b[4], y);
				b[5] = Math.max(b[5], z);
			};
			for (long[] a : new long[][] {cells, shell, spill, watch, lining}) {
				for (long p : a) {
					add.accept(p);
				}
			}
			if (flowing()) {
				predicted.keySet().forEach(add);
			}
			if (b[0] > b[3]) {
				return new int[6];
			}
			for (int i = 0; i < 3; i++) {
				b[i] -= WATCH_GROW;
				b[i + 3] += WATCH_GROW;
			}
			return b;
		}

		/** (8cF) The predicted flowing cells (levels 1-7) and falling cells (8). */
		int flowingCells() {
			int n = 0;
			for (int lv : predicted.values()) {
				if (lv > 0) {
					n++;
				}
			}
			return n;
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

	/** (6c HY) A join into another body of the plan: that body's id and the landing cells. */
	record PlanJoin(String body, long[] cells) {
	}

	/** (6c HY) A water gate's grate: iron bars holding the body's source (§8.3). */
	static final String GRATE = "minecraft:iron_bars[waterlogged=true]";

	/** A body's progress, saved. */
	static final class BodyState {
		String state = "pending"; // pending | written | settled | drained
		@Nullable String reason;
		final List<long[]> at = new ArrayList<>();
		long settledAt = -1;
		int sources;
		int spill;
		boolean escaped;
		/** Not written: the check refused it (at the gate, or again after a stop); its tiles leave its cells. */
		boolean uncontained;
		/** (6c HY) Not written: a body it lands in failed (the upstream closure) before it was written. */
		boolean held;
		/** (6c IRR, S-IRR-4) Drained because its lot's site was removed (the sources belong to the farm): never written again. Saved. */
		boolean lotRemoved;
		/** (6c HY) When an ordered region wrote and forced this body (game time), else -1 (the region's forcedAt). */
		long writtenAt = -1;
		/** Before the write: the cells', ice cap's, spill's and watched cells' states. */
		final Long2ObjectOpenHashMap<String> before = new Long2ObjectOpenHashMap<>();
		/**
		 * (the H batch, §4.2) Every cell the census recorded as escaped from this body (all of them, not the 16 named): with the body's
		 * own predicted cells, the only cells outside its cells, spill and watch that a drain may take. Saved.
		 */
		final LongOpenHashSet escapedCells = new LongOpenHashSet();
		/** (6c IRR, S-IRR-3) The cells of a breach's flow over its own field that a drain took back (counted, saved). */
		int breached;
		/**
		 * (8cF, Steward's S-8c-2) The typed why beside {@link #reason} (an open enum, {@link #WHYS}), set where the reason is; null on a body
		 * that settled, or one saved before 8c (then derived from the flags: {@link #whyOf}).
		 */
		@Nullable String why;
		/** (8cF) A capped removal's foreign cells in this body's watch set: water not the region's that kept it ticking (saved). */
		final it.unimi.dsi.fastutil.longs.LongArrayList foreign = new it.unimi.dsi.fastutil.longs.LongArrayList();
		/** (8cF) How many foreign cells the capped removal found (at most {@link #FOREIGN_NAMED} kept in {@link #foreign}). */
		int foreignCount;

		boolean ended() {
			return "settled".equals(state) || "drained".equals(state);
		}
	}

	/**
	 * (8cF) The typed whys of the fluids rows (an open enum: a consumer notes an unknown one, never refuses it): {@code foreign_water}
	 * (water not the region's in the watch set: a player's bucket, a spring; clear it, then Expand again), {@code census_drift} (the
	 * world settled other than the model predicted), {@code escaped} (fluid outside the body's cells, spill and joins), {@code uncontained}
	 * (a shell, lining or join cell didn't hold at the gate), {@code upstream} (drained or held with a body it lands in), {@code lot_removed}
	 * (an irrigation source left with its lot), {@code wash} (a predicted cell held a block that isn't natural and writable: M25:wash),
	 * {@code bubble} (soul sand or magma under a predicted cell: M25:bubble).
	 */
	static final List<String> WHYS = List.of("foreign_water", "census_drift", "escaped", "uncontained", "upstream", "lot_removed", "wash", "bubble");

	/** (8cF) A body's typed why: the one recorded, else derived from its flags and reason (a record saved before 8c); null when it settled. */
	static @Nullable String whyOf(BodyState bs) {
		if (bs.why != null) {
			return bs.why;
		}
		if (!"drained".equals(bs.state)) {
			return null;
		}
		String r = bs.reason == null ? "" : bs.reason;
		if (bs.lotRemoved) {
			return "lot_removed";
		}
		if (bs.held || r.startsWith("upstream of")) {
			return "upstream";
		}
		if (bs.uncontained) {
			return "uncontained";
		}
		if (bs.escaped || r.startsWith("escaped")) {
			return "escaped";
		}
		if (r.startsWith("unsettled")) {
			return "census_drift";
		}
		return null;
	}

	/** A region's fluids: its bodies (from the IR) and its saved progress. */
	static final class Regional {
		final List<Body> bodies;
		/** (6c IRR) The irrigation bodies' lots: body id -> {minX, minZ, maxX, maxZ, floorY} (the IR's lots[].irrigation.bodies). */
		final Map<String, int[]> irrigation = new java.util.HashMap<>();
		String phase = "gate"; // gate | writing | settling | done
		long forcedAt = -1;
		final Map<String, BodyState> states = new LinkedHashMap<>();
		/** The watch sets' fluids before the write (state strings by position). */
		final Long2ObjectOpenHashMap<String> fluidBefore = new Long2ObjectOpenHashMap<>();
		/** The removal: null (not started), drained (waiting for the settle bound until {@link #until}), done. */
		@Nullable String removal;
		long until = -1;
		/** (the H batch) The removal went on without its settle (fluid still ticking 2 x the bound after the drain): why, else null. */
		@Nullable String removalNote;
		/** (8cF) The removal's phase as the view shows it ({@link dev.larattalabs.architect.api.FluidsRemoval#phase}); null: "draining". Saved. */
		@Nullable String removalPhase;
		long lastCensus;
		/** This session drained already (a removal resumed after a stop drains again first). */
		boolean redrained;
		/** Loaded in phase writing (a stop before the stage was written): the gate checks the bodies again before the tiles (§3.5). */
		boolean recheck;
		/** The chunks this record holds a {@link Ticket#TICKET} on, and their level. */
		final LongOpenHashSet ticketed = new LongOpenHashSet();
		@Nullable ServerLevel ticketLevel;

		/** (6c HY) A body of a course in the region: write in dependency order (the class doc). */
		final boolean ordered;
		/** (6c HY) The write order (H: plan order). */
		final List<Body> order;
		/** (6c HY) This session cleared the bodies not yet due (after a stop, again: idempotent). */
		boolean cleared;
		/** (slice DF) The record's durable file (T0's DurableFile, created at the first load or save). */
		@Nullable DurableFile durable;
		/**
		 * (slice DF, rule 3) The record is not known on disk: the last save was REFUSED or IN_DOUBT, or the loaded file is unconfirmed. While
		 * owed nothing goes on: no source, no forced tick, no hand-down to the solids; each try writes a fresh forced snapshot.
		 */
		boolean owed;
		/** (slice DF) Why the record is owed (the outcome and its reason), else null. */
		@Nullable String owedWhy;
		/** (slice DF) When an owed record was last tried again ({@link System#nanoTime}), 0 never. */
		long owedTriedAt;

		Regional(List<Body> bodies) {
			this.bodies = bodies;
			for (Body b : bodies) {
				states.put(b.id, new BodyState());
			}
			this.ordered = bodies.stream().anyMatch(Body::course);
			this.order = writeOrder(bodies);
		}

		@Nullable Body body(String id) {
			for (Body b : bodies) {
				if (b.id.equals(id)) {
					return b;
				}
			}
			return null;
		}

		/**
		 * The cells the region's other standing bodies plan (their sources, ice and predicted flow): a fountain's spout stands in its basin,
		 * so one body's census and drain leave them to their own body (never an escape, never drained for another body). (6c HY) In an
		 * ordered region a body not yet written is not standing: a head written before the reach it falls into (the dependency order
		 * broken) floods that reach's empty basin, and the census names it as escaped.
		 */
		/** (8c WU) Whether the record holds 8c's flowing water: its removal drains the sources first, then the stray pass ({@link #gateFlowing}). */
		boolean flowingRegion() {
			return FLOWING_BUILD && bodies.stream().anyMatch(Body::flowing);
		}

		LongOpenHashSet othersOf(Body b) {
			LongOpenHashSet out = new LongOpenHashSet();
			for (Body o : bodies) {
				BodyState os = states.get(o.id);
				if (o == b || os != null && "drained".equals(os.state)) {
					continue;
				}
				if (ordered && os != null && "pending".equals(os.state)) {
					continue; // (6c HY) an ordered region's body not yet written stands nowhere: fluid in its cells escaped from this one
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
				joins(o.get("joins"), b);
				b.watch = runs(o.get("watch"));
				// (6c HY) the course members
				b.lining = runs(o.get("lining"));
				b.grate = runs(o.get("grate"));
				// (6c F3-c) the decor set
				decor(o.get("decor"), b);
				// (7a LF) the bubble set
				bubble(o.get("bubble"), b);
				if (o.get("after") instanceof JsonArray af) {
					List<String> ids = new ArrayList<>();
					for (JsonElement e : af) {
						if (e.isJsonPrimitive() && !ids.contains(e.getAsString())) {
							ids.add(e.getAsString());
						}
					}
					b.after = List.copyOf(ids);
				}
				if (o.get("predicted") instanceof JsonArray pr) {
					for (JsonElement q : pr) {
						JsonArray c = q.getAsJsonArray();
						b.predicted.put(BlockPos.asLong(c.get(0).getAsInt(), c.get(1).getAsInt(), c.get(2).getAsInt()), c.get(3).getAsInt());
					}
				}
				b.settleTicks = o.has("settleTicks") ? o.get("settleTicks").getAsInt() : 100;
				// (8cF) 8c's members (open enums kept as given)
				b.flow = strOrNull(o, "flow");
				b.kind = strOrNull(o, "kind");
				b.lip = strOrNull(o, "lip");
				b.on = o.get("on") instanceof JsonObject on ? strOrNull(on, "part") : strOrNull(o, "on");
				b.wash = runs(o.get("wash"));
				b.converted = runs(o.get("converted"));
				out.add(b);
			}
		}
		return out;
	}

	/** (8cF) A string member, else null. */
	static @Nullable String strOrNull(JsonObject o, String k) {
		return o.get(k) instanceof JsonElement e && e.isJsonPrimitive() ? e.getAsString() : null;
	}

	/**
	 * (6c HY) A fluid op's joins: a column run [x, z, y0, y1] is a natural join ({@link Body#joins}); an object {@code {body, cells:
	 * runs}} a join into another body of the plan ({@link Body#planJoins}).
	 */
	static void joins(@Nullable JsonElement e, Body b) {
		if (!(e instanceof JsonArray a)) {
			b.joins = new long[0];
			return;
		}
		JsonArray natural = new JsonArray();
		List<PlanJoin> plan = new ArrayList<>();
		for (JsonElement j : a) {
			if (j instanceof JsonObject jo) {
				plan.add(new PlanJoin(RegionsImpl.str(jo, "body", ""), runs(jo.get("cells"))));
			} else {
				natural.add(j);
			}
		}
		b.joins = runs(natural);
		b.planJoins = List.copyOf(plan);
	}

	/**
	 * (6c HY, §3.1) The write order: each body after every body of the region in its {@code after}, ties in plan order (the IR's op
	 * order); an unknown id is ignored, and a cycle leaves the rest in plan order (M25:order refuses both at the check). With no
	 * {@code after} anywhere, plan order.
	 */
	static List<Body> writeOrder(List<Body> bodies) {
		java.util.Set<String> known = new java.util.HashSet<>();
		for (Body b : bodies) {
			known.add(b.id);
		}
		List<Body> out = new ArrayList<>();
		java.util.Set<String> done = new java.util.HashSet<>();
		while (out.size() < bodies.size()) {
			Body pick = null;
			for (Body b : bodies) {
				if (!done.contains(b.id) && b.after.stream().allMatch(a -> done.contains(a) || !known.contains(a))) {
					pick = b;
					break;
				}
			}
			if (pick == null) {
				for (Body b : bodies) {
					if (!done.contains(b.id)) {
						pick = b;
						break;
					}
				}
			}
			done.add(pick.id);
			out.add(pick);
		}
		return out;
	}

	/**
	 * (6c HY, §3.3) The upstream closure of body {@code k}: every body whose {@code after} names it, transitively (a reach above it, a pond
	 * that overflows into it), upstream first (the reverse of the write order).
	 */
	static List<Body> upstreamOf(Regional st, Body k) {
		java.util.Set<String> in = new java.util.HashSet<>();
		java.util.ArrayDeque<String> q = new java.util.ArrayDeque<>();
		q.add(k.id);
		while (!q.isEmpty()) {
			String id = q.poll();
			for (Body b : st.bodies) {
				if (!b.id.equals(k.id) && !in.contains(b.id) && b.after.contains(id)) {
					in.add(b.id);
					q.add(b.id);
				}
			}
		}
		List<Body> out = new ArrayList<>();
		for (int i = st.order.size() - 1; i >= 0; i--) {
			if (in.contains(st.order.get(i).id)) {
				out.add(st.order.get(i));
			}
		}
		return out;
	}

	/** (6c F3-c) A fluid op's decor set {@code [{state, cells: runs}]}: its cells and each one's state. */
	static void decor(@Nullable JsonElement e, Body b) {
		if (!(e instanceof JsonArray a)) {
			return;
		}
		it.unimi.dsi.fastutil.longs.LongArrayList all = new it.unimi.dsi.fastutil.longs.LongArrayList();
		for (JsonElement d : a) {
			if (!(d instanceof JsonObject o)) {
				continue;
			}
			String state = RegionsImpl.str(o, "state", "");
			for (long p : runs(o.get("cells"))) {
				if (b.decorState.put(p, state) == null) {
					all.add(p);
				}
			}
		}
		b.decor = all.toLongArray();
		b.decorSet = null;
	}

	/** (7a LF) A fluid op's bubble set {@code [{state, cells: runs}]}: its cells and each one's drag. */
	static void bubble(@Nullable JsonElement e, Body b) {
		if (!(e instanceof JsonArray a)) {
			return;
		}
		for (JsonElement d : a) {
			if (!(d instanceof JsonObject o)) {
				continue;
			}
			boolean drag = RegionsImpl.str(o, "state", "").contains("drag=true");
			for (long p : runs(o.get("cells"))) {
				b.bubble.put(p, drag);
			}
		}
	}

	/** (7a LF) The bubble column state a bubble cell of the body is written as. */
	static BlockState bubbleState(boolean drag) {
		return Blocks.BUBBLE_COLUMN.defaultBlockState().setValue(net.minecraft.world.level.block.BubbleColumnBlock.DRAG_DOWN, drag);
	}

	/**
	 * (6c F3-c) Whether a body cell's world state is open for the gate's check: air, water, lava or ice, a grate cell's bars, or a decor
	 * cell holding its own decor's block (the stage's tiles wrote it before a stop).
	 */
	static boolean openCell(Body body, long p, BlockState now) {
		if (now.isAir() || now.is(Blocks.WATER) || now.is(Blocks.LAVA) || now.is(Blocks.ICE) || now.is(Blocks.FROSTED_ICE)) {
			return true;
		}
		if (body.grate.length > 0 && now.is(Blocks.IRON_BARS) && body.gratePos(p)) {
			return true;
		}
		if (now.is(Blocks.BUBBLE_COLUMN) && body.bubble.containsKey(p)) {
			return true; // (7a LF) a bubble cell holding its column (the stage's tiles wrote it before a stop)
		}
		String d = body.decorState.get(p);
		return d != null && now.getBlock() == parse(d).getBlock();
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

	/**
	 * The region's fluids (loaded on first use), or null when its IR has no body. (6d RV, §7) A revision's bodies are their own record: the
	 * revision's Live ({@link Revisions#liveFor}) reads the bodies of its IR alone, keyed {@code <region>#rv<rid>}, saved in
	 * {@code fluids-rv<rid>.json}; the realised plan's are the region's as before.
	 */
	static @Nullable Regional of(RegionsImpl.Live l) {
		String key = key(l);
		Regional st = STATE.get(key);
		if (st != null) {
			return st.bodies.isEmpty() ? null : st;
		}
		st = new Regional(bodiesOf(l.ir().json()));
		st.irrigation.putAll(irrigationLots(l.ir().json()));
		if (!st.bodies.isEmpty()) {
			load(l, st);
			opened(l, st);
		}
		STATE.put(key, st);
		return st.bodies.isEmpty() ? null : st;
	}

	/** (6d RV) The record's key: the region, or {@code <region>#rv<rid>} for a revision's bodies. */
	static String key(RegionsImpl.Live l) {
		return l.rid() == 0 ? l.rec().id : l.rec().id + "#rv" + l.rid();
	}

	/** (6d RV) A revision's bodies' record is forgotten (an undo finished: its revision UNDONE; its file stays). */
	public static void forgetRevision(String regionId, int rid) {
		Regional st = STATE.remove(regionId + "#rv" + rid);
		if (st != null) {
			hold(null, st, false);
		}
	}

	/** (6d RV) The fluids stage's name in a revision ({@code rv<rid>:fluids}) or a region. */
	static String stageOf(RegionsImpl.Live l) {
		return l.rid() == 0 ? STAGE : Revisions.stageName(l.rid(), STAGE);
	}

	/** (6d RV) The region's records in removal order: its standing revisions' (top first), then its own. */
	static List<RegionsImpl.Live> lives(RegionsImpl.Live base) {
		List<RegionsImpl.Live> out = new ArrayList<>();
		List<Revisions.Rev> revs = new ArrayList<>(base.rec().revisions);
		revs.sort(java.util.Comparator.comparingInt((Revisions.Rev r) -> r.position).reversed());
		for (Revisions.Rev r : revs) {
			if (!"UNDONE".equals(r.state) && !"STALE".equals(r.state) && !r.stages.isEmpty()) {
				RegionsImpl.Live rl = Revisions.liveFor(base, r.stages.get(0));
				if (rl.rid() == r.rid) {
					out.add(rl);
				}
			}
		}
		out.add(base);
		return out;
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
		if (stage == null || !STAGE.equals(Revisions.plainStage(stage)) || !RegionItems.isRegion(b)) {
			return true;
		}
		RegionsImpl.Live l0 = RegionsImpl.live(b.ext.get(RegionItems.EXT_REGION).getAsString());
		RegionsImpl.Live l = l0 == null ? null : Revisions.liveFor(l0, stage); // (6d RV) a revision's bodies
		Regional st = l == null ? null : of(l);
		// (slice DF, rule 3) past its gate the stage goes on only while its record is durably on disk: an owed record is written again first
		if (st != null && !"gate".equals(st.phase) && !durable(l, st)) {
			RegionItems.waitStage(b, stage, Reason.SITE_BUSY, notDurable(st));
			return false;
		}
		if (st != null && st.recheck) {
			ServerLevel level = l.level(s);
			if (level == null) {
				return false;
			}
			recheck(level, l, st);
		}
		if (st == null || !"gate".equals(st.phase)) {
			return true;
		}
		ServerLevel level = l.level(s);
		if (level == null) {
			return false;
		}
		// (6c RS, §7.3) a survival region's bodies wait for their barriers: every target, road and lot of the region built first (the
		// containment check then reads built shells, linings, weirs and grates' frames, and irrigation's lots BUILT)
		if (l.rec().survival()) {
			String waiting = survivalBarrier(s, l);
			if (waiting != null) {
				// (6c close-out A, §8) with waitsFor {target, part, waiter, say}: what the bodies wait for, sayable
				String[] first = dev.larattalabs.architect.site.RegionTargets.firstBuilding(l.rec().groupId);
				if (first != null) {
					RegionItems.waitStageFor(s, b, stage, first[0], first[1], waiting); // (8a HB) typed on a staged terrain target
				} else {
					RegionItems.waitStage(b, stage, Reason.SITE_BUSY, waiting);
				}
				return false;
			}
		}
		// a body is never written over an entity (§2.3): players wait, hostile mobs go, the others wait
		for (Body body : st.bodies) {
			AABB box = boxOf(body.cells).inflate(1);
			for (ServerPlayer p : level.getEntitiesOfClass(ServerPlayer.class, box)) {
				if (!p.isSpectator()) {
					RegionItems.waitStage(b, stage, Reason.PLAYER_IN_BOX, "a player is in or next to fluid body " + body.id + " (" + p.getName().getString() + ")");
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
				RegionItems.waitStage(b, stage, Reason.OCCUPIED, "in fluid body " + body.id + "'s box: " + String.join(", ", in) + " (move them out)");
				return false;
			}
		}
		// the realise-time containment check (§2.4), then the before states, saved before any source is written
		var hook = beforeCheck;
		if (hook != null) {
			beforeCheck = null;
			hook.accept(level);
		}
		if (st.flowingRegion() && st.bodies.stream().anyMatch(x -> x.wash.length > 0)) {
			WorldJournal.kill("FL7"); // (8c CR) the wash clears journaled (an earlier stage), no source written
		}
		for (Body body : st.bodies) {
			BodyState bs = st.states.get(body.id);
			if (!"pending".equals(bs.state)) {
				continue;
			}
			List<long[]> bad = bypassCheck ? List.of() : check(level, l, body);
			if (!bad.isEmpty()) {
				bs.state = "drained";
				bs.uncontained = true;
				bs.reason = "uncontained: " + bad.size() + "+ shell or join cell(s) do not hold what the body was checked against";
				bs.at.addAll(bad.subList(0, Math.min(NAMED, bad.size())));
				Architect.LOGGER.info("Region {}: fluid body {} is not written ({}): {}", l.rec().id, body.id, bs.reason, cells(bs.at));
				continue;
			}
			// (8c WU, §2.4, §2.2) a flowing body's predicted cells are re-checked live before any source: a block the flow would wash (a torch
			// placed after approval: M25:wash) or meet, or soul sand or magma under one (M25:bubble), holds the body (not written)
			if (st.flowingRegion() && body.flowing() && !bypassCheck) {
				String[] why = new String[1];
				List<long[]> w = washCheck(level, body, why);
				if (!w.isEmpty()) {
					bs.state = "drained";
					bs.uncontained = true;
					bs.why = why[0];
					bs.reason = ("bubble".equals(why[0]) ? "M25:bubble: " + w.size() + " predicted cell(s) over soul sand or magma" : "M25:wash: " + w.size()
						+ " predicted cell(s) hold a block the flow would " + ("wash".equals(why[0]) ? "wash away" : "meet") + " (placed after approval?)");
					if (!"bubble".equals(why[0]) && !"wash".equals(why[0])) {
						bs.why = "uncontained";
					}
					bs.at.addAll(w.subList(0, Math.min(NAMED, w.size())));
					Architect.LOGGER.info("Region {}: fluid body {} is not written ({}): {}", l.rec().id, body.id, bs.reason, cells(bs.at));
				}
			}
		}
		// (6c HY, §3.3) a body not written holds back its upstream closure (none in an H-only region)
		for (Body body : st.bodies) {
			if (st.states.get(body.id).uncontained) {
				holdUpstream(l, st, body);
			}
		}
		for (Body body : st.bodies) {
			BodyState bs = st.states.get(body.id);
			if (!"pending".equals(bs.state)) {
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
		// (6c RS, §7.3) the bodies' write takes a lava bucket per lava source and the grates' iron bars from the owner's stockpile (the
		// bucket comes back); until all of it is there, the stage waits, naming what it lacks
		if (l.rec().survival() && !l.rec().survival.has("chargedAt")) {
			Map<String, Integer> charge = chargeOf(st);
			var booked = dev.larattalabs.architect.site.Stockpiles.get(l.rec().owner);
			if (!charge.isEmpty() && booked != null && booked.ledger().charged(chargeKey(l)) != null && !dev.larattalabs.architect.site.Stockpiles.ledgerOnDisk(s)) {
				// (OVF, review round 4) booked in memory only (its save refused): the stage waits; never settled as charged before the ledger is on disk
				RegionItems.waitStage(b, stage, Reason.SITE_BUSY, "the fluid bodies wait for their charge's ledger save");
				return false;
			}
			if (!charge.isEmpty() && booked != null && settleBooked(l, booked.ledger(), level.getGameTime())) {
				charge = Map.of(); // (fix b5b, review finding 3) booked before a crash lost the record: settled from the ledger, not charged again
			}
			if (!charge.isEmpty()) {
				// (BC-c) the charge counts against the region's maxBill while it builds: past it, the stage waits (nothing charged or written)
				var pile = dev.larattalabs.architect.site.Stockpiles.get(l.rec().owner);
				Map<String, Integer> capOver = dev.larattalabs.architect.site.BillCaps.chargeOver(dev.larattalabs.architect.site.BillCaps.ofRegion(l, l.rid()), pile == null
					? null : pile.ledger(), charge);
				if (!capOver.isEmpty()) {
					RegionItems.waitStage(b, stage, Reason.SITE_BUSY, "the fluid bodies wait bill_cap: their charge " + charge + " is past the region's maxBill by "
						+ capOver + " (a lava bucket per lava source, a grate's iron bars)");
					return false;
				}
				if (!dev.larattalabs.architect.site.Stockpiles.charge(s, l.rec().owner, charge, chargeKey(l), l.rid())) {
					RegionItems.waitStage(b, stage, Reason.SITE_BUSY, "the fluid bodies wait for " + dev.larattalabs.architect.site.Stockpiles.chargeShort(l.rec()
						.owner, charge) + " in the stockpile of " + l.rec().owner + " (a lava bucket per lava source, a grate's iron bars)");
					return false;
				}
				JsonObject c = new JsonObject();
				charge.forEach(c::addProperty);
				l.rec().survival.add("charged", c);
				l.rec().survival.addProperty(dev.larattalabs.architect.site.BillCaps.CHARGED_RID, l.rid()); // (BC-c) counted against that rid's cap
			}
			if (!l.rec().survival.has("chargedAt")) {
				l.rec().survival.addProperty("chargedAt", level.getGameTime());
			}
			RegionsImpl.saveRec(l);
		}
		st.phase = "writing";
		if (!save(l, st)) {
			// (slice DF, rule 3) the before states are not durable: no source is written; the stage waits and the gate runs again
			st.phase = "gate";
			RegionItems.waitStage(b, stage, Reason.SITE_BUSY, notDurable(st));
			WorldJournal.kill("FL1r"); // (slice DF) the record's save refused or in doubt, no source written
			return false;
		}
		report(l, st);
		WorldJournal.kill("FL1"); // the check and the before states saved, no source written
		Architect.LOGGER.info("Region {}: fluids stage checked ({} bod{}, {} not written)", l.rec().id, st.bodies.size(), st.bodies.size() == 1 ? "y" : "ies", st
			.states.values().stream().filter(x -> "drained".equals(x.state)).count());
		return true;
	}

	/** (fix b5b) The ledger key of a survival region's fluids charge (once per region: {@code survival.chargedAt} is never cleared). */
	public static String chargeKey(RegionsImpl.Live l) {
		return "region:" + l.rec().id + "@" + l.rec().createdAt + ":fluids:charge";
	}

	/**
	 * (fix b5b, review finding 3) A fluids charge the ledger booked whose record was not saved: settled from the ledger ({@code charged},
	 * {@code chargedRid}, {@code chargedAt}). Returns whether it settled one; the caller saves the record.
	 */
	public static boolean settleBooked(RegionsImpl.Live l, dev.larattalabs.architect.survival.StockLedger ledger, long now) {
		if (!l.rec().survival() || l.rec().survival.has("chargedAt")) {
			return false;
		}
		var c = ledger.charged(chargeKey(l));
		if (c == null) {
			return false;
		}
		settleCharge(l.rec().survival, c, now);
		Architect.LOGGER.warn("Region {}: its fluids' charge {} was booked before its record was saved: settled from the ledger", l.rec().id, c.items());
		return true;
	}

	/** (fix b5b, pure) The survival record's fluids charge: its items, its rid (BC-c), the time. */
	static void settleCharge(JsonObject survival, dev.larattalabs.architect.survival.StockLedger.Charge c, long now) {
		JsonObject o = new JsonObject();
		new java.util.TreeMap<>(c.items()).forEach(o::addProperty);
		survival.add("charged", o);
		survival.addProperty(dev.larattalabs.architect.site.BillCaps.CHARGED_RID, c.rid());
		survival.addProperty("chargedAt", now);
	}

	/**
	 * (6c RS) Why a survival region's bodies still wait for their barriers (a target, road or lot of the region still building), or null:
	 * every one is built.
	 */
	static @Nullable String survivalBarrier(MinecraftServer s, RegionsImpl.Live l) {
		String group = l.rec().groupId;
		List<String> t = dev.larattalabs.architect.site.RegionTargets.building(group);
		if (!t.isEmpty()) {
			return "the fluid bodies wait for their barriers: " + t.size() + " target" + (t.size() == 1 ? "" : "s") + " of the region still building (" + String
				.join(", ", t.subList(0, Math.min(4, t.size()))) + (t.size() > 4 ? ", ..." : "") + ")";
		}
		String m = dev.larattalabs.architect.site.RegionTargets.buildingMember(group);
		return m == null ? null : "the fluid bodies wait for " + m + " (a lot or road of the region) to be built";
	}

	/**
	 * (6c RS, the gate's conservation) What an owner's survival regions' bodies hold of the stockpile's items as they stand: per standing lava
	 * source a lava bucket less its bucket (the charge gave the bucket back), per standing grate its iron bars. Loaded chunks only.
	 */
	public static Map<String, Integer> survivalStanding(MinecraftServer s, @Nullable String owner) {
		Map<String, Integer> out = new java.util.TreeMap<>();
		for (RegionsImpl.Live l : RegionsImpl.all()) {
			if (!l.rec().survival() || !java.util.Objects.equals(owner, l.rec().owner) || !l.rec().survival.has("charged")) {
				continue;
			}
			Regional st = of(l);
			ServerLevel level = l.level(s);
			if (st == null || level == null) {
				continue;
			}
			for (Body b : st.bodies) {
				BodyState bs = st.states.get(b.id);
				if (bs.before.isEmpty()) {
					continue;
				}
				if (b.lava) {
					for (long p : b.cells) {
						BlockPos bp = BlockPos.of(p);
						if (!level.isLoaded(bp)) {
							continue;
						}
						FluidState f = level.getBlockState(bp).getFluidState();
						if (f.isSource() && f.getType().isSame(Fluids.LAVA)) {
							out.merge("minecraft:lava_bucket", 1, Integer::sum);
							out.merge("minecraft:bucket", -1, Integer::sum);
						}
					}
				}
				for (long p : b.grate) {
					BlockPos bp = BlockPos.of(p);
					if (level.isLoaded(bp) && level.getBlockState(bp).is(Blocks.IRON_BARS)) {
						out.merge("minecraft:iron_bars", 1, Integer::sum);
					}
				}
			}
		}
		return out;
	}

	/**
	 * (6c RS, §7.3) What an owner's survival regions' bodies will take when they are written (a lava bucket per lava source, a grate's iron
	 * bars), per region, while not yet charged: the stockpile accepts these items and lists them as outstanding ({@code <region>:fluids}).
	 */
	public static Map<String, Map<String, Integer>> pendingCharges(@Nullable String owner) {
		Map<String, Map<String, Integer>> out = new java.util.TreeMap<>();
		for (RegionsImpl.Live l : RegionsImpl.all()) {
			if (!l.rec().survival() || !java.util.Objects.equals(owner, l.rec().owner) || l.rec().survival.has("chargedAt")
				|| l.rec().state == dev.larattalabs.architect.api.RegionState.REMOVING || l.rec().state == dev.larattalabs.architect.api.RegionState.REMOVED) {
				continue;
			}
			Regional st = of(l);
			if (st == null) {
				continue;
			}
			Map<String, Integer> c = chargeOf(st);
			if (!c.isEmpty()) {
				out.put(l.rec().id + ":fluids", c);
			}
		}
		return out;
	}

	/** (6c RS, §7.3) What the pending bodies' write takes: a lava bucket per lava source, an iron bars per grate cell. */
	static Map<String, Integer> chargeOf(Regional st) {
		Map<String, Integer> out = new java.util.TreeMap<>();
		for (Body b : st.bodies) {
			BodyState bs = st.states.get(b.id);
			if (!"pending".equals(bs.state)) {
				continue;
			}
			if (b.lava && b.cells.length > 0) {
				out.merge("minecraft:lava_bucket", b.cells.length, Integer::sum);
			}
			if (b.grate.length > 0) {
				out.merge("minecraft:iron_bars", b.grate.length, Integer::sum);
			}
		}
		return out;
	}

	/**
	 * (6c HY, §3.3) Every body upstream of {@code k} that is still pending is never written: drained, held, {@code reason: "upstream of
	 * <k>"} (its tiles leave its cells when the gate has not run them yet; cells they wrote already are cleared by the drain).
	 */
	static void holdUpstream(RegionsImpl.Live l, Regional st, Body k) {
		for (Body u : upstreamOf(st, k)) {
			BodyState us = st.states.get(u.id);
			if (!"pending".equals(us.state)) {
				continue;
			}
			us.state = "drained";
			us.held = true;
			us.reason = "upstream of " + k.id;
			us.at.clear();
			Architect.LOGGER.info("Region {}: fluid body {} is not written (upstream of {})", l.rec().id, u.id, k.id);
		}
	}

	/**
	 * (§3.5) A stop after the check and before the stage was written: the world may have lost what the check saw (chunks not saved since
	 * the shells were written), so each body is checked again before its tiles. One that fails now is drained (its own cells back to
	 * their before states: idempotent, a no-op when nothing was written) and not written, uncontained, naming the cells.
	 */
	static void recheck(ServerLevel level, RegionsImpl.Live l, Regional st) {
		st.recheck = false;
		if (!"writing".equals(st.phase)) {
			return;
		}
		boolean changed = false;
		for (Body body : st.bodies) {
			BodyState bs = st.states.get(body.id);
			if (!"pending".equals(bs.state) || bs.before.isEmpty()) {
				continue;
			}
			List<long[]> bad = bypassCheck ? List.of() : check(level, l, body);
			if (bad.isEmpty()) {
				continue;
			}
			drain(level, st, body, bs, false, st.othersOf(body));
			bs.state = "drained";
			bs.uncontained = true;
			bs.reason = "uncontained: " + bad.size() + "+ shell or join cell(s) do not hold what the body was checked against (checked again after a stop)";
			bs.at.clear();
			bs.at.addAll(bad.subList(0, Math.min(NAMED, bad.size())));
			Architect.LOGGER.warn("Region {}: fluid body {} is not written ({}): {}", l.rec().id, body.id, bs.reason, cells(bs.at));
			// (6c HY) its upstream closure: pending bodies are held, their tile-written cells (if any) cleared
			for (Body u : upstreamOf(st, body)) {
				BodyState us = st.states.get(u.id);
				if ("pending".equals(us.state) && !us.before.isEmpty()) {
					drain(level, st, u, us, false, st.othersOf(u));
				}
			}
			holdUpstream(l, st, body);
			changed = true;
		}
		if (changed) {
			save(l, st);
			report(l, st);
		}
	}

	/**
	 * (8c WU, §2.4) A flowing body's predicted cells (its own cells aside) as they stand before any source: each must be air or a fluid. A
	 * washable block there (a torch, a plant, a rail: not fluid-stopping) is {@code wash}; any other block {@code meet}; soul sand or magma
	 * under a predicted cell {@code bubble}. Returns the cells, {@code why[0]} the first kind found (wash before bubble before meet).
	 */
	static List<long[]> washCheck(ServerLevel level, Body body, String[] why) {
		List<long[]> wash = new ArrayList<>(), meet = new ArrayList<>(), bub = new ArrayList<>();
		LongOpenHashSet own = body.ownSet();
		long[] keys = body.predicted.keySet().toLongArray();
		java.util.Arrays.sort(keys);
		for (long p : keys) {
			if (own.contains(p)) {
				continue;
			}
			BlockPos bp = BlockPos.of(p);
			BlockState now = level.getBlockState(bp);
			long[] c = {bp.getX(), bp.getY(), bp.getZ()};
			if (!now.isAir() && now.getFluidState().isEmpty()) {
				(fluidStopping(level, bp, now) ? meet : wash).add(c);
			}
			BlockState under = level.getBlockState(bp.below());
			if (under.is(Blocks.SOUL_SAND) || under.is(Blocks.MAGMA_BLOCK)) {
				bub.add(c);
			}
		}
		why[0] = !wash.isEmpty() ? "wash" : !bub.isEmpty() ? "bubble" : !meet.isEmpty() ? "meet" : null;
		return !wash.isEmpty() ? wash : !bub.isEmpty() ? bub : meet;
	}

	/**
	 * The containment check of one body (§2.4): the shell cells and joins that fail, as [x, y, z] (empty: it holds). A shell cell holds
	 * when the region's own top journal cell there holds in the world, or (a cell its tile found already so) no entry has a cell there,
	 * no protected area of the owner covers it, and the world holds natural, fluid-stopping, non-gravity ground; a join holds when it is
	 * still a water source; every cell of the body (and its ice cap) is open: air, water, lava or ice.
	 */
	static List<long[]> check(ServerLevel level, RegionsImpl.Live l, Body body) {
		List<long[]> bad = new ArrayList<>();
		String dim = l.rec().dimension;
		var areas = dev.larattalabs.architect.site.Protected.of(dim, l.rec().owner);
		long[] wall = body.lining.length == 0 ? body.shell : java.util.stream.LongStream.concat(java.util.Arrays.stream(body.shell), java.util.Arrays.stream(body.lining)).toArray();
		for (long p : wall) {
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
		// the body's own cells are open (dug in an earlier stage, or already its fluid): a cell that is not (lost with unsaved chunks, or
		// filled since) is not what the body was checked against
		for (long[] a : new long[][] {body.cells, body.ice}) {
			for (long p : a) {
				BlockState now = level.getBlockState(BlockPos.of(p));
				if (!openCell(body, p, now)) {
					bad.add(new long[] {BlockPos.getX(p), BlockPos.getY(p), BlockPos.getZ(p)});
				}
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
		if (!STAGE.equals(Revisions.plainStage(stage))) {
			return t;
		}
		Regional st = of(l);
		if (st == null) {
			return t;
		}
		LongOpenHashSet drop = new LongOpenHashSet();
		for (Body b : st.bodies) {
			BodyState bs = st.states.get(b.id);
			// not contained (or held, HY): never written; (6c IRR) nor a source whose lot was removed
			if ("drained".equals(bs.state) && (bs.uncontained || bs.held || bs.lotRemoved || bs.before.isEmpty())) {
				for (long p : b.cells) {
					drop.add(p);
				}
				for (long p : b.ice) {
					drop.add(p);
				}
				// ((6c F3-c) and its decor: no live coral on a bed that holds no water)
				for (long p : b.decor) {
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
		byte[] cls = t.cls() == null ? null : new byte[n];
		int[] grp = t.group() == null ? null : new int[n];
		int k = 0;
		for (int i = 0; i < t.size(); i++) {
			if (drop.contains(t.pos()[i])) {
				continue;
			}
			pos[k] = t.pos()[i];
			state[k] = t.state()[i];
			cond[k] = t.cond()[i];
			walk[k] = t.walk()[i];
			if (cls != null) {
				cls[k] = t.cls()[i]; // (6c RS) a survival tile keeps its classes
				grp[k] = t.group()[i];
			}
			k++;
		}
		return new Packed.Tile(pos, state, cond, walk, t.states(), t.stateIds(), t.sha(), cls, grp);
	}

	/** Whether the fluids stage's tiles may be checked ahead (the gate ran): a tile of a body not written must leave its cells first. */
	public static boolean checkedAhead(RegionsImpl.Live l, String stage) {
		if (!STAGE.equals(Revisions.plainStage(stage))) {
			return true;
		}
		Regional st = of(l);
		return st == null || !"gate".equals(st.phase);
	}

	// ------------------------------------------------------------------ the forced tick, settle and census

	/** Server tick: the forced ticks once the stage's tiles are placed, then each settling body's census. */
	public static void tick(MinecraftServer s) {
		for (RegionsImpl.Live l0 : RegionsImpl.all()) {
			if (l0.rec().state == dev.larattalabs.architect.api.RegionState.REMOVING || l0.rec().state == dev.larattalabs.architect.api.RegionState.REMOVED) {
				continue;
			}
			for (RegionsImpl.Live l : lives(l0)) { // (6d RV) the region's bodies and each standing revision's
			if (l.rid() > 0 && l0.rec().busy != null && l0.rec().busy.startsWith("undoing ")) {
				continue; // (an undo drains them: no census of its own meanwhile)
			}
			Regional st = of(l);
			if (st == null) {
				continue;
			}
			ServerLevel level = l.level(s);
			if (level == null) {
				continue;
			}
			hold(level, st, "writing".equals(st.phase) || "settling".equals(st.phase));
			if (st.owed && !durable(l, st)) {
				continue; // (slice DF, rule 3) nothing forced, written or settled while the record is not on disk
			}
			if ("writing".equals(st.phase) && stageWritten(l)) {
				if (st.ordered) {
					writeWaves(level, l, st); // (6c HY) one wave of bodies whose landings have settled
				} else {
					force(level, l, st);
				}
			}
			if (("settling".equals(st.phase) || st.ordered && "writing".equals(st.phase) && st.forcedAt >= 0) && level.getGameTime() - st.lastCensus >= CENSUS_EVERY) {
				st.lastCensus = level.getGameTime();
				settle(level, l, st);
			}
			}
		}
	}

	/** Whether every item of the region's fluids stage ended (placed or failed). */
	static boolean stageWritten(RegionsImpl.Live l) {
		// (6d RV) a revision's stage is in its own batch
		Revisions.Rev rv = l.rid() == 0 ? null : Revisions.rev(l.rec(), l.rid());
		String bid = l.rid() == 0 ? l.rec().batchId : rv == null ? null : rv.batchId;
		QBatch b = bid == null ? null : Batches.get(bid);
		if (b == null) {
			return false;
		}
		List<QItem> items = b.inStage(stageOf(l));
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
			n += forceBody(level, b);
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

	/**
	 * (6c HY, §3.1) An ordered region's writer, once the stage's tiles are placed, each tick: every pending body whose landings (its
	 * {@code after}, those before it in the write order) have all settled is written again (its sources, ice cap and grate, where the cell is
	 * open) and forced, as {@link #force} forces an H region's; every other pending body is first cleared back to its before states (the
	 * tiles wrote it with the others; nothing flowed, no tick was forced). FL4 between two waves, FL2 once the last is written.
	 */
	static void writeWaves(ServerLevel level, RegionsImpl.Live l, Regional st) {
		long now = level.getGameTime();
		if (st.forcedAt < 0) {
			st.forcedAt = now;
		}
		java.util.Map<String, Integer> pos = new java.util.HashMap<>();
		for (int i = 0; i < st.order.size(); i++) {
			pos.put(st.order.get(i).id, i);
		}
		List<Body> due = new ArrayList<>();
		List<Body> waiting = new ArrayList<>();
		for (Body b : st.order) {
			BodyState bs = st.states.get(b.id);
			if (!"pending".equals(bs.state)) {
				continue;
			}
			boolean ready = true;
			for (String a : b.after) {
				BodyState as = st.states.get(a);
				Integer ai = pos.get(a);
				if (as != null && ai != null && ai < pos.get(b.id) && !"settled".equals(as.state)) {
					ready = false;
				}
			}
			(ready ? due : waiting).add(b);
		}
		if (!st.cleared) {
			st.cleared = true;
			int n = 0;
			for (Body b : waiting) {
				BodyState bs = st.states.get(b.id);
				if (!bs.before.isEmpty()) {
					n += drain(level, st, b, bs, false, st.othersOf(b));
				}
			}
			if (n > 0) {
				Architect.LOGGER.info("Region {}: {} body cell(s) written by the stage's tiles cleared until their bodies are due", l.rec().id, n);
			}
		}
		int forced = 0;
		for (Body b : due) {
			BodyState bs = st.states.get(b.id);
			writeBody(level, b);
			forced += forceBody(level, b);
			bs.state = "written";
			bs.writtenAt = now;
			bs.sources = b.cells.length;
			bs.spill = b.spill.length;
		}
		if (due.isEmpty()) {
			return;
		}
		boolean more = st.states.values().stream().anyMatch(x -> "pending".equals(x.state));
		if (!more) {
			st.phase = "settling";
		}
		save(l, st);
		Architect.LOGGER.info("Region {}: fluids wave {}: {} forced fluid tick(s){}", l.rec().id, due.stream().map(b -> b.id).toList(), forced, more ? "" : "; every body written, settling");
		WorldJournal.kill(more ? "FL4" : "FL2"); // (6c HY) between two reaches: the downstream written, the upstream not
	}

	/**
	 * (6c HY) A body's sources, ice cap and grate written where the cell is open (air, a fluid, ice; a grate cell's bars), no update.
	 * (6c F3-c) Then its decor where the cell is open (after its water: a decor cell never takes a source first).
	 */
	static void writeBody(ServerLevel level, Body b) {
		LongOpenHashSet grate = new LongOpenHashSet(b.grate);
		LongOpenHashSet ice = new LongOpenHashSet(b.ice);
		BlockState src = (b.lava ? Blocks.LAVA : Blocks.WATER).defaultBlockState();
		BlockState bars = parse(GRATE);
		for (long p : b.cells) {
			if (b.decorState.containsKey(p)) {
				continue; // (6c F3-c) the decor's own cell: written below, never water first
			}
			BlockPos bp = BlockPos.of(p);
			BlockState now = level.getBlockState(bp);
			BlockState to = ice.contains(p) ? Blocks.ICE.defaultBlockState() : grate.contains(p) ? bars : b.bubble.containsKey(p) ? bubbleState(b.bubble.get(p)) : src;
			boolean open = now.isAir() || !now.getFluidState().isEmpty() || now.is(Blocks.ICE) || now.is(Blocks.FROSTED_ICE) || grate.contains(p) && now.is(Blocks.IRON_BARS);
			if (open && now != to) {
				dev.larattalabs.architect.placed.Placed.set(level, bp, to, Block.UPDATE_CLIENTS | Block.UPDATE_SKIP_ALL_SIDEEFFECTS);
			}
		}
		// ((6c F3-c) the decor: a body cell's where it is open (air, a fluid, ice, or its decor already); a bed cell's stays as the tiles
		// wrote it (the shell's cell, never cleared))
		LongOpenHashSet own = b.decor.length > 0 ? new LongOpenHashSet(b.cells) : null;
		for (long p : b.decor) {
			if (!own.contains(p)) {
				continue;
			}
			BlockPos bp = BlockPos.of(p);
			BlockState now = level.getBlockState(bp);
			BlockState to = parse(b.decorState.get(p));
			if (openCell(b, p, now) && now != to) {
				dev.larattalabs.architect.placed.Placed.set(level, bp, to, Block.UPDATE_CLIENTS | Block.UPDATE_SKIP_ALL_SIDEEFFECTS);
			}
		}
		// ((6c HY-c, §8.3) the grate's bars joined to each other and to the shell, as vanilla's own neighbour update would join them:
		// unjoined bars are posts 2/16 wide with gaps of 14/16, which a 0.6-wide mob passes (HY-c's probe). Still no update sent.)
		for (long p : b.grate) {
			BlockPos bp = BlockPos.of(p);
			BlockState now = level.getBlockState(bp);
			if (!now.is(Blocks.IRON_BARS)) continue;
			BlockState joined = Block.updateFromNeighbourShapes(now, level, bp);
			if (joined != now && joined.is(Blocks.IRON_BARS)) {
				dev.larattalabs.architect.placed.Placed.set(level, bp, joined, Block.UPDATE_CLIENTS | Block.UPDATE_SKIP_ALL_SIDEEFFECTS);
			}
		}
	}

	/**
	 * One fluid tick on every source of a body and every face neighbour that is no body cell (§3.2); the ticks scheduled. (7a LF) A bubble
	 * cell gets a block tick instead (BubbleColumnBlock.tick keeps the column over its base, or turns it back to water); its neighbours
	 * outside the body get the fluid tick as any source's.
	 */
	static int forceBody(ServerLevel level, Body b) {
		int n = 0;
		LongOpenHashSet own = new LongOpenHashSet(b.cells);
		Fluid f = b.source();
		for (long p : b.cells) {
			BlockPos bp = BlockPos.of(p);
			if (b.bubble.containsKey(p)) {
				level.scheduleTick(bp, Blocks.BUBBLE_COLUMN, 1);
			} else {
				level.scheduleTick(bp, f, 1);
			}
			n++;
			for (net.minecraft.core.Direction d : net.minecraft.core.Direction.values()) {
				BlockPos q = bp.relative(d);
				if (!own.contains(q.asLong())) {
					level.scheduleTick(q, f, 1);
					n++;
				}
			}
		}
		return n;
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
				ticking = true; // not seen is not settled (the ticket loads it)
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
				} else if (b.bubble.containsKey(p) && !(s.is(Blocks.BUBBLE_COLUMN) && s.getValue(net.minecraft.world.level.block.BubbleColumnBlock.DRAG_DOWN) == b.bubble.get(p))) {
					mismatch.add(c); // (7a LF) a bubble cell is the body's source only as its column (the census counts it so)
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
			long t0 = bs.writtenAt >= 0 ? bs.writtenAt : st.forcedAt;
			if (!c.escaped().isEmpty()) {
				escape(level, l, st, b, bs, "escaped", c.escaped());
				bs.why = "escaped";
				changed = true;
			} else if (!c.ticking() && c.mismatch().isEmpty()) {
				bs.state = "settled";
				bs.settledAt = now - t0;
				changed = true;
				Architect.LOGGER.info("Region {}: fluid body {} settled in {} ticks (bound {})", l.rec().id, b.id, bs.settledAt, b.settleTicks);
			} else if (now - t0 > 2L * b.settleTicks) {
				boolean foreign = b.flowing() && foreignIn(level, b, st);
				escape(level, l, st, b, bs, "unsettled", c.mismatch());
				bs.why = foreign ? "foreign_water" : "census_drift"; // (8c WU, Steward's S-8c-2) a typed why: water not ours in the watch set, else the model drifted
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

	/**
	 * (8c WU) Whether water that isn't the body's stands in its watch set: a cell holding fluid before the write ({@code fluidBefore}), a
	 * source no body plans (a player's bucket, a spring), or a waterlogged block that isn't one of its own cells.
	 */
	static boolean foreignIn(ServerLevel level, Body b, Regional st) {
		LongOpenHashSet own = b.ownSet(), others = st.othersOf(b);
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		for (long p : b.watchSet()) {
			if (own.contains(p) || others.contains(p)) {
				continue;
			}
			m.set(p);
			if (!level.isLoaded(m)) {
				continue;
			}
			BlockState s = level.getBlockState(m);
			FluidState f = s.getFluidState();
			if (f.isEmpty()) {
				continue;
			}
			if (st.fluidBefore.containsKey(p) || f.isSource()) {
				return true;
			}
		}
		return false;
	}

	/** §3.4: the escape guard: drain the body now, report it drained with the cells. */
	static void escape(ServerLevel level, RegionsImpl.Live l, Regional st, Body b, BodyState bs, String why, List<long[]> at) {
		// (6c HY, §3.3) the upstream closure first, in the same tick, upstream first: a reach above would pour into this one's emptied cells
		for (Body u : upstreamOf(st, b)) {
			BodyState us = st.states.get(u.id);
			if ("drained".equals(us.state)) {
				continue;
			}
			int un = us.before.isEmpty() ? 0 : drain(level, st, u, us, !"pending".equals(us.state), st.othersOf(u));
			if ("pending".equals(us.state)) {
				us.held = true;
			}
			us.state = "drained";
			us.reason = "upstream of " + b.id;
			us.at.clear();
			Architect.LOGGER.warn("Region {}: fluid body {} drained (upstream of {}; {} cell(s) restored)", l.rec().id, u.id, b.id, un);
		}
		if ("escaped".equals(why)) {
			for (long[] c : at) {
				bs.escapedCells.add(BlockPos.asLong((int) c[0], (int) c[1], (int) c[2]));
			}
		}
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
	 * whose state is not their before state (the full state, a flowing level included); with {@code strays}, the body's predicted cells and
	 * the cells the census recorded as escaped from it ({@link BodyState#escapedCells}) holding its fluid where none was before go back to
	 * air (or a record). Any other fluid in the watch set is kept: a player's or another system's water added after the realise (§4.2).
	 * Writes skip updates (nothing flows). Returns the cells written.
	 */
	static int drain(ServerLevel level, Regional st, Body b, BodyState bs, boolean strays) {
		// ((6c F3-c) only the removal drains through here: it leaves the decor for the group undo, H's order)
		return drain(level, st, b, bs, strays, new LongOpenHashSet(), NOT_HELD, true);
	}

	/** (UMT seam, docs/UMT.md) Where a drain reads and writes cells: the level, or the undo model tester's in-memory world. */
	interface DrainTarget {
		BlockState get(BlockPos p);

		/** An Architect write of one cell ({@code Placed.set}). */
		void set(BlockPos p, BlockState s, int flags);
	}

	/** {@code others}: cells another standing body plans, left alone (the escape guard drains one body of several). */
	static int drain(ServerLevel level, Regional st, Body b, BodyState bs, boolean strays, LongOpenHashSet others) {
		return drain(level, st, b, bs, strays, others, NOT_HELD, false);
	}

	/** No cell held: every drain but the removal's ({@link #removalGate}). */
	static final java.util.function.LongPredicate NOT_HELD = p -> false;

	/**
	 * (fix/drain-holders) {@code held}: cells the drain never writes, though they hold a fluid or ice: the removal's cells another journal
	 * entry holds on top ({@link Holders}). The journal's undo hands their before down to that entry and leaves its block standing (its
	 * covering mask), so the drain leaves them too: a later site's waterlogged block in a body cell keeps its block and its water.
	 * (6c F3-c) {@code removal}: the removal's drain leaves the body's decor standing (the group undo restores it and the bed right after,
	 * H's order); every other drain (the escape guard, an unsettled body, the upstream closure, a recheck, a wave's clear, a lot removed)
	 * takes a water decor cell back to its before state with the sources, so a drained body holds no water (a bed coral block holds none
	 * and stays).
	 */
	static int drain(ServerLevel level, Regional st, Body b, BodyState bs, boolean strays, LongOpenHashSet others, java.util.function.LongPredicate held,
		boolean removal) {
		return drain(new DrainTarget() {
			@Override
			public BlockState get(BlockPos p) {
				return level.getBlockState(p);
			}

			@Override
			public void set(BlockPos p, BlockState s, int flags) {
				dev.larattalabs.architect.placed.Placed.set(level, p, s, flags);
			}
		}, level, st, b, bs, strays, others, held, removal);
	}

	/**
	 * {@link #drain(ServerLevel, Regional, Body, BodyState, boolean, LongOpenHashSet, java.util.function.LongPredicate, boolean)} through
	 * {@code t}; {@code level} is read only by an irrigation body's breach judgement (none: it may be null).
	 */
	static int drain(DrainTarget t, @Nullable ServerLevel level, Regional st, Body b, BodyState bs, boolean strays, LongOpenHashSet others,
		java.util.function.LongPredicate held, boolean removal) {
		int n = 0;
		Fluid src = b.source();
		LongOpenHashSet grate = new LongOpenHashSet(b.grate);
		// ((6c IRR, the batch's fix) an irrigation source's breach flow is judged before anything is written: once the source is air, its
		// flow has no feeder left to tell it from a pond's or a player's)
		int[] lot = strays ? st.irrigation.get(b.id) : null;
		LongOpenHashSet breach = lot == null ? null : breachFlow(level, st, b, lot, others);
		for (long[] a : new long[][] {b.ice, b.cells}) {
			for (long p : a) {
				if (removal && drainSkips(b, p)) {
					continue; // ((6c F3-c) a decor cell: the group undo restores it after the drain, as the bed)
				}
				BlockPos bp = BlockPos.of(p);
				BlockState now = t.get(bp);
				// ((6c HY) a grate cell goes back too, whether its bars still hold the water or not)
				if (now.getFluidState().isEmpty() && !now.is(Blocks.ICE) && !now.is(Blocks.FROSTED_ICE) && !(grate.contains(p) && now.is(Blocks.IRON_BARS))) {
					continue;
				}
				if (held.test(p)) {
					continue; // (fix/drain-holders) another entry's block on top: handed down by the undo, not drained
				}
				String before = bs.before.get(p);
				BlockState to = before == null ? Blocks.AIR.defaultBlockState() : parse(before);
				if (now != to) {
					t.set(bp, to, Block.UPDATE_CLIENTS | Block.UPDATE_SKIP_ALL_SIDEEFFECTS);
					n++;
				}
			}
		}
		for (long[] a : new long[][] {b.spill, b.watch}) {
			for (long p : a) {
				BlockPos bp = BlockPos.of(p);
				BlockState now = t.get(bp);
				FluidState f = now.getFluidState();
				if (f.isEmpty() || others.contains(p) || held.test(p)) {
					continue;
				}
				String before = bs.before.get(p);
				BlockState was = before == null ? Blocks.AIR.defaultBlockState() : parse(before);
				if (now == was) {
					continue; // as it was before (a natural cell, its level included): not the body's doing
				}
				t.set(bp, was, Block.UPDATE_CLIENTS | Block.UPDATE_SKIP_ALL_SIDEEFFECTS);
				n++;
			}
		}
		if (strays) {
			LongOpenHashSet own = new LongOpenHashSet(b.cells);
			for (long p : strayCandidates(b, bs)) {
				if (own.contains(p) || st.fluidBefore.containsKey(p) || others.contains(p)) {
					continue;
				}
				BlockPos bp = BlockPos.of(p);
				BlockState now = t.get(bp);
				if (now.getBlock() instanceof LiquidBlock && now.getFluidState().getType().isSame(src) && !held.test(p)) {
					// a cell another body recorded (its breached shell cell, its watched cell) goes back to that record, not to air: that body's
					// own drain, later in the removal, finds no fluid there any more
					String was = beforeAny(st, p);
					t.set(bp, was == null ? Blocks.AIR.defaultBlockState() : parse(was), Block.UPDATE_CLIENTS
						| Block.UPDATE_SKIP_ALL_SIDEEFFECTS);
					n++;
				}
			}
			// ((6c IRR) an irrigation source: its breach's flow over its own field too)
			if (breach != null) {
				n += sweepBreach(level, st, b, bs, breach, held);
			}
		}
		return n;
	}

	/**
	 * (6c F3-c, §6) Whether the removal's drain leaves a body cell alone: a decor cell (the coral's own water is its block's). The
	 * removal's group undo restores it after the drain, with the bed: H's order, drain then decor and bed. Other drains take it.
	 */
	static boolean drainSkips(Body b, long p) {
		return b.decor.length > 0 && b.decorSet().contains(p);
	}

	/** (6c IRR) How far past its lot's box a breach's flow is followed (water runs 7 from its source, then falls). */
	static final int BREACH_REACH = 8;

	/**
	 * (6c IRR, S-IRR-3, S-IRR-4) An irrigation source's breach floods its own field: a player broke a farmland side, and the water ran
	 * over the field (a bare pad: up to 7 over it and past its edge). With {@code strays}, the drain takes back the breach's flow, the
	 * cells {@link #breachFlow} judged this body's before the drain wrote anything, each to the region's record (else air): no orphan
	 * water. Counted in {@link BodyState#breached}.
	 */
	static int sweepBreach(ServerLevel level, Regional st, Body b, BodyState bs, LongOpenHashSet take, java.util.function.LongPredicate held) {
		Fluid src = b.source();
		long[] cells = take.toLongArray();
		java.util.Arrays.sort(cells);
		int n = 0;
		for (long k : cells) {
			BlockPos p = BlockPos.of(k);
			BlockState now = level.getBlockState(p);
			FluidState f = now.getFluidState();
			if (!(now.getBlock() instanceof LiquidBlock) || f.isSource() || !f.getType().isSame(src) || held.test(k)) {
				continue; // (a stray pass took it already, or it changed; or another entry holds it on top)
			}
			String was = beforeAny(st, k);
			dev.larattalabs.architect.placed.Placed.set(level, p, was == null ? Blocks.AIR.defaultBlockState() : parse(was), Block.UPDATE_CLIENTS
				| Block.UPDATE_SKIP_ALL_SIDEEFFECTS);
			n++;
		}
		bs.breached += n;
		return n;
	}

	/**
	 * (6c IRR, the batch's fix of the verifier's breach finding) The cells of an irrigation body's breach flow, judged from the world as it
	 * stands, before the drain writes: {@link #breachTake} over the body's own cells, shell and watch, within its lot's box grown by
	 * {@link #BREACH_REACH} and from 12 under its floor to 1 over it. Water there before the realise ({@code fluidBefore}) and another
	 * body's cells are never taken, and they feed nothing of this body's.
	 */
	static LongOpenHashSet breachFlow(ServerLevel level, Regional st, Body b, int[] lot, LongOpenHashSet others) {
		Fluid src = b.source();
		LongOpenHashSet foreign = new LongOpenHashSet(others);
		foreign.addAll(st.fluidBefore.keySet());
		java.util.List<long[]> seeds = List.of(b.cells, b.shell, b.watch);
		int[] box = {lot[0] - BREACH_REACH, lot[4] - 12, lot[1] - BREACH_REACH, lot[2] + BREACH_REACH, lot[4] + 1, lot[3] + BREACH_REACH};
		return breachTake(seeds, new LongOpenHashSet(b.cells), foreign, box, k -> {
			BlockState s = level.getBlockState(BlockPos.of(k));
			FluidState f = s.getFluidState();
			return f.isEmpty() || !f.getType().isSame(src) ? null : new Wet(f.getAmount(), f.isSource(), s.getBlock() instanceof LiquidBlock);
		}, BREACH_MAX);
	}

	/** (6c IRR) The most cells {@link #breachTake} follows. */
	static final int BREACH_MAX = 65536;

	/** (6c IRR) A cell holding the body's fluid: its amount (8 for a source or falling water), a source (a waterlogged block too), a liquid block. */
	record Wet(int amount, boolean source, boolean liquid) {
	}

	/**
	 * (6c IRR, the batch's fix) Which water a breach's flow is, read from the fluid levels (pure: {@code at} reads a cell, null = not the
	 * body's fluid). A breach comes after the body settled, when no census runs, so nothing recorded its flow as it ran; the levels show
	 * where each cell is fed from. First the flowing water connected to the seeds (the body's cells, shell and watch, whatever they hold now)
	 * inside {@code box} {x0, y0, z0, x1, y1, z1}: never a source (a pond's, a player's bucket, a waterlogged block), never a
	 * {@code foreign} cell (water there before the realise, another body's). Then every cell with a feeder outside the set is dropped, and
	 * what it fed after it, until none is left: a feeder is a neighbour of the same fluid at a higher amount, or the cell over it (the body's
	 * own source cells count as inside). The flow is followed from the body's cells and the taken cells only. So the flow that only this body's source can have made is taken; a flow joined by a pond or a
	 * player's water is spared where they meet and everywhere downstream of that (a few cells of joint water may stay). A cell with no feeder
	 * at all (the source already drained: a removal resumed after a stop) stays in the set.
	 */
	static LongOpenHashSet breachTake(java.util.List<long[]> seeds, LongOpenHashSet own, LongOpenHashSet foreign, int[] box,
		java.util.function.LongFunction<@Nullable Wet> at, int max) {
		LongOpenHashSet set = new LongOpenHashSet();
		LongOpenHashSet seen = new LongOpenHashSet();
		java.util.ArrayDeque<Long> q = new java.util.ArrayDeque<>();
		for (long[] a : seeds) {
			for (long p : a) {
				if (seen.add(p)) {
					q.add(p);
					if (!own.contains(p) && takeable(p, foreign, box, at)) {
						set.add(p);
					}
				}
			}
		}
		while (!q.isEmpty() && seen.size() < max) {
			long p = q.poll();
			if (!own.contains(p) && !set.contains(p)) {
				continue; // (a seed holding no flow of this body's: nothing to follow from it)
			}
			for (net.minecraft.core.Direction d : net.minecraft.core.Direction.values()) {
				long k = BlockPos.offset(p, d);
				if (!seen.add(k)) {
					continue;
				}
				if (own.contains(k) || takeable(k, foreign, box, at)) {
					if (!own.contains(k)) {
						set.add(k);
					}
					q.add(k);
				}
			}
		}
		// prune: a cell fed from outside the set goes, and so may what it fed
		java.util.ArrayDeque<Long> w = new java.util.ArrayDeque<>();
		for (long p : set) {
			w.add(p);
		}
		while (!w.isEmpty()) {
			long p = w.poll();
			if (!set.contains(p)) {
				continue;
			}
			Wet c = at.apply(p);
			if (c == null || fedFromOutside(p, c, set, own, at)) {
				set.remove(p);
				for (net.minecraft.core.Direction d : net.minecraft.core.Direction.values()) {
					long k = BlockPos.offset(p, d);
					if (set.contains(k)) {
						w.add(k);
					}
				}
			}
		}
		return set;
	}

	/** Flowing (or falling) water of the body's fluid in a liquid block, inside the box, not foreign. */
	private static boolean takeable(long p, LongOpenHashSet foreign, int[] box, java.util.function.LongFunction<@Nullable Wet> at) {
		int x = BlockPos.getX(p), y = BlockPos.getY(p), z = BlockPos.getZ(p);
		if (x < box[0] || y < box[1] || z < box[2] || x > box[3] || y > box[4] || z > box[5] || foreign.contains(p)) {
			return false;
		}
		Wet c = at.apply(p);
		return c != null && c.liquid() && !c.source();
	}

	/** A feeder of the cell (the same fluid over it, or beside it at a higher amount) that is neither in the set nor the body's own cell. */
	private static boolean fedFromOutside(long p, Wet c, LongOpenHashSet set, LongOpenHashSet own, java.util.function.LongFunction<@Nullable Wet> at) {
		for (net.minecraft.core.Direction d : new net.minecraft.core.Direction[] {net.minecraft.core.Direction.UP, net.minecraft.core.Direction.NORTH,
			net.minecraft.core.Direction.SOUTH, net.minecraft.core.Direction.WEST, net.minecraft.core.Direction.EAST}) {
			long k = BlockPos.offset(p, d);
			if (set.contains(k) || own.contains(k)) {
				continue;
			}
			Wet n = at.apply(k);
			if (n != null && (d == net.minecraft.core.Direction.UP || n.amount() > c.amount())) {
				return true;
			}
		}
		return false;
	}

	/** (6c IRR) The irrigation bodies of an IR with their lot: body id -> {minX, minZ, maxX, maxZ, floorY}. */
	static Map<String, int[]> irrigationLots(JsonObject ir) {
		Map<String, int[]> out = new java.util.HashMap<>();
		if (ir.get("lots") instanceof JsonArray lots) {
			for (var e : lots) {
				if (e instanceof JsonObject lo && lo.get("irrigation") instanceof JsonObject g && g.get("bodies") instanceof JsonArray bs && lo.get("box") instanceof JsonObject bx) {
					int[] box = {bx.get("minX").getAsInt(), bx.get("minZ").getAsInt(), bx.get("maxX").getAsInt(), bx.get("maxZ").getAsInt(), lo.get("floorY").getAsInt()};
					bs.forEach(x -> out.put(x.getAsString(), box));
				}
			}
		}
		return out;
	}

	/**
	 * (the H batch, §4.2) The cells a drain's stray pass may take: the body's predicted cells (its own flow) and the cells recorded as
	 * escaped from it, sorted. Never the rest of the watch set (a player's water stays).
	 */
	static long[] strayCandidates(Body b, BodyState bs) {
		LongOpenHashSet c = new LongOpenHashSet(bs.escapedCells);
		c.addAll(b.predicted.keySet());
		long[] out = c.toLongArray();
		java.util.Arrays.sort(out);
		return out;
	}

	/** The before state any body of the region recorded for a cell (null: none did). */
	static @Nullable String beforeAny(Regional st, long p) {
		for (BodyState bs : st.states.values()) {
			String s = bs.before.get(p);
			if (s != null) {
				return s;
			}
		}
		return null;
	}

	/** Server thread (Batches): the region's batch holds its end while a written body settles (PLACED waits for the water, §3.3). */
	public static boolean holding(QBatch b) {
		if (!RegionItems.isRegion(b) || b.cancelling) {
			return false;
		}
		RegionsImpl.Live l = RegionsImpl.live(b.ext.get(RegionItems.EXT_REGION).getAsString());
		if (l != null && b.ext.get(Revisions.EXT_REVISION) instanceof JsonObject rv) {
			l = Revisions.liveFor(l, Revisions.stageName(rv.get("rid").getAsInt(), STAGE)); // (6d RV) a revision's batch holds for its own bodies
		}
		Regional st = l == null ? null : of(l);
		return st != null && (st.owed || ("writing".equals(st.phase) || "settling".equals(st.phase)) && stageWritten(l)); // (slice DF) or its record owed
	}

	/** Whether a body of the region was not written or was drained (the region ends PARTIAL, §2.4, §3.4). */
	public static boolean anyDrained(RegionsImpl.Live l) {
		Regional st = of(l); // (a revision's Live: its own bodies)
		// ((6c IRR) a source drained with its removed lot is no failure of the region)
		return st != null && !"gate".equals(st.phase) && st.states.values().stream().anyMatch(x -> "drained".equals(x.state) && !x.lotRemoved);
	}

	// ------------------------------------------------------------------ (6c IRR) a lot's sources leave with the lot

	/**
	 * (6c IRR, S-IRR-4) Server thread, before a lot site's removal (or undo) restores anything: the irrigation sources of that lot (the
	 * IR's {@code lots[].irrigation.bodies}) are drained, drain-first and exact (H's drain: the sources, the spill and the watched cells
	 * holding new fluid back to their befores; another standing body's cells left alone), marked {@code drained} with the reason
	 * {@code lot removed: <lot>} ({@link BodyState#lotRemoved}: never written again, not a PARTIAL), saved and reported. A source not
	 * written yet is marked the same, so the fluids stage never writes it. The shells stay the region's until the region is removed.
	 * Idempotent. Returns the cells written, or -1 when the group is no region or the lot has no irrigation.
	 */
	public static int drainLot(ServerLevel level, @Nullable String group, @Nullable String lotId) {
		if (group == null || lotId == null) {
			return -1;
		}
		RegionsImpl.Live l = null;
		for (RegionsImpl.Live x : RegionsImpl.all()) {
			if (group.equals(x.rec().groupId)) {
				l = x;
				break;
			}
		}
		if (l == null) {
			return -1;
		}
		JsonObject eff = Revisions.effective(l);
		java.util.Set<String> ids = lotBodies(eff, lotId); // (6d RV, §4.5)
		// ((M5 IG) a grown lot's sources are its revision's bodies: that revision's own record ({@code <region>#rv<rid>}), not the region's)
		int rid = lotRid(eff, lotId);
		if (rid > 0) {
			l = Revisions.liveFor(l, Revisions.stageName(rid, STAGE));
		}
		Regional st = ids.isEmpty() ? null : of(l);
		if (st == null) {
			return -1;
		}
		int n = 0;
		boolean changed = false;
		Holders held = null; // (fix/drain-holders) as the region's removal: a later entry's block on top of a source stays
		for (Body b : st.bodies) {
			if (!ids.contains(b.id)) {
				continue;
			}
			BodyState bs = st.states.get(b.id);
			if (bs.lotRemoved) {
				continue;
			}
			if (!bs.before.isEmpty()) {
				if (held == null) {
					held = new Holders(l.rec().dimension, l.rec().groupId, st);
				}
				n += drain(level, st, b, bs, true, st.othersOf(b), held, false); // ((6c F3-c) a lot removed: its decor water goes too)
			}
			bs.state = "drained";
			bs.reason = "lot removed: " + lotId + " (its sources leave with it, S-IRR-4)";
			bs.lotRemoved = true;
			bs.at.clear();
			changed = true;
		}
		if (changed) {
			save(l, st);
			report(l, st);
			Architect.LOGGER.info("Region {}: lot {} removed: its irrigation sources drained ({} cell(s) written){}", l.rec().id, lotId, n, held == null || held
				.kept().isEmpty() ? "" : "; " + held.kept().size() + " cell(s) another entry holds on top kept: " + cells(held.keptCells()));
			WorldJournal.kill("FL6"); // (6c IRR) the lot's sources drained, its site not restored yet
		}
		return n;
	}

	/** (M5 IG) The revision that added a lot of an effective IR (its {@code rid}, Revisions.merge's), or 0 for the realised plan's. */
	static int lotRid(JsonObject eff, String lotId) {
		if (eff.get("lots") instanceof JsonArray lots) {
			for (var e : lots) {
				if (e instanceof JsonObject lo && lo.get("id") instanceof com.google.gson.JsonElement id && lotId.equals(id.getAsString())) {
					return lo.get("rid") instanceof com.google.gson.JsonPrimitive p && p.isNumber() ? p.getAsInt() : 0;
				}
			}
		}
		return 0;
	}

	/** (6c IRR) The irrigation body ids of a lot in an IR ({@code lots[].irrigation.bodies}). */
	static java.util.Set<String> lotBodies(JsonObject ir, String lotId) {
		java.util.Set<String> out = new java.util.LinkedHashSet<>();
		if (ir.get("lots") instanceof JsonArray lots) {
			for (var e : lots) {
				if (e instanceof JsonObject lo && lo.get("id") instanceof com.google.gson.JsonElement id && lotId.equals(id.getAsString()) && lo.get("irrigation") instanceof JsonObject g
					&& g.get("bodies") instanceof JsonArray bs) {
					bs.forEach(x -> out.add(x.getAsString()));
				}
			}
		}
		return out;
	}

	// ------------------------------------------------------------------ the removal

	/**
	 * (fix/drain-holders) The cells of a removal's drain that another journal entry holds on top of the body's entry. At each position the
	 * top of the active stack (by layer, ties by the greater entry id: the undo planner's covering rule) is an entry outside the removed
	 * group (its {@code group} is not the region's, nor is it the group's crate), and it lies above the body's entry:
	 * <ul>
	 * <li>where the group has a cell under it (a body's source or ice, a shell cell), always: the undo leaves the cell to that entry (its
	 * covering mask) and hands the region's before down to it;</li>
	 * <li>where the group has no cell (a spill or watched cell, predicted flow, a breach's flow), when the entry's layer is above the
	 * {@link #floor}: the lowest layer of the group's cells at the bodies' own cells (the stage that wrote the sources). Such an entry was
	 * written after the sources, so its block is not the body's {@code before} there; an entry under the floor was in the world when the
	 * befores were read, and the drain treats its cell as before.</li>
	 * </ul>
	 * The drain leaves held cells as they stand: a later site's waterlogged block in a pond source keeps its block and its water. Read per
	 * chunk section from the journal (its active slices there), once per section, on the server thread. A journal that cannot be read
	 * holds nothing (the drain as before; the undo itself refuses then). {@link #kept}: the held cells the drain asked about (each held
	 * a fluid or ice).
	 */
	static final class Holders implements java.util.function.LongPredicate {
		private final String dim;
		private final String group;
		private final String crate;
		private final Long2ObjectOpenHashMap<Held> bySection = new Long2ObjectOpenHashMap<>();
		private final it.unimi.dsi.fastutil.longs.LongLinkedOpenHashSet kept = new it.unimi.dsi.fastutil.longs.LongLinkedOpenHashSet();
		private final long floor;

		Holders(String dim, String group, Regional st) {
			this.dim = dim;
			this.group = group;
			this.crate = dev.larattalabs.architect.site.SiteGroupRec.CRATE_PREFIX + group;
			long f = Long.MAX_VALUE;
			for (Body b : st.bodies) {
				for (long p : b.cells) {
					long l = held(p).ours().getOrDefault(p, Long.MAX_VALUE);
					f = Math.min(f, l);
				}
			}
			this.floor = f;
		}

		@Override
		public boolean test(long pos) {
			if (heldAt(held(pos), pos, floor)) {
				kept.add(pos);
				return true;
			}
			return false;
		}

		private Held held(long pos) {
			long key = dev.larattalabs.architect.journal.Sections.key(pos);
			Held h = bySection.get(key);
			if (h == null) {
				h = load(key);
				bySection.put(key, h);
			}
			return h;
		}

		/** The held cells the drain asked about, in the order asked. */
		it.unimi.dsi.fastutil.longs.LongSet kept() {
			return kept;
		}

		List<long[]> keptCells() {
			List<long[]> out = new ArrayList<>();
			for (long p : kept) {
				if (out.size() >= NAMED) {
					break;
				}
				out.add(new long[] {BlockPos.getX(p), BlockPos.getY(p), BlockPos.getZ(p)});
			}
			return out;
		}

		private Held load(long key) {
			try {
				var store = WorldJournal.store();
				Map<String, Boolean> ours = new HashMap<>();
				return heldIn(WorldJournal.activeSlices(dim, key), id -> ours.computeIfAbsent(id, x -> {
					var m = store.meta(x);
					return m != null && (group.equals(m.group()) || crate.equals(m.site()));
				}));
			} catch (IOException | RuntimeException e) {
				Architect.LOGGER.warn("Region removal: the journal could not be read for section {} ({}); its cells are drained without asking for holders", key, e
					.toString());
				return new Held(new LongOpenHashSet(), new it.unimi.dsi.fastutil.longs.Long2LongOpenHashMap(), new it.unimi.dsi.fastutil.longs.Long2LongOpenHashMap());
			}
		}
	}

	/**
	 * (fix/drain-holders) One section's stacks as the drain asks them: {@code over}, positions whose top is another entry with a cell of
	 * the group under it; {@code bare}, positions whose top is another entry and the group has no cell there (the top's layer);
	 * {@code ours}, the group's highest layer at each position it has a cell.
	 */
	record Held(LongOpenHashSet over, it.unimi.dsi.fastutil.longs.Long2LongOpenHashMap bare, it.unimi.dsi.fastutil.longs.Long2LongOpenHashMap ours) {
	}

	/** (fix/drain-holders) Of the active entries' slices of one section, {@link Held}; {@code ours}: whether an entry id is the group's. */
	static Held heldIn(List<dev.larattalabs.architect.journal.Journal.Entry> slices, java.util.function.Predicate<String> ours) {
		it.unimi.dsi.fastutil.longs.Long2LongOpenHashMap topLayer = new it.unimi.dsi.fastutil.longs.Long2LongOpenHashMap();
		Long2ObjectOpenHashMap<String> top = new Long2ObjectOpenHashMap<>();
		it.unimi.dsi.fastutil.longs.Long2LongOpenHashMap mine = new it.unimi.dsi.fastutil.longs.Long2LongOpenHashMap();
		for (var e : slices) {
			boolean our = ours.test(e.id());
			for (var c : e.cells()) {
				long p = c.pos();
				if (our && (!mine.containsKey(p) || c.layer() > mine.get(p))) {
					mine.put(p, c.layer());
				}
				String t = top.get(p);
				if (t == null || c.layer() > topLayer.get(p) || c.layer() == topLayer.get(p) && e.id().compareTo(t) > 0) {
					topLayer.put(p, c.layer());
					top.put(p, e.id());
				}
			}
		}
		LongOpenHashSet over = new LongOpenHashSet();
		it.unimi.dsi.fastutil.longs.Long2LongOpenHashMap bare = new it.unimi.dsi.fastutil.longs.Long2LongOpenHashMap();
		for (var en : top.long2ObjectEntrySet()) {
			long p = en.getLongKey();
			if (ours.test(en.getValue())) {
				continue;
			}
			if (mine.containsKey(p)) {
				over.add(p);
			} else {
				bare.put(p, topLayer.get(p));
			}
		}
		return new Held(over, bare, mine);
	}

	/** (fix/drain-holders) Whether the drain leaves {@code pos} to its holder ({@link Holders}): {@code floor}, the bodies' entry layer. */
	static boolean heldAt(Held h, long pos, long floor) {
		return h.over().contains(pos) || h.bare().containsKey(pos) && h.bare().get(pos) > floor;
	}

	/**
	 * Server thread (Groups, before a whole group's undo is planned): false while the region's bodies drain and settle (§4.1): every body
	 * drained (sources and ice back to their before states, the watched cells holding new fluid restored), saved, then one settle bound
	 * (the longest body's) with no fluid tick scheduled in any watch set. True for a group with no region bodies, and once done.
	 */
	/** (6c D3, Steward's RC) Whether a region group's removal began draining its fluid bodies (it wrote the world). Server thread. */
	public static boolean drainStarted(String group) {
		for (RegionsImpl.Live x0 : RegionsImpl.all()) {
			if (group.equals(x0.rec().groupId)) {
				for (RegionsImpl.Live x : lives(x0)) { // (6d RV) its revisions' bodies too
					Regional st = of(x);
					if (st != null && st.removal != null) {
						return true;
					}
				}
				return false;
			}
		}
		return false;
	}

	public static boolean removalGate(MinecraftServer s, String group) {
		RegionsImpl.Live l0 = null;
		for (RegionsImpl.Live x : RegionsImpl.all()) {
			if (group.equals(x.rec().groupId)) {
				l0 = x;
				break;
			}
		}
		if (l0 == null) {
			return true;
		}
		// (6d RV, §6) the standing revisions' bodies first (top first), then the region's own: every body drains before any solid goes
		for (RegionsImpl.Live x : lives(l0)) {
			Regional st = of(x);
			if (st != null && !"done".equals(st.removal) && !gateOne(s, x, st, group)) {
				return false;
			}
		}
		return true;
	}

	/**
	 * (6d RV, §4.4 step 3, §7) An undo's drain of its suffix's bodies (the revisions {@code rids}, top first): H's drain-first protocol
	 * scoped to them (each body's sources, ice and the watched cells holding new fluid back to their befores; a cell an entry outside the
	 * region holds on top is not drained: the undo's hand-down gives it that cell's before), then one settle bound. Saved per body in the
	 * revision's own record, so a restart resumes it. True when every suffix body is drained and settled.
	 */
	public static boolean drainRevisions(MinecraftServer s, RegionsImpl.Live l, List<Integer> rids, String opId) {
		for (int rid : rids) {
			RegionsImpl.Live x = Revisions.liveFor(l, Revisions.stageName(rid, STAGE));
			if (x.rid() != rid) {
				continue;
			}
			Regional st = of(x);
			if (st != null && !"done".equals(st.removal) && !gateOne(s, x, st, l.rec().groupId)) {
				return false;
			}
		}
		return true;
	}

	/** (6d RV) One record's removal drain (the region's, or a revision's): {@link #removalGate}'s body. */
	private static boolean gateOne(MinecraftServer s, RegionsImpl.Live l, Regional st, String group) {
		ServerLevel level = l.level(s);
		if (level == null) {
			return true;
		}
		if (st.removal != null && st.owed && !durable(l, st)) {
			return false; // (slice DF) the removal's record is not on disk: the drain's next step waits for it
		}
		if (st.flowingRegion()) {
			return gateFlowing(s, level, l, st, group); // (8c WU) the sources first, the flow dies, the stray pass, then the solids
		}
		if (st.removal == null || "draining".equals(st.removal)) {
			if (st.removal == null) {
				// (slice DF, CONTRACT 8c §4.4) the removal's draining phase durable before its first write (scoop or drain); a start that finds
				// it drains again from the start (idempotent: a drained cell is at its before state, the scoop is keyed)
				st.removal = "draining";
				if (!save(l, st)) {
					st.removal = null;
					return false;
				}
				WorldJournal.kill("FL3d"); // (slice DF) the removal's draining record saved, nothing drained yet
			}
			// (fix/drain-holders) the cells a later entry outside the group holds on top: never drained (the undo hands them down)
			Holders held = new Holders(l.rec().dimension, group, st);
			int n = 0;
			// (6c RS, §9.2) a survival region's standing lava sources are scooped into its owner's stockpile (a bucket from stock each) and
			// its standing grates refunded, once (keyed), before the drain
			if (l.rec().survival()) {
				int lava = 0, grates = 0;
				for (Body b : st.bodies) {
					BodyState bs = st.states.get(b.id);
					if (bs.before.isEmpty()) {
						continue;
					}
					if (b.lava) {
						for (long p : b.cells) {
							FluidState f = level.getBlockState(BlockPos.of(p)).getFluidState();
							if (f.isSource() && f.getType().isSame(Fluids.LAVA)) {
								lava++;
							}
						}
					}
					for (long p : b.grate) {
						if (level.getBlockState(BlockPos.of(p)).is(Blocks.IRON_BARS)) {
							grates++;
						}
					}
				}
				if (lava > 0 || grates > 0) {
					dev.larattalabs.architect.site.Stockpiles.scoop(s, l.rec().owner, "region:" + l.rec().id + "@" + l.rec().createdAt + ":fluids", lava, grates);
				}
			}
			// (6c HY, §4.1) the exact reverse of the write order (an H region: reverse plan order), the head first
			int drained = 0;
			for (int i = st.order.size() - 1; i >= 0; i--) {
				Body b = st.order.get(i);
				BodyState bs = st.states.get(b.id);
				if (bs.before.isEmpty()) {
					continue; // never written (not checked, or not contained): nothing of it stands
				}
				n += drain(level, st, b, bs, true, new LongOpenHashSet(), held, true); // ((6c F3-c) the removal: decor left for the undo)
				if (++drained == 1 && st.ordered && i > 0) {
					WorldJournal.kill("FL5"); // (6c HY) the head drained, the rest of the course not yet
				}
			}
			int bound = st.bodies.stream().mapToInt(b -> b.settleTicks).max().orElse(0);
			st.removal = "drained";
			st.redrained = true;
			st.until = level.getGameTime() + bound;
			save(l, st);
			Architect.LOGGER.info("Region {}: removal drained {} fluid cell(s); the solids wait one settle bound ({} ticks){}", l.rec().id, n, bound, held.kept()
				.isEmpty() ? "" : "; " + held.kept().size() + " cell(s) another entry holds on top kept for the undo's hand-down: " + cells(held.keptCells()));
			WorldJournal.kill("FL3"); // drained (step 2), before the solids (step 3)
			return false;
		}
		if (!st.redrained) {
			// (§3.5) a removal resumed after a stop: the drain again (idempotent: what the stop lost of it, unsaved chunks, is written now)
			st.redrained = true;
			Holders held = new Holders(l.rec().dimension, group, st); // (fix/drain-holders) as the first drain
			int n = 0;
			for (int i = st.order.size() - 1; i >= 0; i--) {
				Body b = st.order.get(i);
				BodyState bs = st.states.get(b.id);
				if (!bs.before.isEmpty()) {
					n += drain(level, st, b, bs, true, new LongOpenHashSet(), held, true); // ((6c F3-c) the removal: decor left for the undo)
				}
			}
			if (n > 0) {
				Architect.LOGGER.info("Region {}: the resumed removal drained {} fluid cell(s) again", l.rec().id, n);
			}
		}
		hold(level, st, true);
		int bound = st.bodies.stream().mapToInt(b -> b.settleTicks).max().orElse(0);
		long now = level.getGameTime();
		boolean ticking = false;
		if (now >= st.until) {
			for (Body b : st.bodies) {
				if (census(level, b, st.fluidBefore).ticking()) {
					ticking = true;
					break;
				}
			}
		}
		RemovalWait w = removalWait(now, st.until, bound, ticking);
		if (w == RemovalWait.WAIT) {
			return false;
		}
		if (w == RemovalWait.CAPPED) {
			st.removalNote = "fluid still ticking in a body's watch set " + (2L * bound) + " ticks after the drain (2 x the settle bound, " + bound
				+ "): flowing water not the region's (a river, a player's) keeps it ticking; the solids are restored without waiting further";
			JsonObject note = new JsonObject();
			note.addProperty("state", "capped");
			note.addProperty("note", st.removalNote);
			note.addProperty("ticks", 2L * bound);
			l.rec().ext.add(EXT_REMOVAL, note);
			REMOVAL_NOTES.put(l.rec().id, st.removalNote);
			Architect.LOGGER.warn("Region {}: removal: {}", l.rec().id, st.removalNote);
		}
		st.removal = "done";
		if (!save(l, st)) {
			st.removal = "drained"; // (slice DF) the solids wait until the record says done on disk
			return false;
		}
		hold(level, st, false);
		Architect.LOGGER.info("Region {}: fluids drained and settled; the solids are restored next", l.rec().id);
		return true;
	}

	// ------------------------------------------------------------------ (8c WU) a flowing region's removal: the reverse of flow

	/**
	 * (8c WU, §4.2, §4.4) A flowing region's removal drain, server thread, one call per tick until true (the solids next):
	 * <ol>
	 * <li>{@code draining} saved durably first (DF; kill point FL3d), then every body's <b>sources only</b> back to their before states,
	 * the head first (the exact reverse of the write order; FL5 after the head), each with a fluid tick on its face neighbours so vanilla
	 * lets the flow die (a write skips updates); {@code drained} saved, the wait until now + the settle bound (FL8).</li>
	 * <li>The wait: done when no fluid tick is scheduled in any watch set past the bound; capped at 2 x the bound (the foreign cells that
	 * keep it ticking named on the rows). A start that finds {@code draining} or {@code drained} drains the sources again (idempotent).</li>
	 * <li>{@code restoring} saved, then the <b>stray pass</b>, chunk by chunk (FL9 after the first): every watched cell the bodies made that is
	 * not at its before state, as W5 attributes it ({@link #breachTake}: flowing water connected to the bodies' own cells, less every cell
	 * fed from water that isn't theirs), back to its before state. It never writes foreign-fed water or a source that isn't the body's.</li>
	 * <li>{@code done} saved (FL3); then the group undo restores the solids.</li>
	 * </ol>
	 * A Remove asked meanwhile joins this removal (the group's removal is one; this gate is its barrier).
	 */
	static boolean gateFlowing(MinecraftServer s, ServerLevel level, RegionsImpl.Live l, Regional st, String group) {
		int bound = st.bodies.stream().mapToInt(b -> b.settleTicks).max().orElse(0);
		if (st.removal == null || "draining".equals(st.removal)) {
			if (st.removal == null) {
				st.removal = "draining";
				st.removalPhase = "draining";
				if (!save(l, st)) {
					st.removal = null;
					st.removalPhase = null;
					return false;
				}
				WorldJournal.kill("FL3d");
			}
			Holders held = new Holders(l.rec().dimension, group, st);
			int n = drainSourcesAll(level, st, held, true);
			st.removal = "drained";
			st.removalPhase = "draining";
			st.redrained = true;
			st.until = level.getGameTime() + bound;
			if (!save(l, st)) {
				return false; // (DF) owed: the next tick writes it again before anything goes on
			}
			hold(level, st, true);
			report(l, st);
			Architect.LOGGER.info("Region {}: removal drained {} source cell(s) of its flowing water; the flow dies for up to {} ticks before the stray pass", l.rec()
				.id, n, bound);
			WorldJournal.kill("FL8"); // (8c CR) the sources drained and the flow dying, before the stray pass
			return false;
		}
		if ("drained".equals(st.removal)) {
			if (!st.redrained) {
				st.redrained = true;
				int n = drainSourcesAll(level, st, new Holders(l.rec().dimension, group, st), false);
				if (n > 0) {
					Architect.LOGGER.info("Region {}: the resumed removal drained {} source cell(s) again", l.rec().id, n);
				}
			}
			hold(level, st, true);
			long now = level.getGameTime();
			boolean ticking = false;
			if (now >= st.until) {
				for (Body b : st.bodies) {
					if (census(level, b, st.fluidBefore).ticking()) {
						ticking = true;
						break;
					}
				}
			}
			RemovalWait w = removalWait(now, st.until, bound, ticking);
			if (w == RemovalWait.WAIT) {
				return false;
			}
			if (w == RemovalWait.CAPPED) {
				int named = capForeign(level, st);
				st.removalNote = "fluid still ticking in a body's watch set " + (2L * bound) + " ticks after the drain (2 x the settle bound, " + bound + "): "
					+ named + " cell(s) of water not the region's keep it running; the solids are restored without waiting further";
				JsonObject note = new JsonObject();
				note.addProperty("state", "capped");
				note.addProperty("note", st.removalNote);
				note.addProperty("ticks", 2L * bound);
				l.rec().ext.add(EXT_REMOVAL, note);
				REMOVAL_NOTES.put(l.rec().id, st.removalNote);
				st.removalPhase = "capped";
				Architect.LOGGER.warn("Region {}: removal: {}", l.rec().id, st.removalNote);
			} else {
				st.removalPhase = "restoring";
			}
			st.removal = "restoring";
			if (!save(l, st)) {
				st.removal = "drained";
				return false;
			}
			report(l, st);
		}
		if ("restoring".equals(st.removal) && !st.redrained) {
			// (8c CR, FL9 bare) a start in the stray pass: the world's chunks may be older than the record (the sources standing again, flowing
			// into cells the wash cleared): the sources are drained again and the flow waits to die before the stray pass goes on
			st.redrained = true;
			int n = drainSourcesAll(level, st, new Holders(l.rec().dimension, group, st), false);
			if (n > 0) {
				st.removal = "drained";
				st.removalPhase = "draining";
				st.until = level.getGameTime() + bound;
				if (!save(l, st)) {
					st.removal = "restoring";
					return false;
				}
				Architect.LOGGER.info("Region {}: the resumed stray pass found {} source cell(s) standing again: drained, the flow waits again", l.rec().id, n);
				return false;
			}
		}
		if ("restoring".equals(st.removal)) {
			Holders held = new Holders(l.rec().dimension, group, st);
			int n = strayPass(level, st, held);
			st.removal = "done";
			if (!save(l, st)) {
				st.removal = "restoring";
				return false;
			}
			hold(level, st, false);
			report(l, st);
			Architect.LOGGER.info("Region {}: the stray pass restored {} watched cell(s); the solids are restored next", l.rec().id, n);
			WorldJournal.kill("FL3"); // the fluids drained and restored, before the solids
			return true;
		}
		return true;
	}

	/** (8c WU) Every written body's sources back, the head first (the reverse of the write order); FL5 after the head when {@code first}. */
	static int drainSourcesAll(ServerLevel level, Regional st, java.util.function.LongPredicate held, boolean first) {
		int n = 0, drained = 0;
		for (int i = st.order.size() - 1; i >= 0; i--) {
			Body b = st.order.get(i);
			BodyState bs = st.states.get(b.id);
			if (bs.before.isEmpty()) {
				continue;
			}
			n += drainSources(level, b, bs, held);
			if (first && ++drained == 1 && st.ordered && i > 0) {
				WorldJournal.kill("FL5");
			}
		}
		return n;
	}

	/**
	 * (8c WU) One body's sources (its cells, ice and grate) back to their before states where they hold a fluid or ice, then a fluid tick
	 * on each face neighbour holding fluid that isn't a cell of the body: the flow they fed dies by vanilla's own ticks.
	 */
	static int drainSources(ServerLevel level, Body b, BodyState bs, java.util.function.LongPredicate held) {
		int n = 0;
		LongOpenHashSet grate = new LongOpenHashSet(b.grate);
		LongOpenHashSet own = b.ownSet();
		LongOpenHashSet tick = new LongOpenHashSet();
		for (long[] a : new long[][] {b.ice, b.cells}) {
			for (long p : a) {
				if (drainSkips(b, p) || held.test(p)) {
					continue;
				}
				BlockPos bp = BlockPos.of(p);
				BlockState now = level.getBlockState(bp);
				if (now.getFluidState().isEmpty() && !now.is(Blocks.ICE) && !now.is(Blocks.FROSTED_ICE) && !(grate.contains(p) && now.is(Blocks.IRON_BARS))) {
					continue;
				}
				String before = bs.before.get(p);
				BlockState to = before == null ? Blocks.AIR.defaultBlockState() : parse(before);
				if (now != to) {
					dev.larattalabs.architect.placed.Placed.set(level, bp, to, Block.UPDATE_CLIENTS | Block.UPDATE_SKIP_ALL_SIDEEFFECTS);
					n++;
				}
				for (net.minecraft.core.Direction d : net.minecraft.core.Direction.values()) {
					long q = BlockPos.offset(p, d);
					if (!own.contains(q)) {
						tick.add(q);
					}
				}
			}
		}
		for (long q : tick) {
			BlockPos bp = BlockPos.of(q);
			FluidState f = level.getBlockState(bp).getFluidState();
			if (!f.isEmpty()) {
				level.scheduleTick(bp, f.getType(), 1);
			}
		}
		return n;
	}

	/**
	 * (8c WU, §4.2, W5) What the stray pass takes: per body, the watched cells holding its fluid as flowing water, connected to its own
	 * cells or holding what wasn't there before, less every cell fed from water that isn't the region's (breachTake's prune: water there
	 * before the realise, another standing body's, a source the region never wrote). The cells, sorted, each with the body whose before
	 * applies. Pure over {@code at}.
	 */
	static java.util.List<long[]> strayTake(Regional st, java.util.function.LongFunction<@Nullable Wet> at, java.util.function.LongPredicate loaded) {
		java.util.List<long[]> out = new ArrayList<>();
		LongOpenHashSet seen = new LongOpenHashSet();
		for (int i = st.order.size() - 1; i >= 0; i--) {
			Body b = st.order.get(i);
			BodyState bs = st.states.get(b.id);
			if (bs.before.isEmpty()) {
				continue;
			}
			LongOpenHashSet foreign = new LongOpenHashSet(st.othersOf(b));
			foreign.addAll(st.fluidBefore.keySet());
			it.unimi.dsi.fastutil.longs.LongArrayList seeds = new it.unimi.dsi.fastutil.longs.LongArrayList();
			for (long p : b.watchSet()) {
				if (loaded.test(p) && !foreign.contains(p)) {
					seeds.add(p);
				}
			}
			int[] wb = b.watchBox();
			LongOpenHashSet take = breachTake(List.of(b.cells, seeds.toLongArray()), b.ownSet(), foreign, wb, at, BREACH_MAX);
			for (long p : take) {
				if (seen.add(p)) {
					out.add(new long[] {p, i});
				}
			}
		}
		out.sort(java.util.Comparator.comparingLong((long[] a) -> ChunkPos.pack(BlockPos.getX(a[0]) >> 4, BlockPos.getZ(a[0]) >> 4)).thenComparingLong(a -> a[0]));
		return out;
	}

	/** (8c WU) The stray pass in game: {@link #strayTake}, then each cell to its before state, chunk by chunk (FL9 after the first chunk). */
	static int strayPass(ServerLevel level, Regional st, java.util.function.LongPredicate held) {
		java.util.function.LongFunction<@Nullable Wet> at = k -> {
			BlockState bs = level.getBlockState(BlockPos.of(k));
			FluidState f = bs.getFluidState();
			return f.isEmpty() || !f.getType().isSame(Fluids.WATER) ? null : new Wet(f.getAmount(), f.isSource(), bs.getBlock() instanceof LiquidBlock);
		};
		java.util.List<long[]> take = strayTake(st, at, p -> level.isLoaded(BlockPos.of(p)));
		// the chunks the bodies watch, in order: FL9 after the first one's cells are restored, with another still to come
		java.util.TreeSet<Long> chunks = new java.util.TreeSet<>();
		for (Body b : st.bodies) {
			for (long p : b.watchSet()) {
				chunks.add(ChunkPos.pack(BlockPos.getX(p) >> 4, BlockPos.getZ(p) >> 4));
			}
		}
		int n = 0, done = 0;
		for (long ck : chunks) {
			for (long[] c : take) {
				long p = c[0];
				if (ChunkPos.pack(BlockPos.getX(p) >> 4, BlockPos.getZ(p) >> 4) != ck || held.test(p)) {
					continue;
				}
				BlockPos bp = BlockPos.of(p);
				BlockState now = level.getBlockState(bp);
				if (!(now.getBlock() instanceof LiquidBlock) || now.getFluidState().isSource()) {
					continue;
				}
				String was = st.states.get(st.order.get((int) c[1]).id).before.get(p);
				if (was == null) {
					was = beforeAny(st, p);
				}
				dev.larattalabs.architect.placed.Placed.set(level, bp, was == null ? Blocks.AIR.defaultBlockState() : parse(was), Block.UPDATE_CLIENTS
					| Block.UPDATE_SKIP_ALL_SIDEEFFECTS);
				n++;
			}
			if (++done == 1 && chunks.size() > 1) {
				WorldJournal.kill("FL9"); // (8c CR) the stray pass half done: one chunk's cells restored, the next not
			}
		}
		return n;
	}

	/**
	 * (8c WU, Steward's S-8c-1) A capped removal's foreign cells: per body, the cells of its watch set still holding fluid that isn't the
	 * region's (a source no body wrote, water there before) or with a fluid tick scheduled, at most {@link #FOREIGN_NAMED} named. Returns
	 * how many cells it found.
	 */
	static int capForeign(ServerLevel level, Regional st) {
		int total = 0;
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		for (Body b : st.bodies) {
			BodyState bs = st.states.get(b.id);
			bs.foreign.clear();
			bs.foreignCount = 0;
			long[] keys = b.watchSet().toLongArray();
			java.util.Arrays.sort(keys);
			for (long p : keys) {
				m.set(p);
				if (!level.isLoaded(m)) {
					continue;
				}
				FluidState f = level.getBlockState(m).getFluidState();
				boolean tick = level.getFluidTicks().hasScheduledTick(m, Fluids.WATER) || level.getFluidTicks().hasScheduledTick(m, Fluids.FLOWING_WATER);
				if (!f.isEmpty() && (f.isSource() || st.fluidBefore.containsKey(p)) || tick && !f.isEmpty()) {
					bs.foreignCount++;
					if (bs.foreign.size() < FOREIGN_NAMED) {
						bs.foreign.add(p);
					}
				}
			}
			total += bs.foreignCount;
		}
		return total;
	}

	/**
	 * (8c WU) DevBridge {@code dev.fluid.river}: per body its flow, predicted cells (flowing), the census now (mismatches, escaped,
	 * ticking), a sample of predicted levels against the world's, and the item entities spawned in its cells this session.
	 */
	public static JsonObject riverJson(ServerLevel level, RegionsImpl.Live l) {
		Regional st = of(l);
		JsonObject o = new JsonObject();
		JsonArray bodies = new JsonArray();
		o.add("bodies", bodies);
		o.addProperty("items", ITEMS.getOrDefault(key(l), 0));
		if (st == null) {
			return o;
		}
		o.addProperty("phase", st.phase);
		if (st.removal != null) {
			o.addProperty("removal", st.removal);
		}
		// (8c WU) the item entities standing now in a flowing body's own or predicted cells (or beside one: water carries them a cell)
		int now = 0;
		for (Body b : st.bodies) {
			if (!b.flowing()) {
				continue;
			}
			int[] wb = b.watchBox();
			for (var it : level.getEntitiesOfClass(net.minecraft.world.entity.item.ItemEntity.class, new AABB(wb[0], wb[1], wb[2], wb[3] + 1, wb[4] + 1, wb[5] + 1))) {
				BlockPos q = it.blockPosition();
				boolean near = false;
				for (int dx = -1; dx <= 1 && !near; dx++) {
					for (int dy = -1; dy <= 1 && !near; dy++) {
						for (int dz = -1; dz <= 1 && !near; dz++) {
							long k = BlockPos.asLong(q.getX() + dx, q.getY() + dy, q.getZ() + dz);
							near = b.predicted.containsKey(k) || b.ownSet().contains(k);
						}
					}
				}
				if (near) {
					now++;
				}
			}
		}
		o.addProperty("itemsNow", now);
		for (Body b : st.bodies) {
			BodyState bs = st.states.get(b.id);
			JsonObject x = new JsonObject();
			x.addProperty("id", b.id);
			x.addProperty("state", bs.state);
			if (b.flow != null) {
				x.addProperty("flow", b.flow);
			}
			x.addProperty("predicted", b.predicted.size());
			x.addProperty("flowing", b.flowingCells());
			Census c = census(level, b, st.fluidBefore, st.othersOf(b));
			x.addProperty("mismatch", c.mismatch().size());
			x.addProperty("escaped", c.escaped().size());
			x.addProperty("ticking", c.ticking());
			JsonArray lv = new JsonArray();
			long[] keys = b.predicted.keySet().toLongArray();
			java.util.Arrays.sort(keys);
			for (int i = 0; i < keys.length && lv.size() < 16; i += Math.max(1, keys.length / 16)) {
				BlockState s = level.getBlockState(BlockPos.of(keys[i]));
				JsonArray q = new JsonArray();
				q.add(BlockPos.getX(keys[i]));
				q.add(BlockPos.getY(keys[i]));
				q.add(BlockPos.getZ(keys[i]));
				q.add(b.predicted.get(keys[i]));
				q.add(s.getBlock() instanceof LiquidBlock ? s.getValue(LiquidBlock.LEVEL) : -1);
				lv.add(q);
			}
			x.add("levels", lv);
			x.addProperty("items", 0);
			bodies.add(x);
		}
		return o;
	}

	// ------------------------------------------------------------------ the report and the record

	/** The report in the region's ext: one entry per body that ended (S-H-6), in plan order. */
	static void report(RegionsImpl.Live l, Regional st) {
		JsonArray a = new JsonArray();
		// (6d RV) the region's rows and each standing revision's (with its rid): one report over the effective IR's bodies
		RegionsImpl.Live base = RegionsImpl.live(l.rec().id);
		List<RegionsImpl.Live> all = base == null ? List.of(l) : lives(base);
		java.util.Collections.reverse(all);
		for (RegionsImpl.Live x : all) {
			Regional xs = x.rid() == l.rid() ? st : of(x);
			if (xs != null) {
				rows(a, x.rid(), xs);
			}
		}
		l.rec().ext.add(EXT, a);
		// (8cF) the bodies being written or drained, with their boxes
		JsonArray w = new JsonArray();
		for (RegionsImpl.Live x : all) {
			Regional xs = x.rid() == l.rid() ? st : of(x);
			if (xs != null) {
				watchRows(w, x.rid(), xs);
			}
		}
		if (w.isEmpty()) {
			l.rec().ext.remove(EXT_WATCH);
		} else {
			l.rec().ext.add(EXT_WATCH, w);
		}
		RegionsImpl.save(l);
	}

	static void rows(JsonArray a, int rid, Regional st) {
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
			if (bs.breached > 0) {
				o.addProperty("breach", bs.breached); // (6c IRR, S-IRR-3) a breach's flow over its own field, taken back by a drain
			}
			if (rid > 0) {
				o.addProperty("rid", rid); // (6d RV) a revision's body
			}
			rowExtras(o, b, bs);
			a.add(o);
		}
	}

	/**
	 * (8cF, Steward's S-8c-1, S-8c-2, S-8c-4) A row's 8c members: {@code why} (typed, {@link #WHYS}; absent when settled), {@code box} (the
	 * watch set's), {@code settleTicks}; on a flowing body {@code kind}, {@code flow}, {@code lip} and {@code on} (as the op gave them),
	 * {@code flowing} (predicted flowing and falling cells), {@code converted}, {@code washed}; on a capped removal {@code foreign} (at most
	 * {@link #FOREIGN_NAMED} positions) and {@code foreignCount}. Additive: every member before 8c is as it was.
	 */
	static void rowExtras(JsonObject o, Body b, BodyState bs) {
		String why = whyOf(bs);
		if (why != null) {
			o.addProperty("why", why);
		}
		o.add("box", ints(b.watchBox()));
		o.addProperty("settleTicks", b.settleTicks);
		if (b.flowing()) {
			if (b.kind != null) {
				o.addProperty("kind", b.kind);
			}
			if (b.flow != null) {
				o.addProperty("flow", b.flow);
			}
			if (b.lip != null) {
				o.addProperty("lip", b.lip);
			}
			if (b.on != null) {
				o.addProperty("on", b.on);
			}
			o.addProperty("flowing", b.flowingCells());
			o.addProperty("converted", b.converted.length);
			o.addProperty("washed", b.wash.length);
		}
		if (bs.foreignCount > 0) {
			JsonArray f = new JsonArray();
			for (int i = 0; i < bs.foreign.size(); i++) {
				long p = bs.foreign.getLong(i);
				f.add(ints(new int[] {BlockPos.getX(p), BlockPos.getY(p), BlockPos.getZ(p)}));
			}
			o.add("foreign", f);
			o.addProperty("foreignCount", bs.foreignCount);
		}
	}

	static JsonArray ints(int[] v) {
		JsonArray a = new JsonArray();
		for (int x : v) {
			a.add(x);
		}
		return a;
	}

	/**
	 * (8cF, S-8c-3) The {@link #EXT_WATCH} rows of one record: every body whose water is being written ({@code writing}: the stage checked,
	 * the body written or not yet, not ended) or drained by a removal ({@code draining}: the removal began and isn't done), with its box.
	 */
	static void watchRows(JsonArray a, int rid, Regional st) {
		boolean removing = st.removal != null && !"done".equals(st.removal);
		boolean writing = "writing".equals(st.phase) || "settling".equals(st.phase);
		if (!removing && !writing) {
			return;
		}
		for (Body b : st.bodies) {
			BodyState bs = st.states.get(b.id);
			if (removing ? bs.before.isEmpty() : bs.ended()) {
				continue; // (nothing of it stands, or it ended)
			}
			JsonObject o = new JsonObject();
			o.addProperty("part", b.part != null ? b.part : b.id);
			o.addProperty("body", b.id);
			o.addProperty("phase", removing ? "draining" : "writing");
			o.add("box", ints(b.watchBox()));
			if (rid > 0) {
				o.addProperty("rid", rid);
			}
			a.add(o);
		}
	}

	/**
	 * (8cF, Steward's §2 drain timing) The removal's phase for {@link dev.larattalabs.architect.api.RegionView#fluidsRemoval}: while a
	 * record's removal drained its bodies and waits ({@code removal: "drained"}, "draining" until the bound), else null. A revision's record
	 * (6d RV) counts as the region's. Server thread.
	 */
	public static dev.larattalabs.architect.api.@Nullable FluidsRemoval removalPhase(RegionsImpl.Live base) {
		List<RegionsImpl.Live> all;
		try {
			all = lives(base);
		} catch (RuntimeException e) {
			return null;
		}
		for (RegionsImpl.Live x : all) {
			Regional st = STATE.get(key(x));
			if (st == null || st.removal == null || "done".equals(st.removal)) {
				continue;
			}
			long now = st.ticketLevel != null ? st.ticketLevel.getGameTime() : st.until;
			String phase = st.removalPhase != null ? st.removalPhase : "restoring".equals(st.removal) ? "restoring" : "draining";
			return new dev.larattalabs.architect.api.FluidsRemoval(phase, st.until, st.until < 0 ? 0 : st.until - now);
		}
		return null;
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
		o.addProperty("ordered", st.ordered); // (6c HY)
		if (st.owed) {
			o.addProperty("owed", st.owedWhy == null ? "owed" : st.owedWhy); // (slice DF) the record not on disk
		}
		JsonArray order = new JsonArray();
		st.order.forEach(b -> order.add(b.id));
		o.add("order", order);
		if (st.removal != null) {
			o.addProperty("removal", st.removal);
			o.addProperty("until", st.until);
			if (st.removalNote != null) {
				o.addProperty("removalNote", st.removalNote);
			}
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
			x.addProperty("writtenAt", bs.writtenAt); // (6c HY) an ordered region's write time per body (-1: the stage's forced tick, or never)
			x.addProperty("held", bs.held);
			bodies.add(x);
		}
		o.add("bodies", bodies);
		return o;
	}

	private static Path file(RegionsImpl.Live l) {
		return RegionStore.region(l.world(), l.rec().id).resolve(l.rid() == 0 ? "fluids.json" : "fluids-rv" + l.rid() + ".json");
	}

	/** Saves the record (slice DF: on DurableFile); true only when it is durably on disk (OK). */
	static boolean save(RegionsImpl.Live l, Regional st) {
		JsonObject o = new JsonObject();
		o.addProperty("phase", st.phase);
		o.addProperty("forcedAt", st.forcedAt);
		if (st.removal != null) {
			o.addProperty("removal", st.removal);
		}
		o.addProperty("until", st.until);
		if (st.removalNote != null) {
			o.addProperty("removalNote", st.removalNote);
		}
		if (st.removalPhase != null) {
			o.addProperty("removalPhase", st.removalPhase); // (8cF)
		}
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
			if (bs.uncontained) {
				b.addProperty("uncontained", true);
			}
			if (bs.held) {
				b.addProperty("held", true);
			}
			if (bs.lotRemoved) {
				b.addProperty("lotRemoved", true);
			}
			if (bs.breached > 0) {
				b.addProperty("breached", bs.breached);
			}
			if (bs.writtenAt >= 0) {
				b.addProperty("writtenAt", bs.writtenAt);
			}
			if (bs.why != null) {
				b.addProperty("why", bs.why); // (8cF)
			}
			if (bs.foreignCount > 0) {
				JsonArray fa = new JsonArray(); // (8cF) a capped removal's foreign cells
				for (int i = 0; i < bs.foreign.size(); i++) {
					long p = bs.foreign.getLong(i);
					fa.add(BlockPos.getX(p));
					fa.add(BlockPos.getY(p));
					fa.add(BlockPos.getZ(p));
				}
				b.add("foreign", fa);
				b.addProperty("foreignCount", bs.foreignCount);
			}
			b.add("before", packStates(bs.before));
			if (!bs.escapedCells.isEmpty()) {
				JsonArray esc = new JsonArray();
				long[] ks = bs.escapedCells.toLongArray();
				java.util.Arrays.sort(ks);
				for (long p : ks) {
					esc.add(BlockPos.getX(p));
					esc.add(BlockPos.getY(p));
					esc.add(BlockPos.getZ(p));
				}
				b.add("escapedCells", esc);
			}
			bodies.add(e.getKey(), b);
		}
		o.add("bodies", bodies);
		o.add("fluidBefore", packStates(st.fluidBefore));
		DurableFile.Result r = persist(file(l), st, o);
		boolean was = st.owed;
		st.owed = !r.ok();
		st.owedWhy = r.ok() ? null : r.outcome() + ": " + r.reason();
		if (!r.ok()) {
			if (!was) {
				Architect.LOGGER.warn("Region {}: {} not saved ({}): the fluids stage holds until it is", l.rec().id, file(l).getFileName(), st.owedWhy);
			}
			return false;
		}
		if (was) {
			Architect.LOGGER.info("Region {}: {} saved; the fluids stage goes on", l.rec().id, file(l).getFileName());
		}
		if (st.removal == null) {
			Realised.bodies(l.world(), l.rec().id, l.rid(), realisedRows(st)); // (RP) the realise's body outcomes, after fluids.json (a removal's drains aren't); (6d RV) a revision's at its layer
		}
		return true;
	}

	/** (slice DF) The durable file's type label in {@code _durable}. */
	static final String STORE = "fluids";

	/**
	 * (slice DF, rule 3) One snapshot of the record written through its {@link DurableFile} (temp, force, rename, the folder chain forced):
	 * OK, REFUSED (the old file stays) or IN_DOUBT (renamed, a force failed: never read as saved). {@code dev.region.failNextSave} on the
	 * file's name refuses it.
	 */
	static DurableFile.Result persist(Path f, Regional st, JsonObject o) {
		IOException injected = RegionStore.injected(f);
		if (injected != null) {
			return new DurableFile.Result(DurableFile.Outcome.REFUSED, 0, injected.getMessage());
		}
		DurableFile df = st.durable;
		if (df == null || !df.file().equals(f)) {
			st.durable = df = new DurableFile(STORE, f);
		}
		return df.write(o, df.request());
	}

	/**
	 * (slice DF) A loaded record's durable file: a file on disk not confirmed (written before DF, or its loaded generation's re-force failed)
	 * is owed, so it is written again, forced, before the stage goes on.
	 */
	static void opened(RegionsImpl.Live l, Regional st) {
		Path f = file(l);
		if (!Files.isRegularFile(f)) {
			return;
		}
		DurableFile df = new DurableFile(STORE, f);
		st.durable = df;
		if (df.writtenGen() == 0 || df.inDoubt() > 0 || df.installedGen() > df.writtenGen()) {
			st.owed = true;
			st.owedWhy = df.writtenGen() == 0 ? "loaded, not confirmed (no generation)" : "loaded, its re-force in doubt";
		}
	}

	/** (slice DF) Whether the record is durably on disk: an owed one is written again (a fresh forced snapshot covers an IN_DOUBT one). */
	static boolean durable(RegionsImpl.Live l, Regional st) {
		if (!st.owed) {
			return true;
		}
		long now = System.nanoTime();
		if (st.owedTriedAt != 0 && now - st.owedTriedAt < RETRY_NANOS) {
			return false; // (a failing disk: one try a second, not one per caller per tick)
		}
		st.owedTriedAt = now;
		return save(l, st);
	}

	/** (slice DF) How often an owed record is tried again. */
	static final long RETRY_NANOS = 1_000_000_000L;

	/** (slice DF) The stage's wait while its record is owed. */
	static String notDurable(Regional st) {
		return "the fluids record is not durable (" + (st.owedWhy == null ? "owed" : st.owedWhy) + "): nothing is written until it is saved";
	}

	/** (RP) Each body that left {@code pending}: its part, state and the flags that decided it (the realised record's rows). Pure. */
	static Map<String, JsonObject> realisedRows(Regional st) {
		Map<String, JsonObject> out = new LinkedHashMap<>();
		for (Body b : st.bodies) {
			BodyState bs = st.states.get(b.id);
			if (bs == null || "pending".equals(bs.state)) {
				continue;
			}
			JsonObject r = new JsonObject();
			if (b.part != null) {
				r.addProperty("part", b.part);
			}
			r.addProperty("state", bs.state);
			if (bs.reason != null) {
				r.addProperty("reason", bs.reason);
			}
			r.addProperty("uncontained", bs.uncontained);
			r.addProperty("held", bs.held);
			r.addProperty("lotRemoved", bs.lotRemoved);
			r.addProperty("escaped", bs.escaped);
			r.addProperty("sources", bs.sources);
			r.addProperty("spill", bs.spill);
			r.addProperty("settledAt", bs.settledAt);
			r.addProperty("writtenAt", bs.writtenAt);
			out.put(b.id, r);
		}
		return out;
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
			st.removalNote = o.get("removalNote") instanceof JsonElement rn && rn.isJsonPrimitive() ? rn.getAsString() : null;
			st.removalPhase = strOrNull(o, "removalPhase"); // (8cF)
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
					bs.uncontained = b.has("uncontained") && b.get("uncontained").getAsBoolean();
					bs.held = b.has("held") && b.get("held").getAsBoolean();
					bs.lotRemoved = b.has("lotRemoved") && b.get("lotRemoved").getAsBoolean();
					bs.breached = b.has("breached") ? b.get("breached").getAsInt() : 0;
					bs.writtenAt = b.has("writtenAt") ? b.get("writtenAt").getAsLong() : -1;
					bs.why = strOrNull(b, "why"); // (8cF)
					if (b.get("foreign") instanceof JsonArray fa) {
						for (int i = 0; i + 2 < fa.size(); i += 3) {
							bs.foreign.add(BlockPos.asLong(fa.get(i).getAsInt(), fa.get(i + 1).getAsInt(), fa.get(i + 2).getAsInt()));
						}
					}
					bs.foreignCount = b.has("foreignCount") ? b.get("foreignCount").getAsInt() : bs.foreign.size();
					unpackStates(b.get("before"), bs.before);
					if (b.get("escapedCells") instanceof JsonArray esc) {
						for (int i = 0; i + 2 < esc.size(); i += 3) {
							bs.escapedCells.add(BlockPos.asLong(esc.get(i).getAsInt(), esc.get(i + 1).getAsInt(), esc.get(i + 2).getAsInt()));
						}
					}
				}
			}
			unpackStates(o.get("fluidBefore"), st.fluidBefore);
			st.recheck = "writing".equals(st.phase);
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
			STATE.values().forEach(st -> hold(null, st, false));
			STATE.clear();
		} else {
			Regional st = STATE.remove(regionId);
			if (st != null) {
				hold(null, st, false);
			}
			// (6d RV) and its revisions' records
			for (String k : List.copyOf(STATE.keySet())) {
				if (k.startsWith(regionId + "#rv")) {
					hold(null, STATE.remove(k), false);
				}
			}
		}
	}

	/** Takes ({@code want}) or releases the record's {@link Ticket#TICKET} on every chunk of its bodies' watch sets. */
	static void hold(@Nullable ServerLevel level, Regional st, boolean want) {
		if (!want) {
			if (st.ticketLevel != null) {
				for (long k : st.ticketed) {
					st.ticketLevel.getChunkSource().removeTicketWithRadius(Ticket.TICKET, ChunkPos.unpack(k), TICKET_RADIUS);
				}
			}
			st.ticketed.clear();
			st.ticketLevel = null;
			return;
		}
		if (level == null || !st.ticketed.isEmpty()) {
			return;
		}
		for (Body b : st.bodies) {
			for (long p : b.watchSet()) {
				st.ticketed.add(ChunkPos.pack(BlockPos.getX(p) >> 4, BlockPos.getZ(p) >> 4));
			}
		}
		for (long k : st.ticketed) {
			level.getChunkSource().addTicketWithRadius(Ticket.TICKET, ChunkPos.unpack(k), TICKET_RADIUS);
		}
		st.ticketLevel = level;
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

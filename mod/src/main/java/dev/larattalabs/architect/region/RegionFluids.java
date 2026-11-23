package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.batch.QBatch;
import dev.larattalabs.architect.batch.QItem;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.txn.TxnEntry;
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
		synchronized (REMOVED_WATCH) {
			for (LongOpenHashSet w : REMOVED_WATCH.values()) {
				if (w.contains(p)) {
					return true; // ((8c fix round, P2-7) a removed river's watch set: E-flat, never refed)
				}
			}
		}
		return false;
	}

	/** (8c fix round, P2-7) The flowing watch sets of records forgotten this session (a removal's undo diff runs after), by key; at most 32. */
	static final Map<String, LongOpenHashSet> REMOVED_WATCH = new LinkedHashMap<>() {
		@Override
		protected boolean removeEldestEntry(Map.Entry<String, LongOpenHashSet> e) {
			return size() > 32;
		}
	};

	/** (8c fix round, P2-7) A record's flowing watch sets kept before it is forgotten. */
	static void snapshotWatch(String key, @Nullable Regional st) {
		if (st == null) {
			return;
		}
		LongOpenHashSet w = new LongOpenHashSet();
		for (Body b : st.bodies) {
			if (b.flowing()) {
				w.addAll(b.watchSet());
			}
		}
		if (!w.isEmpty()) {
			synchronized (REMOVED_WATCH) {
				REMOVED_WATCH.put(key, w);
			}
		}
	}

	/** (8c WU) The items counted for a region's record (its id), kept after the region is removed. */
	public static int itemsOf(String regionId) {
		return ITEMS.getOrDefault(regionId, 0);
	}

	/** (8cF) Whether this mod builds 8c's flowing water ({@link #FLOWING_BUILD}). */
	public static boolean flowingBuild() {
		Boolean t = testFlowing;
		return t != null ? t : FLOWING_BUILD;
	}

	/** (TEST, 8c fix round) Overrides {@link #flowingBuild} in the units (null: the build's). */
	static volatile @Nullable Boolean testFlowing;
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
	/** (8cT last round) TEST, DevBridge {@code dev.fluid.hold {drain}}: a removal's or lot's drain W refuses (held) while on. Default off. */
	public static volatile boolean holdDrain;
	/**
	 * (slice T5Fa) TEST, DevBridge {@code dev.fluid.writeTrace}: while non-null, every body cell {@link #writeBody} writes (a source, ice, a
	 * grate's bars) is added here: the rows assert Architect's own write, not the cell (vanilla may refill water itself). Default null: off.
	 */
	public static volatile java.util.@Nullable Set<Long> writeTrace;
	/**
	 * (slice T5Fa) TEST, DevBridge {@code dev.fluid.forceTrace}: while non-null, every {@link #forceBody} call adds {@code <body>@<gameTime>}
	 * here: the forced ticks a write (or its replay) scheduled. Default null: off.
	 */
	public static volatile java.util.@Nullable List<String> forceTrace;
	/** DevBridge {@code dev.fluid.bypass} (gate item 2's negative control): the containment check is not run (every body is written). */
	public static volatile boolean bypassCheck;
	/** (8cTa) TEST, DevBridge {@code dev.fluid.hold}: a record's write step (the forced tick, an ordered course's wave) is not run. Default off. */
	public static volatile boolean holdWrite;
	/** (8cTa) TEST, DevBridge {@code dev.fluid.hold}: a record's census (settle, escape guard) is not run. Default off. */
	public static volatile boolean holdSettle;
	/**
	 * (8c, the review's P1-5) DevBridge {@code dev.fluid.beforeWave}: run once, right before an ordered region's next wave after its first
	 * (a reach written after the reach it lands in settled) writes its sources.
	 */
	public static volatile java.util.function.@Nullable Consumer<ServerLevel> beforeWave;
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
		@Nullable LongOpenHashSet iceSet;
		/** (8c fix round, P2-11) The watch set sorted, for the census's slices. */
		long @Nullable [] watchSorted;

		/** (8c fix round) The ice cap's cells as a set. */
		LongOpenHashSet iceSet() {
			if (iceSet == null) {
				iceSet = new LongOpenHashSet(ice);
			}
			return iceSet;
		}

		/** (8c WU) The body's own cells as a set. */
		LongOpenHashSet ownSet() {
			if (ownSet == null) {
				ownSet = new LongOpenHashSet(cells);
			}
			return ownSet;
		}

		/** (8c) The op's {@code model} (the kit's WM: "wm"), else null. */
		@Nullable String model;

		/**
		 * (8cF; the coordinator's decision) Whether the body is 8c's flowing water: {@code flow: "current"}, {@code lip: "form"} or the kit's
		 * {@code model: "wm"}. Any other flow ({@code "level"}, an unknown value: kept, noted) is a plain HY body.
		 */
		boolean flowing() {
			return "current".equals(flow) || "form".equals(lip) || "wm".equals(model);
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
		/** (slice DF round 2, P1 3) A removed lot's drain ran (its record saved first, lotRemoved, then this): a start drains the others again. */
		boolean lotDrained;
		/** (6c HY) When an ordered region wrote and forced this body (game time), else -1 (the region's forcedAt). */
		long writtenAt = -1;
		/**
		 * (slice T5F fix round, P2-6) When a {@code fluid.force} W last scheduled this body's ticks this session (a replay's included), else -1:
		 * the census counts the settle bound from it too ({@link RegionFluids#settleBase}). Not saved: the force receipts are its record.
		 */
		long forcedAt = -1;
		/** (round 2, P2-c) This session read the body's force receipts into {@link #forcedAt} ({@link RegionFluids#settleBase}). */
		boolean forceScanned;
		/** (8cTc) The {@code fluid.write} txn that wrote this body (its R effect), else null. Saved. */
		@Nullable String writeTxn;
		/** (8cTc) The {@code fluid.drain} txn (escape, unsettled, upstream or lot) whose R effect recorded this body drained, else null. Saved. */
		@Nullable String drainTxn;
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
		/** (8c fix round, P2-11) The census's slice cursor and the sweep's findings so far (transient). */
		int censusAt;
		@Nullable Census censusAcc;

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
		/** (8c fix round, P2-11) The stray pass's work (chunk-sorted [cell, order index, target level]) and its cursor; transient. */
		long @Nullable [][] strayWork;
		int strayAt;
		int strayDone;
		/**
		 * (8c round 2, P1-2) The stray pass's chunks still to restore (packed chunk keys): set when the removal enters `restoring`, saved with
		 * the record, a chunk removed (and saved) once its cells are done; `done` only when none is left. A resumed pass re-tickets every
		 * watch set and waits until each remaining chunk is loaded, so no residue is missed in an unloaded chunk.
		 */
		@Nullable LongOpenHashSet strayChunks;
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
		/**
		 * (slice T5F, §4.7) The record's cells carry fluid provenance ({@link FluidProv}): true for a record created by T5F (saved as
		 * {@code prov}); false for one loaded without it (built before T5F), adopted by {@link FluidTxns#adoptFirst} before any write or drain.
		 */
		boolean prov = true;
		/** (T5Fc, §4.3) The removal drain's receipt index: [effect key, cx, cz] per drain W of its txn. Saved; the scoop and the deadline read it. */
		@Nullable JsonArray drainReceipts;
		/** (T5Fc, S4/Q2) Σh of the removal drain's receipts: taken lava cells, grate cells, all cells. Saved. */
		int @Nullable [] taken;
		/** (T5Fc, §4.6) The region.scoop txn that refunded this record, else null; and what its ledger credit returned. Saved. */
		@Nullable String scooped;
		@Nullable JsonObject scoopCredited;
		/** (T5Fc) What this session's scoop L credited (the ledger's answer), for its R. */
		transient @Nullable Map<String, Integer> scoopCreditedNow;
		/** (slice T5F) Body cell -> its body (the first that lists it), built once. */
		it.unimi.dsi.fastutil.longs.@Nullable Long2ObjectOpenHashMap<Body> cellBody;

		/** (slice T5F) The body one of whose own cells {@code p} is, or null. */
		@Nullable Body bodyAt(long p) {
			if (cellBody == null) {
				var m = new it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap<Body>();
				for (Body b : bodies) {
					for (long c : b.cells) {
						m.putIfAbsent(c, b);
					}
				}
				cellBody = m;
			}
			return cellBody.get(p);
		}
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
		/** (slice DF round 2) When the removal last tried T0's world barrier before its done record and was refused, 0 none. */
		long barrierTriedAt;
		/** (slice DF round 3, P1 6) The removal's done record was saved after T0's world barrier (a done without it is recovered first). */
		boolean barrierDone;
		/**
		 * (8cTb) The removal's {@code fluid.drain} txn that wrote {@code drained} (its R effect): set, the drain's writes are covered by its
		 * barrier once it retired, so a start never drains again. Null on a record drained before 8cT (a start drains it again in a txn).
		 */
		@Nullable String drainTxn;
		/** (8cTb) {@link #drainTxn} as last saved durably or loaded (the R effect's probe). */
		@Nullable String drainTxnOnDisk;
		/** (8cTb, Steward's ask) While the removal's drain txn is held: its where ({@code chunk x,z}), for the view's {@code heldAt}. */
		@Nullable String drainHeldAt;
		/** (8cTc) The cells the last lot drain wrote (its log line); transient. */
		int lastLotCells;
		/** (8cT last round, #5) This session's legacy lot conversion is done (or there was none); transient. */
		boolean legacyLotsDone;
		/** (8cT last round, P2) Why the last lot drain waits ({@code held(..) tx-<n>: chunk x,z} when its txn is held); transient. */
		@Nullable String lastLotHeld;
		/** (8cTb review P1-3) What the removal drain saw, just before its writes this session: {lava, grates} to refund at most; transient. */
		int @Nullable [] scoopSeen;

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
			return flowingBuild() && bodies.stream().anyMatch(Body::flowing);
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
				b.model = strOrNull(o, "model");
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
		snapshotWatch(regionId + "#rv" + rid, st); // ((8c fix round, P2-7))
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
		// (slice DF, rule 3) the stage goes on only while its record is durably on disk: an owed record is written again first (one try a
		// second, in every phase: round 2, P2 10)
		if (st != null && !mayWrite(l, st)) {
			waitNotDurable(b, stage, st);
			return false;
		}
		if (st != null && st.recheck) {
			ServerLevel level = l.level(s);
			if (level == null) {
				return false;
			}
			recheck(level, l, st);
			if (!afterRecheck(l, st)) {
				RegionItems.waitStage(b, stage, Reason.SITE_BUSY, notDurable(st));
				return false;
			}
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
				// (8c SV) a staged terrain target first: the paid targets of its tiles wait for it, so it is what the bodies wait for
				String[] first = dev.larattalabs.architect.site.RegionTargets.firstBuildingForFluids(s, l.rec().groupId);
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
					bs.reason = washReason(why[0], w.size());
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
		if (l.rec().survival() && !l.rec().survival.has("chargedAt") && FluidTxns.chargeOpen(l)) {
			// (8cTb) the charge's txn is open (held, or its record replay waits for the region): it finishes first
			RegionItems.waitStage(b, stage, Reason.SITE_BUSY, "the fluid bodies wait for their charge (its txn is still open)");
			return false;
		}
		if (l.rec().survival() && !l.rec().survival.has("chargedAt")) {
			Map<String, Integer> charge = chargeOf(st);
			var booked = dev.larattalabs.architect.site.Stockpiles.get(l.rec().owner);
			if (!charge.isEmpty() && booked != null && booked.ledger().charged(chargeKey(l)) != null && !dev.larattalabs.architect.site.Stockpiles.ledgerOnDisk(s)) {
				// (OVF, review round 4) booked in memory only (its save refused): the stage waits; never settled as charged before the ledger is on disk
				RegionItems.waitStage(b, stage, Reason.SITE_BUSY, "the fluid bodies wait for their charge's ledger save");
				return false;
			}
			if (!charge.isEmpty() && booked != null && settleBooked(l, booked.ledger(), level.getGameTime())) {
				if (!l.rec().survival.has(CHARGED_BODIES)) {
					l.rec().survival.add(CHARGED_BODIES, chargedBodiesOf(st)); // (round 3) the bodies the ledger's charge paid for (chargeOf's)
				}
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
				Map<String, Integer> lack = dev.larattalabs.architect.site.Stockpiles.chargeShort(l.rec().owner, charge);
				if (!lack.isEmpty()) {
					RegionItems.waitStage(b, stage, Reason.SITE_BUSY, "the fluid bodies wait for " + lack + " in the stockpile of " + l.rec().owner
						+ " (a lava bucket per lava source, a grate's iron bars)");
					return false;
				}
				// (8cTb, B) the charge is a txn: its intent (the items, the rid, the bodies it pays for) durable first, then the keyed debit (L),
				// then the region record's charge with chargedBodies (R); a crash between them replays the record from the entry (FLc: after the L)
				FluidTxns.Step g = FluidTxns.charge(s, l, charge, chargedBodiesOf(st), level.getGameTime());
				if (g.kind() != FluidTxns.Step.Kind.DONE) {
					RegionItems.waitStage(b, stage, Reason.SITE_BUSY, "the fluid bodies wait for their charge" + (g.detail() == null ? "" : ": " + g.detail()));
					return false;
				}
			}
			// (fix round, P1-1) chargedAt with its paid bodies, an empty set when nothing was charged (the charge txn's R wrote them otherwise)
			markCharged(l.rec().survival, new JsonArray(), level.getGameTime());
			RegionsImpl.saveRec(l);
		}
		st.phase = "writing";
		if (!save(l, st)) {
			// (slice DF, rule 3) the before states are not durable: no source is written; the stage waits and the gate runs again (throttled)
			st.phase = "gate";
			st.owedTriedAt = System.nanoTime();
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

	/** (slice DF round 3) The record's member naming the bodies the region's fluids charge paid for. */
	static final String CHARGED_BODIES = "chargedBodies";

	/** (slice DF round 3) The bodies {@link #chargeOf} charges (pending, with lava or a grate), as ids. */
	static JsonArray chargedBodiesOf(Regional st) {
		JsonArray a = new JsonArray();
		for (Body b : st.bodies) {
			if ("pending".equals(st.states.get(b.id).state) && (b.lava && b.cells.length > 0 || b.grate.length > 0)) {
				a.add(b.id);
			}
		}
		return a;
	}

	/** (slice DF round 2) The record whose bodies the region's fluids charge was counted against ({@code survival.chargedRid}, else 0). */
	static int chargedRid(RegionsImpl.Live l) {
		JsonElement e = l.rec().survival.get(dev.larattalabs.architect.site.BillCaps.CHARGED_RID);
		return e != null && e.isJsonPrimitive() ? e.getAsInt() : 0;
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
		if (!l.rec().survival() || l.rec().survival.has("chargedAt") || FluidTxns.chargeOpen(l)) {
			return false; // (8cTb) an open charge txn replays its own record (the bodies included)
		}
		var c = ledger.charged(chargeKey(l));
		if (c == null) {
			return false;
		}
		settleCharge(l.rec().survival, c, now);
		Regional st = of(l);
		if (st != null && !l.rec().survival.has(CHARGED_BODIES)) {
			l.rec().survival.add(CHARGED_BODIES, chargedBodiesOf(st)); // (8cTb, B) a booking from before 8cT: the bodies it paid for (still pending)
		}
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
			String[] why = new String[1];
			// ((8c, the review's P1-5) a flowing body's predicted cells again too: a washable recovered from older chunks holds it)
			List<long[]> wash = bad.isEmpty() && st.flowingRegion() && body.flowing() && !bypassCheck ? washCheck(level, body, why) : List.of();
			if (bad.isEmpty() && wash.isEmpty()) {
				continue;
			}
			String typed = "uncontained";
			if (!wash.isEmpty()) {
				bad = wash;
				typed = "bubble".equals(why[0]) || "wash".equals(why[0]) ? why[0] : "uncontained";
			}
			String reason = !wash.isEmpty() ? washReason(why[0], wash.size()) + " (checked again after a stop)" : "uncontained: " + bad.size()
				+ "+ shell or join cell(s) do not hold what the body was checked against (checked again after a stop)";
			// (8cT last round, #4) the body's (and its pending upstream closure's) tile-written cells drained in a txn: W, R (drained, held
			// upstream), the barrier
			FluidTxns.Step g = FluidTxns.hold(l, st, body, typed, reason, bad.subList(0, Math.min(NAMED, bad.size())));
			if (g.kind() != FluidTxns.Step.Kind.DONE) {
				st.recheck = true; // (checked again next time: the txn finishes first)
				return;
			}
			Architect.LOGGER.warn("Region {}: fluid body {} is not written ({}): {}", l.rec().id, body.id, bs.reason, cells(bs.at));
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
	/**
	 * (8c round 2, P1-1, P1-3) The emission check of a flowing body, at its wave or its forced tick: its own cells open (air, or what it
	 * wrote: a player's waterlogged chest there is not) and its predicted cells free of washables. Null when it may be written, else
	 * {why, reason} and the cells in {@code at}.
	 */
	static @Nullable String[] emissionCheck(ServerLevel level, Body b, List<long[]> at) {
		List<long[]> shut = new ArrayList<>();
		for (long[] a : new long[][] {b.cells, b.ice}) {
			for (long p : a) {
				BlockState now = level.getBlockState(BlockPos.of(p));
				if (now.hasBlockEntity() || !(now.isAir() || ownStillOurs(b, p, now) || openCell(b, p, now))) {
					shut.add(new long[] {BlockPos.getX(p), BlockPos.getY(p), BlockPos.getZ(p)});
				}
			}
		}
		if (!shut.isEmpty()) {
			at.addAll(shut.subList(0, Math.min(NAMED, shut.size())));
			return new String[] {"uncontained", "uncontained: " + shut.size() + " of its own cell(s) hold a block it didn't write (a player's waterlogged block?)"};
		}
		String[] why = new String[1];
		List<long[]> w = washCheck(level, b, why);
		if (w.isEmpty()) {
			return null;
		}
		at.addAll(w.subList(0, Math.min(NAMED, w.size())));
		return new String[] {"bubble".equals(why[0]) || "wash".equals(why[0]) ? why[0] : "uncontained", washReason(why[0], w.size())};
	}

	/**
	 * (8c round 2, P1-3) A body the emission check holds: its cells the stage's tiles already wrote drained back first (the guarded drain:
	 * only what still holds its water), then reported drained (never while its sources stand), its upstream closure held.
	 */
	static boolean holdBody(ServerLevel level, RegionsImpl.Live l, Regional st, Body b, BodyState bs, String[] why, List<long[]> at, String where) {
		// (8cT last round, #4) the tiles wrote it: its drain is a txn (W the drain, R the record drained, the barrier); true once done
		FluidTxns.Step g = FluidTxns.hold(l, st, b, why[0], why[1] + " (" + where + ")", at);
		if (g.kind() != FluidTxns.Step.Kind.DONE) {
			return false;
		}
		Architect.LOGGER.info("Region {}: fluid body {} is not written ({}): {}", l.rec().id, b.id, bs.reason, cells(bs.at));
		return true;
	}

	static String washReason(@Nullable String why, int n) {
		return "bubble".equals(why) ? "M25:bubble: " + n + " predicted cell(s) over soul sand or magma" : "M25:wash: " + n
			+ " predicted cell(s) hold a block the flow would " + ("wash".equals(why) ? "wash away" : "meet") + " (placed after approval?)";
	}

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
			// not contained (or held, HY): never written; (6c IRR) nor a source whose lot was removed. (8cTc, deviation from N1) the tiles
			// still write the bodies' cells: their journal entries carry the undo's hand-down to a later entry layered over a body cell
			// (irr-holders) and the drain's holders' floor; the write txn records and forces what they wrote (FluidTxns.write)
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
			if (!st.prov) {
				FluidTxns.adoptFirst(l, st); // (slice T5F, §4.7) a record built before T5F: its marks first, then everything else
				continue;
			}
			hold(level, st, "writing".equals(st.phase) || "settling".equals(st.phase));
			legacyLots(l, st); // (8cT last round, #5) a lot removed before 8cT, its drain maybe lost: drained again at load, in a txn
			final RegionsImpl.Live fl = l;
			final Regional fst = st;
			tickRecord(l, st, () -> "writing".equals(fst.phase) && stageWritten(fl), () -> {
				if (fst.ordered) {
					writeWaves(level, fl, fst); // (6c HY) one wave of bodies whose landings have settled
				} else {
					force(level, fl, fst);
				}
			}, () -> ("settling".equals(fst.phase) || fst.ordered && "writing".equals(fst.phase) && fst.forcedAt >= 0) && level.getGameTime() - fst.lastCensus
				>= CENSUS_EVERY, () -> {
				fst.lastCensus = level.getGameTime();
				settle(level, fl, fst);
			});
			}
		}
	}

	/**
	 * (slice DF round 2) One record's tick: its write step (the forced ticks, or a course's next wave) when due, then its census when due.
	 * Nothing runs while the record is owed and its retry fails.
	 */
	static void tickRecord(RegionsImpl.Live l, Regional st, java.util.function.BooleanSupplier writeDue, Runnable write, java.util.function.BooleanSupplier settleDue,
		Runnable settle) {
		if (st.owed && !durable(l, st)) {
			return; // (slice DF, rule 3) nothing forced, written or settled while the record is not on disk
		}
		if (!holdWrite && writeDue.getAsBoolean()) {
			write.run();
			if (st.owed) {
				return; // (round 2, P1 6) the write step's save failed: no census or escape drain on an undurable record this tick
			}
		}
		if (!holdSettle && settleDue.getAsBoolean()) {
			settle.run();
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

	/** (8cTc) A body state's id in its record. */
	static String idOf(Regional st, BodyState bs) {
		for (var e : st.states.entrySet()) {
			if (e.getValue() == bs) {
				return e.getKey();
			}
		}
		return "";
	}

	/** §3.2: one fluid tick on every source and every face neighbour of one that is no body cell. */
	static void force(ServerLevel level, RegionsImpl.Live l, Regional st) {
		List<String> due = new ArrayList<>();
		for (Body b : st.bodies) {
			BodyState bs = st.states.get(b.id);
			if (!"pending".equals(bs.state)) {
				continue;
			}
			// ((8c round 2, P1-3) an unordered flowing body's emission check before its forced tick: held, its tile-written sources drained)
			if (st.flowingRegion() && b.flowing() && !bypassCheck) {
				List<long[]> at = new ArrayList<>();
				String[] why = emissionCheck(level, b, at);
				if (why != null) {
					if (!holdBody(level, l, st, b, bs, why, at, "at its forced tick")) {
						return; // (8cT last round) its drain txn runs first
					}
					continue;
				}
			}
			due.add(b.id);
		}
		// (8cTc, N1) the tiles are markers: the write txn writes every due body's cells and forces it (W, receipts per chunk), then records
		// them written and the phase settling (R), the barrier; a start replays it
		if (!due.isEmpty()) {
			FluidTxns.Step g = FluidTxns.write(l, st, due, true, List.of());
			if (g.kind() != FluidTxns.Step.Kind.DONE) {
				if (g.detail() != null) {
					Architect.LOGGER.warn("Region {}: the fluids write waits: {}", l.rec().id, g.detail());
				}
				return;
			}
		} else {
			st.phase = "settling";
			save(l, st);
		}
		if (st.forcedAt < 0) {
			st.forcedAt = level.getGameTime();
		}
		WorldJournal.kill("FL2"); // the sources written and ticked, settling
		Architect.LOGGER.info("Region {}: fluids written; {} bod{} forced, settling", l.rec().id, due.size(), due.size() == 1 ? "y" : "ies");
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
		// (slice T5F, §4.2) the first wave's txn clears what the tiles wrote of the waiting water bodies (fluid.clear W per chunk: WROTE ->
		// CLEARED, in the same tick and chunk); a later wave finds them CLEARED. Lava and grate bodies are never cleared (the N1 condition)
		boolean firstWave = st.states.values().stream().noneMatch(x -> x.writeTxn != null || x.writtenAt >= 0);
		List<String> clear = new ArrayList<>();
		if (firstWave) {
			for (Body b : waiting) {
				if (!b.lava && b.grate.length == 0 && !st.states.get(b.id).before.isEmpty()) {
					clear.add(b.id);
				}
			}
		}
		int forced = 0;
		var waveHook = beforeWave;
		if (waveHook != null && !due.isEmpty() && st.states.values().stream().anyMatch(x -> !"pending".equals(x.state) && !"drained".equals(x.state))) {
			beforeWave = null; // (TEST, the review's P1-5) a later wave: a block set now stands in its predicted cells
			waveHook.accept(level);
		}
		List<Body> held = new ArrayList<>();
		List<String> wave = new ArrayList<>();
		for (Body b : due) {
			BodyState bs = st.states.get(b.id);
			if (!"pending".equals(bs.state)) {
				continue; // (held by an earlier body's wash check this wave)
			}
			// ((8c P1-5; round 2, P1-1, P1-3) the emission check at the source's wave: a washable in its predicted cells, or a block it didn't
			// write in its own cells, holds it; what the tiles wrote of it is drained first)
			if (st.flowingRegion() && b.flowing() && !bypassCheck) {
				List<long[]> at = new ArrayList<>();
				String[] why = emissionCheck(level, b, at);
				if (why != null) {
					if (!holdBody(level, l, st, b, bs, why, at, "at its wave")) {
						return; // (8cT last round) its drain txn runs first
					}
					held.add(b);
					continue;
				}
			}
			wave.add(b.id);
		}
		if (due.isEmpty()) {
			return;
		}
		if (!held.isEmpty()) {
			report(l, st);
		}
		boolean more = st.states.values().stream().anyMatch(x -> "pending".equals(x.state) && !wave.contains(x == null ? "" : idOf(st, x)));
		if (!wave.isEmpty()) {
			// (8cTc, N1) the wave's write as a txn (W: the bodies written and forced, receipts; R: written, settling with the last wave)
			FluidTxns.Step g = FluidTxns.write(l, st, wave, !more, clear);
			if (g.kind() != FluidTxns.Step.Kind.DONE) {
				if (g.detail() != null) {
					Architect.LOGGER.warn("Region {}: the fluids wave waits: {}", l.rec().id, g.detail());
				}
				return;
			}
			forced = wave.size();
		} else {
			if (!more) {
				st.phase = "settling";
			}
			save(l, st);
		}
		Architect.LOGGER.info("Region {}: fluids wave {}: {} forced fluid tick(s){}", l.rec().id, due.stream().map(b -> b.id).toList(), forced, more ? "" : "; every body written, settling");
		WorldJournal.kill(more ? "FL4" : "FL2"); // (6c HY) between two reaches: the downstream written, the upstream not
	}

	/** (slice T5F) Whether cell {@code p} lies in chunk {@code (cx, cz)}. */
	static boolean inChunk(long p, int cx, int cz) {
		return BlockPos.getX(p) >> 4 == cx && BlockPos.getZ(p) >> 4 == cz;
	}

	/** (slice T5F) The chunks of a body's own cells (packed {@link #chunkKey}), sorted. */
	static long[] cellChunks(Body b) {
		java.util.TreeSet<Long> out = new java.util.TreeSet<>();
		for (long p : b.cells) {
			out.add(chunkKey(p));
		}
		return out.stream().mapToLong(Long::longValue).toArray();
	}

	/**
	 * (slice T5F, I6's chunk-locality rule) The chunks that receive one of {@link #forceBodyIn}'s ticks: every own cell's, and every face
	 * neighbour's that is not an own cell (a neighbour across a chunk border is that chunk's W), sorted.
	 */
	static long[] forceChunks(Body b) {
		java.util.TreeSet<Long> out = new java.util.TreeSet<>();
		LongOpenHashSet own = b.ownSet();
		for (long p : b.cells) {
			out.add(chunkKey(p));
			for (net.minecraft.core.Direction d : net.minecraft.core.Direction.values()) {
				long q = BlockPos.offset(p, d);
				if (!own.contains(q)) {
					out.add(chunkKey(q));
				}
			}
		}
		return out.stream().mapToLong(Long::longValue).toArray();
	}

	/**
	 * (slice T5F, §4.2 {@code fluid.place}, §3.3, I2) One body's cells in chunk {@code (cx, cz)}: its sources, ice cap, grate and bubble
	 * cells, then its decor, each written only where §3.3 writes it (no mark, or R's own {@code CLEARED}, and the cell open: air or what
	 * the body itself would hold there, never over a block entity) and then marked {@code WROTE(R)} in the same tick and chunk. A
	 * {@code WROTE} cell is never written again, whatever stands there (a bucketed pond cell, harvested lava, broken bars: N3). No update
	 * is sent. Returns {written, WROTE cells found taken}.
	 */
	static int[] placeBody(FluidWorld w, Body b, String rec, int cx, int cz) {
		int written = 0, taken = 0, refused = 0;
		var marks = w.marks(cx, cz, rec);
		boolean changed = false;
		LongOpenHashSet grate = new LongOpenHashSet(b.grate);
		LongOpenHashSet ice = new LongOpenHashSet(b.ice);
		BlockState src = (b.lava ? Blocks.LAVA : Blocks.WATER).defaultBlockState();
		BlockState bars = parse(GRATE);
		for (long p : b.cells) {
			if (b.decorState.containsKey(p) || !inChunk(p, cx, cz)) {
				continue; // (6c F3-c) the decor's own cell: written below, never water first
			}
			int idx = w.index(p);
			FluidProv.Mark m = marks.get(idx);
			BlockState now = w.get(p);
			BlockState to = ice.contains(p) ? Blocks.ICE.defaultBlockState() : grate.contains(p) ? bars : b.bubble.containsKey(p) ? bubbleState(b.bubble.get(p)) : src;
			boolean ours = ownStillOurs(b, p, now);
			// ((8c round 2, P1-1) only into air or what the body wrote there (its fluid, ice, its grate's bars, its column): never over a block
			// with a block entity or a waterlogged block a player placed)
			boolean open = !now.hasBlockEntity() && (now.isAir() || ours || (now.is(Blocks.ICE) || now.is(Blocks.FROSTED_ICE)));
			FluidProv.Cell c = FluidProv.read(m, open, ours);
			if (m == FluidProv.Mark.WROTE && !ownDelivered(b, p, now)) {
				taken++; // harvested, broken or replaced (flow in a harvested source cell included): never written again (I2, N3), refunded 0
			}
			if (c.write() && now != to) {
				if (!w.set(p, to)) {
					refused++; // (fix round, P1-2) a hold refused it: no mark, no receipt; the W holds and runs again
					continue;
				}
				marks.put(idx, FluidProv.Mark.WROTE);
				changed = true;
				written++;
				java.util.Set<Long> wt = writeTrace;
				if (wt != null) {
					wt.add(p); // (T5Fa TEST) dev.fluid.writeTrace
				}
			} else if (m == FluidProv.Mark.CLEARED && now == to && !b.lava && grate.isEmpty()) {
				marks.put(idx, FluidProv.Mark.WROTE); // a cleared water cell refilled already (vanilla's infinite source): the body's again
				changed = true;
			}
		}
		// ((6c F3-c) the decor: a body cell's where it is open (air, a fluid, ice, or its decor already), by the same marks; a bed cell's stays
		// as the tiles wrote it (the shell's cell, never cleared))
		LongOpenHashSet own = b.decor.length > 0 ? b.ownSet() : null;
		for (long p : b.decor) {
			if (!own.contains(p) || !inChunk(p, cx, cz)) {
				continue;
			}
			int idx = w.index(p);
			FluidProv.Mark m = marks.get(idx);
			BlockState now = w.get(p);
			BlockState to = parse(b.decorState.get(p));
			boolean ours = ownStillOurs(b, p, now);
			FluidProv.Cell c = FluidProv.read(m, openCell(b, p, now), ours);
			if (m == FluidProv.Mark.WROTE && !ours) {
				taken++;
			}
			if (c.write() && now != to) {
				if (!w.set(p, to)) {
					refused++; // (fix round, P1-2) a hold refused it: no mark, no receipt; the W holds and runs again
					continue;
				}
				marks.put(idx, FluidProv.Mark.WROTE);
				changed = true;
				written++;
				java.util.Set<Long> wt = writeTrace;
				if (wt != null) {
					wt.add(p);
				}
			}
		}
		if (changed) {
			w.putMarks(cx, cz, rec, marks);
		}
		if (refused > 0) {
			throw new IllegalStateException("chunk " + cx + "," + cz + ": " + refused + " cell(s) of body " + b.id + " refused the write (a hold): the place waits");
		}
		// ((6c HY-c, §8.3) the grate's bars joined to each other and to the shell, as vanilla's own neighbour update would join them:
		// unjoined bars are posts 2/16 wide with gaps of 14/16, which a 0.6-wide mob passes (HY-c's probe). Still no update sent.)
		for (long p : b.grate) {
			if (!inChunk(p, cx, cz)) {
				continue;
			}
			BlockState now = w.get(p);
			if (!now.is(Blocks.IRON_BARS)) continue;
			BlockState joined = w.joined(p, now);
			if (joined != now && joined.is(Blocks.IRON_BARS)) {
				w.set(p, joined);
			}
		}
		return new int[] {written, taken};
	}

	/** (fix round, P2-5) The block a body writes in its own cell {@code p}: its decor's, bars, ice, a bubble column, else its fluid's. */
	static Block expectedBlock(Body b, long p) {
		String d = b.decorState.get(p);
		if (d != null) {
			return parse(d).getBlock();
		}
		if (b.grate.length > 0 && b.gratePos(p)) {
			return Blocks.IRON_BARS;
		}
		if (b.ice.length > 0 && b.iceSet().contains(p)) {
			return Blocks.ICE;
		}
		if (b.bubble.containsKey(p)) {
			return Blocks.BUBBLE_COLUMN;
		}
		return b.lava ? Blocks.LAVA : Blocks.WATER;
	}

	/**
	 * (fix round, P1-3) 8cT's write of one body's cells in chunk {@code (cx, cz)}, for an entry planned before T5F only: every open cell
	 * (air, the body's own, ice) is written except a charged cell {@code journaled} says the record's tiles wrote, then 8cT's decor pass and
	 * grate joining pass; no marks (the record is adopted after). Returns the cells written.
	 */
	static int writeBodyV1(FluidWorld w, Body b, int cx, int cz, java.util.function.LongPredicate journaled) {
		int written = 0;
		LongOpenHashSet grate = new LongOpenHashSet(b.grate);
		LongOpenHashSet ice = new LongOpenHashSet(b.ice);
		BlockState src = (b.lava ? Blocks.LAVA : Blocks.WATER).defaultBlockState();
		BlockState bars = parse(GRATE);
		for (long p : b.cells) {
			if (b.decorState.containsKey(p) || !inChunk(p, cx, cz) || journaled.test(p)) {
				continue;
			}
			BlockState now = w.get(p);
			BlockState to = ice.contains(p) ? Blocks.ICE.defaultBlockState() : grate.contains(p) ? bars : b.bubble.containsKey(p) ? bubbleState(b.bubble.get(p)) : src;
			boolean open = !now.hasBlockEntity() && (now.isAir() || ownStillOurs(b, p, now) || (now.is(Blocks.ICE) || now.is(Blocks.FROSTED_ICE)));
			if (open && now != to && w.set(p, to)) {
				written++;
			}
		}
		// (round 2, P2-d) 8cT's decor pass: a body cell's decor where it is open (a bed cell's stays as the tiles wrote it)
		LongOpenHashSet own = b.decor.length > 0 ? b.ownSet() : null;
		for (long p : b.decor) {
			if (!own.contains(p) || !inChunk(p, cx, cz)) {
				continue;
			}
			BlockState now = w.get(p);
			BlockState to = parse(b.decorState.get(p));
			if (openCell(b, p, now) && now != to) {
				w.set(p, to);
			}
		}
		// (round 2, P2-d) 8cT's grate joining pass: the bars joined to each other and to the shell, no update sent
		for (long p : b.grate) {
			if (!inChunk(p, cx, cz)) {
				continue;
			}
			BlockState now = w.get(p);
			if (!now.is(Blocks.IRON_BARS)) {
				continue;
			}
			BlockState joined = w.joined(p, now);
			if (joined != now && joined.is(Blocks.IRON_BARS)) {
				w.set(p, joined);
			}
		}
		return written;
	}

	/**
	 * (slice T5F, §4.2 {@code fluid.clear}) A waiting water body's cells in chunk {@code (cx, cz)} that R wrote and still holds back to their
	 * before states ({@code WROTE -> CLEARED}), so the body is written again at its wave; a cell already taken keeps {@code WROTE} (a
	 * player's harvest is never laundered into "the stage cleared it"). Lava and grate bodies are never cleared. Fluid neighbours in this
	 * chunk get a tick (water that isn't the body's settles back). Returns the cells written.
	 */
	static int clearBody(FluidWorld w, Body b, BodyState bs, String rec, int cx, int cz) {
		if (b.lava || b.grate.length > 0) {
			return 0;
		}
		var marks = w.marks(cx, cz, rec);
		boolean changed = false;
		int n = 0, refused = 0;
		Fluid src = b.source();
		it.unimi.dsi.fastutil.longs.LongArrayList written = new it.unimi.dsi.fastutil.longs.LongArrayList();
		for (long p : b.cells) {
			if (!inChunk(p, cx, cz)) {
				continue;
			}
			int idx = w.index(p);
			if (marks.get(idx) != FluidProv.Mark.WROTE) {
				continue;
			}
			BlockState now = w.get(p);
			if (!ownStillOurs(b, p, now) || !bodyWrote(b, p, now, src, false) || w.playerPlaced(p)) {
				continue; // taken (or a player's source there): WROTE stays
			}
			String before = bs.before.get(p);
			BlockState to = before == null ? Blocks.AIR.defaultBlockState() : parse(before);
			if (now != to) {
				if (!w.set(p, to)) {
					refused++; // (fix round, P1-2) the water still stands: it stays WROTE; the W holds and runs again
					continue;
				}
				written.add(p);
				n++;
			}
			marks.put(idx, FluidProv.Mark.CLEARED);
			changed = true;
		}
		if (changed) {
			w.putMarks(cx, cz, rec, marks);
		}
		LongOpenHashSet done = new LongOpenHashSet();
		for (int i = 0; i < written.size(); i++) {
			for (net.minecraft.core.Direction d : net.minecraft.core.Direction.values()) {
				long q = BlockPos.offset(written.getLong(i), d);
				if (!inChunk(q, cx, cz) || !done.add(q)) {
					continue; // (I6) a tick only in this W's own chunk
				}
				FluidState f = w.get(q).getFluidState();
				if (!f.isEmpty()) {
					w.tick(q, f.getType());
				}
			}
		}
		if (refused > 0) {
			// (round 2, P2-e) after the accepted cells' neighbour ticks: a retry skips them (CLEARED), so their wakeups are never owed
			throw new IllegalStateException("chunk " + cx + "," + cz + ": " + refused + " cell(s) of body " + b.id + " refused the clear (a hold): the clear waits");
		}
		return n;
	}

	/**
	 * One fluid tick on every source of a body and every face neighbour that is no body cell (§3.2), restricted to chunk {@code (cx, cz)}
	 * (slice T5F, I6: the {@code fluid.force} W of that chunk; {@link #forceChunks} plans one per chunk receiving a tick). (7a LF) A bubble
	 * cell gets a block tick instead (BubbleColumnBlock.tick keeps the column over its base, or turns it back to water). Returns the ticks.
	 */
	static int forceBodyIn(FluidWorld w, Body b, int cx, int cz) {
		java.util.List<String> ft = forceTrace;
		if (ft != null) {
			ft.add(b.id + "@" + w.gameTime()); // (T5Fa TEST) dev.fluid.forceTrace
		}
		int n = 0;
		LongOpenHashSet own = b.ownSet();
		Fluid f = b.source();
		for (long p : b.cells) {
			if (inChunk(p, cx, cz)) {
				if (b.bubble.containsKey(p)) {
					w.blockTick(p, Blocks.BUBBLE_COLUMN);
				} else {
					w.tick(p, f);
				}
				n++;
			}
			for (net.minecraft.core.Direction d : net.minecraft.core.Direction.values()) {
				long q = BlockPos.offset(p, d);
				if (!own.contains(q) && inChunk(q, cx, cz)) {
					w.tick(q, f);
					n++;
				}
			}
		}
		return n;
	}

	/**
	 * (slice T5F, §3.2) The tile hook: a fluids-stage tile ({@code region|stage|set|key}) marks each body cell it writes {@code WROTE(R)} where
	 * the cell then holds what the body wrote, in the same call as the block. Any other tile marks nothing.
	 */
	public interface TileMarker {
		void mark(ServerLevel level, long p);

		/** (fix round, the PLACING harvest) Whether the tile must not write cell {@code p}: R wrote it and it was taken since. */
		default boolean skip(ServerLevel level, long p) {
			return false;
		}
	}

	static final TileMarker NO_MARKS = (level, p) -> {
	};

	/**
	 * (slice T5F fix round, the PLACING harvest) A fluids tile's write of a body cell that R marked WROTE and that no longer holds R's own
	 * (harvested while the tile was PLACING, then a saved crash and the tile's retry): never written again (I2), refunded 0. Pure.
	 */
	static boolean tileSkips(Body b, long p, FluidProv.@Nullable Mark m, BlockState now) {
		return m == FluidProv.Mark.WROTE && !ownDelivered(b, p, now); // (round 2, P1-b) flow at a WROTE cell is never promoted to a source
	}

	/**
	 * The tile's marker: {@link #NO_MARKS} for a tile of another stage or a record with no bodies; null while the tile's region is not loaded
	 * (the tile waits: a cell is never written without its mark).
	 */
	public static @Nullable TileMarker tileMarker(String tile) {
		String[] t = tile.split("\\|", -1);
		if (t.length < 2 || !STAGE.equals(Revisions.plainStage(t[1]))) {
			return NO_MARKS;
		}
		RegionsImpl.Live l0 = RegionsImpl.live(t[0]);
		RegionsImpl.Live l = l0 == null ? null : Revisions.liveFor(l0, t[1]);
		Regional st = l == null ? null : of(l);
		if (l0 == null) {
			return null; // (the region's record not loaded yet: the tile waits; RegionsImpl loads every record at the start)
		}
		if (st == null) {
			// (of() loads the record on demand: null means the region (or revision) has no fluid bodies, so no cell to mark; a revision whose
			// live record is gone has no record to refund either)
			return NO_MARKS;
		}
		String rec = FluidTxns.recKey(l);
		return new TileMarker() {
			@Override
			public void mark(ServerLevel level, long p) {
				Body b = st.bodyAt(p);
				if (b != null && ownStillOurs(b, p, level.getBlockState(BlockPos.of(p)))) {
					FluidProv.set(level, p, rec, FluidProv.Mark.WROTE);
				}
			}

			@Override
			public boolean skip(ServerLevel level, long p) {
				Body b = st.bodyAt(p);
				return b != null && tileSkips(b, p, FluidProv.get(level, p, rec), level.getBlockState(BlockPos.of(p)));
			}
		};
	}

	/**
	 * (slice T5F, §3.2) The record whose marks a rollback of item {@code itemKey} of batch {@code batchId} clears with its writes: R when the
	 * item is a tile of R's fluids stage, else null.
	 */
	public static FluidProv.@Nullable Scope provScopeOf(@Nullable String batchId, @Nullable String itemKey) {
		QBatch b = batchId == null ? null : Batches.get(batchId);
		if (b == null || itemKey == null || !RegionItems.isRegion(b)) {
			return null;
		}
		QItem it = b.items.stream().filter(i -> itemKey.equals(i.key)).findFirst().orElse(null);
		if (it == null || it.stage == null || !STAGE.equals(Revisions.plainStage(it.stage))) {
			return null;
		}
		RegionsImpl.Live l0 = RegionsImpl.live(b.ext.get(RegionItems.EXT_REGION).getAsString());
		RegionsImpl.Live l = l0 == null ? null : Revisions.liveFor(l0, it.stage);
		Regional st = l == null ? null : of(l);
		if (st == null) {
			return null;
		}
		return scopeOf(FluidTxns.recKey(l), st);
	}

	/** (fix round 2) R's rollback scope: whether a cell's state before a rollback write is R's own delivery. */
	static FluidProv.Scope scopeOf(String rec, Regional st) {
		return new FluidProv.Scope(rec, (p, prev) -> {
			Body body = st.bodyAt(p);
			return body != null && ownDelivered(body, p, prev); // (round 2, P1-b) residual flow is not R's delivery: WROTE stays
		});
	}

	/** A body's census now (§3.3): what differs from the prediction, and where fluid escaped. */
	record Census(boolean ticking, List<long[]> mismatch, List<long[]> escaped, int fluidCells) {
	}

	static Census census(ServerLevel level, Body b, Long2ObjectOpenHashMap<String> fluidBefore) {
		return census(level, b, fluidBefore, new LongOpenHashSet());
	}

	static Census census(ServerLevel level, Body b, Long2ObjectOpenHashMap<String> fluidBefore, LongOpenHashSet others) {
		return census(level, b, fluidBefore, others, null);
	}

	/** {@link #census} over {@code only} of the watch set's cells (all of them when null). */
	static Census census(ServerLevel level, Body b, Long2ObjectOpenHashMap<String> fluidBefore, LongOpenHashSet others, long @Nullable [] only) {
		Fluid src = b.source();
		LongOpenHashSet own = new LongOpenHashSet(b.cells);
		LongOpenHashSet ice = new LongOpenHashSet(b.ice);
		LongOpenHashSet declared = b.declared();
		boolean ticking = false;
		List<long[]> mismatch = new ArrayList<>();
		List<long[]> escaped = new ArrayList<>();
		int fluidCells = 0;
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		for (long p : only != null ? only : b.watchSet().toLongArray()) {
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

	/** (8c fix round, P2-11) Whether any fluid tick is scheduled (or any cell unloaded) in a body's watch set: the removal wait's read, no census. */
	static boolean tickingIn(ServerLevel level, Body b) {
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		for (long p : b.watchSet()) {
			m.set(p);
			if (!level.isLoaded(m) || level.getFluidTicks().hasScheduledTick(m, Fluids.WATER) || level.getFluidTicks().hasScheduledTick(m, Fluids.FLOWING_WATER) || level
				.getFluidTicks().hasScheduledTick(m, Fluids.LAVA) || level.getFluidTicks().hasScheduledTick(m, Fluids.FLOWING_LAVA)) {
				return true;
			}
		}
		return false;
	}

	/** (8c fix round, P2-11) Watched cells a river's census reads a census tick at most. */
	static final int CENSUS_BUDGET = 32768;

	/**
	 * (8c fix round, P2-11) A flowing body's census in slices: at most {@link #CENSUS_BUDGET} watched cells per call (its watch set sorted),
	 * the findings carried over; null until a whole sweep is done, then the sweep's census (a body is judged settled only on a whole
	 * clean sweep). A body under the budget sweeps in one call, as {@link #census} does.
	 */
	static @Nullable Census censusStep(ServerLevel level, Body b, BodyState bs, Long2ObjectOpenHashMap<String> fluidBefore, LongOpenHashSet others) {
		if (b.watchSorted == null) {
			b.watchSorted = b.watchSet().toLongArray();
			java.util.Arrays.sort(b.watchSorted);
		}
		long[] all = b.watchSorted;
		if (all.length <= CENSUS_BUDGET) {
			return census(level, b, fluidBefore, others);
		}
		int from = bs.censusAt, to = Math.min(all.length, from + CENSUS_BUDGET);
		Census part = census(level, b, fluidBefore, others, java.util.Arrays.copyOfRange(all, from, to));
		bs.censusAcc = bs.censusAcc == null ? part : new Census(bs.censusAcc.ticking() || part.ticking(), concat(bs.censusAcc.mismatch(), part.mismatch()), concat(bs.censusAcc
			.escaped(), part.escaped()), bs.censusAcc.fluidCells() + part.fluidCells());
		bs.censusAt = to >= all.length ? 0 : to;
		if (to < all.length) {
			return null;
		}
		Census whole = bs.censusAcc;
		bs.censusAcc = null;
		return whole;
	}

	private static List<long[]> concat(List<long[]> a, List<long[]> b) {
		List<long[]> o = new ArrayList<>(a);
		o.addAll(b);
		return o;
	}

	static void settle(ServerLevel level, RegionsImpl.Live l, Regional st) {
		boolean changed = false;
		long now = level.getGameTime();
		for (Body b : st.bodies) {
			BodyState bs = st.states.get(b.id);
			if (!"written".equals(bs.state)) {
				continue;
			}
			Census c = b.flowing() && st.flowingRegion() ? censusStep(level, b, bs, st.fluidBefore, st.othersOf(b)) : census(level, b, st.fluidBefore, st.othersOf(b));
			if (c == null) {
				continue; // ((8c fix round, P2-11) a river's census spans census ticks: judged once a whole sweep is done)
			}
			long t0 = settleBase(FluidWorld.of(level), st, b, bs);
			if (!c.escaped().isEmpty()) {
				// (8cTc, E) the escape drain is a txn: drained (W), the record saved (R; FLe), the barrier; a start replays it
				FluidTxns.Step g = FluidTxns.escape(l, st, b, "escaped", "escaped", c.escaped());
				changed = true;
				if (g.kind() != FluidTxns.Step.Kind.DONE) {
					break; // (one drain txn at a time; the census goes on once it is done)
				}
			} else if (!c.ticking() && c.mismatch().isEmpty()) {
				bs.state = "settled";
				bs.settledAt = now - t0;
				changed = true;
				Architect.LOGGER.info("Region {}: fluid body {} settled in {} ticks (bound {})", l.rec().id, b.id, bs.settledAt, b.settleTicks);
			} else if (now - t0 > 2L * b.settleTicks) {
				boolean foreign = b.flowing() && foreignIn(level, b, st);
				// (8c WU, Steward's S-8c-2) a typed why: water not ours in the watch set, else the model drifted; (8cTc, E) drained in a txn
				FluidTxns.Step g = FluidTxns.escape(l, st, b, "unsettled", foreign ? "foreign_water" : "census_drift", c.mismatch());
				changed = true;
				if (g.kind() != FluidTxns.Step.Kind.DONE) {
					break;
				}
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
		escape(level, l, st, b, bs, why, at, true);
	}

	/**
	 * (8cT last round) The escape's writes ({@code writes}: the drain txn's W) and its outcome on the record (always: the R rebuilds it after
	 * a start that found the W's receipts). (#3) The whole upstream closure is drained whatever its saved state: a replay after a crash
	 * drains an upstream reach the record already called drained but whose drain the chunks lost.
	 */
	static void escape(ServerLevel level, RegionsImpl.Live l, Regional st, Body b, BodyState bs, String why, List<long[]> at, boolean writes) {
		// (6c HY, §3.3) the upstream closure first, in the same tick, upstream first: a reach above would pour into this one's emptied cells
		for (Body u : upstreamOf(st, b)) {
			BodyState us = st.states.get(u.id);
			boolean was = "drained".equals(us.state);
			int un = 0;
			if (writes && !us.before.isEmpty()) {
				un = st.flowingRegion() && u.flowing() && !"pending".equals(us.state) && !was ? abortFlowing(level, st, u, us) : drain(level, st, u, us,
					!"pending".equals(us.state), st.othersOf(u));
			}
			if (was) {
				continue; // (its outcome stands: an earlier drain's reason)
			}
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
		int n = !writes ? 0 : st.flowingRegion() && b.flowing() && !"drained".equals(bs.state) ? abortFlowing(level, st, b, bs) : drain(level, st, b, bs, true, st
			.othersOf(b)); // ((8c fix round, P1-2))
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

		/** (slice DF round 3) Whether a player placed what the cell holds (its {@code Placed} record). */
		default boolean playerPlaced(BlockPos p) {
			return false;
		}
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

			@Override
			public boolean playerPlaced(BlockPos p) {
				return dev.larattalabs.architect.placed.Placed.record(level, p) != null;
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
		it.unimi.dsi.fastutil.longs.LongArrayList written = new it.unimi.dsi.fastutil.longs.LongArrayList();
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
				// ((6c HY) a grate cell goes back too, whether its bars still hold the water or not; (8c fix round) only a cell that still holds
				// what the body wrote, by both readings (8c's still-ours and DF round 2's exact state): a player's waterlogged chest is never replaced)
				if (!ownStillOurs(b, p, now) || !bodyWrote(b, p, now, src, grate.contains(p)) || t.playerPlaced(bp)) {
					continue; // ((DF round 3, P1 5) a source a player placed there (its Placed record) is theirs)
				}
				if (held.test(p)) {
					continue; // (fix/drain-holders) another entry's block on top: handed down by the undo, not drained
				}
				String before = bs.before.get(p);
				BlockState to = before == null ? Blocks.AIR.defaultBlockState() : parse(before);
				if (now != to) {
					t.set(bp, to, Block.UPDATE_CLIENTS | Block.UPDATE_SKIP_ALL_SIDEEFFECTS);
					written.add(p);
					n++;
				}
			}
		}
		for (long[] a : new long[][] {b.spill, b.watch}) {
			for (long p : a) {
				BlockPos bp = BlockPos.of(p);
				BlockState now = t.get(bp);
				// ((8c fix round; DF round 2, P1 5) only the body's flow: a source (a player's bucket), a waterlogged block or another fluid is kept;
				// (DF round 3) nor a player's placed source, nor a level the body does not predict there)
				if (!flowStillOurs(b, now) || !ownFluid(now, src) || others.contains(p) || held.test(p) || t.playerPlaced(bp) || !predictedLevel(b, p, now)) {
					continue;
				}
				String before = bs.before.get(p);
				BlockState was = before == null ? Blocks.AIR.defaultBlockState() : parse(before);
				if (now == was) {
					continue; // as it was before (a natural cell, its level included): not the body's doing
				}
				t.set(bp, was, Block.UPDATE_CLIENTS | Block.UPDATE_SKIP_ALL_SIDEEFFECTS);
				written.add(p);
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
				if (flowStillOurs(b, now) && now.getBlock() instanceof LiquidBlock && now.getFluidState().getType().isSame(src) && !held.test(p) && !t
					.playerPlaced(bp)) { // ((8c fix round) never a source: a player's bucket in the predicted flow stays; (DF round 3) nor a placed
					// one. (8cTb, C) closed by flowStillOurs: a dispensed source is a source. The level is not judged here: a foreign source beside
					// the flow shifts the body's own levels, and that flow must still go (RegionFluidsLintTest strays/spout-and-bucket))
					// a cell another body recorded (its breached shell cell, its watched cell) goes back to that record, not to air: that body's
					// own drain, later in the removal, finds no fluid there any more
					String was = beforeAny(st, p);
					t.set(bp, was == null ? Blocks.AIR.defaultBlockState() : parse(was), Block.UPDATE_CLIENTS
						| Block.UPDATE_SKIP_ALL_SIDEEFFECTS);
					written.add(p);
					n++;
				}
			}
			// ((6c IRR) an irrigation source: its breach's flow over its own field too)
			if (breach != null) {
				n += sweepBreach(level, st, b, bs, breach, held);
			}
		}
		if (level != null && !written.isEmpty()) {
			tickAround(level, written); // ((8c fix round) water that isn't the body's settles back to its own level)
		}
		return n;
	}

	/**
	 * (8c fix round, the review's structural rule for P1-1, 2, 6) Whether one of a body's own cells (its sources, ice cap, grate, bubble and
	 * decor cells) still holds what its record wrote: its fluid as a liquid block (a source, or flowing once its feeders went), ice on an ice
	 * cell, the bars on a grate cell, the column on a bubble cell, the decor's block on a decor cell. Anything else (a player's waterlogged
	 * chest, stair or slab, a placed block) is not the body's: no drain, restore or abort writes it. Pure.
	 */
	static boolean ownStillOurs(Body b, long p, BlockState now) {
		boolean liquid = now.getBlock() instanceof LiquidBlock && now.getFluidState().getType().isSame(b.source());
		if (b.ice.length > 0 && b.iceSet().contains(p)) {
			return now.is(Blocks.ICE) || now.is(Blocks.FROSTED_ICE) || liquid;
		}
		if (b.grate.length > 0 && b.gratePos(p)) {
			return now.is(Blocks.IRON_BARS);
		}
		if (b.bubble.containsKey(p) && now.is(Blocks.BUBBLE_COLUMN)) {
			return true;
		}
		String d = b.decorState.get(p);
		if (d != null && now.getBlock() == parse(d).getBlock()) {
			return true;
		}
		return liquid;
	}

	/**
	 * (slice T5F fix round 2, P1-b) Whether one of a body's own cells holds what R delivered there: {@link #ownStillOurs}, except that a fluid
	 * cell must hold a source (flow into a harvested cell is residual flow, never the delivery). The rollback scope and the tile's skip read
	 * it, so a harvested source refilled by flow is neither rolled back as R's nor delivered again. Pure.
	 */
	static boolean ownDelivered(Body b, long p, BlockState now) {
		if (!ownStillOurs(b, p, now)) {
			return false;
		}
		boolean liquid = now.getBlock() instanceof LiquidBlock;
		return !liquid || now.getFluidState().isSource();
	}

	/**
	 * (8c fix round, the structural rule) Whether a cell outside a body's own cells may hold the body's flow: flowing (or falling) water of
	 * its fluid in a liquid block. A source there is never the body's (a player's bucket, a spring: a body writes sources only in its own
	 * cells), nor a waterlogged block. Pure.
	 */
	static boolean flowStillOurs(Body b, BlockState now) {
		return now.getBlock() instanceof LiquidBlock && now.getFluidState().getType().isSame(b.source()) && !now.getFluidState().isSource();
	}

	/**
	 * (8c fix round) After a drain wrote cells without updates: a fluid tick on every fluid face neighbour of a written cell, so water that
	 * isn't the body's (a lake, a player's source) settles back into its own level by vanilla's ticks (a raised cell goes to the foreign-only
	 * level; an own-only cell stays dry).
	 */
	/** (T5Fc, I6) While set (a per-chunk drain W's apply, server thread): the drains' ticks only where it accepts (its own chunk). */
	static java.util.function.@Nullable LongPredicate tickOnly;

	static void tickAround(ServerLevel level, it.unimi.dsi.fastutil.longs.LongArrayList written) {
		LongOpenHashSet done = new LongOpenHashSet();
		var only = tickOnly;
		for (int i = 0; i < written.size(); i++) {
			long p = written.getLong(i);
			for (net.minecraft.core.Direction d : net.minecraft.core.Direction.values()) {
				long q = BlockPos.offset(p, d);
				if (!done.add(q) || only != null && !only.test(q)) {
					continue;
				}
				BlockPos bp = BlockPos.of(q);
				FluidState f = level.getBlockState(bp).getFluidState();
				if (!f.isEmpty()) {
					level.scheduleTick(bp, f.getType(), 1);
				}
			}
		}
	}

	/**
	 * (8c fix round, P1-6) The level each cell of a stray take holds from water that isn't the body's alone (the foreign-only level), by a
	 * fixed point over the take: a cell under foreign (or foreign-lowered) water falls (amount 8); beside one, its amount less 1. Own cells
	 * (the body's sources, gone after the drain) feed nothing. Returns the amount per taken cell (0: dry, the cell goes to its before
	 * state). Pure over {@code at}.
	 */
	static Long2IntOpenHashMap foreignOnly(LongOpenHashSet take, LongOpenHashSet own, java.util.function.LongFunction<@Nullable Wet> at) {
		Long2IntOpenHashMap amt = new Long2IntOpenHashMap();
		// ((8c round 2, P1-4) an own cell feeds when it holds water the body didn't write (a player's waterlogged chest that ownStillOurs
		// keeps: a source, no liquid block); the body's own water (a liquid block there) never does)
		java.util.function.LongToIntFunction of = (q) -> {
			if (take.contains(q)) {
				return amt.get(q);
			}
			Wet w = at.apply(q);
			if (w == null) {
				return 0;
			}
			return own.contains(q) && w.liquid() ? 0 : w.amount();
		};
		net.minecraft.core.Direction[] side = {net.minecraft.core.Direction.NORTH, net.minecraft.core.Direction.SOUTH, net.minecraft.core.Direction.WEST,
			net.minecraft.core.Direction.EAST};
		// ((8c round 2, P1-4) a worklist to the real fixed point: amounts only rise, each at most to 8, so it ends within 8 x the take's
		// cells; a 48-high falling column converges as a 1-cell one)
		java.util.ArrayDeque<Long> work = new java.util.ArrayDeque<>();
		LongOpenHashSet queued = new LongOpenHashSet();
		for (long c : take) {
			work.add(c);
			queued.add(c);
		}
		long bound = 8L * take.size() + 16;
		while (!work.isEmpty() && bound-- > 0) {
			long c = work.poll();
			queued.remove(c);
			int best = of.applyAsInt(BlockPos.offset(c, net.minecraft.core.Direction.UP)) > 0 ? 8 : 0;
			for (net.minecraft.core.Direction d : side) {
				best = Math.max(best, of.applyAsInt(BlockPos.offset(c, d)) - 1);
			}
			if (best > amt.get(c)) {
				amt.put(c, best);
				for (net.minecraft.core.Direction d : net.minecraft.core.Direction.values()) {
					long q = BlockPos.offset(c, d);
					if (take.contains(q) && queued.add(q)) {
						work.add(q);
					}
				}
			}
		}
		return amt;
	}

	/** (8c fix round) A water (or lava) cell of an amount (1..8; 8 falling) as its liquid block state. */
	static BlockState flowingState(Fluid src, int amount) {
		Fluid fl = src.isSame(Fluids.LAVA) ? Fluids.FLOWING_LAVA : Fluids.FLOWING_WATER;
		return ((net.minecraft.world.level.material.FlowingFluid) fl).getFlowing(Math.min(8, amount), amount >= 8).createLegacyBlock();
	}

	/**
	 * (slice DF round 2, P1 5) Whether a body cell holds what the body wrote there: its fluid (a source or flow of it, a bubble column for
	 * water: a lift's), ice in an ice cell, iron bars in a grate cell, exactly its decor state in a decor cell. Anything else (a player's
	 * waterlogged stair, a block put there since) is not the body's and a drain leaves it.
	 */
	static boolean bodyWrote(Body b, long p, BlockState now, Fluid src, boolean grateCell) {
		if (ownFluid(now, src) && (now.getFluidState().isSource() || now.is(Blocks.BUBBLE_COLUMN))) {
			return true; // ((round 3) a source cell holds a source: flow there is the decay of the body's own, gone without it)
		}
		if ((now.is(Blocks.ICE) || now.is(Blocks.FROSTED_ICE)) && java.util.Arrays.stream(b.ice).anyMatch(x -> x == p)) {
			return true;
		}
		if (grateCell && now.is(Blocks.IRON_BARS)) {
			return true;
		}
		String d = b.decor.length > 0 ? b.decorState.get(p) : null;
		if (d == null || now.getFluidState().isEmpty()) {
			return false;
		}
		try {
			return now == parse(d);
		} catch (RuntimeException e) {
			return false;
		}
	}

	/** (slice DF round 3) A watched or spill cell's level is the one the body predicts there (any level where it predicts none). */
	static boolean predictedLevel(Body b, long p, BlockState now) {
		if (!b.predicted.containsKey(p) || !(now.getBlock() instanceof LiquidBlock)) {
			return true;
		}
		return now.getValue(LiquidBlock.LEVEL) == b.predicted.get(p);
	}

	/** (slice DF round 2) A cell holding the body's own fluid: a liquid block of it, or (water) a bubble column. */
	static boolean ownFluid(BlockState now, Fluid src) {
		if (now.getBlock() instanceof LiquidBlock) {
			return now.getFluidState().getType().isSame(src);
		}
		return src.isSame(Fluids.WATER) && now.is(Blocks.BUBBLE_COLUMN);
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
	/** (8cT last round, P2) Per group, why its last lot drain waits ({@code held(other) tx-<n>: chunk x,z}), else absent. */
	static final java.util.Map<String, String> LOT_WAIT = new java.util.concurrent.ConcurrentHashMap<>();

	/** (8cT last round, P2) A txn step's detail as {@code held(other) tx-<n>: <where>} (the caller's word: another txn holds it). */
	static String heldOther(@Nullable String detail) {
		if (detail == null) {
			return "held(other): the region's water record";
		}
		return detail.startsWith("held(decided) ") ? "held(other) " + detail.substring("held(decided) ".length()) : detail.startsWith("held(") ? detail
			: "held(other) " + detail;
	}

	/** (8cT last round, P2) The worded hold of a group's waiting lot drain, or null. */
	public static @Nullable String lotWait(@Nullable String group) {
		return group == null ? null : LOT_WAIT.get(group);
	}

	/** (slice DF round 2) {@link #drainLot}'s answer when its record could not be saved: the lot's site must not be restored now. */
	public static final int NOT_DURABLE = -2;

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
		if (!mayWrite(l, st)) {
			return NOT_DURABLE; // (round 2, P1 3) the record not on disk: nothing drained, the site not restored
		}
		// (8cTc, D) the lot's drain is a txn: its bodies drained (W, receipts; FL6d after the writes), then lotRemoved, lotDrained and the
		// drain txn saved (R), the barrier. A body lotRemoved without a drain txn (DF's or main's record, its drain maybe lost to a crash) is
		// drained again: the legacy lot conversion
		List<String> need = new ArrayList<>();
		for (Body b : st.bodies) {
			BodyState bs = st.states.get(b.id);
			if (ids.contains(b.id) && !(bs.lotRemoved && bs.drainTxn != null)) {
				need.add(b.id);
			}
		}
		if (need.isEmpty()) {
			// (8cT last round, P2) the flags are the R's: while the lot's txn is still open (its barrier refused, say), join it, never go on
			TxnEntry open = FluidTxns.open(FluidTxns.DRAIN, "fluid-drain:" + FluidTxns.recKey(l) + "/lot:" + lotId);
			if (open == null) {
				return 0;
			}
			FluidTxns.Step j = FluidTxns.after(open);
			if (j.kind() != FluidTxns.Step.Kind.DONE) {
				st.lastLotHeld = j.detail();
				LOT_WAIT.put(group, heldOther(j.detail()));
				return NOT_DURABLE;
			}
			return 0;
		}
		FluidTxns.Step g = FluidTxns.lot(l, st, lotId, need);
		if (g.kind() != FluidTxns.Step.Kind.DONE) {
			Architect.LOGGER.warn("Region {}: lot {}'s drain is not durable yet{}; its site waits", l.rec().id, lotId, g.detail() == null ? "" : " (" + g.detail()
				+ ")");
			st.lastLotHeld = g.detail(); // (8cT last round, P2) the typed answer the site removal gives
			LOT_WAIT.put(group, heldOther(g.detail()));
			return NOT_DURABLE;
		}
		LOT_WAIT.remove(group);
		report(l, st);
		int n = st.lastLotCells;
		Architect.LOGGER.info("Region {}: lot {} removed: its irrigation sources drained ({} cell(s) written)", l.rec().id, lotId, n);
		WorldJournal.kill("FL6"); // (6c IRR) the lot's sources drained, its site not restored yet
		return n;
	}

	/**
	 * (8cT last round, #5) The legacy lot conversion at load: every body recorded {@code lotRemoved} without a drain txn (a world from before
	 * 8cT, where the site's removal finished but its drain's chunks may not have) is drained again in its lot's txn, without waiting for a
	 * site removal that can no longer run. Once a session per record; a txn that waits is driven again by the core's tick.
	 */
	static void legacyLots(RegionsImpl.Live l, Regional st) {
		if (st.legacyLotsDone) {
			return;
		}
		java.util.Map<String, List<String>> byLot = new java.util.TreeMap<>();
		for (Body b : st.bodies) {
			BodyState bs = st.states.get(b.id);
			if (bs.lotRemoved && bs.drainTxn == null) {
				String lot = bs.reason != null && bs.reason.startsWith("lot removed: ") ? bs.reason.substring("lot removed: ".length()).split(" ")[0] : "legacy";
				byLot.computeIfAbsent(lot, k -> new ArrayList<>()).add(b.id);
			}
		}
		if (byLot.isEmpty()) {
			st.legacyLotsDone = true;
			return;
		}
		boolean all = true;
		for (var e : byLot.entrySet()) {
			FluidTxns.Step g = FluidTxns.lot(l, st, e.getKey(), e.getValue());
			all &= g.kind() == FluidTxns.Step.Kind.DONE;
			if (g.kind() == FluidTxns.Step.Kind.DONE) {
				report(l, st);
				Architect.LOGGER.info("Region {}: lot {} (removed before 8cT): its irrigation sources drained again at load", l.rec().id, e.getKey());
			}
		}
		st.legacyLotsDone = all;
	}

	/** (8cTc, D) The lot drain txn's writes: each of {@code ids} marked removed (never written again) and drained (its decor water too). */
	static int lotDrainWrites(ServerLevel level, RegionsImpl.Live l, Regional st, String lotId, List<String> ids) {
		int n = 0;
		Holders held = null;
		for (String id : ids) {
			Body b = st.body(id);
			BodyState bs = st.states.get(id);
			if (b == null || bs == null) {
				continue;
			}
			bs.state = "drained";
			bs.reason = "lot removed: " + lotId + " (its sources leave with it, S-IRR-4)";
			bs.lotRemoved = true; // in memory: the stage never writes it again; the R effect saves it
			bs.at.clear();
			if (!bs.before.isEmpty()) {
				if (held == null) {
					held = new Holders(l.rec().dimension, l.rec().groupId, st);
				}
				n += drain(level, st, b, bs, true, st.othersOf(b), held, false); // ((6c F3-c) a lot removed: its decor water goes too)
			}
		}
		st.lastLotCells = n;
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
		if (!RegionsImpl.mayDrive(l0)) {
			return false; // (slice DF round 2, P1 7) the region's record (REMOVING) not on disk: nothing drained or restored yet
		}
		// (6d RV, §6) the standing revisions' bodies first (top first), then the region's own: every body drains before any solid goes
		for (RegionsImpl.Live x : lives(l0)) {
			Regional st = of(x);
			if (st != null && !removalReady(x, st, () -> gateOne(s, x, st, group))) {
				return false;
			}
		}
		return true;
	}

	/** (slice DF round 2) Whether one record's removal drain is done, running its next step ({@code gateOne}) when it is not. */
	static boolean removalReady(RegionsImpl.Live x, Regional st, java.util.function.BooleanSupplier gateOne) {
		// (round 2, P1 2) a loaded done record is confirmed too: the solids are restored only on a record known on disk
		return mayWrite(x, st) && ("done".equals(st.removal) || gateOne.getAsBoolean());
	}

	/**
	 * (slice DF round 2) Whether a region batch's running stage may start an item now: the fluids stage's gate while it is approved; any
	 * other state or stage goes on.
	 */
	public static boolean stageMayRun(MinecraftServer s, QBatch b, @Nullable String stage, boolean approvedState) {
		RegionsImpl.Live l0 = RegionsImpl.live(b.ext.get(RegionItems.EXT_REGION).getAsString());
		if (l0 != null && stage != null && !RegionsImpl.mayDrive(l0)) {
			RegionItems.waitStage(b, stage, Reason.SITE_BUSY, "the region record is not durable: nothing is written until it is saved");
			return false; // (round 2, P1 7) the region's record not on disk: no item of its batch starts
		}
		RegionsImpl.Live l = l0 == null || stage == null ? null : Revisions.liveFor(l0, stage);
		if (l != null && stage != null && STAGE.equals(Revisions.plainStage(stage))) {
			Regional st = of(l);
			if (st != null && !mayWrite(l, st)) {
				waitNotDurable(b, stage, st);
				return false;
			}
		}
		return stageMayRun(l, stage, approvedState, () -> gate(s, b, stage));
	}

	/** {@link #stageMayRun(MinecraftServer, QBatch, String, boolean)}'s rule over a record ({@code l}: null when none resolves). */
	static boolean stageMayRun(RegionsImpl.@Nullable Live l, @Nullable String stage, boolean approvedState, java.util.function.BooleanSupplier gate) {
		// (round 2, P1 1) a PLACING fluids stage too (its gate ran before a stop): no item starts while its record is owed
		if (l != null && stage != null && STAGE.equals(Revisions.plainStage(stage))) {
			Regional st = of(l);
			if (st != null && !mayWrite(l, st)) {
				return false;
			}
		}
		return !approvedState || gate.getAsBoolean();
	}

	/**
	 * (slice DF round 2) The one check before a write to the world on this record's behalf, and after any save: true when the record is
	 * known on disk; an owed one is written again first (one try a second).
	 */
	static boolean mayWrite(RegionsImpl.Live l, Regional st) {
		return durable(l, st);
	}

	/**
	 * (slice DF round 2) Whether a running job of a region batch's item ({@code batchId}, {@code itemKey}) may write its cells now: a fluids
	 * stage tile waits while its record is not durable. Any other job goes on.
	 */
	public static boolean itemMayWrite(@Nullable String batchId, @Nullable String itemKey) {
		QBatch b = batchId == null ? null : Batches.get(batchId);
		if (b == null || itemKey == null || !RegionItems.isRegion(b)) {
			return true;
		}
		QItem it = b.items.stream().filter(i -> itemKey.equals(i.key)).findFirst().orElse(null);
		if (it == null || it.stage == null || !STAGE.equals(Revisions.plainStage(it.stage))) {
			return true;
		}
		RegionsImpl.Live l0 = RegionsImpl.live(b.ext.get(RegionItems.EXT_REGION).getAsString());
		if (l0 == null) {
			return true;
		}
		RegionsImpl.Live l = Revisions.liveFor(l0, it.stage);
		Regional st = of(l);
		return st == null || mayWrite(l, st); // (round 2, P1 1) a resumed fluids tile writes nothing while its record is owed
	}

	/** (slice DF round 2) After a recheck (which may have saved): whether the gate goes on. */
	static boolean afterRecheck(RegionsImpl.Live l, Regional st) {
		return mayWrite(l, st); // (round 2, P1 6) a recheck whose save failed stops the gate
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
			if (st != null && !removalReady(x, st, () -> gateOne(s, x, st, l.rec().groupId))) {
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
		if (needsDrain(l, st)) {
			// (8cTb, CONTRACT "Phase 8cT" §2.3) the drain is a txn: its intent (the scoop's amounts, the chunks, the bound) durable first, then
			// the scoop (L, keyed), the writes (W, a receipt per chunk), drained with a fresh bound (R), the barrier. A start finds it open and
			// replays it; a Remove asked again joins it (the same key)
			if (!drainStep(s, level, l, st, group, false)) {
				return false;
			}
			WorldJournal.kill("FL3"); // drained (its txn retired: the writes durable), before the solids
			return false;
		}
		if (!scoopStep(l, st)) {
			return false; // (T5Fc, §4.6) the scoop's own txn, after the drain's EFFECTS_DONE: drain, scoop, settle, solids
		}
		hold(level, st, true);
		int bound = st.bodies.stream().mapToInt(b -> b.settleTicks).max().orElse(0);
		long now = level.getGameTime();
		settleDeadline(FluidWorld.of(level), st, bound, now);
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
		// (round 2, P1 2) the drain's writes durable before the record says done (T0's world barrier: players, a flushed chunk save, the
		// ledger): a crash after done can never lose them and restore the solids round surviving sources. Refused: stays drained, again later
		long tb = System.nanoTime();
		if (st.barrierTriedAt != 0 && tb - st.barrierTriedAt < RETRY_NANOS) {
			return false; // (a refused barrier: one try a second)
		}
		st.barrierTriedAt = tb;
		var barrier = dev.larattalabs.architect.site.Stockpiles.barrier(s);
		if (!barrier.ok()) {
			Architect.LOGGER.warn("Region {}: the drain's writes are not durable yet ({}: {}); the solids wait", l.rec().id, barrier.outcome(), barrier.reason());
			return false;
		}
		st.barrierTriedAt = 0;
		st.removal = "done";
		freezeRows(l, st); // (T5Fc, 8cS Q1) the rows the tombstone keeps: the removal's final truth
		st.barrierDone = true;
		if (!save(l, st)) {
			st.barrierDone = false;
			st.removal = "drained"; // (slice DF) the solids wait until the record says done on disk
			st.owedTriedAt = System.nanoTime();
			return false;
		}
		hold(level, st, false);
		WorldJournal.kill("FL3x"); // (slice DF round 2) the removal's done record saved, the solids not restored yet
		Architect.LOGGER.info("Region {}: fluids drained and settled; the solids are restored next", l.rec().id);
		return true;
	}

	// ------------------------------------------------------------------ (8cTb) the removal's drain on the txn layer

	/**
	 * (8cTb) Whether the record's removal still needs its drain txn: not begun ({@code removal} null, or DF's {@code draining}), drained
	 * before 8cT ({@code drainTxn} null: a start drains it again, with a fresh bound: F), or its txn still open (drained written, the
	 * barrier not yet).
	 */
	static boolean needsDrain(RegionsImpl.Live l, Regional st) {
		if (st.removal == null || "draining".equals(st.removal)) {
			return true;
		}
		if (!"drained".equals(st.removal)) {
			return false;
		}
		return st.drainTxn == null || FluidTxns.openDrain(l) != null;
	}

	/**
	 * (T5Fc, §4.6, I5, N4) A survival record's scoop: its own {@code region.scoop} txn, begun once the drain txn is EFFECTS_DONE (its
	 * receipts durable), its amount summed from them. True when done, or nothing to scoop (creative; a drain from before T5Fc scooped in its txn).
	 */
	static boolean scoopStep(RegionsImpl.Live l, Regional st) {
		if (!l.rec().survival() || st.scooped != null || st.drainReceipts == null) {
			return true;
		}
		FluidTxns.Step g = FluidTxns.scoop(l, st);
		if (g.kind() == FluidTxns.Step.Kind.DONE) {
			return true;
		}
		if (g.detail() != null && !g.detail().equals(st.drainHeldAt)) {
			st.drainHeldAt = g.detail();
			Architect.LOGGER.warn("Region {}: the removal's scoop waits: {}", l.rec().id, g.detail());
		}
		return false;
	}

	/** (8cTb) Runs (or joins) the drain txn; true once it retired. While held, the view's {@code heldAt} and a revision's waiting say where. */
	static boolean drainStep(MinecraftServer s, ServerLevel level, RegionsImpl.Live l, Regional st, String group, boolean flowing) {
		FluidTxns.Step g = FluidTxns.removalDrain(s, level, l, st, group, flowing);
		if (g.kind() == FluidTxns.Step.Kind.DONE) {
			if (st.drainHeldAt != null) {
				st.drainHeldAt = null;
				Revisions.drainWaiting(l, null);
			}
			return true;
		}
		if (g.kind() == FluidTxns.Step.Kind.HELD || g.kind() == FluidTxns.Step.Kind.REFUSED) {
			String where = g.detail() == null ? null : g.detail().replaceFirst("^held\\((decided|other)\\) tx-[0-9]+: ", "");
			if (where != null && !where.equals(st.drainHeldAt)) {
				st.drainHeldAt = where;
				Revisions.drainWaiting(l, "the water drains first: " + g.detail());
				Architect.LOGGER.warn("Region {}: the removal's drain waits: {}", l.rec().id, g.detail());
			}
		}
		return false;
	}

	/**
	 * (8cTb, A's refund side, N2) What a survival record's removal scoops, planned once from the world before any drain write: per lava cell
	 * and grate cell of its bodies, {lava sources, grate bars}. A body that stands (it has befores): each cell still standing. A body the
	 * charge paid for ({@code chargedBodies}, its rid; N2: every lava and grate body of a record charged on main): a cell R never wrote
	 * (slice T5F, §3.3: no {@code WROTE} mark in its chunk) comes back too; a cell written and then taken (a player's bucket, broken bars:
	 * WROTE, not standing) is neither. The journal is never read.
	 */
	static int[] scoopPlan(ServerLevel level, RegionsImpl.Live l, Regional st, String group) {
		return scoopPlan(level, l, st, group, p -> true);
	}

	/** {@link #scoopPlan} over the cells {@code in} accepts (8cT last round, #2: one chunk's, saved with that chunk). */
	static int[] scoopPlan(ServerLevel level, RegionsImpl.Live l, Regional st, String group, java.util.function.LongPredicate in) {
		return scoopPlan(FluidWorld.of(level), l, st, group, in);
	}

	/** {@link #scoopPlan} through a {@link FluidWorld} (slice T5F fix round, P2-7: the units' world). */
	static int[] scoopPlan(FluidWorld w, RegionsImpl.Live l, Regional st, String group, java.util.function.LongPredicate in) {
		int[] s = scoopSplit(w, l, st, group, in);
		return new int[] {s[0] + s[2], s[1] + s[3]};
	}

	/**
	 * (T5Fc, §4.3's counts) {@link #scoopPlan} split: {standing lava, standing bars, never-delivered lava, never-delivered bars} over the
	 * cells {@code in} accepts (a drain W's: one body's cells in its chunk).
	 */
	static int[] scoopSplit(FluidWorld w, RegionsImpl.Live l, Regional st, String group, java.util.function.LongPredicate in) {
		java.util.Set<String> paid = new java.util.HashSet<>();
		int[] cap = null;
		if (l.rid() == chargedRid(l) && l.rec().survival.get(CHARGED_BODIES) instanceof JsonArray cb) {
			cb.forEach(x -> paid.add(x.getAsString())); // (fix round, P1-1) the explicit paid set, an empty one included
		} else if (l.rid() == 0 && FluidProv.mainEraPaid(l.rec().survival)) {
			// (N2; fix rounds 1-2, P1-1, P1-a; T5Fc (a)) charged on main, once per region at the gate, for the bodies still pending there (the
			// ones whose befores it captured): a body its check refused or held paid nothing; those bodies count as paid, and never-delivered cells are
			// refunded only within what the acknowledged charge took net of what was delivered (chargedAt alone is no evidence)
			cap = acknowledgedCharge(l);
			if (cap != null) {
				for (Body b : st.bodies) {
					BodyState bs = st.states.get(b.id);
					// (T5Fc (a)) the gate's durable evidence: it captured the befores of exactly the bodies it charged (pending, past its
					// check); a later recheck's uncontained or a later hold never takes that payment back
					if ((b.lava || b.grate.length > 0) && !bs.before.isEmpty()) {
						paid.add(b.id);
					}
				}
			}
		}
		String rec = FluidTxns.recKey(l);
		// (fix round, P1-4) a record not yet adopted (an old drain recovering before fluid.adopt can take the record) keeps 8cT's accounting:
		// a paid cell the record's tiles' ACTIVE journal entries never wrote, and no write txn wrote, is refunded
		FluidTxns.AdoptEvidence legacy = st.prov ? null : testLegacyJournal != null ? testLegacyJournal : new FluidTxns.TileEntries(l.rec().dimension, group,
			stageOf(l))::after;
		// (round 2, P1-a) a legacy charge's budget for never-delivered cells, per kind: charged less delivered (standing or taken), handed out
		// to the never-delivered cells in body and cell order, so a drain's per-chunk plans add up to the whole
		LongOpenHashSet lavaOk = null, barsOk = null;
		if (cap != null) {
			lavaOk = new LongOpenHashSet();
			barsOk = new LongOpenHashSet();
			int lavaLeft = cap[0], barsLeft = cap[1];
			List<Long> lavaNd = new ArrayList<>(), barsNd = new ArrayList<>();
			for (Body b : st.bodies) {
				if (!paid.contains(b.id)) {
					continue;
				}
				BodyState bs = st.states.get(b.id);
				if (b.lava) {
					for (long p : b.cells) {
						if (delivered(w, p, rec, legacy, bs, Blocks.LAVA)) {
							lavaLeft--;
						} else {
							lavaNd.add(p);
						}
					}
				}
				for (long p : b.grate) {
					if (delivered(w, p, rec, legacy, bs, Blocks.IRON_BARS)) {
						barsLeft--;
					} else {
						barsNd.add(p);
					}
				}
			}
			for (int i = 0; i < lavaNd.size() && i < lavaLeft; i++) {
				lavaOk.add((long) lavaNd.get(i));
			}
			for (int i = 0; i < barsNd.size() && i < barsLeft; i++) {
				barsOk.add((long) barsNd.get(i));
			}
		}
		int lava = 0, grates = 0, uLava = 0, uBars = 0;
		for (Body b : st.bodies) {
			BodyState bs = st.states.get(b.id);
			boolean ours = !bs.before.isEmpty();
			boolean charged = paid.contains(b.id);
			if (!ours && !charged) {
				continue;
			}
			if (b.lava) {
				for (long p : b.cells) {
					if (!in.test(p)) {
						continue;
					}
					FluidState f = w.get(p).getFluidState();
					if (f.isSource() && f.getType().isSame(Fluids.LAVA)) {
						lava++;
					} else if (charged && !delivered(w, p, rec, legacy, bs, Blocks.LAVA) && (lavaOk == null || lavaOk.contains(p))) {
						uLava++; // (slice T5F, §3.3) paid and never delivered (no mark): refunded; WROTE and taken: 0 (A)
					}
				}
			}
			for (long p : b.grate) {
				if (!in.test(p)) {
					continue;
				}
				if (w.get(p).is(Blocks.IRON_BARS)) {
					grates++;
				} else if (charged && !delivered(w, p, rec, legacy, bs, Blocks.IRON_BARS) && (barsOk == null || barsOk.contains(p))) {
					uBars++;
				}
			}
		}
		return new int[] {lava, grates, uLava, uBars};
	}

	/** (fix rounds) Whether R delivered a paid cell (standing or taken since): its WROTE mark, or, before adoption, 8cT's journal rule. */
	static boolean delivered(FluidWorld w, long p, String rec, FluidTxns.@Nullable AdoptEvidence legacy, BodyState bs,
		net.minecraft.world.level.block.Block block) {
		if (legacy == null) {
			return markOf(w, p, rec) == FluidProv.Mark.WROTE;
		}
		return bs.writeTxn != null || legacy.after(p) == block;
	}


	/** (fix round, P1-4, TEST) The legacy journal a unit reads; null: the world journal. */
	static volatile FluidTxns.@Nullable AdoptEvidence testLegacyJournal;

	/**
	 * (fix round, P1-1) What a main-era record's acknowledged fluids charge took, as {lava buckets, iron bars}: the record's settled
	 * {@code charged} items, else the ledger's keyed charge; null when neither shows one.
	 */
	static int @Nullable [] acknowledgedCharge(RegionsImpl.Live l) {
		Map<String, Integer> items = null;
		if (l.rec().survival.get("charged") instanceof JsonObject c) {
			items = new java.util.HashMap<>();
			for (var e : c.entrySet()) {
				items.put(e.getKey(), e.getValue().getAsInt());
			}
		} else {
			try {
				var pile = l.rec().owner == null ? null : dev.larattalabs.architect.site.Stockpiles.get(l.rec().owner);
				var ch = pile == null ? null : pile.ledger().charged(chargeKey(l));
				items = ch == null ? null : ch.items();
			} catch (RuntimeException e) {
				items = null;
			}
		}
		if (items == null) {
			return null;
		}
		return new int[] {items.getOrDefault("minecraft:lava_bucket", 0), items.getOrDefault("minecraft:iron_bars", 0)};
	}

	/** (slice T5F) R's mark on one cell of a fluid world. */
	static FluidProv.@Nullable Mark markOf(FluidWorld w, long p, String rec) {
		return w.marks(BlockPos.getX(p) >> 4, BlockPos.getZ(p) >> 4, rec).get(w.index(p));
	}

	/**
	 * (slice T5F fix round, P2-6) From when a written body's settle bound counts: its write (or the region's forced pass), and no earlier than
	 * the latest force W that scheduled its ticks this session (a recovery that redid a lost chunk's force W restarts the bound).
	 */
	static long settleBase(FluidWorld w, Regional st, Body b, BodyState bs) {
		if (!bs.forceScanned) {
			// (round 2, P2-c) once per session: the latest force W of the body's write txn, from its receipts (durable with their chunks; an
			// APPLIED probe's receipt included, so a second restart still counts from the replayed force)
			bs.forcedAt = Math.max(bs.forcedAt, lastForce(w, b, bs.writeTxn));
			bs.forceScanned = true;
		}
		return Math.max(bs.writtenAt >= 0 ? bs.writtenAt : st.forcedAt, bs.forcedAt);
	}

	/** (round 2, P2-c) The latest {@code t} of write txn {@code txn}'s force receipts for body {@code b} in its force chunks, else -1. */
	static long lastForce(FluidWorld w, Body b, @Nullable String txn) {
		if (txn == null) {
			return -1;
		}
		long t = -1;
		for (long ck : forceChunks(b)) {
			for (String r : w.receipts((int) (ck >> 32), (int) ck)) {
				if (!r.startsWith(txn + "/")) {
					continue;
				}
				int semi = r.indexOf(';');
				var f = semi < 0 ? null : dev.larattalabs.architect.txn.Receipts.fields(r, r.substring(0, semi));
				if (f != null && "force".equals(f.get("op")) && b.id.equals(f.get("b")) && f.get("t") != null) {
					t = Math.max(t, Long.parseLong(f.get("t")));
				}
			}
		}
		return t;
	}

	/**
	 * (slice T5F fix round, P1-1) The survival record charged: {@code chargedAt}, and {@code chargedBodies}, the bodies the charge paid for,
	 * always written, an empty set included (a gate whose every lava and grate body failed charges nothing). Each kept when present.
	 */
	static void markCharged(JsonObject survival, JsonArray bodies, long now) {
		if (!survival.has("chargedAt")) {
			survival.addProperty("chargedAt", now);
		}
		if (!survival.has(CHARGED_BODIES)) {
			survival.add(CHARGED_BODIES, bodies.deepCopy());
		}
	}

	/** (8cTb) A cell's chunk as {@code cx << 32 | cz} (unsigned low half). */
	static long chunkKey(long p) {
		return (long) (BlockPos.getX(p) >> 4) << 32 | (BlockPos.getZ(p) >> 4) & 0xffffffffL;
	}

	/**
	 * (T5Fc, §4.3, I6) The chunks body {@code b}'s removal drain writes or ticks in: its cells, ice, grates, spill, watch and predicted cells,
	 * its escaped cells, an irrigation lot's breach box, and each of those cells' face neighbours (a drain's tick there is that chunk's W).
	 */
	static long[] drainChunksOf(Regional st, Body b) {
		LongOpenHashSet c = new LongOpenHashSet();
		java.util.function.LongConsumer add = p -> {
			c.add(chunkKey(p));
			for (net.minecraft.core.Direction d : net.minecraft.core.Direction.values()) {
				c.add(chunkKey(BlockPos.offset(p, d)));
			}
		};
		for (long[] a : new long[][] {b.cells, b.ice, b.grate, b.spill, b.watch}) {
			for (long p : a) {
				add.accept(p);
			}
		}
		for (long p : b.predicted.keySet()) {
			add.accept(p);
		}
		for (long p : st.states.get(b.id).escapedCells) {
			add.accept(p);
		}
		int[] lot = st.irrigation.get(b.id);
		if (lot != null) {
			for (int x = (lot[0] - BREACH_REACH - 1) >> 4; x <= (lot[2] + BREACH_REACH + 1) >> 4; x++) {
				for (int z = (lot[1] - BREACH_REACH - 1) >> 4; z <= (lot[3] + BREACH_REACH + 1) >> 4; z++) {
					c.add((long) x << 32 | z & 0xffffffffL);
				}
			}
		}
		long[] out = c.toLongArray();
		java.util.Arrays.sort(out);
		return out;
	}

	/** (T5Fc) A drain target over a fluid world; {@code refused} counts the writes the world refused (a hold). */
	static DrainTarget drainTarget(FluidWorld w, int[] refused) {
		return new DrainTarget() {
			@Override
			public BlockState get(BlockPos p) {
				return w.get(p.asLong());
			}

			@Override
			public void set(BlockPos p, BlockState s, int flags) {
				if (!w.set(p.asLong(), s)) {
					refused[0]++;
				}
			}

			@Override
			public boolean playerPlaced(BlockPos p) {
				return w.playerPlaced(p.asLong());
			}
		};
	}

	/**
	 * (T5Fc, §4.3) One removal drain W: body {@code b} in chunk {@code (cx, cz)}, in one apply: its cells classified by §3.3 and counted
	 * ({@code l}: our standing lava and bars, {@code u}: paid cells never delivered, {@code h}: WROTE cells found taken, as lava, bars and
	 * cells), its writes (sources, ice and bars where R's own stand, the spill, watch and stray cells by the ownership rules; a flowing
	 * region's sources only), R's marks of the body's cells in the chunk deleted, all in the same tick and chunk; the caller adds the receipt.
	 * A cell a hold refuses holds the W (no receipt). Returns the receipt's fields.
	 */
	static Map<String, Object> drainBodyChunk(FluidWorld w, @Nullable ServerLevel level, RegionsImpl.Live l, Regional st, Body b, int cx, int cz, String group,
		boolean flowing, java.util.function.LongPredicate held) {
		BodyState bs = st.states.get(b.id);
		String rec = FluidTxns.recKey(l);
		java.util.function.LongPredicate inB = p -> inChunk(p, cx, cz) && (b.ownSet().contains(p) || b.gratePos(p));
		int[] split = l.rec().survival() ? scoopSplit(w, l, st, group, inB) : new int[4];
		var marks = w.marks(cx, cz, rec);
		int hLava = 0, hBars = 0, hCells = 0;
		for (long p : b.cells) {
			if (!inChunk(p, cx, cz)) {
				continue;
			}
			if (marks.get(w.index(p)) == FluidProv.Mark.WROTE && !ownDelivered(b, p, w.get(p))) {
				hCells++;
				hLava += b.lava ? 1 : 0;
				hBars += b.gratePos(p) ? 1 : 0;
			}
		}
		int n = 0;
		int[] refused = {0};
		if (!bs.before.isEmpty()) {
			java.util.function.LongPredicate h2 = p -> held.test(p) || !inChunk(p, cx, cz);
			var was = tickOnly;
			tickOnly = q -> inChunk(q, cx, cz);
			try {
				if (flowing && level != null) {
					n = drainSources(level, b, bs, h2);
				} else {
					n = drain(drainTarget(w, refused), level, st, b, bs, true, new LongOpenHashSet(), h2, true);
				}
			} finally {
				tickOnly = was;
			}
		}
		if (refused[0] > 0) {
			throw new IllegalStateException("chunk " + cx + "," + cz + ": " + refused[0] + " cell(s) of body " + b.id + " refused the drain (a hold): the drain waits");
		}
		boolean changed = false;
		for (long p : b.cells) {
			if (inChunk(p, cx, cz) && marks.remove(w.index(p)) != null) {
				changed = true; // (§4.3) R's marks go with the drain, in the same tick and chunk
			}
		}
		if (changed) {
			w.putMarks(cx, cz, rec, marks);
		}
		Map<String, Object> f = new java.util.LinkedHashMap<>();
		f.put("b", b.id);
		f.put("l", split[0] + "," + split[1]);
		f.put("u", split[2] + "," + split[3]);
		f.put("h", hLava + "," + hBars + "," + hCells);
		f.put("n", n);
		return f;
	}

	/**
	 * (T5Fc, §4.4, F) The removal's settle deadline: the latest {@code t} over its drain's receipts plus the bound, never a stored value. A
	 * record drained before T5Fc (no receipt index) waits one bound from the first read this session. Cached in {@code until} (memory).
	 */
	static long settleDeadline(@Nullable FluidWorld w, Regional st, int bound, long now) {
		if (st.until >= 0) {
			return st.until;
		}
		long t = -1;
		if (st.drainReceipts != null && w != null) {
			for (JsonElement x : st.drainReceipts) {
				JsonArray a = x.getAsJsonArray();
				Map<String, String> f = FluidTxns.receiptOf(w, a.get(1).getAsInt(), a.get(2).getAsInt(), a.get(0).getAsString());
				if (f != null && f.get("t") != null) {
					t = Math.max(t, Long.parseLong(f.get("t")));
				}
			}
		}
		st.until = (t >= 0 ? t : now) + bound;
		return st.until;
	}

	/**
	 * (slice T5Fc, S3 (a)-(c), S4/Q2) A region's fluids removal for its result, read from its records on disk (a REMOVED region keeps them):
	 * {refund: what its scoops' ledger credits returned, taken: {lava bucket: taken lava cells, iron bars: taken grate cells}, takenCells:
	 * every taken written cell}; a stage's ({@code stage}) only for that record's fluids stage. Null: nothing to report.
	 */
	public static @Nullable JsonObject removalExtras(MinecraftServer s, String group, @Nullable String stage) {
		RegionRec rr = RegionsImpl.regionOfGroup(group);
		if (rr == null) {
			return null;
		}
		String id = rr.id;
		String file;
		java.util.Set<String> undone = new java.util.HashSet<>();
		for (Revisions.Rev rv : rr.revisions) {
			if ("UNDONE".equals(rv.state)) {
				undone.add("fluids-rv" + rv.rid + ".json"); // (an undo reported its own fluids already)
			}
		}
		if (stage == null) {
			file = null; // every record of the region still standing at the removal
		} else if (STAGE.equals(Revisions.plainStage(stage))) {
			file = stage.equals(STAGE) ? "fluids.json" : "fluids-" + stage.substring(0, stage.indexOf(':')) + ".json";
		} else {
			return null;
		}
		return extrasIn(RegionStore.region(s.getWorldPath(net.minecraft.world.level.storage.LevelResource.ROOT), id), file, undone, id);
	}

	/** (slice T5Fc) {@link #removalExtras} over a region's directory: {@code file} one record, null every one but {@code undone}'s. */
	static @Nullable JsonObject extrasIn(Path dir, @Nullable String file, java.util.Set<String> undone, String id) {
		JsonObject refund = new JsonObject();
		int[] taken = new int[3];
		boolean any = false;
		try (var files = Files.isDirectory(dir) ? Files.list(dir) : java.util.stream.Stream.<Path>empty()) {
			for (Path f : files.toList()) {
				String n = f.getFileName().toString();
				if (!(file == null ? n.startsWith("fluids") && n.endsWith(".json") && !undone.contains(n) : n.equals(file))) {
					continue;
				}
				JsonObject o = RegionStore.readJson(f);
				if (o.get("scoopCredited") instanceof JsonObject sc) {
					any = true;
					sc.entrySet().forEach(e -> {
						if (!"planned".equals(e.getKey())) {
							refund.addProperty(e.getKey(), (refund.has(e.getKey()) ? refund.get(e.getKey()).getAsInt() : 0) + e.getValue().getAsInt());
						}
					});
				}
				if (o.get("taken") instanceof JsonArray tk && tk.size() == 3) {
					any = true;
					for (int i = 0; i < 3; i++) {
						taken[i] += tk.get(i).getAsInt();
					}
				}
			}
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("Region {}: its fluids records could not be read for the removal's result ({})", id, e.toString());
			return null;
		}
		if (!any) {
			return null;
		}
		JsonObject out = new JsonObject();
		out.add("refund", refund);
		JsonObject tk = new JsonObject();
		if (taken[0] > 0) {
			tk.addProperty("minecraft:lava_bucket", taken[0]);
		}
		if (taken[1] > 0) {
			tk.addProperty("minecraft:iron_bars", taken[1]);
		}
		out.add("taken", tk);
		out.addProperty("takenCells", taken[2]);
		return out;
	}

	/**
	 * (T5Fc, 8cS Q1) A region removal's done: every body of the record reads its final state (drained, "removed with its region" where its
	 * placement state stood), and the rows are reported into the record's ext, which the tombstone keeps (removed.json) for as long as it is
	 * readable. A revision's undo leaves its region's rows to the region.
	 */
	static void freezeRows(RegionsImpl.Live l, Regional st) {
		if (l.rec().state != dev.larattalabs.architect.api.RegionState.REMOVING) {
			return;
		}
		for (Body b : st.bodies) {
			BodyState bs = st.states.get(b.id);
			if (!"drained".equals(bs.state)) {
				bs.state = "drained";
				bs.reason = "removed with its region";
			}
		}
		report(l, st);
	}

	/** (T5Fc, §4.5) At most this many chunks per fluid.stray txn. */
	static final int STRAY_CHUNKS_PER_TXN = 8;

	/**
	 * (T5Fc, §4.5) One fluid.stray W: the stray pass's work in chunk {@code (cx, cz)} (the take judged over the whole flow as it stands, W5,
	 * read only; the writes and ticks in this chunk), each cell back to its before state (or the foreign water's own level) where the body's
	 * flow still stands (I8). Returns the cells written.
	 */
	static int strayChunk(ServerLevel level, Regional st, int cx, int cz, java.util.function.LongPredicate held) {
		java.util.function.LongFunction<@Nullable Wet> at = k -> {
			BlockState bs = level.getBlockState(BlockPos.of(k));
			FluidState f = bs.getFluidState();
			return f.isEmpty() || !f.getType().isSame(Fluids.WATER) ? null : new Wet(f.getAmount(), f.isSource(), bs.getBlock() instanceof LiquidBlock);
		};
		long[][] work = strayWork(st, strayTake(st, at, p -> true), at);
		it.unimi.dsi.fastutil.longs.LongArrayList written = new it.unimi.dsi.fastutil.longs.LongArrayList();
		for (long[] c : work) {
			long p = c[0];
			if (!inChunk(p, cx, cz)) {
				continue;
			}
			Body b = st.order.get((int) c[1]);
			BlockPos bp = BlockPos.of(p);
			BlockState now = level.getBlockState(bp);
			if (held.test(p) || !flowStillOurs(b, now)) {
				continue;
			}
			BlockState to;
			if (c[2] > 0) {
				to = flowingState(b.source(), (int) c[2]);
			} else {
				String was = st.states.get(b.id).before.get(p);
				if (was == null) {
					was = beforeAny(st, p);
				}
				to = was == null ? Blocks.AIR.defaultBlockState() : parse(was);
			}
			if (now != to && dev.larattalabs.architect.placed.Placed.set(level, bp, to, Block.UPDATE_CLIENTS | Block.UPDATE_SKIP_ALL_SIDEEFFECTS)) {
				written.add(p);
			}
		}
		var was = tickOnly;
		tickOnly = q -> inChunk(q, cx, cz);
		try {
			tickAround(level, written);
		} finally {
			tickOnly = was;
		}
		st.strayDone += written.size();
		return written.size();
	}

	/** (8cTb) Every chunk a removal's drain may write: the bodies' cells, ice, grates, spill, watch and predicted cells, escaped cells. */
	static long[] drainChunks(Regional st) {
		LongOpenHashSet c = new LongOpenHashSet();
		for (Body b : st.bodies) {
			for (long[] a : new long[][] {b.cells, b.ice, b.grate, b.spill, b.watch}) {
				for (long p : a) {
					c.add(chunkKey(p));
				}
			}
			for (long p : b.predicted.keySet()) {
				c.add(chunkKey(p));
			}
			for (long p : st.states.get(b.id).escapedCells) {
				c.add(chunkKey(p));
			}
			int[] lot = st.irrigation.get(b.id);
			if (lot != null) {
				// (8cTb review P1-6) the breach sweep's search box: the lot grown by BREACH_REACH (sweepBreach's own)
				for (int x = (lot[0] - BREACH_REACH) >> 4; x <= (lot[2] + BREACH_REACH) >> 4; x++) {
					for (int z = (lot[1] - BREACH_REACH) >> 4; z <= (lot[3] + BREACH_REACH) >> 4; z++) {
						c.add((long) x << 32 | z & 0xffffffffL);
					}
				}
			}
		}
		long[] out = c.toLongArray();
		java.util.Arrays.sort(out);
		return out;
	}

	/**
	 * (8cTb) The drain txn's W effect: the record's removal writes (idempotent: every write goes through the ownership rules, a drained cell
	 * is at its before state). An H region: every written body, the exact reverse of the write order (FL5 after an ordered head), the stray
	 * pass with it; a flowing region: its sources only (the flow dies; the stray pass follows the wait). Returns the cells written.
	 */
	static int removalDrainWrites(ServerLevel level, RegionsImpl.Live l, Regional st, String group, boolean flowing) {
		Holders held = new Holders(l.rec().dimension, group, st);
		int bound = st.bodies.stream().mapToInt(b -> b.settleTicks).max().orElse(0);
		if (flowing) {
			int n = drainSourcesAll(level, st, held, true);
			Architect.LOGGER.info("Region {}: removal drained {} source cell(s) of its flowing water; the flow dies for up to {} ticks before the stray pass", l.rec()
				.id, n, bound);
			return n;
		}
		int n = 0;
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
		Architect.LOGGER.info("Region {}: removal drained {} fluid cell(s); the solids wait one settle bound ({} ticks){}", l.rec().id, n, bound, held.kept()
			.isEmpty() ? "" : "; " + held.kept().size() + " cell(s) another entry holds on top kept for the undo's hand-down: " + cells(held.keptCells()));
		return n;
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
		if (needsDrain(l, st)) {
			// (8cTb) the sources' drain as a txn (as an H region's, §2.3): intent, scoop, writes, drained with a fresh bound, barrier
			if (!drainStep(s, level, l, st, group, true)) {
				return false;
			}
			hold(level, st, true);
			report(l, st);
			WorldJournal.kill("FL8"); // (8c CR) the sources drained and the flow dying, before the stray pass
			return false;
		}
		if ("drained".equals(st.removal) && !scoopStep(l, st)) {
			return false; // (T5Fc, §4.6) drain, scoop, settle, stray, solids
		}
		if ("drained".equals(st.removal)) {
			hold(level, st, true);
			long now = level.getGameTime();
			settleDeadline(FluidWorld.of(level), st, bound, now);
			boolean ticking = false;
			if (now >= st.until) {
				if (now - st.lastCensus < CENSUS_EVERY) {
					return false; // ((8c fix round, P2-11) the wait reads its watch sets every CENSUS_EVERY ticks, not every tick)
				}
				st.lastCensus = now;
				for (Body b : st.bodies) {
					if (tickingIn(level, b)) {
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
			st.strayChunks = watchChunks(st); // ((8c round 2, P1-2) every chunk the bodies watch, durable before the first stray write)
			if (!save(l, st)) {
				st.removal = "drained";
				st.strayChunks = null;
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
			// (T5Fc, §4.5) the stray pass as fluid.stray txns of at most 8 chunks (a W per chunk, receipted; the R saves the chunks left):
			// one txn a tick; done follows the world barrier below, once no chunk is left
			hold(level, st, true);
			if (st.strayChunks == null) {
				st.strayChunks = watchChunks(st);
			}
			if (!strayReady(st, k -> level.getChunkSource().hasChunk(ChunkPos.getX(k), ChunkPos.getZ(k)))) {
				return false; // (the ticket loads them: the pass waits, never seeds from loaded chunks only)
			}
			if (!st.strayChunks.isEmpty()) {
				long[] left = st.strayChunks.toLongArray();
				java.util.Arrays.sort(left);
				List<Long> next = new ArrayList<>();
				for (int i = 0; i < left.length && i < STRAY_CHUNKS_PER_TXN; i++) {
					next.add(left[i]);
				}
				FluidTxns.Step g = FluidTxns.stray(l, st, group, next);
				if (g.kind() != FluidTxns.Step.Kind.DONE && g.detail() != null) {
					Architect.LOGGER.warn("Region {}: the stray pass waits: {}", l.rec().id, g.detail());
				}
				return false; // (the pass goes on next tick)
			}
			int n = st.strayDone;
			// ((8c fix round, P1-4) `done` is recorded only once the drain's chunks are durable: the T0 barrier (players, chunks forced, the
			// ledger), tried at most once a second; a start before it finds `restoring` and drains and restores again)
			long t = System.nanoTime();
			if (st.barrierTriedAt != 0 && t - st.barrierTriedAt < RETRY_NANOS) {
				return false;
			}
			st.barrierTriedAt = t;
			dev.larattalabs.architect.site.DurableBarrier.Result br = barrier.apply(s);
			if (!br.ok()) {
				Architect.LOGGER.warn("Region {}: the river's drain waits for the world barrier ({}: {})", l.rec().id, br.outcome(), br.reason());
				return false;
			}
			st.removal = "done";
			freezeRows(l, st); // (T5Fc, 8cS Q1)
			st.barrierDone = true; // (merge with DF round 3) done saved after the barrier: trusted at a start
			if (!save(l, st)) {
				st.removal = "restoring";
				st.barrierDone = false;
				return false;
			}
			hold(level, st, false);
			report(l, st);
			Architect.LOGGER.info("Region {}: the stray pass restored {} watched cell(s); the solids are restored next", l.rec().id, n);
			WorldJournal.kill("FL3"); // the fluids drained and restored, before the solids
			WorldJournal.kill("FL3x"); // (DF round 2's point, a river's too) done saved after the world barrier, the solids not restored yet
			return true;
		}
		return true;
	}

	/** (8c fix round, P1-3) The charged items standing in a record's written bodies: {lava sources, grate bars}, any body kind. Pure over {@code get}. */
	static int[] standingCharged(Regional st, java.util.function.LongFunction<BlockState> get) {
		int lava = 0, grates = 0;
		for (Body b : st.bodies) {
			BodyState bs = st.states.get(b.id);
			if (bs.before.isEmpty()) {
				continue;
			}
			if (b.lava) {
				for (long p : b.cells) {
					FluidState f = get.apply(p).getFluidState();
					if (f.isSource() && f.getType().isSame(Fluids.LAVA)) {
						lava++;
					}
				}
			}
			for (long p : b.grate) {
				if (get.apply(p).is(Blocks.IRON_BARS)) {
					grates++;
				}
			}
		}
		return new int[] {lava, grates};
	}

	/** (8c fix round, P1-4; TEST seam) The world barrier the river's removal waits for before it records done. */
	static java.util.function.Function<MinecraftServer, dev.larattalabs.architect.site.DurableBarrier.Result> barrier = dev.larattalabs.architect.site.Stockpiles::barrier;

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
		LongOpenHashSet own = b.ownSet();
		LongOpenHashSet tick = new LongOpenHashSet();
		for (long[] a : new long[][] {b.ice, b.cells}) {
			for (long p : a) {
				if (drainSkips(b, p)) {
					continue;
				}
				BlockPos bp = BlockPos.of(p);
				BlockState now = level.getBlockState(bp);
				if (held.test(p)) {
					continue; // (fix/drain-holders) another entry's block on top: handed down by the undo, not drained
				}
				if (!ownStillOurs(b, p, now)) {
					continue; // ((8c fix round, P1-1) a player's waterlogged chest in a source cell is never drained)
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
		var only = tickOnly;
		for (long q : tick) {
			if (only != null && !only.test(q)) {
				continue; // (T5Fc, I6) that chunk's own drain W ticks it
			}
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
		return strayTake(st, at, loaded, null);
	}

	/** (8c fix round) {@link #strayTake} over one body only ({@code only}), or every written body (null). */
	static java.util.List<long[]> strayTake(Regional st, java.util.function.LongFunction<@Nullable Wet> at, java.util.function.LongPredicate loaded, @Nullable Body only) {
		java.util.List<long[]> out = new ArrayList<>();
		LongOpenHashSet seen = new LongOpenHashSet();
		for (int i = st.order.size() - 1; i >= 0; i--) {
			Body b = st.order.get(i);
			BodyState bs = st.states.get(b.id);
			if (bs.before.isEmpty() || only != null && b != only) {
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

	/** (8c fix round, P2-11) Stray cells restored a tick at most (a cap-sized river's pass spans ticks). */
	static final int STRAY_BUDGET = 4096;

	/**
	 * (8c fix round, P1-6) The stray pass's work for the take: each cell with its body's order index and its target (the foreign-only
	 * amount, {@link #foreignOnly}; 0: its before state), sorted by chunk then position. Pure over {@code at}.
	 */
	static long[][] strayWork(Regional st, java.util.List<long[]> take, java.util.function.LongFunction<@Nullable Wet> at) {
		LongOpenHashSet set = new LongOpenHashSet();
		LongOpenHashSet own = new LongOpenHashSet();
		for (long[] c : take) {
			set.add(c[0]);
		}
		for (Body b : st.bodies) {
			own.addAll(b.ownSet());
		}
		Long2IntOpenHashMap lv = foreignOnly(set, own, at);
		long[][] out = new long[take.size()][];
		for (int i = 0; i < take.size(); i++) {
			out[i] = new long[] {take.get(i)[0], take.get(i)[1], lv.get(take.get(i)[0])};
		}
		return out;
	}

	/**
	 * (8c fix round, P2-11, P1-6) One tick of the stray pass: its work computed once (the world as it stands), then at most
	 * {@link #STRAY_BUDGET} cells written, chunk by chunk: a cell the foreign water alone reaches to its foreign-only level, any other to
	 * its before state, only where the body's flow still stands ({@link #flowStillOurs}); then a fluid tick round them. FL9 once the first
	 * chunk is done with more to come. Returns true when the pass is done.
	 */
	/** (8c round 2, P1-2) Every chunk of the record's bodies' watch sets (packed keys). */
	static LongOpenHashSet watchChunks(Regional st) {
		LongOpenHashSet out = new LongOpenHashSet();
		for (Body b : st.bodies) {
			for (long p : b.watchSet()) {
				out.add(ChunkPos.pack(BlockPos.getX(p) >> 4, BlockPos.getZ(p) >> 4));
			}
		}
		return out;
	}

	/** (8c round 2, P1-2) Whether every remaining stray chunk is loaded (the pass waits for the rest: never a seed lost to an unloaded one). Pure. */
	static boolean strayReady(Regional st, java.util.function.LongPredicate chunkLoaded) {
		if (st.strayChunks == null) {
			return true;
		}
		for (long k : st.strayChunks) {
			if (!chunkLoaded.test(k)) {
				return false;
			}
		}
		return true;
	}

	/** (8c round 2, P1-2) The work cells in the remaining chunks only (a resumed pass never redoes a finished chunk, never skips a left one). Pure. */
	static long[][] remainingWork(long[][] work, @Nullable LongOpenHashSet chunks) {
		if (chunks == null) {
			return work;
		}
		return java.util.Arrays.stream(work).filter(c -> chunks.contains(ChunkPos.pack(BlockPos.getX(c[0]) >> 4, BlockPos.getZ(c[0]) >> 4))).toArray(long[][]::new);
	}

	static boolean strayStep(ServerLevel level, RegionsImpl.Live l, Regional st, java.util.function.LongPredicate held) {
		java.util.function.LongFunction<@Nullable Wet> at = k -> {
			BlockState bs = level.getBlockState(BlockPos.of(k));
			FluidState f = bs.getFluidState();
			return f.isEmpty() || !f.getType().isSame(Fluids.WATER) ? null : new Wet(f.getAmount(), f.isSource(), bs.getBlock() instanceof LiquidBlock);
		};
		hold(level, st, true); // ((8c round 2, P1-2) a resumed pass re-tickets every watch set)
		if (st.strayChunks == null) {
			st.strayChunks = watchChunks(st); // (a record saved before round 2: every chunk)
		}
		if (!strayReady(st, k -> level.getChunkSource().hasChunk(ChunkPos.getX(k), ChunkPos.getZ(k)))) {
			return false; // (the ticket loads them: the pass waits, never seeds from loaded chunks only)
		}
		if (st.strayWork == null) {
			st.strayWork = remainingWork(strayWork(st, strayTake(st, at, p -> true), at), st.strayChunks);
			st.strayAt = 0;
		}
		long[][] w = st.strayWork;
		it.unimi.dsi.fastutil.longs.LongArrayList written = new it.unimi.dsi.fastutil.longs.LongArrayList();
		int budget = STRAY_BUDGET;
		long firstChunk = w.length == 0 ? 0 : ChunkPos.pack(BlockPos.getX(w[0][0]) >> 4, BlockPos.getZ(w[0][0]) >> 4);
		while (st.strayAt < w.length && budget-- > 0) {
			long[] c = w[st.strayAt++];
			long p = c[0];
			Body b = st.order.get((int) c[1]);
			BlockPos bp = BlockPos.of(p);
			BlockState now = level.getBlockState(bp);
			if (!held.test(p) && flowStillOurs(b, now)) {
				BlockState to;
				if (c[2] > 0) {
					to = flowingState(b.source(), (int) c[2]); // (raised: the foreign water's own level)
				} else {
					String was = st.states.get(b.id).before.get(p);
					if (was == null) {
						was = beforeAny(st, p);
					}
					to = was == null ? Blocks.AIR.defaultBlockState() : parse(was);
				}
				if (now != to) {
					dev.larattalabs.architect.placed.Placed.set(level, bp, to, Block.UPDATE_CLIENTS | Block.UPDATE_SKIP_ALL_SIDEEFFECTS);
					written.add(p);
					st.strayDone++;
				}
			}
			long ck = ChunkPos.pack(BlockPos.getX(p) >> 4, BlockPos.getZ(p) >> 4);
			boolean chunkEnds = st.strayAt >= w.length || ChunkPos.pack(BlockPos.getX(w[st.strayAt][0]) >> 4, BlockPos.getZ(w[st.strayAt][0]) >> 4) != ck;
			if (chunkEnds) {
				// ((8c round 2, P1-2) a finished chunk leaves the saved list: a start resumes with the chunks left)
				tickAround(level, written);
				written.clear();
				st.strayChunks.remove(ck); // (8cTb review P1-5) in memory only: the saved list keeps every chunk until done is saved after the barrier
				if (ck == firstChunk && st.strayAt < w.length) {
					WorldJournal.kill("FL9"); // (8c CR) the stray pass half done: one chunk's cells restored, the next not
				}
			}
		}
		if (!written.isEmpty()) {
			tickAround(level, written);
		}
		if (st.strayAt >= w.length) {
			if (w.length <= 1 && st.strayDone == 0) {
				WorldJournal.kill("FL9"); // (a pass with nothing to split still reaches its kill point once)
			}
			st.strayChunks.clear(); // (every chunk's work is done; chunks with none are done too); (P1-5) not saved: done follows the barrier
			return true;
		}
		return false;
	}

	/**
	 * (8c fix round, P1-2) A flowing body's abort (escaped, unsettled, upstream of one): the stray take judged first over the flow as it
	 * stands (its sources still feeding), then the sources back ({@link #drainSources}: only what still holds the body's water), then
	 * every taken cell to its foreign-only level or its before state, a tick round them. A player's source or waterlogged block is never
	 * written. Returns the cells written.
	 */
	static int abortFlowing(ServerLevel level, Regional st, Body b, BodyState bs) {
		java.util.function.LongFunction<@Nullable Wet> at = k -> {
			BlockState s0 = level.getBlockState(BlockPos.of(k));
			FluidState f = s0.getFluidState();
			return f.isEmpty() || !f.getType().isSame(b.source()) ? null : new Wet(f.getAmount(), f.isSource(), s0.getBlock() instanceof LiquidBlock);
		};
		long[][] w = strayWork(st, strayTake(st, at, p -> level.isLoaded(BlockPos.of(p)), b), at);
		int n = drainSources(level, b, bs, NOT_HELD);
		it.unimi.dsi.fastutil.longs.LongArrayList written = new it.unimi.dsi.fastutil.longs.LongArrayList();
		for (long[] c : w) {
			BlockPos bp = BlockPos.of(c[0]);
			BlockState now = level.getBlockState(bp);
			if (!flowStillOurs(b, now)) {
				continue;
			}
			String was = bs.before.get(c[0]);
			BlockState to = c[2] > 0 ? flowingState(b.source(), (int) c[2]) : was == null ? Blocks.AIR.defaultBlockState() : parse(was);
			if (now != to) {
				dev.larattalabs.architect.placed.Placed.set(level, bp, to, Block.UPDATE_CLIENTS | Block.UPDATE_SKIP_ALL_SIDEEFFECTS);
				written.add(c[0]);
				n++;
			}
		}
		tickAround(level, written);
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
			String phase = st.drainHeldAt != null ? "held" : st.removalPhase != null ? st.removalPhase : "restoring".equals(st.removal) ? "restoring" : "draining";
			return new dev.larattalabs.architect.api.FluidsRemoval(phase, st.until, st.until < 0 ? 0 : st.until - now, st.drainHeldAt); // (8cTb) heldAt
		}
		return null;
	}

	/**
	 * (slice T5F, DevBridge {@code dev.fluid.marks}) Per body, its own cells' fluid provenance now: {@code cells}, {@code wrote},
	 * {@code cleared}, and {@code standing} (cells holding what the body delivered: a fluid cell as a source), {@code wroteStanding} (both), {@code takenWrote} (WROTE, not
	 * standing).
	 */
	public static JsonObject marksJson(ServerLevel level, RegionsImpl.Live l) {
		Regional st = of(l);
		JsonObject o = new JsonObject();
		JsonArray bodies = new JsonArray();
		o.add("bodies", bodies);
		if (st == null) {
			return o;
		}
		o.addProperty("prov", st.prov);
		String rec = FluidTxns.recKey(l);
		o.addProperty("rec", rec);
		for (Body b : st.bodies) {
			int wrote = 0, cleared = 0, standing = 0, ws = 0, taken = 0;
			for (long ck : cellChunks(b)) {
				var marks = FluidProv.marks(level.getChunk((int) (ck >> 32), (int) ck), rec);
				for (long p : b.cells) {
					if (chunkKey(p) != ck) {
						continue;
					}
					FluidProv.Mark m = marks.get(FluidProv.index(level, p));
					boolean ours = ownDelivered(b, p, level.getBlockState(BlockPos.of(p))); // (a source: flow into a taken cell is not standing)
					wrote += m == FluidProv.Mark.WROTE ? 1 : 0;
					cleared += m == FluidProv.Mark.CLEARED ? 1 : 0;
					standing += ours ? 1 : 0;
					ws += ours && m == FluidProv.Mark.WROTE ? 1 : 0;
					taken += !ours && m == FluidProv.Mark.WROTE ? 1 : 0;
				}
			}
			JsonObject bo = new JsonObject();
			bo.addProperty("id", b.id);
			bo.addProperty("cells", b.cells.length);
			bo.addProperty("wrote", wrote);
			bo.addProperty("cleared", cleared);
			bo.addProperty("standing", standing);
			bo.addProperty("wroteStanding", ws);
			bo.addProperty("takenWrote", taken);
			bodies.add(bo);
		}
		return o;
	}

	/**
	 * (slice T5F, TEST DevBridge {@code dev.fluid.unprov}) Makes a record read as one saved before T5F: every mark of it in its bodies' chunks
	 * removed and the record saved without {@code prov}; the next tick (or write, or drain) adopts it ({@code fluid.adopt}).
	 */
	public static JsonObject unprovForTest(ServerLevel level, RegionsImpl.Live l) {
		Regional st = of(l);
		JsonObject o = new JsonObject();
		if (st == null) {
			o.addProperty("bodies", 0);
			return o;
		}
		String rec = FluidTxns.recKey(l);
		int n = 0;
		LongOpenHashSet chunks = new LongOpenHashSet();
		for (Body b : st.bodies) {
			for (long ck : cellChunks(b)) {
				chunks.add(ck);
			}
		}
		for (long ck : chunks) {
			net.minecraft.world.level.chunk.LevelChunk ch = level.getChunk((int) (ck >> 32), (int) ck);
			var marks = FluidProv.marks(ch, rec);
			n += marks.size();
			marks.clear();
			FluidProv.put(ch, rec, marks);
		}
		st.prov = false;
		o.addProperty("marksRemoved", n);
		o.addProperty("saved", save(l, st));
		return o;
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
		o.addProperty("prov", st.prov); // (slice T5F) false until a record built before T5F is adopted
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
		if (st.prov) {
			o.addProperty("prov", 1); // (slice T5F) its cells carry fluid provenance
		}
		o.addProperty("phase", st.phase);
		o.addProperty("forcedAt", st.forcedAt);
		if (st.removal != null) {
			o.addProperty("removal", st.removal);
		}
		if (st.barrierDone) {
			o.addProperty("barrierDone", true); // (round 3)
		}
		if (st.drainTxn != null) {
			o.addProperty("drainTxn", st.drainTxn); // (8cTb) the drain txn that wrote drained
		}
		if (st.drainReceipts != null) {
			o.add("drainReceipts", st.drainReceipts.deepCopy()); // (T5Fc) the scoop and the deadline read it (never a stored until)
		}
		if (st.taken != null) {
			JsonArray tk = new JsonArray();
			for (int v : st.taken) {
				tk.add(v);
			}
			o.add("taken", tk);
		}
		if (st.scooped != null) {
			o.addProperty("scooped", st.scooped);
		}
		if (st.scoopCredited != null) {
			o.add("scoopCredited", st.scoopCredited.deepCopy());
		}
		if (st.removalNote != null) {
			o.addProperty("removalNote", st.removalNote);
		}
		if (st.removalPhase != null) {
			o.addProperty("removalPhase", st.removalPhase); // (8cF)
		}
		if (st.strayChunks != null && "restoring".equals(st.removal)) {
			JsonArray sc = new JsonArray(); // ((8c round 2, P1-2) the stray pass's chunks still to restore)
			long[] ks = st.strayChunks.toLongArray();
			java.util.Arrays.sort(ks);
			for (long k : ks) {
				sc.add(k);
			}
			o.add("strayChunks", sc);
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
				b.addProperty("lotDrained", bs.lotDrained); // (round 2)
			}
			if (bs.writeTxn != null) {
				b.addProperty("writeTxn", bs.writeTxn); // (8cTc)
			}
			if (bs.drainTxn != null) {
				b.addProperty("drainTxn", bs.drainTxn); // (8cTc)
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
		RegionStore.Injection inj = RegionStore.injection(f);
		if (inj == RegionStore.Injection.REFUSED) {
			return new DurableFile.Result(DurableFile.Outcome.REFUSED, 0, "injected write failure of " + f.getFileName() + " (dev.region.failNextSave)");
		}
		DurableFile df = st.durable;
		if (df == null || !df.file().equals(f)) {
			st.durable = df = new DurableFile(STORE, f).compact(); // (round 2) one line: a river's record stays small
		}
		DurableFile.Result r = df.write(o, df.request());
		if (inj == RegionStore.Injection.IN_DOUBT && r.ok()) {
			return new DurableFile.Result(DurableFile.Outcome.IN_DOUBT, r.gen(), "injected in-doubt write of " + f.getFileName() + " (dev.region.failNextSave inDoubt)");
		}
		return r;
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
		DurableFile df = new DurableFile(STORE, f).compact();
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

	/** (slice DF) The fluids stage waits SITE_BUSY on its owed record; at its gate (nothing written yet) that is kill point FL1r. */
	static void waitNotDurable(QBatch b, String stage, Regional st) {
		RegionItems.waitStage(b, stage, Reason.SITE_BUSY, notDurable(st));
		if ("gate".equals(st.phase)) {
			WorldJournal.kill("FL1r"); // (slice DF) the record's save refused (again) at its gate, no source written
		}
	}

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
			st.prov = o.has("prov"); // (slice T5F, §4.7) a record saved before T5F has no marks: adopted first
			st.phase = RegionsImpl.str(o, "phase", "gate");
			st.forcedAt = o.has("forcedAt") ? o.get("forcedAt").getAsLong() : -1;
			st.removal = o.get("removal") instanceof JsonElement r && r.isJsonPrimitive() ? r.getAsString() : null;
			st.until = -1; // (T5Fc, F, §4.4) never read from disk: rebuilt from the drain's receipts (settleDeadline)
			st.drainReceipts = o.get("drainReceipts") instanceof JsonArray dr ? dr.deepCopy() : null;
			if (o.get("taken") instanceof JsonArray tk && tk.size() == 3) {
				st.taken = new int[] {tk.get(0).getAsInt(), tk.get(1).getAsInt(), tk.get(2).getAsInt()};
			}
			st.scooped = strOrNull(o, "scooped");
			st.scoopCredited = o.get("scoopCredited") instanceof JsonObject sc ? sc.deepCopy() : null;
			st.removalNote = o.get("removalNote") instanceof JsonElement rn && rn.isJsonPrimitive() ? rn.getAsString() : null;
			st.barrierDone = o.has("barrierDone") && o.get("barrierDone").getAsBoolean();
			st.drainTxn = strOrNull(o, "drainTxn"); // (8cTb)
			st.drainTxnOnDisk = st.drainTxn;
			if ("done".equals(st.removal) && !st.barrierDone) {
				// (round 3, P1 6) a done written before the barrier (its drain's writes maybe lost): recovered as drained (drained again through the
				// ownership check, the wait, the barrier, then done)
				st.removal = "drained";
				st.until = -1;
				st.drainTxn = null; // (8cTb) untrusted: drained again in a legacy txn, with a fresh bound (F)
				st.drainTxnOnDisk = null;
			}
			st.removalPhase = strOrNull(o, "removalPhase"); // (8cF)
			if (o.get("strayChunks") instanceof JsonArray sc) {
				st.strayChunks = new LongOpenHashSet();
				sc.forEach(e -> st.strayChunks.add(e.getAsLong()));
			}
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
					// (round 2) a record from before round 2 saved lotRemoved after its drain
					bs.lotDrained = b.has("lotDrained") ? b.get("lotDrained").getAsBoolean() : bs.lotRemoved;
					bs.writeTxn = strOrNull(b, "writeTxn"); // (8cTc)
					bs.drainTxn = strOrNull(b, "drainTxn"); // (8cTc) a lot's or an escape's drain txn; a lotRemoved without one is drained again (D)
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
			snapshotWatch(regionId, st); // ((8c fix round, P2-7))
			if (st != null) {
				hold(null, st, false);
			}
			// (6d RV) and its revisions' records
			for (String k : List.copyOf(STATE.keySet())) {
				if (k.startsWith(regionId + "#rv")) {
					snapshotWatch(k, STATE.get(k)); // ((8c round 2, P2-5) a revision's river too)
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

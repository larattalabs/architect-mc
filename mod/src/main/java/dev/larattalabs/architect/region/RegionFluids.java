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
 * </ul>
 * An H-only region has none of these members: its bodies are written by the tiles and forced together, in plan order, as before.
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

		boolean ended() {
			return "settled".equals(state) || "drained".equals(state);
		}
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
				out.add(b);
			}
		}
		return out;
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
		st.irrigation.putAll(irrigationLots(l.ir().json()));
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
				bs.uncontained = true;
				bs.reason = "uncontained: " + bad.size() + "+ shell or join cell(s) do not hold what the body was checked against";
				bs.at.addAll(bad.subList(0, Math.min(NAMED, bad.size())));
				Architect.LOGGER.info("Region {}: fluid body {} is not written ({}): {}", l.rec().id, body.id, bs.reason, cells(bs.at));
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
		st.phase = "writing";
		save(l, st);
		report(l, st);
		WorldJournal.kill("FL1"); // the check and the before states saved, no source written
		Architect.LOGGER.info("Region {}: fluids stage checked ({} bod{}, {} not written)", l.rec().id, st.bodies.size(), st.bodies.size() == 1 ? "y" : "ies", st
			.states.values().stream().filter(x -> "drained".equals(x.state)).count());
		return true;
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
		LongOpenHashSet grate = new LongOpenHashSet(body.grate);
		for (long[] a : new long[][] {body.cells, body.ice}) {
			for (long p : a) {
				BlockState now = level.getBlockState(BlockPos.of(p));
				if (!(now.isAir() || now.is(Blocks.WATER) || now.is(Blocks.LAVA) || now.is(Blocks.ICE) || now.is(Blocks.FROSTED_ICE) || grate.contains(p) && now.is(Blocks.IRON_BARS))) {
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
			// not contained (or held, HY): never written; (6c IRR) nor a source whose lot was removed
			if ("drained".equals(bs.state) && (bs.uncontained || bs.held || bs.lotRemoved || bs.before.isEmpty())) {
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
			hold(level, st, "writing".equals(st.phase) || "settling".equals(st.phase));
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

	/** (6c HY) A body's sources, ice cap and grate written where the cell is open (air, a fluid, ice; a grate cell's bars), no update. */
	static void writeBody(ServerLevel level, Body b) {
		LongOpenHashSet grate = new LongOpenHashSet(b.grate);
		LongOpenHashSet ice = new LongOpenHashSet(b.ice);
		BlockState src = (b.lava ? Blocks.LAVA : Blocks.WATER).defaultBlockState();
		BlockState bars = parse(GRATE);
		for (long p : b.cells) {
			BlockPos bp = BlockPos.of(p);
			BlockState now = level.getBlockState(bp);
			BlockState to = ice.contains(p) ? Blocks.ICE.defaultBlockState() : grate.contains(p) ? bars : src;
			boolean open = now.isAir() || !now.getFluidState().isEmpty() || now.is(Blocks.ICE) || now.is(Blocks.FROSTED_ICE) || grate.contains(p) && now.is(Blocks.IRON_BARS);
			if (open && now != to) {
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

	/** One fluid tick on every source of a body and every face neighbour that is no body cell (§3.2); the ticks scheduled. */
	static int forceBody(ServerLevel level, Body b) {
		int n = 0;
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
				changed = true;
			} else if (!c.ticking() && c.mismatch().isEmpty()) {
				bs.state = "settled";
				bs.settledAt = now - t0;
				changed = true;
				Architect.LOGGER.info("Region {}: fluid body {} settled in {} ticks (bound {})", l.rec().id, b.id, bs.settledAt, b.settleTicks);
			} else if (now - t0 > 2L * b.settleTicks) {
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
		return drain(level, st, b, bs, strays, new LongOpenHashSet());
	}

	/** {@code others}: cells another standing body plans, left alone (the escape guard drains one body of several). */
	static int drain(ServerLevel level, Regional st, Body b, BodyState bs, boolean strays, LongOpenHashSet others) {
		int n = 0;
		Fluid src = b.source();
		LongOpenHashSet grate = new LongOpenHashSet(b.grate);
		for (long[] a : new long[][] {b.ice, b.cells}) {
			for (long p : a) {
				BlockPos bp = BlockPos.of(p);
				BlockState now = level.getBlockState(bp);
				// ((6c HY) a grate cell goes back too, whether its bars still hold the water or not)
				if (now.getFluidState().isEmpty() && !now.is(Blocks.ICE) && !now.is(Blocks.FROSTED_ICE) && !(grate.contains(p) && now.is(Blocks.IRON_BARS))) {
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
				if (now == was) {
					continue; // as it was before (a natural cell, its level included): not the body's doing
				}
				dev.larattalabs.architect.placed.Placed.set(level, bp, was, Block.UPDATE_CLIENTS | Block.UPDATE_SKIP_ALL_SIDEEFFECTS);
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
				BlockState now = level.getBlockState(bp);
				if (now.getBlock() instanceof LiquidBlock && now.getFluidState().getType().isSame(src)) {
					// a cell another body recorded (its breached shell cell, its watched cell) goes back to that record, not to air: that body's
					// own drain, later in the removal, finds no fluid there any more
					String was = beforeAny(st, p);
					dev.larattalabs.architect.placed.Placed.set(level, bp, was == null ? Blocks.AIR.defaultBlockState() : parse(was), Block.UPDATE_CLIENTS
						| Block.UPDATE_SKIP_ALL_SIDEEFFECTS);
					n++;
				}
			}
			// ((6c IRR) an irrigation source: its breach's flow over its own field too)
			int[] lot = st.irrigation.get(b.id);
			if (lot != null) {
				n += sweepBreach(level, st, b, bs, lot, others);
			}
		}
		return n;
	}

	/** (6c IRR) How far past its lot's box a breach's flow is followed (water runs 7 from its source, then falls). */
	static final int BREACH_REACH = 8;

	/**
	 * (6c IRR, S-IRR-3, S-IRR-4) An irrigation source's breach floods its own field: a player broke a farmland side, and the water ran
	 * over the field (a bare pad: up to 7 over it and past its edge). With {@code strays}, the drain follows the water connected to the
	 * body's cells, shell and watch (flowing, falling, or a source the flow made), within its lot's box grown by {@link #BREACH_REACH}
	 * and from 12 under its floor to 1 over it, and puts each cell back to the region's record (else air): no orphan water. Water that
	 * was there before the realise ({@code fluidBefore}) and another body's cells stay. Counted in {@link BodyState#breached}.
	 */
	static int sweepBreach(ServerLevel level, Regional st, Body b, BodyState bs, int[] lot, LongOpenHashSet others) {
		Fluid src = b.source();
		int x0 = lot[0] - BREACH_REACH, z0 = lot[1] - BREACH_REACH, x1 = lot[2] + BREACH_REACH, z1 = lot[3] + BREACH_REACH;
		int y0 = lot[4] - 12, y1 = lot[4] + 1;
		LongOpenHashSet seen = new LongOpenHashSet();
		java.util.ArrayDeque<Long> q = new java.util.ArrayDeque<>();
		for (long[] a : new long[][] {b.cells, b.shell, b.watch}) {
			for (long p : a) {
				if (seen.add(p)) {
					q.add(p);
				}
			}
		}
		LongOpenHashSet own = new LongOpenHashSet(b.cells);
		int n = 0;
		while (!q.isEmpty() && seen.size() < 65536) {
			long p = q.poll();
			BlockPos bp = BlockPos.of(p);
			for (net.minecraft.core.Direction d : net.minecraft.core.Direction.values()) {
				BlockPos np = bp.relative(d);
				long k = np.asLong();
				if (np.getX() < x0 || np.getX() > x1 || np.getZ() < z0 || np.getZ() > z1 || np.getY() < y0 || np.getY() > y1 || !seen.add(k)) {
					continue;
				}
				if (own.contains(k) || others.contains(k) || st.fluidBefore.containsKey(k)) {
					continue;
				}
				BlockState now = level.getBlockState(np);
				if (!(now.getBlock() instanceof LiquidBlock) || !now.getFluidState().getType().isSame(src)) {
					continue;
				}
				String was = beforeAny(st, k);
				dev.larattalabs.architect.placed.Placed.set(level, np, was == null ? Blocks.AIR.defaultBlockState() : parse(was), Block.UPDATE_CLIENTS
					| Block.UPDATE_SKIP_ALL_SIDEEFFECTS);
				n++;
				q.add(k);
			}
		}
		bs.breached += n;
		return n;
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
		Regional st = l == null ? null : of(l);
		return st != null && ("writing".equals(st.phase) || "settling".equals(st.phase)) && stageWritten(l);
	}

	/** Whether a body of the region was not written or was drained (the region ends PARTIAL, §2.4, §3.4). */
	public static boolean anyDrained(RegionsImpl.Live l) {
		Regional st = of(l);
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
		java.util.Set<String> ids = lotBodies(l.ir().json(), lotId);
		Regional st = ids.isEmpty() ? null : of(l);
		if (st == null) {
			return -1;
		}
		int n = 0;
		boolean changed = false;
		for (Body b : st.bodies) {
			if (!ids.contains(b.id)) {
				continue;
			}
			BodyState bs = st.states.get(b.id);
			if (bs.lotRemoved) {
				continue;
			}
			if (!bs.before.isEmpty()) {
				n += drain(level, st, b, bs, true, st.othersOf(b));
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
			Architect.LOGGER.info("Region {}: lot {} removed: its irrigation sources drained ({} cell(s) written)", l.rec().id, lotId, n);
			WorldJournal.kill("FL6"); // (6c IRR) the lot's sources drained, its site not restored yet
		}
		return n;
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
			// (6c HY, §4.1) the exact reverse of the write order (an H region: reverse plan order), the head first
			int drained = 0;
			for (int i = st.order.size() - 1; i >= 0; i--) {
				Body b = st.order.get(i);
				BodyState bs = st.states.get(b.id);
				if (bs.before.isEmpty()) {
					continue; // never written (not checked, or not contained): nothing of it stands
				}
				n += drain(level, st, b, bs, true);
				if (++drained == 1 && st.ordered && i > 0) {
					WorldJournal.kill("FL5"); // (6c HY) the head drained, the rest of the course not yet
				}
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
			for (int i = st.order.size() - 1; i >= 0; i--) {
				Body b = st.order.get(i);
				BodyState bs = st.states.get(b.id);
				if (!bs.before.isEmpty()) {
					n += drain(level, st, b, bs, true);
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
		hold(level, st, false);
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
			if (bs.breached > 0) {
				o.addProperty("breach", bs.breached); // (6c IRR, S-IRR-3) a breach's flow over its own field, taken back by a drain
			}
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
		o.addProperty("ordered", st.ordered); // (6c HY)
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
		if (st.removalNote != null) {
			o.addProperty("removalNote", st.removalNote);
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
			st.removalNote = o.get("removalNote") instanceof JsonElement rn && rn.isJsonPrimitive() ? rn.getAsString() : null;
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

package dev.larattalabs.architect.placed;

import dev.larattalabs.architect.api.ArchitectRefused;
import dev.larattalabs.architect.api.BlockHit;
import dev.larattalabs.architect.api.Build;
import dev.larattalabs.architect.api.BuildConsent;
import dev.larattalabs.architect.api.BuildHit;
import dev.larattalabs.architect.api.BuildKind;
import dev.larattalabs.architect.api.BuildState;
import dev.larattalabs.architect.api.Entrance;
import dev.larattalabs.architect.api.PlacedBox;
import dev.larattalabs.architect.api.PlacedBy;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.api.SiteEvents;
import dev.larattalabs.architect.journal.Sections;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * The public side of builds (docs/CONTRACT.md "Phase 6c slice PT" §6, §8, §9): views, box queries, consent, the named refusal's
 * build list, claim and release. Server thread.
 */
public final class BuildViews {
	private BuildViews() {
	}

	// ------------------------------------------------------------------ views

	static ResourceKey<Level> dimKey(String dim) {
		return ResourceKey.create(Registries.DIMENSION, Identifier.parse(dim));
	}

	public static Build view(Builds.Rec r) {
		List<Entrance> en = new ArrayList<>();
		for (Builds.Ent e : r.entrances) {
			en.add(new Entrance(BlockPos.of(e.pos()), e.facing(), e.block()));
		}
		return new Build(r.id, dimKey(r.dimension), r.box(), r.footprint, en, r.kind, r.confidence, r.cells, r.placers, r.state, r.revision,
			r.state == BuildState.ADOPTED ? r.siteId : null);
	}

	static void fire(Builds.Rec r, String what) {
		SiteEvents.BUILD_CHANGED.invoker().onChanged(view(r), what);
	}

	public static Optional<PlacedBy> placedBy(@Nullable ServerLevel level, BlockPos pos) {
		if (level == null) {
			return Optional.empty();
		}
		Placed.Rec r = Placed.record(level, pos);
		return r == null ? Optional.empty() : Optional.of(new PlacedBy(r.placer(), r.build()));
	}

	public static List<Build> builds(@Nullable ResourceKey<Level> dim, @Nullable BoundingBox within) {
		List<Build> out = new ArrayList<>();
		for (Builds.Rec r : Builds.list(dim == null ? null : dim.identifier().toString(), within)) {
			out.add(view(r));
		}
		return out;
	}

	public static Optional<Build> build(String id) {
		Builds.Rec r = Builds.rec(id);
		return r == null || r.gone ? Optional.empty() : Optional.of(view(r));
	}

	/** The tracked cells of a box (loaded chunks; touched sections only). */
	public static PlacedBox box(@Nullable ServerLevel level, BoundingBox box) {
		if (level == null) {
			return new PlacedBox(0, 0, Map.of(), List.of());
		}
		int tracked = 0;
		int incidental = 0;
		Map<UUID, Integer> by = new LinkedHashMap<>();
		Hits hits = new Hits();
		for (int cx = box.minX() >> 4; cx <= box.maxX() >> 4; cx++) {
			for (int cz = box.minZ() >> 4; cz <= box.maxZ() >> 4; cz++) {
				LevelChunk c = level.getChunkSource().getChunkNow(cx, cz);
				PlacedChunk pc = c == null ? null : c.getAttached(Placed.TYPE);
				if (pc == null) {
					continue;
				}
				for (int sy : pc.sectionYs()) {
					if ((sy << 4) + 15 < box.minY() || sy << 4 > box.maxY()) {
						continue;
					}
					int[] cells = pc.cells(sy);
					for (int i = 0; i < cells.length; i += 2) {
						int idx = cells[i];
						int x = (cx << 4) + (idx & 15);
						int y = (sy << 4) + (idx >> 8);
						int z = (cz << 4) + (idx >> 4 & 15);
						if (!box.isInside(x, y, z)) {
							continue;
						}
						int v = cells[i + 1];
						tracked++;
						by.merge(pc.placer(PlacedChunk.placerOf(v)), 1, Integer::sum);
						String b = pc.build(PlacedChunk.buildOf(v));
						String kept = b == null || !Placed.on() ? null : Builds.kept(b);
						if (kept == null) {
							incidental++;
						} else {
							hits.add(level, kept, x, y, z);
						}
					}
				}
			}
		}
		return new PlacedBox(tracked, incidental, by, hits.list());
	}

	/** The kept build cells of a box a write would take, but those {@code consent} names (tracked cells only: touched sections). */
	public static Hits scan(ServerLevel level, dev.larattalabs.architect.placement.Anchors.Bounds b, Placed.Consent consent) {
		return scan(level, new BoundingBox(b.minX(), b.minY(), b.minZ(), b.maxX(), b.maxY(), b.maxZ()), consent);
	}

	public static Hits scan(ServerLevel level, BoundingBox box, Placed.Consent consent) {
		Hits hits = new Hits();
		if (!Placed.on()) {
			return hits;
		}
		for (int cx = box.minX() >> 4; cx <= box.maxX() >> 4; cx++) {
			for (int cz = box.minZ() >> 4; cz <= box.maxZ() >> 4; cz++) {
				LevelChunk c = level.getChunkSource().getChunkNow(cx, cz);
				PlacedChunk pc = c == null ? null : c.getAttached(Placed.TYPE);
				if (pc == null) {
					continue;
				}
				for (int sy : pc.sectionYs()) {
					if ((sy << 4) + 15 < box.minY() || sy << 4 > box.maxY()) {
						continue;
					}
					int[] cells = pc.cells(sy);
					for (int i = 0; i < cells.length; i += 2) {
						int idx = cells[i];
						int x = (cx << 4) + (idx & 15);
						int y = (sy << 4) + (idx >> 8);
						int z = (cz << 4) + (idx >> 4 & 15);
						if (!box.isInside(x, y, z)) {
							continue;
						}
						String bd = pc.build(PlacedChunk.buildOf(cells[i + 1]));
						String kept = bd == null ? null : Builds.kept(bd);
						if (kept != null && !consent.allows(kept)) {
							hits.add(level, kept, x, y, z);
						}
					}
				}
			}
		}
		return hits;
	}

	// ------------------------------------------------------------------ the named refusal (C32 question 3)

	/** Builds in the way, collected cell by cell: per build its blocking count and first 8 cells with their block ids. */
	public static final class Hits {
		private final Map<String, int[]> count = new LinkedHashMap<>();
		private final Map<String, List<BlockHit>> first = new LinkedHashMap<>();

		public void add(Level level, String buildId, int x, int y, int z) {
			count.computeIfAbsent(buildId, k -> new int[1])[0]++;
			List<BlockHit> f = first.computeIfAbsent(buildId, k -> new ArrayList<>());
			if (f.size() < 8) {
				BlockPos p = new BlockPos(x, y, z);
				BlockState s = level.getBlockState(p);
				f.add(new BlockHit(p, BuiltInRegistries.BLOCK.getKey(s.getBlock()).toString()));
			}
		}

		public void add(Level level, String buildId, long pos) {
			add(level, buildId, BlockPos.getX(pos), BlockPos.getY(pos), BlockPos.getZ(pos));
		}

		public boolean isEmpty() {
			return count.isEmpty();
		}

		public int total() {
			int n = 0;
			for (int[] c : count.values()) {
				n += c[0];
			}
			return n;
		}

		/** The builds by id number, at most {@code max}. */
		public List<BuildHit> list(int max) {
			List<String> ids = new ArrayList<>(count.keySet());
			ids.sort(java.util.Comparator.comparingLong(Builds::idNumber));
			List<BuildHit> out = new ArrayList<>();
			for (String id : ids) {
				if (out.size() >= max) {
					break;
				}
				Builds.Rec r = Builds.rec(id);
				out.add(new BuildHit(id, r == null ? BuildKind.OTHER : r.kind, count.get(id)[0], first.get(id)));
			}
			return out;
		}

		public List<BuildHit> list() {
			return list(Integer.MAX_VALUE);
		}

		/** "the player's build build-12 (house, 41 blocks in the way: -120 64 33 minecraft:oak_log; ...; and 33 more)". */
		public String message() {
			return message(list());
		}

		public static String message(List<BuildHit> hits) {
			StringBuilder sb = new StringBuilder();
			for (BuildHit h : hits) {
				if (!sb.isEmpty()) {
					sb.append("; ");
				}
				sb.append("the player's build ").append(h.buildId()).append(" (").append(h.kind().name().toLowerCase(Locale.ROOT)).append(", ").append(h
					.blocking()).append(h.blocking() == 1 ? " block" : " blocks").append(" in the way: ");
				for (int i = 0; i < h.first().size(); i++) {
					BlockHit b = h.first().get(i);
					sb.append(i > 0 ? "; " : "").append(b.pos().getX()).append(' ').append(b.pos().getY()).append(' ').append(b.pos().getZ()).append(' ').append(
						b.blockId());
				}
				if (h.blocking() > h.first().size()) {
					sb.append("; and ").append(h.blocking() - h.first().size()).append(" more");
				}
				sb.append(')');
			}
			return sb.toString();
		}

		/** The refusal as the API throws it. */
		public ArchitectRefused refused(String prefix) {
			List<BuildHit> l = list();
			return new ArchitectRefused(Reason.PLAYER_BUILD, prefix + message(l), "", l);
		}
	}

	/**
	 * §7 "Region plan (kit)": the kept builds meeting a claim {minX, minY, minZ, maxX, maxY, maxZ} as keep-out rects
	 * {@code [x0, z0, x1, z1]}: each build's bounds grown by 1, and each entrance's apron (the 3 cells outside it).
	 */
	public static List<int[]> keepOut(String dimension, int[] claim) {
		List<int[]> out = new ArrayList<>();
		if (!Placed.on()) {
			return out;
		}
		BoundingBox c = new BoundingBox(claim[0] - 1, claim[1], claim[2] - 1, claim[3] + 1, claim[4], claim[5] + 1);
		for (Builds.Rec r : Builds.list(dimension, c)) {
			if (!r.kept()) {
				continue;
			}
			out.add(new int[] {r.bounds[0] - 1, r.bounds[2] - 1, r.bounds[3] + 1, r.bounds[5] + 1});
			for (Builds.Ent e : r.entrances) {
				BlockPos p = BlockPos.of(e.pos());
				net.minecraft.core.Direction f = e.facing();
				// a door faces into its room or out of it: the apron is on both sides of the opening
				for (net.minecraft.core.Direction d : new net.minecraft.core.Direction[] {f, f.getOpposite()}) {
					BlockPos a = p.relative(d, 1);
					BlockPos b = p.relative(d, 3);
					out.add(new int[] {Math.min(a.getX(), b.getX()), Math.min(a.getZ(), b.getZ()), Math.max(a.getX(), b.getX()), Math.max(a.getZ(), b.getZ())});
				}
			}
		}
		return out;
	}

	/**
	 * §10: the builds meeting a claim {minX, minY, minZ, maxX, maxY, maxZ} as the kit's plan helpers read them
	 * ({@code kit/lib/region/builds.mjs}: id, kind, state, cells, revision, bounds, footprint, entrances {pos, facing}); kept and
	 * released (the helpers skip released ones). For the plan check (P0's compiler) to answer feature.build and endpoint.build.
	 */
	public static com.google.gson.JsonArray planJson(String dimension, int[] claim) {
		com.google.gson.JsonArray out = new com.google.gson.JsonArray();
		BoundingBox c = new BoundingBox(claim[0], claim[1], claim[2], claim[3], claim[4], claim[5]);
		for (Builds.Rec r : Builds.list(dimension, c)) {
			com.google.gson.JsonObject o = new com.google.gson.JsonObject();
			o.addProperty("id", r.id);
			o.addProperty("kind", r.kind.name());
			o.addProperty("state", r.state.name());
			o.addProperty("cells", r.cells);
			o.addProperty("revision", r.revision);
			com.google.gson.JsonArray b = new com.google.gson.JsonArray();
			for (int v : r.bounds) {
				b.add(v);
			}
			o.add("bounds", b);
			com.google.gson.JsonArray f = new com.google.gson.JsonArray();
			for (int v : r.footprint) {
				f.add(v);
			}
			o.add("footprint", f);
			com.google.gson.JsonArray en = new com.google.gson.JsonArray();
			for (Builds.Ent e : r.entrances) {
				com.google.gson.JsonObject x = new com.google.gson.JsonObject();
				com.google.gson.JsonArray p = new com.google.gson.JsonArray();
				BlockPos bp = BlockPos.of(e.pos());
				p.add(bp.getX());
				p.add(bp.getY());
				p.add(bp.getZ());
				x.add("pos", p);
				x.addProperty("facing", e.facing().getSerializedName());
				en.add(x);
			}
			o.add("entrances", en);
			out.add(o);
		}
		return out;
	}

	// ------------------------------------------------------------------ consent (§6)

	/**
	 * A request's consent as the write paths use it: the named builds (aliases resolved) whose actor is one of their placers with at
	 * least 10% of the cells, or holds permission level 2 (online), or is the console ({@code console}). Null consent: none.
	 */
	public static Placed.Consent consent(@Nullable MinecraftServer s, @Nullable BuildConsent c, boolean console) {
		if (c == null || c.buildIds().isEmpty()) {
			return Placed.Consent.NONE;
		}
		ServerPlayer actor = c.actor() == null || s == null ? null : s.getPlayerList().getPlayer(c.actor());
		boolean op = console || dev.larattalabs.architect.apiimpl.ApiRules.permission2(actor);
		Set<String> ok = new HashSet<>();
		for (String id : c.buildIds()) {
			Builds.Rec r = Builds.rec(id);
			if (r == null || r.gone) {
				continue;
			}
			if (op || c.actor() != null && placerShare(r, c.actor()) * 10 >= r.cells && placerShare(r, c.actor()) > 0) {
				ok.add(r.id);
				ok.add(id);
			}
		}
		return new Placed.Consent(Set.copyOf(ok));
	}

	static int placerShare(Builds.Rec r, UUID u) {
		return r.placers.getOrDefault(u, 0);
	}

	// ------------------------------------------------------------------ claim and release (§8)

	public static final int CLAIM_SIDE = 32;
	public static final int CLAIM_REACH = 64;
	public static final int CLAIM_MAX = 8;
	public static final int CLAIM_OP_COLUMNS = 4096;
	/** Cells claimed in the call; bigger boxes are marked over ticks (2 ms a tick). */
	static final long CLAIM_SYNC_CELLS = 1_000_000L;

	/** "Claim my build". {@code console}: the console (an op; the nil placer). */
	public static Build claim(ServerLevel level, BoundingBox box, @Nullable ServerPlayer actor, boolean console) {
		boolean op = console || dev.larattalabs.architect.apiimpl.ApiRules.permission2(actor);
		if (!console && actor == null) {
			throw new ArchitectRefused(Reason.PERMISSION, "a claim needs an online player as its actor (or the console)");
		}
		if (op) {
			if (box.getXSpan() > CLAIM_OP_COLUMNS || box.getZSpan() > CLAIM_OP_COLUMNS) {
				throw new ArchitectRefused(Reason.FIELD_LIMIT, "the claim is " + box.getXSpan() + "x" + box.getZSpan() + " columns (at most " + CLAIM_OP_COLUMNS
					+ "x" + CLAIM_OP_COLUMNS + ")");
			}
		} else {
			if (box.getXSpan() > CLAIM_SIDE || box.getYSpan() > CLAIM_SIDE || box.getZSpan() > CLAIM_SIDE) {
				throw new ArchitectRefused(Reason.PERMISSION, "a claim is at most " + CLAIM_SIDE + "x" + CLAIM_SIDE + "x" + CLAIM_SIDE + " without permission level 2 ("
					+ box.getXSpan() + "x" + box.getYSpan() + "x" + box.getZSpan() + ")");
			}
			double cx = Math.clamp(actor.getX(), box.minX(), box.maxX() + 1);
			double cy = Math.clamp(actor.getY(), box.minY(), box.maxY() + 1);
			double cz = Math.clamp(actor.getZ(), box.minZ(), box.maxZ() + 1);
			if (actor.distanceToSqr(cx, cy, cz) > CLAIM_REACH * CLAIM_REACH || actor.level() != level) {
				throw new ArchitectRefused(Reason.PERMISSION, "a claim must be within " + CLAIM_REACH + " blocks of you");
			}
			long mine = 0;
			for (Builds.Rec r : Builds.list(null, null)) {
				if (r.state == BuildState.CLAIMED && actor.getUUID().equals(r.claimedBy)) {
					mine++;
				}
			}
			if (mine >= CLAIM_MAX) {
				throw new ArchitectRefused(Reason.PERMISSION, "at most " + CLAIM_MAX + " claims each without permission level 2 (you have " + mine + ")");
			}
		}
		for (int cx = box.minX() >> 4; cx <= box.maxX() >> 4; cx++) {
			for (int cz = box.minZ() >> 4; cz <= box.maxZ() >> 4; cz++) {
				if (level.getChunkSource().getChunkNow(cx, cz) == null) {
					throw new ArchitectRefused(Reason.NOT_LOADED, "the claim's chunk " + cx + ", " + cz + " is not loaded");
				}
			}
		}
		UUID placer = actor == null ? PlacedChunk.NIL : actor.getUUID();
		long now = System.currentTimeMillis();
		Builds.Rec r = Builds.newClaim(level.dimension().identifier().toString(), placer, now);
		ClaimJob j = new ClaimJob(level, box, placer, r.id);
		long vol = (long) box.getXSpan() * box.getYSpan() * box.getZSpan();
		if (vol <= CLAIM_SYNC_CELLS) {
			while (!j.step(Long.MAX_VALUE)) {
				// whole
			}
			j.finish();
		} else {
			CLAIMS.add(j);
		}
		return view(r);
	}

	private static final List<ClaimJob> CLAIMS = new ArrayList<>();

	/** A claim's marking over ticks (2 ms a tick). */
	static void tickClaims() {
		if (CLAIMS.isEmpty()) {
			return;
		}
		long deadline = System.nanoTime() + 2_000_000L;
		ClaimJob j = CLAIMS.get(0);
		if (j.step(deadline)) {
			CLAIMS.remove(0);
			j.finish();
		}
	}

	static void stopClaims() {
		CLAIMS.clear();
	}

	/** Marks a claim's cells, column by column. */
	static final class ClaimJob {
		final ServerLevel level;
		final BoundingBox box;
		final UUID placer;
		final String id;
		final String dim;
		int x;
		int z;
		final Builds.Comp comp = new Builds.Comp();

		ClaimJob(ServerLevel level, BoundingBox box, UUID placer, String id) {
			this.level = level;
			this.box = box;
			this.placer = placer;
			this.id = id;
			this.dim = level.dimension().identifier().toString();
			this.x = box.minX();
			this.z = box.minZ();
		}

		boolean step(long deadline) {
			BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
			int n = 0;
			while (z <= box.maxZ()) {
				if ((++n & 15) == 0 && System.nanoTime() >= deadline) {
					return false;
				}
				LevelChunk c = level.getChunkSource().getChunkNow(x >> 4, z >> 4);
				if (c != null) {
					for (int y = box.minY(); y <= box.maxY(); y++) {
						BlockState s = c.getBlockState(m.set(x, y, z));
						if (PlacedRules.empty(s)) {
							continue;
						}
						long p = m.asLong();
						Placed.Rec cur = Placed.record(c, x, y, z);
						if (cur != null && !cur.placer().equals(placer)) {
							continue; // another placer's cell stays theirs
						}
						if (dev.larattalabs.architect.site.SiteJournal.owned(dim, p)) {
							continue; // journal-owned cells are never marked
						}
						Placed.mark(c, m.immutable(), placer, id);
						PlacedChunk pc = c.getAttached(Placed.TYPE);
						comp.add(p, pc == null ? 0 : pc.get(x, y, z), id, s);
					}
				}
				if (++x > box.maxX()) {
					x = box.minX();
					z++;
				}
			}
			return true;
		}

		void finish() {
			Builds.finishClaim(level, id, comp);
		}
	}

	/** Releases a build: a placer of it, an op, or the console. */
	public static Build release(String id, @Nullable ServerPlayer actor, boolean console) {
		Builds.Rec r = Builds.rec(id);
		if (r == null || r.gone) {
			throw new ArchitectRefused(Reason.FIELD_LIMIT, "no build " + id);
		}
		boolean op = console || dev.larattalabs.architect.apiimpl.ApiRules.permission2(actor);
		if (!op && (actor == null || placerShare(r, actor.getUUID()) == 0 && !actor.getUUID().equals(r.claimedBy))) {
			throw new ArchitectRefused(Reason.PERMISSION, "only a placer of " + r.id + " or an op may release it");
		}
		if (r.state == BuildState.ADOPTED) {
			// (PT2 §4) remove (or undo) the site first: the un-adopt returns the build to its prior state
			throw new ArchitectRefused(Reason.ADOPT_REFUSED, r.id + " is adopted as " + r.siteId + ": remove that site first (an un-adopt keeps the house)",
				"adopted");
		}
		Builds.release(r);
		return view(r);
	}
}

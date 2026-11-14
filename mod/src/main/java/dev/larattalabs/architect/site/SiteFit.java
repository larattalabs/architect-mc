package dev.larattalabs.architect.site;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.FitMode;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.api.Refusal;
import dev.larattalabs.architect.api.SiteBinding;
import dev.larattalabs.architect.api.SiteSpec;
import dev.larattalabs.architect.api.VoxelClass;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.Approach;
import dev.larattalabs.architect.placement.TerrainFit;
import dev.larattalabs.architect.region.volume.Arvx;
import dev.larattalabs.architect.region.volume.VolumeSurvey;
import dev.larattalabs.architect.region.volume.VoxelTable;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import net.minecraft.world.level.storage.LevelResource;
import org.jspecify.annotations.Nullable;

/**
 * (7b slice PL) A placement with a site (docs/CONTRACT.md "Phase 7b" §2, slice PL; SETTLEMENTS §7.5): the site a request's checks and
 * writes see ({@link #with}, read by the placement's checks as {@link dev.larattalabs.architect.placed.Placed#consentNow} is), what it
 * changes (TerrainFit {@link TerrainFit.Policy#KEEP}, the {@link Approach.Mode}) and the site checks of its verdict, in this order:
 * <ol>
 * <li>the spec's own problems ({@link SiteSpec#problems()}), the request's origin and rotation against the site's frame, the template box
 * inside the site's volume ({@code OTHER}, {@code OTHER}, {@code LOT_TOO_SMALL});</li>
 * <li>{@code SITE_MISMATCH}: the entry is bound ({@link SiteBinding} in its ext, else its sidecar's own {@code site} spec, slice SV) to
 * another volume sha; the message starts with the bound sha; a sidecar {@code site} on this sha with another frame is refused
 * {@code OTHER};</li>
 * <li>{@code KEEP_LOST}: a keep-critical cell is gone (its class now is air, a fluid or a plant, or not the frozen volume's), or the
 * template writes one; the message starts with the first cell {@code x,y,z};</li>
 * <li>{@code SITE_DRIFTED}: a cell of the site volume changed class since the frozen survey (keep-critical cells left out: they are
 * {@code KEEP_LOST}'s; air and plants count as one; cells the survey froze as OWNED, PLAYER, BLOCK_ENTITY or MISSING are not compared),
 * or the frozen volume can't be read here (fail closed);</li>
 * <li>{@code SITE_UNSUPPORTED} (every fit but {@code on_pad}): the live support scan: every block the template writes connects through
 * written blocks (faces) to a site-solid cell (a world cell the template doesn't write that is not air, a fluid, replaceable or leaves)
 * or a keep-critical cell. The fit's limits (cantilever, chain run, span) are the checker's (slice SC), not placement's.</li>
 * </ol>
 * Pure apart from {@link #volume} (reads a frozen file). Internal.
 */
public final class SiteFit {
	/** The most cells a drift or keep message lists. */
	static final int MESSAGE_CELLS = 4;

	private SiteFit() {
	}

	// ------------------------------------------------------------------ the request's site while its checks and writes run

	private static final Deque<Optional<SiteSpec>> SITES = new ArrayDeque<>();

	/** {@link #with}'s body. */
	public interface Body<T, E extends Exception> {
		T run() throws E;
	}

	/** Runs {@code r} with {@code site} as the site its checks and writes see ({@link #now}); null = a plain placement. Server thread. */
	public static <T, E extends Exception> T with(@Nullable SiteSpec site, Body<T, E> r) throws E {
		return with(site, null, r);
	}

	/** (7b SL-b) The region group of the site lot whose checks run now (null outside one, or off a region): its own cells never drift its site. */
	private static final Deque<Optional<String>> GROUPS = new ArrayDeque<>();

	/**
	 * (7b SL-b) As {@link #with(SiteSpec, Body)}, for a region's site lot: {@code regionGroup} is its region's group, whose own journal
	 * entries (its earlier lots, tiles and roads) are left out of the site's drift check ({@link #ownCells}). Server thread.
	 */
	public static <T, E extends Exception> T with(@Nullable SiteSpec site, @Nullable String regionGroup, Body<T, E> r) throws E {
		SITES.push(Optional.ofNullable(site));
		GROUPS.push(Optional.ofNullable(site == null ? null : regionGroup));
		try {
			return r.run();
		} finally {
			GROUPS.pop();
			SITES.pop();
		}
	}

	/** (7b SL-b) The region group of the site lot whose checks run now, or null. */
	public static @Nullable String regionGroupNow() {
		Optional<String> g = GROUPS.peek();
		return g == null ? null : g.orElse(null);
	}

	/**
	 * (7b SL-b) The cells of {@code vol} that the region group {@code group} has written: every active journal entry of that group (its
	 * earlier lots' houses, its tiles, its roads, the leaves they cut) in the volume's sections, by the journal's own index. A neighbour site
	 * lot's house standing in this site's margin is the region's own change, not drift; anyone else's change still is. Empty with no group or
	 * no journal. Server thread.
	 */
	static Set<Long> ownCells(@Nullable String group, @Nullable String dim, BoundingBox vol) {
		Set<Long> out = new HashSet<>();
		dev.larattalabs.architect.journal.JournalStore js = group == null || dim == null ? null : dev.larattalabs.architect.journal.WorldJournal.storeOrNull();
		if (js == null) {
			return out;
		}
		for (int sx = vol.minX() >> 4; sx <= vol.maxX() >> 4; sx++) {
			for (int sy = vol.minY() >> 4; sy <= vol.maxY() >> 4; sy++) {
				for (int sz = vol.minZ() >> 4; sz <= vol.maxZ() >> 4; sz++) {
					long k = dev.larattalabs.architect.journal.Sections.key(sx, sy, sz);
					for (String id : js.inSection(dim, k)) {
						dev.larattalabs.architect.journal.JournalStore.Meta m = js.meta(id);
						if (m == null || !m.active() || !group.equals(m.group())) {
							continue;
						}
						dev.larattalabs.architect.journal.SectionCells sc;
						try {
							sc = js.section(id, k);
						} catch (java.io.IOException e) {
							continue; // unreadable: its cells stay compared (fail closed: drift, never a missed change)
						}
						if (sc == null) {
							continue;
						}
						for (int i = 0; i < sc.size(); i++) {
							long p = sc.pos(i);
							int x = BlockPos.getX(p), y = BlockPos.getY(p), z = BlockPos.getZ(p);
							if (vol.isInside(x, y, z)) {
								out.add(p);
							}
						}
					}
				}
			}
		}
		return out;
	}

	/** The site of the request whose checks run now (null outside one, or for a plain placement). */
	public static @Nullable SiteSpec now() {
		Optional<SiteSpec> s = SITES.peek();
		return s == null ? null : s.orElse(null);
	}

	/** The check-cache key part of a site ("" for none): a cached plain plan is never used for a site placement, nor the reverse. */
	public static String key(@Nullable SiteSpec s) {
		return s == null ? "" : "|site:" + Arvx.sha256(s.wire().toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
	}

	/** The TerrainFit policy of a placement: {@code CLEAR} for none or {@code on_pad}, else {@code KEEP}. */
	public static TerrainFit.Policy policy(@Nullable SiteSpec s) {
		return s == null || s.fit() == FitMode.ON_PAD ? TerrainFit.Policy.CLEAR : TerrainFit.Policy.KEEP;
	}

	/** The approach of a placement: {@code GROUND} for none or {@code on_pad}, else {@code PORT} (or {@code NONE} without a port). */
	public static Approach.Mode approach(@Nullable SiteSpec s) {
		return s == null ? Approach.Mode.GROUND : Approach.Mode.of(s.fit(), !s.ports().isEmpty());
	}

	/** Whether a placed site is site-bound (its record's ext carries a binding): move, update and revert refuse it. */
	public static boolean bound(@Nullable JsonObject ext) {
		return ext != null && ext.has(SiteBinding.EXT_KEY);
	}

	/** The refusal of a move, update or revert of a site-bound placement. */
	public static String fixedMessage(String siteId, String what) {
		return siteId + " is site-bound (placed on its site's frame): " + what + " is refused; remove it and place it again (a site variant elsewhere)";
	}

	/** {@code ext} with the placement's binding added under {@link SiteBinding#EXT_KEY} (a copy; the caller's object is not changed). */
	public static JsonObject withBinding(@Nullable JsonObject ext, SiteSpec s) {
		JsonObject o = ext == null ? new JsonObject() : ext.deepCopy();
		o.add(SiteBinding.EXT_KEY, SiteBinding.of(s, null).wire());
		return o;
	}

	// ------------------------------------------------------------------ the checks (pure)

	/** The first problem of the spec against the request (frame, then the box inside the volume), or null. */
	static @Nullable Refusal shape(SiteSpec s, BlockPos origin, Rotation rotation, Anchors.Bounds box) {
		List<String> p = s.problems();
		if (!p.isEmpty()) {
			return new Refusal(Reason.OTHER, "The site is malformed: " + String.join("; ", p));
		}
		if (!s.frame().origin().equals(origin) || s.frame().rotation() != rotation) {
			return new Refusal(Reason.OTHER, "A site-bound design is placed only in its site's frame (origin " + s.frame().origin().toShortString() + ", "
				+ dev.larattalabs.architect.api.SiteFrame.rotationWire(s.frame().rotation()) + "), not at " + origin.toShortString() + " "
				+ dev.larattalabs.architect.api.SiteFrame.rotationWire(rotation));
		}
		BoundingBox v = s.volume();
		if (box.minX() < v.minX() || box.minY() < v.minY() || box.minZ() < v.minZ() || box.maxX() > v.maxX() || box.maxY() > v.maxY() || box.maxZ() > v.maxZ()) {
			return new Refusal(Reason.LOT_TOO_SMALL, "The design's box " + Anchors.str(box) + " reaches outside the site's volume " + str(v));
		}
		return null;
	}

	/**
	 * The volume sha an entry (its sidecar JSON) is bound to: its {@link SiteBinding} ({@code ext["architect_mc:site"]}, written by DS and
	 * by a site placement's record), else the kit's own {@code site} spec (slice SV: a design built over a site records the spec it was
	 * built for in its sidecar); empty for an unbound entry.
	 */
	static Optional<String> boundSha(@Nullable JsonObject entryJson) {
		JsonObject ext = entryJson != null && entryJson.get("ext") instanceof JsonObject e ? e : null;
		Optional<SiteBinding> b = SiteBinding.ofExt(ext);
		if (b.isPresent()) {
			return Optional.of(b.get().volumeSha());
		}
		if (entryJson != null && entryJson.get(SiteSpec.WIRE_KEY) instanceof JsonObject site && site.get("volumeSha") instanceof com.google.gson.JsonPrimitive p
			&& p.isString()) {
			return Optional.of(p.getAsString());
		}
		return Optional.empty();
	}

	/**
	 * (SA, A35; N-7b-6, Noah yes 2026-11-13) {@code SITE_MISMATCH} when a site-bound entry ({@link #boundSha}: the pin badge) is placed with
	 * no site at all ({@code /architect place}, {@code Sites.place} without {@code site}): it places only on its own site, or elsewhere as a
	 * site variant of it. Null for an unbound entry. Since NEXT.
	 */
	public static @Nullable Refusal pinnedNoSite(String entryId, @Nullable JsonObject entryJson) {
		Optional<String> b = boundSha(entryJson);
		if (b.isEmpty()) {
			return null;
		}
		// the message starts with the bound sha, as {@link #mismatch}'s does (the refusal's detail)
		return new Refusal(Reason.SITE_MISMATCH, b.get() + ": " + entryId + " is site-bound (pinned to its site): placed with no site it is refused;"
			+ " place it on its own site, or place a site variant here instead");
	}

	/** {@code SITE_MISMATCH} when the entry is bound ({@link #boundSha}) to another volume sha; an unbound entry may be fitted. */
	static @Nullable Refusal mismatch(@Nullable JsonObject entryJson, SiteSpec s) {
		Optional<String> b = boundSha(entryJson);
		if (b.isPresent() && !b.get().equals(s.volumeSha())) {
			return new Refusal(Reason.SITE_MISMATCH, b.get() + ": the design is bound to another site volume than " + s.volumeSha()
				+ "; place a site variant here instead");
		}
		return null;
	}

	/**
	 * A design built over a site (its sidecar {@code site}, slice SV) on the same volume but another frame: its cells are the site's at
	 * that frame, so another one is refused ({@code OTHER}); null otherwise (no sidecar site, another sha: {@link #mismatch}'s).
	 */
	static @Nullable Refusal frameOfEntry(@Nullable JsonObject entryJson, SiteSpec s) {
		if (entryJson == null || !(entryJson.get(SiteSpec.WIRE_KEY) instanceof JsonObject site) || !(site.get("frame") instanceof JsonObject f)) {
			return null;
		}
		try {
			if (site.get("volumeSha") == null || !s.volumeSha().equals(site.get("volumeSha").getAsString())) {
				return null;
			}
			dev.larattalabs.architect.api.SiteFrame bound = dev.larattalabs.architect.api.SiteFrame.fromWire(f);
			if (!bound.equals(s.frame())) {
				return new Refusal(Reason.OTHER, "The design was built for its site's frame " + bound.origin().toShortString() + " "
					+ dev.larattalabs.architect.api.SiteFrame.rotationWire(bound.rotation()) + ", not this one; place a site variant here instead");
			}
		} catch (RuntimeException e) {
			return null; // a malformed sidecar site: not the placement's to judge
		}
		return null;
	}

	/** A cell's class in the frozen volume (a {@link VoxelClass} ordinal). */
	@FunctionalInterface
	public interface Classes {
		int classAt(int x, int y, int z);
	}

	/** Air and plants are one class for drift (grass grows, flowers are trampled); fluids, rock, soil, logs and leaves are not. */
	static int driftClass(int c) {
		return c == VoxelClass.PLANT.ordinal() ? VoxelClass.AIR.ordinal() : c;
	}

	/** A frozen class drift does not compare: the journal's, a player's, a block entity's, a column the survey didn't read. */
	static boolean uncompared(int c) {
		return c == VoxelClass.OWNED.ordinal() || c == VoxelClass.PLAYER.ordinal() || c == VoxelClass.BLOCK_ENTITY.ordinal()
			|| c == VoxelClass.MISSING.ordinal();
	}

	/** A class that holds nothing up: air, a fluid, a plant. */
	static boolean empty(int c) {
		return c == VoxelClass.AIR.ordinal() || c == VoxelClass.WATER.ordinal() || c == VoxelClass.LAVA.ordinal() || c == VoxelClass.PLANT.ordinal();
	}

	/**
	 * The drift of {@code vol} between the frozen classes and the live ones: the cells compared, the cells changed and the first few
	 * ({@code x,y,z FROM->TO}). {@code skip}: cells left out (the keep-critical ones), as {@link BlockPos#asLong}.
	 */
	public record Drift(long compared, long drifted, List<String> first) {
	}

	public static Drift drift(BoundingBox vol, Classes frozen, Classes live, Set<Long> skip) {
		long compared = 0;
		long drifted = 0;
		List<String> first = new ArrayList<>();
		VoxelClass[] names = VoxelClass.values();
		for (int y = vol.minY(); y <= vol.maxY(); y++) {
			for (int z = vol.minZ(); z <= vol.maxZ(); z++) {
				for (int x = vol.minX(); x <= vol.maxX(); x++) {
					int f = frozen.classAt(x, y, z);
					if (uncompared(f) || !skip.isEmpty() && skip.contains(BlockPos.asLong(x, y, z))) {
						continue;
					}
					int l = live.classAt(x, y, z);
					if (l == VoxelClass.MISSING.ordinal()) {
						continue; // not loaded now (a dry run): the placement's own check reads it
					}
					compared++;
					if (driftClass(f) != driftClass(l)) {
						drifted++;
						if (first.size() < MESSAGE_CELLS) {
							first.add(x + "," + y + "," + z + " " + names[f] + "->" + names[l]);
						}
					}
				}
			}
		}
		return new Drift(compared, drifted, first);
	}

	/**
	 * The keep-critical cells that are gone: their live class is empty (air, a fluid, a plant) or, where the survey froze terrain, a log
	 * or leaves, not that class any more. The first few as {@code x,y,z FROM->TO}; empty when none.
	 */
	public static List<String> keepLost(List<BlockPos> keep, Classes frozen, Classes live, long[] count) {
		List<String> out = new ArrayList<>();
		VoxelClass[] names = VoxelClass.values();
		for (BlockPos p : keep) {
			int f = frozen.classAt(p.getX(), p.getY(), p.getZ());
			int l = live.classAt(p.getX(), p.getY(), p.getZ());
			if (l == VoxelClass.MISSING.ordinal()) {
				continue;
			}
			boolean gone = empty(l) && !empty(f) || !uncompared(f) && !empty(f) && f != l;
			if (gone) {
				count[0]++;
				if (out.size() < MESSAGE_CELLS) {
					out.add(p.getX() + "," + p.getY() + "," + p.getZ() + " " + names[f] + "->" + names[l]);
				}
			}
		}
		return out;
	}

	/** A world cell placement can stand on: not air, a fluid, replaceable (plants, snow layers) or leaves ({@link TerrainFit#flags}). */
	public static boolean siteSolid(int flags) {
		return (flags & (TerrainFit.FILLABLE | TerrainFit.LEAVES | TerrainFit.WATER | TerrainFit.LAVA)) == 0;
	}

	/** The live support scan's answer: the template's blocks, those connected to no site-solid cell, the first such (world cell). */
	public record Support(int blocks, int unsupported, @Nullable BlockPos first) {
		public boolean ok() {
			return unsupported == 0;
		}
	}

	/**
	 * The live support scan of a template (its {@code writes}, {@link TerrainFit#writes}) at (ox, oy, oz) over the world {@code w}: a
	 * breadth-first search from the written blocks face-adjacent to a site-solid cell (a world cell the template doesn't write, solid by
	 * {@link #siteSolid}) or a keep-critical one ({@code anchors}, {@link BlockPos#asLong}), through written blocks.
	 */
	public static Support support(int sx, int sy, int sz, byte[] writes, int ox, int oy, int oz, TerrainFit.World w, Set<Long> anchors) {
		int n = sx * sy * sz;
		boolean[] seen = new boolean[n];
		int[] queue = new int[n];
		int head = 0;
		int tail = 0;
		int blocks = 0;
		int[][] dirs = {{1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1}};
		for (int y = 0; y < sy; y++) {
			for (int z = 0; z < sz; z++) {
				for (int x = 0; x < sx; x++) {
					int i = (y * sz + z) * sx + x;
					if (writes[i] != 2) {
						continue;
					}
					blocks++;
					for (int[] d : dirs) {
						int nx = x + d[0];
						int ny = y + d[1];
						int nz = z + d[2];
						boolean inside = nx >= 0 && ny >= 0 && nz >= 0 && nx < sx && ny < sy && nz < sz;
						if (inside && writes[(ny * sz + nz) * sx + nx] != 0) {
							continue; // written by the template: not the site's
						}
						int wx = ox + nx;
						int wy = oy + ny;
						int wz = oz + nz;
						if (anchors.contains(BlockPos.asLong(wx, wy, wz)) || siteSolid(w.flags(wx, wy, wz))) {
							seen[i] = true;
							queue[tail++] = i;
							break;
						}
					}
				}
			}
		}
		while (head < tail) {
			int i = queue[head++];
			int x = i % sx;
			int z = i / sx % sz;
			int y = i / (sx * sz);
			for (int[] d : dirs) {
				int nx = x + d[0];
				int ny = y + d[1];
				int nz = z + d[2];
				if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= sy || nz >= sz) {
					continue;
				}
				int j = (ny * sz + nz) * sx + nx;
				if (!seen[j] && writes[j] == 2) {
					seen[j] = true;
					queue[tail++] = j;
				}
			}
		}
		int unsupported = blocks - tail;
		BlockPos first = null;
		for (int i = 0; i < n && unsupported > 0 && first == null; i++) {
			if (writes[i] == 2 && !seen[i]) {
				first = new BlockPos(ox + i % sx, oy + i / (sx * sz), oz + i / sx % sz);
			}
		}
		return new Support(blocks, unsupported, first);
	}

	// ------------------------------------------------------------------ the frozen volume

	private static final Map<String, Arvx.Decoded> VOLUMES = new LinkedHashMap<>(4, 0.75f, true) {
		@Override
		protected boolean removeEldestEntry(Map.Entry<String, Arvx.Decoded> e) {
			return size() > 2;
		}
	};

	/**
	 * The site's frozen volume, read from this world's {@code architect/volumes/<sha>.bin} ({@code Survey.volume} always freezes it
	 * there) and checked against its sha; null when it is not there or does not check out. Server thread.
	 */
	public static synchronized Arvx.@Nullable Decoded volume(MinecraftServer server, String sha) {
		Arvx.Decoded d = VOLUMES.get(sha);
		if (d != null) {
			return d;
		}
		if (!sha.matches("[0-9a-f]{64}")) {
			return null;
		}
		Path world = server.getWorldPath(LevelResource.ROOT);
		Path f = volumeFile(world, sha);
		if (f == null) {
			List<dev.larattalabs.architect.region.RegionsImpl.Live> live = dev.larattalabs.architect.region.RegionsImpl.all();
			f = fromRegionBlobs(world, sha, live.stream().map(l -> l.rec().id).toList(), live.stream().map(l -> l.ir().blobs()).toList());
		}
		if (f == null) {
			return null;
		}
		try {
			byte[] raw = Arvx.gunzip(Files.readAllBytes(f));
			if (!Arvx.sha256(raw).equals(sha)) {
				Architect.LOGGER.warn("The frozen volume {} does not hash to its name", f);
				return null;
			}
			d = Arvx.decode(raw);
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("The frozen volume {} can't be read: {}", f, e.toString());
			return null;
		}
		VOLUMES.put(sha, d);
		return d;
	}

	/**
	 * (7b SL) The frozen volume's file: this world's {@code architect/volumes/<sha>.bin} first (where {@code Survey.volume} and a region
	 * plan's two-plan flow freeze it), else a region's own copy {@code architect-regions/<id>/volumes/<sha>.bin} (a region site lot's
	 * volume, {@code RegionBlobs.installVolumes}); null when neither exists (the checks then fail closed, {@code SITE_DRIFTED}).
	 */
	public static @Nullable Path volumeFile(Path world, String sha) {
		Path f = world.resolve(VolumeSurvey.STANDALONE_DIR).resolve(sha + ".bin");
		if (Files.isRegularFile(f)) {
			return f;
		}
		Path root = dev.larattalabs.architect.region.RegionStore.root(world);
		if (!Files.isDirectory(root)) {
			return null;
		}
		try (var st = Files.list(root)) {
			for (Path d : st.sorted().toList()) {
				Path g = d.resolve("volumes").resolve(sha + ".bin");
				if (Files.isRegularFile(g)) {
					return g;
				}
			}
		} catch (IOException e) {
			return null;
		}
		return null;
	}

	/**
	 * (7b SL) A region site lot's volume kept only as its IR's side blob (the kit crops a site lot's lot + 8 out of a volume the plan
	 * read and records it as a blob of kind {@code volume}, e.g. {@code site_<lotId>}): each region's blob copy
	 * ({@code architect-regions/<id>/blobs/<blob sha>.bin}, gzip ARVX) of kind {@code volume} is read, gunzipped and checked against
	 * {@code sha} (the ARVX sha of the uncompressed bytes); the first that matches is frozen into this world's
	 * {@code architect/volumes/<sha>.bin} ({@link VolumeSurvey#freeze}: written once, read back), whose path is answered, so PL's read
	 * path works from then. Null when none matches. {@code regions.get(i)} is a region id, {@code blobs.get(i)} its IR's blobs.
	 */
	public static @Nullable Path fromRegionBlobs(Path world, String sha, List<String> regions, List<List<dev.larattalabs.architect.region.Ir.BlobRef>> blobs) {
		for (int i = 0; i < regions.size(); i++) {
			for (dev.larattalabs.architect.region.Ir.BlobRef b : blobs.get(i)) {
				if (!"volume".equals(b.kind()) || !b.sha().matches("[0-9a-f]{64}")) {
					continue;
				}
				Path f = dev.larattalabs.architect.region.RegionBlobs.file(world, regions.get(i), b.sha());
				if (!Files.isRegularFile(f)) {
					continue;
				}
				try {
					byte[] gz = Files.readAllBytes(f);
					if (!Arvx.sha256(Arvx.gunzip(gz)).equals(sha)) {
						continue;
					}
					Path to = world.resolve(VolumeSurvey.STANDALONE_DIR).resolve(sha + ".bin");
					VolumeSurvey.freeze(to, gz, sha);
					return to;
				} catch (IOException | RuntimeException e) {
					Architect.LOGGER.warn("Region {} volume blob {} can't be read: {}", regions.get(i), b.sha(), e.toString());
				}
			}
		}
		return null;
	}

	/** The frozen classes of a decoded volume; MISSING outside its box. */
	static Classes frozen(Arvx.Decoded d) {
		int[] b = d.box();
		return (x, y, z) -> x < b[0] || y < b[1] || z < b[2] || x > b[3] || y > b[4] || z > b[5] ? VoxelClass.MISSING.ordinal() : d.classAt(x, y, z);
	}

	/** Whether {@code v} lies inside the decoded volume's box. */
	static boolean inside(Arvx.Decoded d, BoundingBox v) {
		int[] b = d.box();
		return v.minX() >= b[0] && v.minY() >= b[1] && v.minZ() >= b[2] && v.maxX() <= b[3] && v.maxY() <= b[4] && v.maxZ() <= b[5];
	}

	/** The live class of a state, as the survey classifies it (without the journal's OWNED). */
	static int liveClass(BlockState s, IdentityHashMap<BlockState, Byte> memo) {
		return VolumeSurvey.classOf(s, VoxelTable.get(), memo);
	}

	/**
	 * The site checks of a placement (the class comment's order, after the shape: mismatch, keep, drift, support) over the live world:
	 * {@code states} reads a world cell (null where it is not loaded), {@code world} its flags. Every refusal found, in that order.
	 */
	static List<Refusal> check(MinecraftServer server, SiteSpec s, @Nullable JsonObject entryJson, int sx, int sy, int sz, byte[] writes, int ox, int oy,
		int oz, java.util.function.Function<BlockPos, @Nullable BlockState> states, TerrainFit.World world) {
		return check(server, s, entryJson, sx, sy, sz, writes, ox, oy, oz, states, world, Set.of());
	}

	/** As above; {@code own}: the cells the site lot's own region has written ({@link #ownCells}), left out of the drift check. */
	static List<Refusal> check(MinecraftServer server, SiteSpec s, @Nullable JsonObject entryJson, int sx, int sy, int sz, byte[] writes, int ox, int oy,
		int oz, java.util.function.Function<BlockPos, @Nullable BlockState> states, TerrainFit.World world, Set<Long> own) {
		List<Refusal> out = new ArrayList<>();
		Refusal mm = mismatch(entryJson, s);
		if (mm != null) {
			out.add(mm);
		}
		Refusal fr = frameOfEntry(entryJson, s);
		if (fr != null) {
			out.add(fr);
		}
		IdentityHashMap<BlockState, Byte> memo = new IdentityHashMap<>();
		BlockPos.MutableBlockPos mp = new BlockPos.MutableBlockPos();
		Classes live = (x, y, z) -> {
			BlockState st = states.apply(mp.set(x, y, z));
			return st == null ? VoxelClass.MISSING.ordinal() : liveClass(st, memo);
		};
		Set<Long> keep = new HashSet<>();
		s.keepCritical().forEach(p -> keep.add(p.asLong()));
		// the template writing a keep-critical cell (the checker's site_keep, refused here too)
		List<String> written = new ArrayList<>();
		for (BlockPos p : s.keepCritical()) {
			int x = p.getX() - ox;
			int y = p.getY() - oy;
			int z = p.getZ() - oz;
			if (x >= 0 && y >= 0 && z >= 0 && x < sx && y < sy && z < sz && writes[(y * sz + z) * sx + x] != 0 && written.size() < MESSAGE_CELLS) {
				written.add(p.getX() + "," + p.getY() + "," + p.getZ());
			}
		}
		if (!written.isEmpty()) {
			out.add(new Refusal(Reason.KEEP_LOST, written.get(0) + ": the design writes a keep-critical cell of its site (" + String.join("; ", written) + ")"));
		}
		Arvx.Decoded d = volume(server, s.volumeSha());
		if (d == null || !inside(d, s.volume())) {
			out.add(new Refusal(Reason.SITE_DRIFTED, s.volumeSha() + ": the site's frozen volume " + (d == null ? "can't be read in this world"
				: "doesn't cover the site volume " + str(s.volume())) + "; survey the site again"));
		} else {
			Classes frozen = frozen(d);
			long[] lost = {0};
			List<String> gone = keepLost(s.keepCritical(), frozen, live, lost);
			if (!gone.isEmpty()) {
				out.add(new Refusal(Reason.KEEP_LOST, gone.get(0).substring(0, gone.get(0).indexOf(' ')) + ": " + lost[0] + " keep-critical cell"
					+ (lost[0] == 1 ? " is" : "s are") + " gone (" + String.join("; ", gone) + ")"));
			}
			// ((7b SL-b) the cells the lot's own region wrote (a neighbour lot's house in this site's margin) are its own change, not drift)
			Set<Long> skip = keep;
			if (!own.isEmpty()) {
				skip = new HashSet<>(keep);
				skip.addAll(own);
			}
			Drift dr = drift(s.volume(), frozen, live, skip);
			if (dr.drifted() > 0) {
				out.add(new Refusal(Reason.SITE_DRIFTED, dr.drifted() + " of " + dr.compared() + " cells of the site changed since its survey (" + String.join("; ",
					dr.first()) + "); survey the site again"));
			}
		}
		if (s.fit() != FitMode.ON_PAD) {
			Support sp = support(sx, sy, sz, writes, ox, oy, oz, world, keep);
			if (!sp.ok()) {
				BlockPos f = sp.first();
				out.add(new Refusal(Reason.SITE_UNSUPPORTED, f.getX() + "," + f.getY() + "," + f.getZ() + ": " + sp.unsupported() + " of " + sp.blocks()
					+ " blocks connect to nothing of the site (fit " + s.fit().wire() + ")"));
			}
		}
		return out;
	}

	/** (7b ST) The start of the "opens onto a drop" warning (SETTLEMENTS §7.8): one per port that meets no standable cell. */
	public static final String DROP = "the entrance opens onto a drop";

	/**
	 * (7b ST) The "opens onto a drop" warnings of a standalone site (no lot id; a site under a lot is the link pass's): for each port
	 * facing a side, the world cell just outside its first cell (the frame's rotation applied to the port's cell and facing) must be
	 * standable: that cell and the one above open (fillable, not a fluid), the one below solid ({@link #siteSolid}). A port facing up or
	 * down has no such cell. Warnings only, never a refusal. {@code sx, sz}: the template's size in the design frame. Pure.
	 */
	public static List<String> drops(SiteSpec s, int sx, int sz, TerrainFit.World w) {
		List<String> out = new ArrayList<>();
		for (Drop d : dropsOf(s, sx, sz, w)) {
			out.add(DROP + ": port " + d.port() + " faces " + d.facing() + " at " + d.at().getX() + "," + d.at().getY() + "," + d.at().getZ()
				+ " with no ground to stand on (build the way in: " + LINK_HERE + ")");
		}
		return out;
	}

	/** (7c CX) The words the drop warning gains (CONTRACT "Phase 7c" §3 row 11): the client's Build a link key starts a connector from it. */
	public static final String LINK_HERE = "build a link here";

	/** (7c CX) A port that opens onto a drop: its name, the side it faces and the world cell just outside it (a link's first end). */
	public record Drop(String port, String facing, BlockPos at) {
	}

	/** (7c CX) {@link #drops}' ports as data, in the same order (the client's "build a link here" starts a connector at {@code at}). Pure. */
	public static List<Drop> dropsOf(SiteSpec s, int sx, int sz, TerrainFit.World w) {
		List<Drop> out = new ArrayList<>();
		if (s == null || s.lotId() != null || s.fit() == FitMode.ON_PAD) {
			return out;
		}
		int turns = s.frame().rotation().ordinal();
		BlockPos o = s.frame().origin();
		for (dev.larattalabs.architect.api.SitePort p : s.ports()) {
			if (!p.facing().getAxis().isHorizontal()) {
				continue;
			}
			int[] r = dev.larattalabs.architect.placement.BlueprintTransform.rotateBlock(p.atDesign().getX(), p.atDesign().getZ(), sx, sz, turns);
			net.minecraft.core.Direction f = p.facing();
			for (int i = 0; i < turns; i++) {
				f = f.getClockWise();
			}
			int x = o.getX() + r[0] + f.getStepX();
			int y = o.getY() + p.atDesign().getY();
			int z = o.getZ() + r[1] + f.getStepZ();
			if (!open(w.flags(x, y, z)) || !open(w.flags(x, y + 1, z)) || !siteSolid(w.flags(x, y - 1, z))) {
				out.add(new Drop(p.name(), f.getName(), new BlockPos(x, y, z)));
			}
		}
		return out;
	}

	private static boolean open(int flags) {
		return (flags & TerrainFit.FILLABLE) != 0 && (flags & (TerrainFit.WATER | TerrainFit.LAVA)) == 0;
	}

	/** The verdict notes of a site placement's approach. */
	static List<String> notes(SiteSpec s) {
		Approach.Mode m = approach(s);
		if (m == Approach.Mode.GROUND) {
			return List.of();
		}
		if (m == Approach.Mode.NONE) {
			return List.of("site fit " + s.fit().wire() + ": no approach (the site has no port)");
		}
		List<String> names = s.ports().stream().map(p -> p.name()).toList();
		return List.of("site fit " + s.fit().wire() + ": approach by port " + String.join(", ", names) + (s.lotId() != null
			? " (the door port faces a graph edge; the link pass joins it)" : " (no ground strip; the way in is the player's to build)"));
	}

	static String str(BoundingBox b) {
		return "(" + b.minX() + ", " + b.minY() + ", " + b.minZ() + ")-(" + b.maxX() + ", " + b.maxY() + ", " + b.maxZ() + ")";
	}
}

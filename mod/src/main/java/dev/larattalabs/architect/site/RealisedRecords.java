package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.batch.QBatch;
import dev.larattalabs.architect.batch.QItem;
import dev.larattalabs.architect.journal.Journal.Value;
import dev.larattalabs.architect.journal.JournalStore;
import dev.larattalabs.architect.journal.SectionCells;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.region.Packed;
import dev.larattalabs.architect.region.Realised;
import dev.larattalabs.architect.region.RegionsImpl;
import dev.larattalabs.architect.region.TileStream;
import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.LeavesBlock;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

/**
 * (RP) Where the realise paths record what they realised ({@link Realised}): region tiles at their write boundary (RegionItems),
 * roads when their job starts and ends (Batches, RegionsImpl.itemDone), lots when their item ends, and the fluid bodies with
 * fluids.json (RegionFluids). Also the readers: a record's {@link #status} against the journal and the queue, and {@link #verify}
 * (the record against the journal and the world), and the dev audit ({@code ARCHITECT_RP_AUDIT} or {@code dev.region.realised.audit}):
 * each tile, right after its commit, re-read from the world against its intent per code. Server thread.
 */
public final class RealisedRecords {
	/** Tiles recorded this session, and their bytes (dev.region.realised's sizes). */
	public static long tiles;
	public static long bytes;
	private static volatile @Nullable Path auditDir = envAudit();

	private RealisedRecords() {
	}

	private static @Nullable Path envAudit() {
		String v = System.getenv("ARCHITECT_RP_AUDIT");
		return v == null || v.isBlank() ? null : Path.of(v);
	}

	/** Arms (or with null disarms) the audit into {@code dir}. */
	public static void audit(@Nullable Path dir) {
		auditDir = dir;
		AUDIT.clear();
	}

	public static @Nullable Path auditDir() {
		return auditDir;
	}

	// ------------------------------------------------------------------ tiles: the write boundary

	/**
	 * A tile's record, written durably before its PLACING commit (site) or before its item is marked placed (no site: nothing to
	 * write). Returns its bytes, or -1 when the check made no draft. Throws when it can't be written: the tile then doesn't commit.
	 */
	static int tile(ServerLevel level, RegionsImpl.Live r, String[] t, TileStream.Tile ts, TileCheck.Result res, @Nullable String site) throws IOException {
		Realised.Draft d = res.draft();
		Packed.Tile orig = ts.cells();
		if (d == null || orig == null) {
			return -1;
		}
		Path world = r.world();
		String region = r.rec().id;
		String stage = t[1];
		String set = t[2];
		String key = t[3];
		byte[] chain = Realised.chain(r.ir(), stage, set, key, w -> w[0].equals(stage) && w[1].equals(set) ? orig.sha() : Realised.shaAt(world, region, 0, w[0],
			w[1], key));
		byte[] wr = ts.writers;
		Realised.Tile rec0 = new Realised.Tile(0, stage, set, key, site == null ? "" : site, site == null ? Realised.NO_ENTRY : 0, HexFormat.of().parseHex(orig
			.sha()), chain, d.codes(), d.extras(), wr == null ? new byte[0] : wr);
		Realised.Tile rec = rec0;
		// an earlier attempt of this tile whose entry stands (a crash after its commit, before its item was placed): kept in the record
		Realised.Tile was = Realised.read(world, region, 0, stage, set, key);
		if (was != null && !was.noEntry()) {
			List<String> standing = new ArrayList<>();
			for (String s : was.sites()) {
				JournalStore.Meta m = mainEntry(s);
				// an earlier attempt of THIS tile (a cell site id can be reused after a crash) that committed, or is still being written
				// by its resumed job (it commits later; the record reads placing until then)
				if (!s.equals(site) && m != null && ownedBy(s, String.join("|", t)) && (m.status() == dev.larattalabs.architect.journal.Journal.Status.ACTIVE
					|| m.status() == dev.larattalabs.architect.journal.Journal.Status.PLACING)) {
					standing.add(s);
				}
			}
			rec = Realised.mergePrior(rec, was, standing);
		}
		int n = Realised.write(world, region, rec);
		tiles++;
		bytes += n;
		if (auditDir != null) {
			stash(level, region, t, orig, rec);
		}
		return n;
	}

	/**
	 * A record's standing: {@code committed} (its entry ACTIVE, or no entry and its item placed), {@code placing} (the entry is still
	 * PLACING), {@code pending} (no entry, its item not placed yet), {@code undone} (the entry undone) or {@code stale} (its entry is
	 * gone: written before a commit that never happened; the tile reads as unfinished).
	 */
	public static String status(RegionsImpl.Live l, Realised.Tile rec) {
		if (rec.noEntry()) {
			QBatch b = l.rec().batchId == null ? null : Batches.get(l.rec().batchId);
			if (b == null) {
				return "committed";
			}
			for (QItem i : b.items) {
				if ("tile".equals(i.itemKind) && i.spec != null && rec.stage().equals(i.spec.get("stage").getAsString()) && rec.set().equals(i.spec.get("set")
					.getAsString()) && rec.key().equals(i.spec.get("tile").getAsString())) {
					return i.status == QItem.Status.PLACED ? "committed" : "pending";
				}
			}
			return "committed";
		}
		String worst = "committed";
		String tile = String.join("|", l.rec().id, rec.stage(), rec.set(), rec.key());
		for (String s : rec.sites()) {
			JournalStore.Meta m = ownedBy(s, tile) ? mainEntry(s) : null; // a reused id: this record's entry never was
			String st = m == null ? "stale" : switch (m.status()) {
				case ACTIVE -> "committed";
				case PLACING -> "placing";
				default -> "undone";
			};
			if (!"committed".equals(st) && ("committed".equals(worst) || "stale".equals(st))) {
				worst = st;
			}
		}
		return worst;
	}

	/**
	 * Whether cell site {@code site} is the tile {@code tile} ({@code region|stage|set|key}, its spec's {@code tile}): a site id named
	 * by a record whose commit never happened can be given to another tile after a restart. Before its record exists (P4), yes.
	 */
	static boolean ownedBy(String site, String tile) {
		Infra i = Infras.get(site);
		return i == null || !i.spec().has("tile") || tile.equals(i.spec().get("tile").getAsString());
	}

	private static JournalStore.@Nullable Meta mainEntry(String site) {
		for (JournalStore.Meta m : SiteJournal.entries(site)) {
			if (m.kind().equals(RegionKinds.TERRAIN) || m.kind().equals(RegionKinds.PATH)) {
				return m;
			}
		}
		return null;
	}

	private static JournalStore.@Nullable Meta leavesEntry(String site) {
		for (JournalStore.Meta m : SiteJournal.entries(site)) {
			if (m.kind().equals(WorldJournal.LEAVES)) {
				return m;
			}
		}
		return null;
	}

	// ------------------------------------------------------------------ items ending; roads starting

	/** A region item ended (RegionsImpl.itemDone): a failed tile's record goes; a lot's and a road's outcome is recorded. */
	public static void itemDone(RegionsImpl.Live l, QBatch b, QItem i) {
		Path world = l.world();
		String region = l.rec().id;
		if ("tile".equals(i.itemKind) && i.spec != null) {
			String stage = i.spec.get("stage").getAsString();
			String set = i.spec.get("set").getAsString();
			String key = i.spec.get("tile").getAsString();
			if (i.status == QItem.Status.FAILED) {
				Realised.discard(world, region, 0, stage, set, key);
			} else if (i.status == QItem.Status.PLACED && auditDir != null) {
				check(l, b, i, stage, set, key);
			}
			return;
		}
		if (i.key.startsWith("lot:")) {
			JsonObject o = new JsonObject();
			o.addProperty("site", i.siteId);
			o.addProperty("entry", l.rec().lots.containsKey(i.key.substring(4)) ? l.rec().lots.get(i.key.substring(4)).entry : null);
			o.addProperty("state", i.status == QItem.Status.PLACED ? "placed" : "failed");
			if (i.status != QItem.Status.PLACED) {
				o.addProperty("reason", i.reason);
			}
			o.addProperty("at", System.currentTimeMillis());
			Realised.putSite(world, region, 0, "lots", i.key.substring(4), o);
			return;
		}
		if ("road".equals(i.itemKind)) {
			String id = i.key.startsWith("road:") ? i.key.substring(5) : i.key;
			JsonObject sites = Realised.sites(world, region, 0);
			JsonObject was = sites != null && sites.has("roads") && sites.getAsJsonObject("roads").has(id) ? sites.getAsJsonObject("roads").getAsJsonObject(id)
				: null;
			JsonObject o = was != null ? was.deepCopy() : Realised.road(i.siteId == null ? "" : i.siteId, -1, List.of(), "placed");
			if (was == null) {
				o.addProperty("spans", "unknown"); // its start was not recorded (a crash between its commit and its record)
			}
			o.addProperty("state", i.status == QItem.Status.PLACED ? "placed" : "failed");
			if (i.status != QItem.Status.PLACED) {
				o.addProperty("reason", i.reason);
			}
			o.addProperty("at", System.currentTimeMillis());
			Realised.putSite(world, region, 0, "roads", id, o);
		}
	}

	/** A region road's job began (Batches): its site, its planned cells and the spans a partial road skipped. */
	static void roadStarted(QBatch b, QItem i, String siteId, InfraPlace.Check c) {
		String region = RegionItems.regionOf(b);
		RegionsImpl.Live l = region == null ? null : RegionsImpl.live(region);
		if (l == null) {
			return;
		}
		String id = i.key.startsWith("road:") ? i.key.substring(5) : i.key;
		Realised.putSite(l.world(), region, 0, "roads", id, Realised.road(siteId, c.cells(), c.spans(), "placing"));
	}

	// ------------------------------------------------------------------ verify: the record against the journal and the world

	/**
	 * Every tile record of the region (layer 0) against the journal (a committed record's WRITTEN count plus its tree and dependent
	 * extras equals its entry's cells, those extras are among them, its leaves are its leaves entry's) and the world (each entry cell no
	 * later active entry covers still holds the entry's after, StillOurs); every ACTIVE tile entry of the region's group has a record;
	 * and sites.json against the region's lots, roads and fluids. Loads chunks. Server thread.
	 */
	public static JsonObject verify(RegionsImpl.Live l, ServerLevel level, boolean world) {
		JsonObject out = new JsonObject();
		Path dir = Realised.dir(l.world(), l.rec().id, 0);
		List<String> problems = new ArrayList<>();
		Map<String, Integer> st = new java.util.TreeMap<>();
		long checked = 0, held = 0, covered = 0, notHeld = 0, recBytes = 0, files = 0;
		java.util.Set<String> recordedSites = new java.util.HashSet<>();
		JournalStore js = WorldJournal.storeOrNull();
		try (var ds = Files.isDirectory(dir) ? Files.list(dir) : java.util.stream.Stream.<Path>empty()) {
			for (Path f : (Iterable<Path>) ds.sorted()::iterator) {
				if (!f.getFileName().toString().endsWith(".bin")) {
					continue;
				}
				files++;
				byte[] raw = Files.readAllBytes(f);
				recBytes += raw.length;
				Realised.Tile rec;
				try {
					rec = Realised.decode(raw);
				} catch (IOException e) {
					problems.add(f.getFileName() + ": " + e.getMessage());
					continue;
				}
				String s = status(l, rec);
				st.merge(s, 1, Integer::sum);
				recordedSites.addAll(rec.sites());
				if (!"committed".equals(s) || rec.noEntry()) {
					if (rec.noEntry() && rec.counts()[Realised.WRITTEN] > 0) {
						problems.add(f.getFileName() + ": no entry but " + rec.counts()[Realised.WRITTEN] + " WRITTEN");
					}
					continue;
				}
				if (js == null) {
					continue;
				}
				// the union of the tile's entries (one, or an earlier attempt's too), each judged on its own layer below
				Long2ObjectOpenHashMap<Value> cells = new Long2ObjectOpenHashMap<>();
				List<JournalStore.Meta> metas = new ArrayList<>();
				for (String sid : rec.sites()) {
					JournalStore.Meta mm = mainEntry(sid);
					if (mm != null) {
						metas.add(mm);
						cells.putAll(cellsOf(js, mm));
					}
				}
				int written = rec.counts()[Realised.WRITTEN];
				int ex = 0;
				LongOpenHashSet leaves = new LongOpenHashSet();
				for (Realised.Extra e : rec.extras()) {
					if (e.kind() == Realised.LEAF) {
						leaves.add(e.pos());
					} else {
						ex++;
						if (!cells.containsKey(e.pos())) {
							problems.add(f.getFileName() + ": extra " + Realised.extraName(e.kind()) + " " + BlockPos.of(e.pos()).toShortString() + " not in the entry");
							}
					}
				}
				if (written + ex != cells.size()) {
					problems.add(f.getFileName() + ": WRITTEN " + written + " + extras " + ex + " != entry cells " + cells.size());
				}
				Long2ObjectOpenHashMap<Value> lc = new Long2ObjectOpenHashMap<>();
				for (String sid : rec.sites()) {
					JournalStore.Meta lm = leavesEntry(sid);
					if (lm != null) {
						lc.putAll(cellsOf(js, lm));
					}
				}
				if (!new LongOpenHashSet(lc.keySet()).equals(leaves)) {
					problems.add(f.getFileName() + ": leaves " + leaves.size() + " != leaves entry " + lc.size());
				}
				if (world) {
					for (JournalStore.Meta m : metas) {
						LongOpenHashSet over = coveredAbove(js, m);
						for (var e : cellsOf(js, m).long2ObjectEntrySet()) {
							long p = e.getLongKey();
							checked++;
							if (over.contains(p)) {
								covered++;
								continue;
							}
							level.getChunk(BlockPos.getX(p) >> 4, BlockPos.getZ(p) >> 4);
							if (WorldJournal.holds(level, p, e.getValue())) {
								held++;
							} else {
								notHeld++;
								if (problems.size() < 40) {
									problems.add(f.getFileName() + ": " + BlockPos.of(p).toShortString() + " holds " + level.getBlockState(BlockPos.of(p)) + ", wrote "
										+ WorldJournal.state(e.getValue()));
								}
							}
						}
					}
				}
			}
		} catch (IOException e) {
			problems.add("read: " + e.getMessage());
		}
		// every ACTIVE tile entry of the region's group has a record
		int unrecorded = 0;
		if (js != null && l.rec().groupId != null) {
			for (JournalStore.Meta m : activeTileEntries(js, l.rec().groupId)) {
				if (!recordedSites.contains(m.site())) {
					unrecorded++;
					if (problems.size() < 60) {
						problems.add("ACTIVE tile entry " + m.id() + " of " + m.site() + " has no record");
					}
				}
			}
		}
		// (recorded) tile entries of the group left PLACING with no record naming them: a crash's leftover the queue ran past
		int leftover = 0;
		if (js != null && l.rec().groupId != null) {
			String g = l.rec().groupId;
			for (JournalStore.Meta m : js.find(m -> m.status() == dev.larattalabs.architect.journal.Journal.Status.PLACING && g.equals(m.group()) && (m.kind()
				.equals(RegionKinds.TERRAIN) || m.kind().equals(RegionKinds.PATH)))) {
				if (!recordedSites.contains(m.site())) {
					leftover++;
				}
			}
		}
		out.addProperty("placingLeftover", leftover);
		out.addProperty("files", files);
		out.addProperty("bytes", recBytes);
		JsonObject so = new JsonObject();
		st.forEach(so::addProperty);
		out.add("status", so);
		out.addProperty("unrecorded", unrecorded);
		if (world) {
			out.addProperty("cellsChecked", checked);
			out.addProperty("held", held);
			out.addProperty("coveredLater", covered);
			out.addProperty("notHeld", notHeld);
		}
		JsonObject sites = Realised.sites(l.world(), l.rec().id, 0);
		out.add("sites", sites == null ? new JsonObject() : sites);
		sitesAgainst(l, sites, problems);
		JsonArray pa = new JsonArray();
		problems.forEach(pa::add);
		out.add("problems", pa);
		out.addProperty("ok", problems.isEmpty() && notHeld == 0 && unrecorded == 0);
		return out;
	}

	/** sites.json's lots against RegionRec's lots (site and placed state), its bodies against fluids' report. */
	private static void sitesAgainst(RegionsImpl.Live l, @Nullable JsonObject sites, List<String> problems) {
		JsonObject lots = sites != null && sites.has("lots") ? sites.getAsJsonObject("lots") : new JsonObject();
		l.rec().lots.forEach((id, ls) -> {
			if (ls.entry == null || ls.siteId == null) {
				return; // a pad, or a lot never reached
			}
			JsonObject o = lots.has(id) ? lots.getAsJsonObject(id) : null;
			if (o == null) {
				problems.add("lot " + id + " (" + ls.siteId + ") has no record");
			} else if (!ls.siteId.equals(o.has("site") && !o.get("site").isJsonNull() ? o.get("site").getAsString() : null)) {
				problems.add("lot " + id + ": record site " + o.get("site") + " != " + ls.siteId);
			}
		});
	}

	private static Long2ObjectOpenHashMap<Value> cellsOf(JournalStore js, JournalStore.Meta m) {
		Long2ObjectOpenHashMap<Value> out = new Long2ObjectOpenHashMap<>();
		try {
			for (long k : m.sections()) {
				SectionCells sc = js.section(m.id(), k);
				if (sc == null) {
					continue;
				}
				for (int i = 0; i < sc.size(); i++) {
					Value a = sc.after(i);
					out.put(sc.pos(i), a == null ? sc.before(i) : a);
				}
			}
		} catch (IOException e) {
			Architect.LOGGER.warn("RP verify: entry {}: {}", m.id(), e.toString());
		}
		return out;
	}

	/** The cells of the entry's sections that an active entry on a later layer holds (a path tile, a road, a lot, a later stage). */
	private static LongOpenHashSet coveredAbove(JournalStore js, JournalStore.Meta m) {
		LongOpenHashSet out = new LongOpenHashSet();
		for (long k : m.sections()) {
			for (String id : js.inSection(m.dimension(), k)) {
				JournalStore.Meta o = js.meta(id);
				if (o == null || o.id().equals(m.id()) || !o.active() || o.layer() <= m.layer()) {
					continue;
				}
				try {
					SectionCells sc = js.section(id, k);
					if (sc != null) {
						for (int i = 0; i < sc.size(); i++) {
							out.add(sc.pos(i));
						}
					}
				} catch (IOException e) {
					// unreadable: not counted as covering
				}
			}
		}
		return out;
	}

	private static List<JournalStore.Meta> activeTileEntries(JournalStore js, String group) {
		return js.find(m -> m.active() && group.equals(m.group()) && (m.kind().equals(RegionKinds.TERRAIN) || m.kind().equals(RegionKinds.PATH)));
	}

	// ------------------------------------------------------------------ the audit: each tile against its intent, right after its commit

	private record Stash(Packed.Tile tile, Realised.Tile rec, BlockState[] pre, Map<Long, BlockState> extraPre) {
	}

	private static final Map<String, Stash> AUDIT = new HashMap<>();

	/** The world under every intended cell and extra just before the commit (the audit's "untouched" reference). */
	private static void stash(ServerLevel level, String region, String[] t, Packed.Tile tile, Realised.Tile rec) {
		BlockState[] pre = new BlockState[tile.size()];
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		for (int i = 0; i < pre.length; i++) {
			long p = tile.pos()[i];
			pre[i] = level.getBlockState(m.set(BlockPos.getX(p), BlockPos.getY(p), BlockPos.getZ(p)));
		}
		Map<Long, BlockState> ep = new HashMap<>();
		for (Realised.Extra e : rec.extras()) {
			ep.put(e.pos(), level.getBlockState(BlockPos.of(e.pos())));
		}
		AUDIT.put(String.join("|", t), new Stash(tile, rec, pre, ep));
	}

	/**
	 * The audit of one tile just committed: every WRITTEN or NOOP cell holds its intended state (StillOurs, so a copper stage or a
	 * fluid level counts); every other cell not among the extras is as it was before the commit (the same block; a fluid that moved
	 * is counted apart, not failed); each extra holds what the tile wrote there (air, water, or a persistent leaf); the record on
	 * disk decodes to what was written and stands committed. One JSON line per tile in the audit dir.
	 */
	private static void check(RegionsImpl.Live l, QBatch b, QItem i, String stage, String set, String key) {
		String id = String.join("|", l.rec().id, stage, set, key);
		Stash s = AUDIT.remove(id);
		Path dir = auditDir;
		if (s == null || dir == null) {
			return;
		}
		var srv = SiteDeltas.serverOrNull();
		ServerLevel level = srv == null ? null : l.level(srv);
		if (level == null) {
			return;
		}
		long t0 = System.nanoTime();
		JsonObject o = new JsonObject();
		o.addProperty("region", l.rec().id);
		o.addProperty("tile", stage + "|" + set + "|" + key);
		List<String> bad = new ArrayList<>();
		int[] okBy = new int[32];
		int fluidMoved = 0, coincide = 0;
		Packed.Tile t = s.tile();
		byte[] codes = s.rec().codes();
		LongOpenHashSet extra = new LongOpenHashSet();
		s.rec().extras().forEach(e -> extra.add(e.pos()));
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		for (int k = 0; k < t.size(); k++) {
			long p = t.pos()[k];
			BlockState now = level.getBlockState(m.set(BlockPos.getX(p), BlockPos.getY(p), BlockPos.getZ(p)));
			BlockState want = t.states().get(t.state()[k]);
			byte c = codes[k];
			boolean pass;
			if (c == Realised.WRITTEN || c == Realised.NOOP) {
				pass = WorldJournal.holds(level, p, WorldJournal.value(want));
			} else if (extra.contains(p)) {
				pass = true; // an intended cell the tile skipped but wrote as an extra (judged with the extras)
			} else {
				BlockState pre = s.pre()[k];
				pass = now.getBlock() == pre.getBlock() || dev.larattalabs.architect.journal.StillOurs.holds(now, null, pre, null);
				if (!pass && (!now.getFluidState().isEmpty() || !pre.getFluidState().isEmpty())) {
					fluidMoved++;
					pass = true;
				}
				if (pass && now == want) {
					coincide++;
				}
			}
			if (pass) {
				okBy[c]++;
			} else if (bad.size() < 8) {
				bad.add(Realised.codeName(c) + " " + BlockPos.of(p).toShortString() + " now " + now + " want " + want + " before " + s.pre()[k]);
			} else {
				bad.add("");
			}
		}
		int[] exOk = new int[4];
		for (Realised.Extra e : s.rec().extras()) {
			BlockState now = level.getBlockState(BlockPos.of(e.pos()));
			boolean pass = switch (e.kind()) {
				case Realised.LEAF -> now.getBlock() instanceof LeavesBlock && now.getValue(LeavesBlock.PERSISTENT);
				case Realised.DEPENDENT_WET -> !now.getFluidState().isEmpty();
				default -> now.isAir() || !now.getFluidState().isEmpty() && s.extraPre().get(e.pos()) != null && !s.extraPre().get(e.pos()).getFluidState()
					.isEmpty();
			};
			if (pass) {
				exOk[e.kind()]++;
			} else if (bad.size() < 8) {
				bad.add(Realised.extraName(e.kind()) + " " + BlockPos.of(e.pos()).toShortString() + " now " + now);
			} else {
				bad.add("");
			}
		}
		// the record on disk: decodes to what was written, and stands committed
		String status;
		try {
			Realised.Tile disk = Realised.read(l.world(), l.rec().id, 0, stage, set, key);
			status = disk == null ? "missing" : !java.util.Arrays.equals(disk.codes(), codes) || !disk.extras().equals(s.rec().extras()) ? "differs" : status(l,
				disk);
		} catch (IOException e) {
			status = "unreadable";
		}
		o.addProperty("record", status);
		o.addProperty("cells", t.size());
		JsonObject cc = new JsonObject();
		int[] n = s.rec().counts();
		for (int k = 0; k < n.length; k++) {
			if (n[k] > 0) {
				cc.addProperty(Realised.codeName(k), n[k]);
			}
		}
		o.add("codes", cc);
		JsonObject ec = new JsonObject();
		int[] en = new int[4];
		s.rec().extras().forEach(e -> en[e.kind()]++);
		for (int k = 0; k < 4; k++) {
			if (en[k] > 0) {
				ec.addProperty(Realised.extraName(k), en[k]);
			}
		}
		o.add("extras", ec);
		o.addProperty("bytes", Realised.encode(s.rec()).length);
		o.addProperty("writers", s.rec().writers().length);
		o.addProperty("fluidMoved", fluidMoved);
		o.addProperty("coincide", coincide);
		o.addProperty("mismatches", bad.size());
		JsonArray ba = new JsonArray();
		bad.stream().filter(x -> !x.isEmpty()).forEach(ba::add);
		o.add("first", ba);
		o.addProperty("ok", bad.isEmpty() && "committed".equals(status));
		o.addProperty("ms", (System.nanoTime() - t0) / 1e6);
		line(dir, o);
	}

	/** The region's batch ended: its whole record verified (journal and world) into the audit, while its chunks are loaded. */
	public static void batchDone(RegionsImpl.Live l) {
		Path dir = auditDir;
		if (dir == null) {
			return;
		}
		var srv = SiteDeltas.serverOrNull();
		ServerLevel level = srv == null ? null : l.level(srv);
		if (level == null) {
			return;
		}
		JsonObject o = verify(l, level, true);
		o.addProperty("region", l.rec().id);
		o.addProperty("kind", "region");
		o.addProperty("state", String.valueOf(l.rec().state));
		JsonObject sites = o.has("sites") ? o.getAsJsonObject("sites") : new JsonObject();
		o.remove("sites");
		for (String m : new String[] {"roads", "lots", "bodies"}) {
			if (sites.has(m)) {
				JsonObject n = new JsonObject();
				sites.getAsJsonObject(m).entrySet().forEach(e -> n.add(e.getKey(), e.getValue().getAsJsonObject().get("state")));
				o.add(m, n);
			}
		}
		line(dir, o);
	}

	private static synchronized void line(Path dir, JsonObject o) {
		try {
			Files.createDirectories(dir);
			Files.writeString(dir.resolve("rp-audit-" + ProcessHandle.current().pid() + ".jsonl"), o + "\n", StandardCharsets.UTF_8, StandardOpenOption.CREATE,
				StandardOpenOption.APPEND);
		} catch (IOException e) {
			Architect.LOGGER.warn("RP audit: {}", e.toString());
		}
	}

	/** dev.region.realised (docs/DEVBRIDGE.md). Server thread. */
	public static JsonObject dev(RegionsImpl.Live l, @Nullable ServerLevel level, int layer, @Nullable String tile, boolean cells, boolean verify,
		boolean world) {
		String region = l.rec().id;
		JsonObject o = new JsonObject();
		o.addProperty("region", region);
		o.addProperty("layer", layer);
		try {
			if (tile != null) {
				String[] t = tile.split("\\|");
				Realised.Tile rec = Realised.read(l.world(), region, layer, t[0], t[1], t[2]);
				o.add("tile", rec == null ? null : summary(l, rec, cells));
				return o;
			}
			JsonArray a = new JsonArray();
			long bytes = 0;
			Path dir = Realised.dir(l.world(), region, layer);
			if (Files.isDirectory(dir)) {
				try (var ds = Files.list(dir)) {
					for (Path f : (Iterable<Path>) ds.sorted()::iterator) {
						if (!f.getFileName().toString().endsWith(".bin")) {
							continue;
						}
						Realised.Tile rec = Realised.decode(Files.readAllBytes(f));
						JsonObject so = summary(l, rec, cells);
						long sz = Files.size(f);
						so.addProperty("diskBytes", sz);
						bytes += sz;
						a.add(so);
					}
				}
			}
			o.add("tiles", a);
			o.addProperty("bytes", bytes);
			o.addProperty("sessionTiles", tiles);
			o.addProperty("sessionBytes", RealisedRecords.bytes);
		} catch (IOException e) {
			throw new IllegalStateException("the realised record could not be read: " + e.getMessage(), e);
		}
		JsonObject sites = Realised.sites(l.world(), region, layer);
		o.add("sites", sites == null ? new JsonObject() : sites);
		JsonObject composed = new JsonObject();
		java.util.Set<String> keys = new java.util.TreeSet<>();
		l.ir().terrainTiles().values().forEach(keys::addAll);
		l.ir().pathTiles().values().forEach(keys::addAll);
		for (String k : keys) {
			composed.addProperty(k, Realised.composedSha(l.world(), region, layer, l.ir(), k));
		}
		o.add("composedSha", composed);
		if (verify && level != null) {
			o.add("verify", verify(l, level, world));
		}
		return o;
	}

	/** For the dev hook: a record's summary (status, counts, extras by kind, sizes, writers). */
	public static JsonObject summary(RegionsImpl.Live l, Realised.Tile rec, boolean cells) {
		JsonObject o = new JsonObject();
		o.addProperty("stage", rec.stage());
		o.addProperty("set", rec.set());
		o.addProperty("key", rec.key());
		o.addProperty("layer", rec.layer());
		o.addProperty("site", rec.site());
		o.addProperty("status", status(l, rec));
		o.addProperty("tileSha", rec.tileShaHex());
		o.addProperty("chainSha", HexFormat.of().formatHex(rec.chainSha()));
		o.addProperty("cells", rec.codes().length);
		o.addProperty("bytes", Realised.encode(rec).length);
		o.addProperty("writersBytes", rec.writers().length);
		int[] ws = Realised.writersSummary(rec.writers());
		if (ws != null) {
			JsonObject w = new JsonObject();
			w.addProperty("ops", ws[0]);
			w.addProperty("cells", ws[1]);
			w.addProperty("runs", ws[2]);
			w.addProperty("loserCells", ws[3]);
			w.addProperty("losers", ws[4]);
			o.add("writers", w);
		}
		JsonObject cc = new JsonObject();
		int[] n = rec.counts();
		for (int k = 0; k < n.length; k++) {
			if (n[k] > 0) {
				cc.addProperty(Realised.codeName(k), n[k]);
			}
		}
		o.add("codes", cc);
		JsonObject ec = new JsonObject();
		int[] en = new int[8];
		rec.extras().forEach(e -> en[e.kind() & 7]++);
		for (int k = 0; k < 4; k++) {
			if (en[k] > 0) {
				ec.addProperty(Realised.extraName(k), en[k]);
			}
		}
		o.add("extras", ec);
		if (cells) {
			JsonArray c = new JsonArray();
			for (byte b : rec.codes()) {
				c.add(b);
			}
			o.add("codeList", c);
			JsonArray e = new JsonArray();
			for (Realised.Extra x : rec.extras()) {
				JsonObject eo = new JsonObject();
				eo.addProperty("kind", Realised.extraName(x.kind()));
				eo.add("pos", posArr(x.pos()));
				eo.addProperty("cause", x.cause());
				e.add(eo);
			}
			o.add("extraList", e);
			o.addProperty("writersB64", java.util.Base64.getEncoder().encodeToString(rec.writers()));
		}
		return o;
	}

	private static JsonArray posArr(long p) {
		JsonArray a = new JsonArray();
		a.add(BlockPos.getX(p));
		a.add(BlockPos.getY(p));
		a.add(BlockPos.getZ(p));
		return a;
	}
}

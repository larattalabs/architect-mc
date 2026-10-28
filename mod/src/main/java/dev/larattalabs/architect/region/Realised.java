package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.zip.CRC32;
import org.jspecify.annotations.Nullable;

/**
 * (RP, realised provenance; docs/CONTRACT.md "RP as built") What a region tile actually realised against what it intended, recorded
 * at the write boundary: per tile, the intent's sha, a code for every intended cell (in {@code evalTile}'s payload order), the
 * extra cells the tile wrote (felled trunks, dependents, held leaves) with the intended cell that caused each, the kit's writers
 * (each cell's winning op and the ops it overwrote in the tile) and a chain hash over every stage and set of the tile's key. Per
 * region, the roads, lots and fluid bodies as realised ({@code sites.json}).
 *
 * <p>Files: {@code <world>/architect-regions/<region>/realised/L<layer>/<stage>.<set>.<tx>.<tz>.bin} (layer 0: the realise; RV's
 * revisions add their own layers and never replace a lower one) and {@code realised/L<layer>/sites.json}. A tile file is written
 * (fsync, rename) <b>before</b> the tile's PLACING journal commit is submitted, with the cell site that commit creates; it is valid
 * only while that site's tile entry is ACTIVE ({@link #status}). A tile with nothing to write has no entry ({@link #NO_ENTRY}): it is
 * written before its item is marked placed and valid once the item is. Invisible to plans, IRs and the API.
 */
public final class Realised {
	public static final int FORMAT = 1;
	private static final byte[] MAGIC = "ARPR".getBytes(StandardCharsets.US_ASCII);

	// ---- cell codes (u8, append only)
	/** The tile's entry wrote the intended state. */
	public static final byte WRITTEN = 0;
	/** The world already held the intended state (nothing written). */
	public static final byte NOOP = 1;
	/** Another entry held the cell (a site, delta, road, cell site, another owner's region). */
	public static final byte HELD = 2;
	/** A player's build cell (6c PT), not consented. */
	public static final byte BUILD = 3;
	/** The intended cell's condition failed against the world. */
	public static final byte COND = 4;
	/** The fluids stage's body gate left the cell out (its body not written: uncontained, held, its lot removed). */
	public static final byte FLUID = 5;
	/** Outside the claim (REGION_LIMIT; the mod never trusts the evaluator for it). */
	public static final byte CLIP = 6;
	/** (RS) A survival target's cell put down but not built yet; RS marks it {@link #WRITTEN} when its target builds it. */
	public static final byte UNFINISHED = 7;
	/** Reserved for RV (§3.4: a revision's patch cell a player changed, kept). Never written by RP. */
	public static final byte KEPT = 8;
	/** Reserved for RV (§3.7: a derived record's cell whose outcome can't be told). Never written by RP. */
	public static final byte UNKNOWN = 9;
	/** E-normal: an air write a fluid beside or in the cell would flow into (TileCheck stage 1), left out. */
	public static final byte FLUID_EDGE = 10;
	/** (6c B) A brush stroke never writes an unbreakable block. */
	public static final byte UNBREAKABLE = 11;
	/** (6c PT) The cell holds up a player's build cell (a torch, door, sand...): left as it is. */
	public static final byte BUILD_SUPPORT = 12;
	static final String[] NAMES = {"WRITTEN", "NOOP", "HELD", "BUILD", "COND", "FLUID", "CLIP", "UNFINISHED", "KEPT", "UNKNOWN", "FLUID_EDGE",
		"UNBREAKABLE", "BUILD_SUPPORT"};

	// ---- extra kinds (u8, append only)
	public static final byte TREE = 0;
	public static final byte DEPENDENT = 1;
	/** A dependent written as a water source (it stood under a natural water surface, 6c H §4.4). */
	public static final byte DEPENDENT_WET = 2;
	/** A leaf held persistent (the tile's {@code leaves} entry). */
	public static final byte LEAF = 3;
	static final String[] EXTRA_NAMES = {"TREE", "DEPENDENT", "DEPENDENT_WET", "LEAF"};

	// ---- header flags
	/** The tile wrote nothing (every cell skipped): no journal entry; {@code site} is empty. */
	public static final int NO_ENTRY = 1;
	/** Reserved for RV §3.7: a record derived after the fact (never by RP). */
	public static final int DERIVED = 2;
	/** The kit's writers (ARWR) are present. */
	public static final int WRITERS = 4;
	/** The writers are stored raw-deflated (always when present; {@link Tile#writers()} is the inflated ARWR). */
	public static final int WRITERS_DEFLATED = 8;

	private Realised() {
	}

	public static String codeName(int c) {
		return c >= 0 && c < NAMES.length ? NAMES[c] : "code" + c;
	}

	public static String extraName(int k) {
		return k >= 0 && k < EXTRA_NAMES.length ? EXTRA_NAMES[k] : "kind" + k;
	}

	/**
	 * The code of one intended cell from TileCheck's decisions, in its order (ownership first, then a build, then the world's state).
	 * TileCheck calls this for every cell it reads.
	 */
	public static byte decide(boolean owned, boolean buildKept, boolean unbreakable, boolean condPasses, boolean same) {
		if (owned) {
			return HELD;
		}
		if (buildKept) {
			return BUILD;
		}
		if (unbreakable) {
			return UNBREAKABLE;
		}
		if (!condPasses) {
			return COND;
		}
		return same ? NOOP : WRITTEN;
	}

	/** An extra cell: its kind, position and the intended cell (payload index) whose write caused it (-1: not known). */
	public record Extra(byte kind, long pos, int cause) {
	}

	/** What TileCheck decided for a tile, over the unfiltered tile's cells (codes in payload order). */
	public record Draft(byte[] codes, List<Extra> extras) {
	}

	/** One tile's record (see the class comment). */
	public record Tile(int layer, String stage, String set, String key, String site, int flags, byte[] tileSha, byte[] chainSha, byte[] codes,
		List<Extra> extras, byte[] writers) {
		public boolean noEntry() {
			return (flags & NO_ENTRY) != 0;
		}

		/** The tile's entries' cell sites, newest first (several when an earlier attempt's entry stood: see the as-built §6). */
		public List<String> sites() {
			return site.isEmpty() ? List.of() : List.of(site.split(","));
		}

		public int[] counts() {
			int[] n = new int[NAMES.length];
			for (byte c : codes) {
				if (c >= 0 && c < n.length) {
					n[c]++;
				}
			}
			return n;
		}

		public String tileShaHex() {
			return HexFormat.of().formatHex(tileSha);
		}
	}

	// ------------------------------------------------------------------ the draft (TileCheck, off the server thread)

	/**
	 * The draft over the unfiltered tile: {@code filtered} is the tile TileCheck checked (the fluids gate's {@link RegionFluids#filter}
	 * drops cells, keeping the order), {@code fcodes} its codes (by filtered index), extras' causes by filtered index. A cell of
	 * {@code original} missing from {@code filtered} is {@link #FLUID}. Pure.
	 */
	public static Draft draft(Packed.Tile original, Packed.Tile filtered, byte[] fcodes, List<Extra> fextras) {
		int n = original.size();
		byte[] codes = new byte[n];
		int[] f2o = new int[filtered.size()];
		int j = 0;
		for (int i = 0; i < n; i++) {
			if (j < f2o.length && filtered.pos()[j] == original.pos()[i]) {
				f2o[j] = i;
				codes[i] = fcodes[j];
				j++;
			} else {
				codes[i] = FLUID;
			}
		}
		if (j != f2o.length) {
			throw new IllegalStateException("the filtered tile is not a subsequence of the tile (" + j + " of " + f2o.length + ")");
		}
		List<Extra> ex = new ArrayList<>(fextras.size());
		for (Extra e : fextras) {
			ex.add(new Extra(e.kind(), e.pos(), e.cause() >= 0 && e.cause() < f2o.length ? f2o[e.cause()] : -1));
		}
		ex.sort((a, b) -> Long.compare(a.pos(), b.pos()));
		return new Draft(codes, List.copyOf(ex));
	}

	// ------------------------------------------------------------------ encoding (ARPR v1)

	/**
	 * ARPR v1, little endian, LEB128 varints: "ARPR", u8 version 1, u8 flags; varint layer; strings (varint length + UTF-8) stage, set,
	 * key, site; 32 bytes tileSha; 32 bytes chainSha; varint nCells; varint nRuns, per run u8 code + varint length (payload order);
	 * varint nExtras, per extra (ascending position) u8 kind, zigzag varint position delta (BlockPos.asLong, from 0), varint cause + 1
	 * (0: unknown); varint writers length + the ARWR bytes raw-deflated (flag WRITERS_DEFLATED); u32 CRC32 of every byte before it.
	 */
	public static byte[] encode(Tile t) {
		Out o = new Out(64 + t.codes().length / 8 + t.extras().size() * 6 + t.writers().length);
		o.bytes(MAGIC);
		o.u8(FORMAT);
		byte[] wz = t.writers().length > 0 ? deflate(t.writers()) : new byte[0];
		o.u8((t.flags() & ~(WRITERS | WRITERS_DEFLATED)) | (wz.length > 0 ? WRITERS | WRITERS_DEFLATED : 0));
		o.varint(t.layer());
		o.str(t.stage());
		o.str(t.set());
		o.str(t.key());
		o.str(t.site());
		o.bytes(sha32(t.tileSha()));
		o.bytes(sha32(t.chainSha()));
		byte[] c = t.codes();
		o.varint(c.length);
		int runs = 0;
		for (int i = 0; i < c.length; i++) {
			if (i == 0 || c[i] != c[i - 1]) {
				runs++;
			}
		}
		o.varint(runs);
		for (int i = 0; i < c.length;) {
			int k = i + 1;
			while (k < c.length && c[k] == c[i]) {
				k++;
			}
			o.u8(c[i]);
			o.varint(k - i);
			i = k;
		}
		o.varint(t.extras().size());
		long prev = 0;
		for (Extra e : t.extras()) {
			o.u8(e.kind());
			o.zigzag(e.pos() - prev);
			prev = e.pos();
			o.varint(e.cause() + 1L);
		}
		o.varint(wz.length);
		o.bytes(wz);
		CRC32 crc = new CRC32();
		crc.update(o.buf, 0, o.len);
		long v = crc.getValue();
		o.u8((int) v);
		o.u8((int) (v >>> 8));
		o.u8((int) (v >>> 16));
		o.u8((int) (v >>> 24));
		return Arrays.copyOf(o.buf, o.len);
	}

	public static Tile decode(byte[] a) throws IOException {
		if (a.length < 8 || !Arrays.equals(Arrays.copyOf(a, 4), MAGIC)) {
			throw new IOException("not an ARPR record");
		}
		CRC32 crc = new CRC32();
		crc.update(a, 0, a.length - 4);
		long want = (a[a.length - 4] & 0xffL) | (a[a.length - 3] & 0xffL) << 8 | (a[a.length - 2] & 0xffL) << 16 | (a[a.length - 1] & 0xffL) << 24;
		if (crc.getValue() != want) {
			throw new IOException("ARPR record CRC mismatch");
		}
		In in = new In(a, 4, a.length - 4);
		int ver = in.u8();
		if (ver != FORMAT) {
			throw new IOException("ARPR version " + ver);
		}
		int flags = in.u8();
		int layer = (int) in.varint();
		String stage = in.str();
		String set = in.str();
		String key = in.str();
		String site = in.str();
		byte[] tileSha = in.bytes(32);
		byte[] chainSha = in.bytes(32);
		int n = (int) in.varint();
		byte[] codes = new byte[n];
		long runs = in.varint();
		int at = 0;
		for (long r = 0; r < runs; r++) {
			byte code = (byte) in.u8();
			int len = (int) in.varint();
			if (at + len > n) {
				throw new IOException("ARPR runs overflow the cells");
			}
			Arrays.fill(codes, at, at + len, code);
			at += len;
		}
		if (at != n) {
			throw new IOException("ARPR runs cover " + at + " of " + n + " cells");
		}
		int ne = (int) in.varint();
		List<Extra> ex = new ArrayList<>(ne);
		long prev = 0;
		for (int i = 0; i < ne; i++) {
			byte kind = (byte) in.u8();
			prev += in.zigzag();
			ex.add(new Extra(kind, prev, (int) (in.varint() - 1)));
		}
		byte[] writers = in.bytes((int) in.varint());
		if ((flags & WRITERS_DEFLATED) != 0 && writers.length > 0) {
			writers = inflate(writers);
		}
		if (in.p != a.length - 4) {
			throw new IOException("ARPR trailing bytes");
		}
		return new Tile(layer, stage, set, key, site, flags, tileSha, chainSha, codes, List.copyOf(ex), writers);
	}

	/** Raw deflate, level 6 (the writers: ~57x smaller on overlapping ops, measured on mega_bench). */
	static byte[] deflate(byte[] b) {
		java.util.zip.Deflater d = new java.util.zip.Deflater(6, true);
		try {
			d.setInput(b);
			d.finish();
			java.io.ByteArrayOutputStream o = new java.io.ByteArrayOutputStream(Math.max(64, b.length / 8));
			byte[] buf = new byte[8192];
			while (!d.finished()) {
				o.write(buf, 0, d.deflate(buf));
			}
			return o.toByteArray();
		} finally {
			d.end();
		}
	}

	static byte[] inflate(byte[] b) throws IOException {
		java.util.zip.Inflater f = new java.util.zip.Inflater(true);
		try {
			f.setInput(b);
			java.io.ByteArrayOutputStream o = new java.io.ByteArrayOutputStream(b.length * 8);
			byte[] buf = new byte[8192];
			while (!f.finished()) {
				int n = f.inflate(buf);
				if (n == 0 && (f.needsInput() || f.needsDictionary())) {
					throw new IOException("ARPR writers truncated");
				}
				o.write(buf, 0, n);
			}
			return o.toByteArray();
		} catch (java.util.zip.DataFormatException e) {
			throw new IOException("ARPR writers: " + e.getMessage());
		} finally {
			f.end();
		}
	}

	private static byte[] sha32(byte[] s) {
		return s.length == 32 ? s : Arrays.copyOf(s, 32);
	}

	// ------------------------------------------------------------------ the chain hash

	/**
	 * The chain hash of a key up to and including (stage, set): SHA-256 over the UTF-8 lines {@code <stage>\t<set>\t<tileSha hex>\n},
	 * one per (stage, set) the IR lists the key under, in write order (the IR's stages in order; terrain before path), up to and
	 * including this one; a writer before it with no record at this layer contributes {@code -} for its sha. The chain of the key's
	 * last writer is its composed hash ({@link #composedSha}). Not interchangeable with a tile sha (one stage and set's payload).
	 */
	public static byte[] chain(Ir ir, String stage, String set, String key, java.util.function.Function<String[], @Nullable String> shaOf) {
		StringBuilder sb = new StringBuilder();
		for (String[] w : writers(ir, key)) {
			boolean me = w[0].equals(stage) && w[1].equals(set);
			String sha = shaOf.apply(w);
			sb.append(w[0]).append('\t').append(w[1]).append('\t').append(sha == null ? "-" : sha).append('\n');
			if (me) {
				break;
			}
		}
		return sha256(sb.toString().getBytes(StandardCharsets.UTF_8));
	}

	/** Every (stage, set) the IR lists {@code key} under, in write order. */
	public static List<String[]> writers(Ir ir, String key) {
		List<String[]> out = new ArrayList<>();
		for (String st : ir.stages()) {
			if (ir.terrainTiles().getOrDefault(st, List.of()).contains(key)) {
				out.add(new String[] {st, "terrain"});
			}
			if (ir.pathTiles().getOrDefault(st, List.of()).contains(key)) {
				out.add(new String[] {st, "path"});
			}
		}
		return out;
	}

	static byte[] sha256(byte[] b) {
		try {
			return MessageDigest.getInstance("SHA-256").digest(b);
		} catch (java.security.NoSuchAlgorithmException e) {
			throw new IllegalStateException(e);
		}
	}

	// ------------------------------------------------------------------ files

	/** {@code <world>/architect-regions/<region>/realised/L<layer>}. */
	public static Path dir(Path world, String region, int layer) {
		return RegionStore.region(world, region).resolve("realised").resolve("L" + layer);
	}

	/** {@code <stage>.<set>.<tx>.<tz>.bin}, the stage escaped (any byte but [A-Za-z0-9_-] as %XX). */
	public static String fileName(String stage, String set, String key) {
		return esc(stage) + "." + esc(set) + "." + key.replace(',', '.') + ".bin";
	}

	private static String esc(String s) {
		StringBuilder b = new StringBuilder();
		for (byte c : s.getBytes(StandardCharsets.UTF_8)) {
			if (c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
				b.append((char) c);
			} else {
				b.append('%').append(String.format(java.util.Locale.ROOT, "%02X", c & 0xff));
			}
		}
		return b.toString();
	}

	public static Path file(Path world, String region, int layer, String stage, String set, String key) {
		return dir(world, region, layer).resolve(fileName(stage, set, key));
	}

	/** Writes a tile's record (fsync, rename). Its bytes' length. */
	public static int write(Path world, String region, Tile t) throws IOException {
		byte[] b = encode(t);
		RegionStore.write(file(world, region, t.layer(), t.stage(), t.set(), t.key()), b);
		return b.length;
	}

	public static @Nullable Tile read(Path world, String region, int layer, String stage, String set, String key) throws IOException {
		byte[] b = RegionStore.read(file(world, region, layer, stage, set, key));
		return b == null ? null : decode(b);
	}

	public static void discard(Path world, String region, int layer, String stage, String set, String key) {
		try {
			Files.deleteIfExists(file(world, region, layer, stage, set, key));
		} catch (IOException e) {
			Architect.LOGGER.warn("Region {}: realised record {} {} {} could not be removed: {}", region, stage, set, key, e.toString());
		}
	}

	/** The tile sha a record at this layer holds, else null (the chain's lookup). */
	public static @Nullable String shaAt(Path world, String region, int layer, String stage, String set, String key) {
		try {
			Tile t = read(world, region, layer, stage, set, key);
			return t == null ? null : t.tileShaHex();
		} catch (IOException e) {
			return null;
		}
	}

	/** The composed hash of a key: the chain of its last writer's record at the layer (null if that writer has no record). */
	public static @Nullable String composedSha(Path world, String region, int layer, Ir ir, String key) {
		List<String[]> ws = writers(ir, key);
		if (ws.isEmpty()) {
			return null;
		}
		String[] last = ws.get(ws.size() - 1);
		try {
			Tile t = read(world, region, layer, last[0], last[1], key);
			return t == null ? null : HexFormat.of().formatHex(t.chainSha());
		} catch (IOException e) {
			return null;
		}
	}

	// ------------------------------------------------------------------ RS: cells built later

	/**
	 * (RS) Re-marks cells of a tile's record (by payload index) with {@code code}: a survival target's cells are {@link #UNFINISHED}
	 * at put-down ({@link #withCodes} on the draft) and become {@link #WRITTEN} here when its target builds them. Rewritten whole
	 * (fsync, rename); false when the tile has no record. Server thread.
	 */
	public static boolean mark(Path world, String region, int layer, String stage, String set, String key, int[] cells, byte code) throws IOException {
		return mark(world, region, layer, stage, set, key, cells, code, null);
	}

	/**
	 * {@link #mark(Path, String, int, String, String, String, int[], byte)}; with {@code site} (the batch v0.41.0's RS wiring: a target
	 * that built its cells), that target's cell site is added to the record's entries (after the free-pass entry; {@link Tile#sites()})
	 * and the record loses {@link #NO_ENTRY} (a tile with no free-pass cell has its first entry once a target builds), so the RP verify
	 * reads the target's entry with its WRITTEN cells. Idempotent.
	 */
	public static synchronized boolean mark(Path world, String region, int layer, String stage, String set, String key, int[] cells, byte code,
		@Nullable String site) throws IOException {
		Tile t = read(world, region, layer, stage, set, key);
		if (t == null) {
			return false;
		}
		byte[] c = t.codes().clone();
		for (int i : cells) {
			if (i >= 0 && i < c.length) {
				c[i] = code;
			}
		}
		String sites = t.site();
		int flags = t.flags();
		if (site != null && !t.sites().contains(site)) {
			sites = sites.isEmpty() ? site : sites + "," + site;
			flags &= ~NO_ENTRY;
		}
		write(world, region, new Tile(t.layer(), t.stage(), t.set(), t.key(), sites, flags, t.tileSha(), t.chainSha(), c, t.extras(), t.writers()));
		return true;
	}

	/**
	 * A tile ran again while an earlier attempt's entry stands (a crash after its commit, before its item was marked placed: the
	 * queue runs the item again and the earlier entry stays ACTIVE). The new record keeps that attempt: its sites listed after the
	 * new one, a cell it WROTE stays WRITTEN, its extras kept. Only over the same intent (tile sha) and cell count. Pure.
	 */
	public static Tile mergePrior(Tile now, Tile was, List<String> standing) {
		if (standing.isEmpty() || !Arrays.equals(now.tileSha(), was.tileSha()) || now.codes().length != was.codes().length) {
			return now;
		}
		byte[] c = now.codes().clone();
		for (int i = 0; i < c.length; i++) {
			if (was.codes()[i] == WRITTEN) {
				c[i] = WRITTEN;
			}
		}
		java.util.Map<Long, Extra> ex = new java.util.TreeMap<>();
		for (Extra e : was.extras()) {
			ex.put(e.pos(), e);
		}
		for (Extra e : now.extras()) {
			ex.put(e.pos(), e);
		}
		List<String> sites = new ArrayList<>(now.sites());
		for (String s : standing) {
			if (!sites.contains(s)) {
				sites.add(s);
			}
		}
		List<Extra> el = new ArrayList<>(ex.values());
		el.sort((a, b) -> Long.compare(a.pos(), b.pos()));
		return new Tile(now.layer(), now.stage(), now.set(), now.key(), String.join(",", sites), now.flags() & ~NO_ENTRY, now.tileSha(), now.chainSha(), c,
			List.copyOf(el), now.writers());
	}

	/** (RS) The draft with {@code cells} (payload indexes) re-coded, before the record is written (a target's cells: UNFINISHED). */
	public static Draft withCodes(Draft d, int[] cells, byte code) {
		byte[] c = d.codes().clone();
		for (int i : cells) {
			if (i >= 0 && i < c.length) {
				c[i] = code;
			}
		}
		return new Draft(c, d.extras());
	}

	// ------------------------------------------------------------------ roads, lots and bodies (sites.json)

	public static Path sitesFile(Path world, String region, int layer) {
		return dir(world, region, layer).resolve("sites.json");
	}

	/** Updates one member ({@code roads}, {@code lots} or {@code bodies}) entry of sites.json (rewritten whole: fsync, rename). */
	public static void putSite(Path world, String region, int layer, String member, String id, JsonObject entry) {
		putSites(world, region, layer, member, Map.of(id, entry));
	}

	/** {@link #putSite} for several entries of one member, in one write. */
	public static synchronized void putSites(Path world, String region, int layer, String member, Map<String, JsonObject> entries) {
		if (entries.isEmpty()) {
			return;
		}
		try {
			Path f = sitesFile(world, region, layer);
			JsonObject o = RegionStore.readJson(f);
			if (o == null) {
				o = new JsonObject();
				o.addProperty("format", FORMAT);
				o.addProperty("layer", layer);
			}
			JsonObject m = o.has(member) ? o.getAsJsonObject(member) : new JsonObject();
			entries.forEach(m::add);
			o.add(member, m);
			RegionStore.writeJson(f, o);
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("Region {}: realised {} {} could not be recorded: {}", region, member, entries.keySet(), e.toString());
		}
	}

	/** sites.json as written, or null. */
	public static @Nullable JsonObject sites(Path world, String region, int layer) {
		try {
			return RegionStore.readJson(sitesFile(world, region, layer));
		} catch (IOException | RuntimeException e) {
			return null;
		}
	}

	/** A road's entry: its site, the cells planned, its skipped spans (a partial road, 6c 0c) and its state. */
	public static JsonObject road(String site, int cells, List<dev.larattalabs.architect.site.roads.RoadPlan.Span> spans, String state) {
		JsonObject o = new JsonObject();
		o.addProperty("site", site);
		o.addProperty("cells", cells);
		JsonArray a = new JsonArray();
		for (var s : spans) {
			JsonObject x = new JsonObject();
			x.addProperty("from", s.fromPoint());
			x.addProperty("to", s.toPoint());
			x.addProperty("reason", s.reason());
			x.add("at", arr(s.x(), s.y(), s.z()));
			a.add(x);
		}
		o.add("skipped", a);
		o.addProperty("state", state);
		o.addProperty("at", System.currentTimeMillis());
		return o;
	}

	private static JsonArray arr(int... v) {
		JsonArray a = new JsonArray();
		for (int x : v) {
			a.add(x);
		}
		return a;
	}

	/** Rows last recorded per region and body (only a changed row is written again). */
	private static final Map<String, String> BODY_ROWS = new java.util.concurrent.ConcurrentHashMap<>();

	/**
	 * (6c H) The bodies' outcomes, recorded in the same call that saved fluids.json (after it): each body's state (written, settled,
	 * drained) with the flags that ended it. Only rows that changed are written.
	 */
	static void bodies(Path world, String region, Map<String, JsonObject> rows) {
		bodies(world, region, 0, rows);
	}

	/** (6d RV) {@link #bodies} at a layer: a revision's bodies in its own layer's sites.json. */
	static void bodies(Path world, String region, int layer, Map<String, JsonObject> rows) {
		Map<String, JsonObject> changed = new java.util.LinkedHashMap<>();
		rows.forEach((id, row) -> {
			String k = region + "|" + layer + "|" + id;
			String v = row.toString();
			if (!v.equals(BODY_ROWS.get(k)) || !Files.isRegularFile(sitesFile(world, region, layer))) {
				changed.put(id, row);
				BODY_ROWS.put(k, v);
			}
		});
		putSites(world, region, layer, "bodies", changed);
	}

	// ------------------------------------------------------------------ byte streams

	static final class Out {
		byte[] buf;
		int len;

		Out(int cap) {
			buf = new byte[Math.max(64, cap)];
		}

		void ensure(int n) {
			if (len + n > buf.length) {
				buf = Arrays.copyOf(buf, Math.max(buf.length * 2, len + n));
			}
		}

		void u8(int v) {
			ensure(1);
			buf[len++] = (byte) v;
		}

		void bytes(byte[] b) {
			ensure(b.length);
			System.arraycopy(b, 0, buf, len, b.length);
			len += b.length;
		}

		void varint(long v) {
			ensure(10);
			while ((v & ~0x7fL) != 0) {
				buf[len++] = (byte) ((v & 0x7f) | 0x80);
				v >>>= 7;
			}
			buf[len++] = (byte) v;
		}

		void zigzag(long v) {
			varint((v << 1) ^ (v >> 63));
		}

		void str(String s) {
			byte[] b = s.getBytes(StandardCharsets.UTF_8);
			varint(b.length);
			bytes(b);
		}
	}

	static final class In {
		final byte[] a;
		int p;
		final int end;

		In(byte[] a, int p, int end) {
			this.a = a;
			this.p = p;
			this.end = end;
		}

		int u8() throws IOException {
			if (p >= end) {
				throw new IOException("ARPR truncated");
			}
			return a[p++] & 0xff;
		}

		long varint() throws IOException {
			long v = 0;
			int s = 0;
			int b;
			do {
				b = u8();
				v |= (long) (b & 0x7f) << s;
				s += 7;
			} while ((b & 0x80) != 0 && s < 70);
			return v;
		}

		long zigzag() throws IOException {
			long u = varint();
			return (u >>> 1) ^ -(u & 1);
		}

		byte[] bytes(int n) throws IOException {
			if (n < 0 || p + n > end) {
				throw new IOException("ARPR truncated");
			}
			byte[] b = Arrays.copyOfRange(a, p, p + n);
			p += n;
			return b;
		}

		String str() throws IOException {
			return new String(bytes((int) varint()), StandardCharsets.UTF_8);
		}
	}

	/**
	 * A summary of ARWR v1 writers ({@code kit/lib/realise.mjs encodeWriters}): {ops, cells, runs, loserCells, losers}; null when they
	 * can't be read.
	 */
	public static int @Nullable [] writersSummary(byte[] w) {
		if (w.length < 5 || w[0] != 'A' || w[1] != 'R' || w[2] != 'W' || w[3] != 'R' || w[4] != 1) {
			return null;
		}
		try {
			In in = new In(w, 5, w.length);
			int ops = (int) in.varint();
			for (int i = 0; i < ops; i++) {
				in.str();
				in.varint();
				in.varint();
				in.u8();
			}
			int cells = (int) in.varint();
			int runs = (int) in.varint();
			for (int i = 0; i < runs; i++) {
				in.varint();
				in.varint();
			}
			int lc = (int) in.varint();
			int losers = 0;
			for (int i = 0; i < lc; i++) {
				in.varint();
				int k = (int) in.varint();
				losers += k;
				for (int j = 0; j < k; j++) {
					in.varint();
				}
			}
			return in.p == w.length ? new int[] {ops, cells, runs, lc, losers} : null;
		} catch (IOException e) {
			return null;
		}
	}

	/** Gunzips the wire's writers (null on any error: the record goes without them). */
	public static byte @Nullable [] gunzip(byte @Nullable [] gz) {
		if (gz == null) {
			return null;
		}
		try {
			return Packed.gunzip(gz);
		} catch (IOException e) {
			return null;
		}
	}
}

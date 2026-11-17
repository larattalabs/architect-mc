package dev.larattalabs.architect.site;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.jspecify.annotations.Nullable;

/**
 * (slice T0, docs/TXN-DESIGN.md on slice/TXN §3.1 "Step 0") One durable write primitive: PSV's queue writer (Placement.writeSave on
 * slice/PSV f68b7716: a temp file written and forced, an atomic rename, the parent directory forced) lifted out and given a typed result and
 * persisted generations.
 * <ul>
 * <li>{@link #request()} takes the next generation (no IO). A snapshot written for generation {@code g} holds every change made before
 * {@code g} was requested.</li>
 * <li>{@link #write} writes the snapshot with a member {@value #MEMBER} {@code {store, type, gen}} in the file itself: {@code store} is this
 * file's own id (a UUID minted when the file is first written and kept across rewrites, {@link #id}), {@code type} the label the caller gave
 * ({@link #store}). A new instance reads both back, so a generation means the same after a restart and an await {@code {id, gen}} is met
 * only by the same file ({@link #satisfies}).</li>
 * <li><b>Loading confirms nothing by itself</b> (TXN review 3, item 1): a generation read back at construction counts as written only once
 * the file and its folders were forced again ({@link #confirm}); a rename that was IN_DOUBT before a process restart may still be only in the
 * page cache.</li>
 * <li>The result is {@link Outcome#OK} (written, forced, renamed, the directory forced: {@link #written} answers true from now on),
 * {@link Outcome#REFUSED} (a failure before the rename: the file on disk is the previous one) or {@link Outcome#IN_DOUBT} (the rename
 * happened, a later force failed: the new file may or may not survive a power loss). IN_DOUBT is never "not committed": the caller must
 * treat the snapshot as possibly on disk, and {@link #inDoubt} answers it until a later write is OK.</li>
 * <li>An obsolete generation (older than the one installed) never replaces the file (review P2-9).</li>
 * <li>A folder the write creates has its own entry forced in its parent before the snapshot is renamed into it (review P1-6), and the
 * file's folder and its parent have their entries confirmed once a process even when they already existed ({@link #confirmChain}, TXN
 * review 4 item 1: an earlier session may have crashed before its force).</li>
 * <li>A folder that can't be opened for reading is best effort only on Windows (logged once); elsewhere the open's failure is the force's
 * (review P1-5).</li>
 * </ul>
 * Any thread; writes are serialised per instance.
 */
public final class DurableFile {
	/** The member every snapshot carries: {@code {"store": id, "type": label, "gen": n}}. */
	public static final String MEMBER = "_durable";

	/** A write's outcome. */
	public enum Outcome {
		OK, REFUSED, IN_DOUBT
	}

	/** A write's result: its outcome, its generation, and why when not OK. */
	public record Result(Outcome outcome, long gen, @Nullable String reason) {
		public boolean ok() {
			return outcome == Outcome.OK;
		}
	}

	/** (TEST seam) The forces: a file's channel, a directory. */
	interface Forcer {
		void file(FileChannel ch) throws IOException;

		void dir(Path dir) throws IOException;
	}

	static final Forcer REAL = new Forcer() {
		@Override
		public void file(FileChannel ch) throws IOException {
			ch.force(true);
		}

		@Override
		public void dir(Path dir) throws IOException {
			forceDir(dir);
		}
	};

	/** (TEST) The forces every instance uses; the units swap it to fail one. */
	static volatile Forcer FORCER = REAL;
	/** (TEST) The next writes that fail before the rename (a full disk). */
	static final AtomicInteger FAIL_BEFORE_RENAME = new AtomicInteger();
	/** (TEST) Whether a folder that can't be opened is best effort (Windows); the units set it. */
	static volatile boolean dirOpenBestEffort = System.getProperty("os.name", "").toLowerCase(Locale.ROOT).startsWith("windows");

	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create(); // as Stockpiles writes it
	private static volatile boolean dirUnsupportedLogged;

	private final String store;
	private final String id;
	private final Path file;
	private final AtomicLong requested = new AtomicLong();
	private final AtomicLong written = new AtomicLong();
	/** The highest generation renamed into place (OK, IN_DOUBT or unforced). */
	private final AtomicLong installed = new AtomicLong();
	private volatile long inDoubtGen;
	private volatile boolean failing;
	/** Folders this instance created whose entry in their parent is not forced yet (retried before every write). */
	private final Set<Path> newDirs = ConcurrentHashMap.newKeySet();

	/**
	 * A store's durable file of type {@code store}; its generations go on from the one its file on disk carries (0 with none). The loaded
	 * generation counts as written only after {@link #confirm} (run here once) forced the file and its folders again.
	 */
	public DurableFile(String store, Path file) {
		this.store = store;
		this.file = file;
		Meta m = readMeta(file, store);
		this.id = m.id != null ? m.id : UUID.randomUUID().toString();
		requested.set(m.gen);
		installed.set(m.gen);
		if (m.gen > 0) {
			Result r = confirm();
			if (!r.ok()) {
				Architect.LOGGER.warn("Durable file {} ({}): generation {} loaded but not confirmed on disk ({}): in doubt until a write is OK", file,
					store, m.gen, r.reason());
			}
		}
	}

	/** The type label this file was made with ({@code "stockpiles"}). */
	public String store() {
		return store;
	}

	/** (review P1-8) This file's own id, persisted in it: an await records it, and a file with another id satisfies nothing. */
	public String id() {
		return id;
	}

	public Path file() {
		return file;
	}

	/** The next generation (no IO). */
	public long request() {
		return requested.incrementAndGet();
	}

	/** The highest generation whose write was OK (or the one read back at construction and confirmed). */
	public long writtenGen() {
		return written.get();
	}

	/** The highest generation renamed into place, confirmed or not. */
	public long installedGen() {
		return installed.get();
	}

	/** Whether generation {@code gen} is known on disk: a write at or after it was OK. */
	public boolean written(long gen) {
		return written.get() >= gen;
	}

	/** Whether an await {@code {id, gen}} is met: this very file (the same id) with generation {@code gen} known on disk. */
	public boolean satisfies(String id, long gen) {
		return this.id.equals(id) && written(gen);
	}

	/** Whether the last write failed (REFUSED or IN_DOUBT) and none was OK since. */
	public boolean failing() {
		return failing;
	}

	/** The generation of an IN_DOUBT write no OK write has covered since, or 0. */
	public long inDoubt() {
		return inDoubtGen > written.get() ? inDoubtGen : 0;
	}

	/**
	 * Forces the installed file, its folder and that folder's entry in its parent again; OK makes the installed generation written. A load's
	 * generation and an IN_DOUBT one are confirmed this way (a retry needs no new snapshot).
	 */
	public synchronized Result confirm() {
		long g = installed.get();
		if (g == 0 || !Files.exists(file)) {
			return new Result(g == 0 ? Outcome.OK : Outcome.REFUSED, g, g == 0 ? null : "no file");
		}
		Path dir = file.toAbsolutePath().getParent();
		try {
			forceDirsCreated();
			try (FileChannel ch = FileChannel.open(file, StandardOpenOption.READ)) {
				FORCER.file(ch);
			}
			FORCER.dir(dir);
			confirmChain(dir, 2);
		} catch (IOException | RuntimeException e) {
			failing = true;
			inDoubtGen = Math.max(inDoubtGen, g);
			return new Result(Outcome.IN_DOUBT, g, "confirm: " + e);
		}
		written.accumulateAndGet(g, Math::max);
		failing = false;
		return new Result(Outcome.OK, g, null);
	}

	/** Writes {@code root} (not changed; a copy carries {@value #MEMBER}) as generation {@code gen}. */
	public synchronized Result write(JsonObject root, long gen) {
		Result obsolete = obsolete(gen);
		if (obsolete != null) {
			return obsolete;
		}
		Path dir = file.toAbsolutePath().getParent();
		try {
			install(root, gen, true);
		} catch (IOException | RuntimeException e) {
			failing = true;
			Architect.LOGGER.warn("Durable file {} ({}): generation {} not written: {}", file, store, gen, e.toString());
			return new Result(Outcome.REFUSED, gen, "write: " + e);
		}
		try {
			FORCER.dir(dir);
		} catch (IOException | RuntimeException e) {
			failing = true;
			inDoubtGen = Math.max(inDoubtGen, gen);
			Architect.LOGGER.error("Durable file {} ({}): generation {} renamed but its folder's force failed ({}): in doubt", file, store, gen, e.toString());
			return new Result(Outcome.IN_DOUBT, gen, "directory force: " + e);
		}
		failing = false;
		written.accumulateAndGet(gen, Math::max);
		return new Result(Outcome.OK, gen, null);
	}

	/**
	 * An unforced save of the same file: temp and rename only, with this file's {@value #MEMBER} kept in it. The generation is installed,
	 * not written, and it <b>un-acknowledges</b> every earlier generation (T0 review 2 finding 6: a power loss may tear the unforced file
	 * that replaced them): {@link #written} answers false until a forced write or {@link #confirm} covers it. The ledger no longer uses it.
	 * False when it was not renamed (an IO failure or an obsolete generation).
	 */
	public synchronized boolean writeUnforced(JsonObject root, long gen) {
		if (gen < installed.get()) {
			return false;
		}
		try {
			install(root, gen, false);
			// (T0 review 2 finding 6) the unforced file replaced the acknowledged one: after a power loss it may be torn, so nothing counts
			// as written until a forced write or confirm() covers it
			written.set(0);
			return true;
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("Could not save {}: {}", file, e.toString());
			return false;
		}
	}

	/** (P2-9) An older generation than the one installed never replaces it: OK when a covering write is known, else refused or in doubt. */
	private @Nullable Result obsolete(long gen) {
		if (gen >= installed.get()) {
			return null;
		}
		if (written(gen)) {
			return new Result(Outcome.OK, gen, null);
		}
		if (inDoubtGen >= gen) {
			return new Result(Outcome.IN_DOUBT, gen, "obsolete: generation " + installed.get() + " is installed, in doubt");
		}
		return new Result(Outcome.REFUSED, gen, "obsolete: generation " + installed.get() + " is installed");
	}

	private void install(JsonObject root, long gen, boolean forced) throws IOException {
		JsonObject out = root.deepCopy();
		out.remove(MEMBER);
		JsonObject d = new JsonObject();
		d.addProperty("store", id);
		d.addProperty("type", store);
		d.addProperty("gen", gen);
		out.add(MEMBER, d);
		byte[] bytes = GSON.toJson(out).getBytes(StandardCharsets.UTF_8);
		Path dir = file.toAbsolutePath().getParent();
		Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
		if (FAIL_BEFORE_RENAME.get() > 0 && FAIL_BEFORE_RENAME.getAndDecrement() > 0) {
			throw new IOException("injected write failure (TEST)");
		}
		createDirs(dir);
		if (forced) {
			forceDirsCreated();
			confirmChain(dir, 2); // (TXN review 4 item 1) its folder's entry and its parent's, even when an earlier session made them
		}
		try (FileChannel ch = FileChannel.open(tmp, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE)) {
			ByteBuffer b = ByteBuffer.wrap(bytes);
			while (b.hasRemaining()) {
				ch.write(b);
			}
			if (forced) {
				FORCER.file(ch);
			}
		}
		Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
		installed.accumulateAndGet(gen, Math::max);
		requested.accumulateAndGet(gen, Math::max);
	}

	/** Creates the missing folders of {@code dir}, each one remembered until its entry in its parent is forced. */
	private void createDirs(Path dir) throws IOException {
		List<Path> missing = new ArrayList<>();
		for (Path p = dir; p != null && !Files.isDirectory(p); p = p.getParent()) {
			missing.add(p);
		}
		if (missing.isEmpty()) {
			return;
		}
		Files.createDirectories(dir);
		newDirs.addAll(missing);
	}

	/** (P1-6) Each created folder's entry forced in its parent, outermost first; a failure keeps the rest owed (the write is refused). */
	private void forceDirsCreated() throws IOException {
		if (newDirs.isEmpty()) {
			return;
		}
		List<Path> ds = new ArrayList<>(newDirs);
		ds.sort(Comparator.comparingInt(Path::getNameCount));
		for (Path p : ds) {
			Path parent = p.getParent();
			if (parent != null) {
				FORCER.dir(parent);
			}
			newDirs.remove(p);
		}
	}

	/** Folders whose own entry (in their parent) was forced in this process: a folder an earlier session made may never have been. */
	private static final Set<Path> CHAIN_CONFIRMED = ConcurrentHashMap.newKeySet();

	/**
	 * (TXN review 4 item 1) {@code dir}'s entry and those of its next {@code levels - 1} ancestors confirmed: each one's parent forced, once a
	 * process (a folder that already exists may come from an earlier session that crashed before its parent's force). Before anything in it
	 * is acknowledged: the ledger's {@code world/architect}, {@code playerdata}, the region folders. Throws as a failed force.
	 */
	public static void confirmChain(Path dir, int levels) throws IOException {
		Path d = dir.toAbsolutePath().normalize();
		for (int i = 0; i < levels && d != null && d.getParent() != null; i++, d = d.getParent()) {
			if (CHAIN_CONFIRMED.contains(d)) {
				continue;
			}
			FORCER.dir(d.getParent());
			CHAIN_CONFIRMED.add(d);
		}
	}

	/** The generation a store's file carries ({@value #MEMBER}), or 0 (no file, unreadable, another type's, or written before T0). */
	public static long readGen(Path file, String store) {
		return readMeta(file, store).gen;
	}

	/** The id a store's file carries ({@value #MEMBER} {@code store}), or null (no file, unreadable, another type's, or a pre-id file). */
	public static @Nullable String readId(Path file, String store) {
		return readMeta(file, store).id;
	}

	private record Meta(long gen, @Nullable String id) {
	}

	private static Meta readMeta(Path file, String store) {
		try {
			if (!Files.exists(file)) {
				return new Meta(0, null);
			}
			JsonObject o = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
			if (o.get(MEMBER) instanceof JsonObject d && d.has("gen") && d.has("store")) {
				String s = d.get("store").getAsString();
				if (d.has("type")) {
					return store.equals(d.get("type").getAsString()) ? new Meta(d.get("gen").getAsLong(), s) : new Meta(0, null);
				}
				// slice T0's first form (042da098): the label in "store", no id yet; its generation goes on, a new id is minted
				return store.equals(s) ? new Meta(d.get("gen").getAsLong(), null) : new Meta(0, null);
			}
		} catch (IOException | RuntimeException e) {
			return new Meta(0, null);
		}
		return new Meta(0, null);
	}

	/**
	 * A directory forced (its entries durable: a file's fsync does not persist its directory entry, Linux fsync(2)). On Windows a folder
	 * can't be opened for reading: best effort, logged once. Elsewhere an open that fails (permissions, descriptors, IO) throws as a failed
	 * force does (review P1-5).
	 */
	static void forceDir(Path dir) throws IOException {
		FileChannel ch;
		try {
			ch = FileChannel.open(dir, StandardOpenOption.READ);
		} catch (IOException | UnsupportedOperationException e) {
			if (dirOpenBestEffort || e instanceof UnsupportedOperationException) {
				if (!dirUnsupportedLogged) {
					dirUnsupportedLogged = true;
					Architect.LOGGER.warn("Durable files: the folder {} can't be synced on this platform ({}); renames are best effort", dir, e.toString());
				}
				return;
			}
			throw e instanceof IOException io ? io : new IOException(e);
		}
		try (ch) {
			ch.force(true);
		}
	}
}

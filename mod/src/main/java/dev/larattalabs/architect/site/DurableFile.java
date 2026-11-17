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
 * <li>{@link #write} writes the snapshot with a member {@value #MEMBER} {@code {store, gen}} in the file itself, so a generation means the
 * same after a restart: a new instance reads it back ({@link #readGen}) and its generations go on from there.</li>
 * <li>The result is {@link Outcome#OK} (written, forced, renamed, the directory forced: {@link #written} answers true from now on),
 * {@link Outcome#REFUSED} (a failure before the rename: the file on disk is the previous one) or {@link Outcome#IN_DOUBT} (the rename
 * happened, a later force failed: the new file may or may not survive a power loss). IN_DOUBT is never "not committed": the caller must
 * treat the snapshot as possibly on disk, and {@link #inDoubt} answers it until a later write is OK.</li>
 * <li>A directory that can't be opened for reading (Windows) is best effort, logged once, as PSV's: OK.</li>
 * </ul>
 * Any thread; writes are serialised per instance.
 */
public final class DurableFile {
	/** The member every snapshot carries: {@code {"store": id, "gen": n}}. */
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

	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
	private static volatile boolean dirUnsupportedLogged;

	private final String store;
	private final Path file;
	private final AtomicLong requested = new AtomicLong();
	private final AtomicLong written = new AtomicLong();
	private volatile long inDoubtGen;
	private volatile boolean failing;

	/** A store's durable file; its generations go on from the one its file on disk carries (0 with none). */
	public DurableFile(String store, Path file) {
		this.store = store;
		this.file = file;
		long g = readGen(file, store);
		requested.set(g);
		written.set(g);
	}

	public String store() {
		return store;
	}

	public Path file() {
		return file;
	}

	/** The next generation (no IO). */
	public long request() {
		return requested.incrementAndGet();
	}

	/** The highest generation whose write was OK (or the one read back at construction). */
	public long writtenGen() {
		return written.get();
	}

	/** Whether generation {@code gen} is known on disk: a write at or after it was OK. */
	public boolean written(long gen) {
		return written.get() >= gen;
	}

	/** Whether the last write failed (REFUSED or IN_DOUBT) and none was OK since. */
	public boolean failing() {
		return failing;
	}

	/** The generation of an IN_DOUBT write no OK write has covered since, or 0. */
	public long inDoubt() {
		return inDoubtGen > written.get() ? inDoubtGen : 0;
	}

	/** Writes {@code root} (not changed; a copy carries {@value #MEMBER}) as generation {@code gen}. */
	public synchronized Result write(JsonObject root, long gen) {
		JsonObject out = root.deepCopy();
		JsonObject d = new JsonObject();
		d.addProperty("store", store);
		d.addProperty("gen", gen);
		out.add(MEMBER, d);
		byte[] bytes = GSON.toJson(out).getBytes(StandardCharsets.UTF_8);
		Path dir = file.toAbsolutePath().getParent();
		Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
		try {
			if (FAIL_BEFORE_RENAME.get() > 0 && FAIL_BEFORE_RENAME.getAndDecrement() > 0) {
				throw new IOException("injected write failure (TEST)");
			}
			Files.createDirectories(dir);
			try (FileChannel ch = FileChannel.open(tmp, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE)) {
				ByteBuffer b = ByteBuffer.wrap(bytes);
				while (b.hasRemaining()) {
					ch.write(b);
				}
				FORCER.file(ch);
			}
			Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
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
		requested.accumulateAndGet(gen, Math::max);
		return new Result(Outcome.OK, gen, null);
	}

	/** The generation a store's file carries ({@value #MEMBER}), or 0 (no file, unreadable, another store's, or written before T0). */
	public static long readGen(Path file, String store) {
		try {
			if (!Files.exists(file)) {
				return 0;
			}
			JsonObject o = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
			if (o.get(MEMBER) instanceof JsonObject d && d.has("store") && store.equals(d.get("store").getAsString()) && d.has("gen")) {
				return d.get("gen").getAsLong();
			}
		} catch (IOException | RuntimeException e) {
			return 0;
		}
		return 0;
	}

	/**
	 * A directory forced (its entries durable: a file's fsync does not persist its directory entry, Linux fsync(2)). One that can't be
	 * opened for reading (Windows: AccessDeniedException) is best effort, logged once; one that opens and fails its force throws.
	 */
	static void forceDir(Path dir) throws IOException {
		FileChannel ch;
		try {
			ch = FileChannel.open(dir, StandardOpenOption.READ);
		} catch (IOException | UnsupportedOperationException e) {
			if (!dirUnsupportedLogged) {
				dirUnsupportedLogged = true;
				Architect.LOGGER.warn("Durable files: the folder {} can't be synced on this platform ({}); renames are best effort", dir, e.toString());
			}
			return;
		}
		try (ch) {
			ch.force(true);
		}
	}
}

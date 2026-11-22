package dev.larattalabs.architect.region;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.site.DurableFile;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import org.jspecify.annotations.Nullable;

/**
 * The world's region files (CONTRACT §1 "Plans live in two places"):
 * <pre>
 * &lt;world&gt;/architect-regions/plans/&lt;planId&gt;.json        a plan the mod received (the IR inline), so a realise works after a restart
 * &lt;world&gt;/architect-regions/prepare-&lt;planId&gt;.json      a prepare's progress (resumes after a relog)
 * &lt;world&gt;/architect-regions/&lt;regionId&gt;/region.json     the region record
 * &lt;world&gt;/architect-regions/&lt;regionId&gt;/ir.json         the IR (the sidecar may have lost its plan dir)
 * &lt;world&gt;/architect-regions/&lt;regionId&gt;/heights/&lt;tx&gt;.&lt;tz&gt;.bin   frozen heights, ARSV per tile (H0)
 * </pre>
 * Every write is write, fsync, atomic rename, folder fsync (slice DF: T0's DurableFile path); heights shards are also read back and compared.
 */
public final class RegionStore {
	public static final String DIR = "architect-regions";
	static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();

	private RegionStore() {
	}

	public static Path root(Path world) {
		return world.resolve(DIR);
	}

	public static Path plan(Path world, String planId) {
		return root(world).resolve("plans").resolve(safe(planId) + ".json");
	}

	public static Path prepare(Path world, String planId) {
		return root(world).resolve("prepare-" + safe(planId) + ".json");
	}

	public static Path region(Path world, String regionId) {
		return root(world).resolve(safe(regionId));
	}

	public static Path shard(Path world, String regionId, int tx, int tz) {
		return region(world, regionId).resolve("heights").resolve(tx + "." + tz + ".bin");
	}

	/** The heights a region's placed items left over tile (tx, tz) (the per-stage drift baseline). */
	public static Path after(Path world, String regionId, int tx, int tz) {
		return region(world, regionId).resolve("after").resolve(tx + "." + tz + ".bin");
	}

	static String safe(String id) {
		if (!id.matches("[A-Za-z0-9_.-]{1,96}") || id.contains("..")) {
			throw new IllegalArgumentException("bad id " + id);
		}
		return id;
	}

	/**
	 * (LCAP, TEST: {@code dev.region.failNextSave}) The next write of a file with this name fails with an IOException (once), as a full or
	 * read-only disk would: the gate's stand-in for a region record that cannot be saved. Null: off.
	 */
	public static volatile @org.jspecify.annotations.Nullable String failNext;
	/** (slice DF, TEST: {@code dev.region.failNextSave {sticky: true}}) {@link #failNext} stays armed (every write of that file fails) until off. */
	public static volatile boolean failSticky;

	/**
	 * (slice DF round 2, TEST: {@code dev.region.failNextSave {inDoubt: true}}) {@link #failNext}'s write is renamed into place and then
	 * answers IN_DOUBT, as a folder force that failed after the rename: the new file is on disk, its durability unknown.
	 */
	public static volatile boolean failInDoubt;

	/** (slice DF round 2) A write that renamed its file into place and then failed a force: the new bytes may or may not survive a power loss. */
	public static final class InDoubt extends IOException {
		public InDoubt(String msg) {
			super(msg);
		}
	}

	/** (slice DF round 2) An injected outcome of a write ({@link #failNext}). */
	public enum Injection {
		NONE, REFUSED, IN_DOUBT
	}

	/** (slice DF round 2) The injected outcome of a write of {@code f} ({@link #failNext}), spent unless sticky. */
	public static Injection injection(Path f) {
		String fail = failNext;
		if (fail == null || !fail.equals(f.getFileName().toString())) {
			return Injection.NONE;
		}
		boolean doubt = failInDoubt;
		if (!failSticky) {
			failNext = null;
			failInDoubt = false;
		}
		return doubt ? Injection.IN_DOUBT : Injection.REFUSED;
	}

	/** (slice DF) The injected REFUSED failure of a write of {@code f}, or null (none armed, or an IN_DOUBT one: see {@link #injection}). */
	public static @Nullable IOException injected(Path f) {
		Injection i = injection(f);
		return i == Injection.NONE ? null : i == Injection.REFUSED ? new IOException("injected write failure of " + f.getFileName()
			+ " (dev.region.failNextSave)") : new InDoubt("injected in-doubt write of " + f.getFileName() + " (dev.region.failNextSave inDoubt)");
	}

	/**
	 * (slice DF, rule 3) Write, fsync, atomic rename, then the folder forced, on T0's durable path ({@link DurableFile#writeBytes}: every
	 * folder entry up to the world folder confirmed, a new folder's too). Throws on REFUSED (the old file stays) and on IN_DOUBT (renamed, the
	 * folder's force failed): a caller never reads an unconfirmed write as saved.
	 */
	public static void write(Path f, byte[] data) throws IOException {
		IOException fail = injected(f);
		if (fail != null && !(fail instanceof InDoubt)) {
			throw fail;
		}
		DurableFile.Result r = DurableFile.writeBytes(f, data);
		if (fail != null && r.ok()) {
			throw fail; // (TEST) written and renamed, then in doubt
		}
		if (r.outcome() == DurableFile.Outcome.IN_DOUBT) {
			throw new InDoubt(f.getFileName() + " IN_DOUBT: " + r.reason());
		}
		if (!r.ok()) {
			throw new IOException(f.getFileName() + " " + r.outcome() + ": " + r.reason());
		}
	}

	/** {@link #write}, then read back and compared (heights shards: H0). */
	public static void writeChecked(Path f, byte[] data) throws IOException {
		write(f, data);
		byte[] back = Files.readAllBytes(f);
		if (!Arrays.equals(back, data)) {
			throw new IOException("read-back of " + f + " differs");
		}
	}

	public static void writeJson(Path f, JsonObject o) throws IOException {
		write(f, GSON.toJson(o).getBytes(StandardCharsets.UTF_8));
	}

	public static @Nullable JsonObject readJson(Path f) throws IOException {
		if (!Files.isRegularFile(f)) {
			return null;
		}
		return JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject();
	}

	public static @Nullable byte[] read(Path f) throws IOException {
		return Files.isRegularFile(f) ? Files.readAllBytes(f) : null;
	}
}

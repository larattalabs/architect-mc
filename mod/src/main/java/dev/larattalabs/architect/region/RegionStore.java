package dev.larattalabs.architect.region;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
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
 * Every write is write, fsync, atomic rename; heights shards are also read back and compared.
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

	static String safe(String id) {
		if (!id.matches("[A-Za-z0-9_.-]{1,96}") || id.contains("..")) {
			throw new IllegalArgumentException("bad id " + id);
		}
		return id;
	}

	/** Write, fsync, atomic rename (and the directory exists). */
	public static void write(Path f, byte[] data) throws IOException {
		Files.createDirectories(f.getParent());
		Path tmp = f.resolveSibling(f.getFileName() + ".tmp");
		try (FileChannel ch = FileChannel.open(tmp, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE)) {
			ch.write(java.nio.ByteBuffer.wrap(data));
			ch.force(true);
		}
		Files.move(tmp, f, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
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

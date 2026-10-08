package dev.larattalabs.architect.library;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.stream.Stream;
import org.jspecify.annotations.Nullable;

/**
 * Entry versions on disk (docs/CONTRACT.md phase 5b "Entry versions on disk", docs/HANDOFF-5b.md "Pinned formats"):
 * {@code <library>/<id>/versions/<n>/} holds version n's files; the top level is always a complete head. The blueprint JSON's
 * {@code version} (absent = 1) and {@code versions} lineage. The sidecar installs versions; the mod reads them, repairs an
 * interrupted install at its library load ({@link #repair}) and installs hand-written versions for tests
 * ({@link #install}, DevBridge {@code dev.entry.installVersion}). Pure NIO + Gson: tested without a game.
 */
public final class EntryVersions {
	public static final String VERSIONS = "versions";
	public static final String SIDECAR_SUFFIX = ".blueprint.json";
	/** The keys the mod owns in the top-level blueprint JSON: carried over by every replace of the top level. */
	public static final List<String> USER_KEYS = List.of("favorite", "userTags", "displayName", "ext");
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();

	private EntryVersions() {
	}

	/** One version of an entry's lineage ({@code versions[]} in the blueprint JSON). */
	public record Lineage(int n, long createdAt, String by, @Nullable Integer parent, @Nullable String designId, String summary, String nbtSha256,
		@Nullable String criticHash) {
		public JsonObject toJson() {
			JsonObject o = new JsonObject();
			o.addProperty("n", n);
			o.addProperty("createdAt", createdAt);
			o.addProperty("by", by);
			if (parent == null) {
				o.add("parent", com.google.gson.JsonNull.INSTANCE);
			} else {
				o.addProperty("parent", parent);
			}
			if (designId != null) {
				o.addProperty("designId", designId);
			}
			o.addProperty("summary", summary);
			o.addProperty("nbtSha256", nbtSha256);
			if (criticHash != null) {
				o.addProperty("criticHash", criticHash);
			}
			return o;
		}

		static Lineage fromJson(JsonObject o) {
			return new Lineage(o.get("n").getAsInt(), o.has("createdAt") ? o.get("createdAt").getAsLong() : 0L, str(o, "by", "design"),
				o.has("parent") && !o.get("parent").isJsonNull() ? o.get("parent").getAsInt() : null, o.has("designId") && !o.get("designId").isJsonNull()
					? o.get("designId").getAsString() : null, str(o, "summary", ""), str(o, "nbtSha256", ""), o.has("criticHash") && !o.get("criticHash")
						.isJsonNull() ? o.get("criticHash").getAsString() : null);
		}
	}

	private static String str(JsonObject o, String k, String d) {
		return o.has(k) && !o.get(k).isJsonNull() ? o.get(k).getAsString() : d;
	}

	/** The head version a blueprint JSON records ({@code version}; absent = 1). */
	public static int version(@Nullable JsonObject json) {
		return json != null && json.has("version") && !json.get("version").isJsonNull() ? json.get("version").getAsInt() : 1;
	}

	/**
	 * The lineage a blueprint JSON records, oldest first. An entry never bumped has none recorded: one synthesized version 1
	 * ({@code by: "migrated"} when made before 5b) with {@code nbtSha256} = {@code sha} when given.
	 */
	public static List<Lineage> lineage(@Nullable JsonObject json, @Nullable String sha) {
		List<Lineage> out = new ArrayList<>();
		if (json != null && json.get("versions") instanceof JsonArray a) {
			for (JsonElement e : a) {
				if (e instanceof JsonObject o && o.has("n")) {
					out.add(Lineage.fromJson(o));
				}
			}
		}
		if (out.isEmpty()) {
			long at = json != null && json.has("createdAt") ? json.get("createdAt").getAsLong() : 0L;
			out.add(new Lineage(1, at, "migrated", null, null, "", sha == null ? "" : sha, null));
		}
		out.sort(Comparator.comparingInt(Lineage::n));
		return out;
	}

	/** {@code <entryDir>/versions/<n>}. */
	public static Path dir(Path entryDir, int n) {
		return entryDir.resolve(VERSIONS).resolve(Integer.toString(n));
	}

	/** The complete version folders of an entry ({@code versions/<n>/}, numeric names), ascending. */
	public static List<Integer> complete(Path entryDir) {
		Path v = entryDir.resolve(VERSIONS);
		List<Integer> out = new ArrayList<>();
		if (!Files.isDirectory(v)) {
			return out;
		}
		try (Stream<Path> s = Files.list(v)) {
			for (Path p : s.toList()) {
				String n = p.getFileName().toString();
				if (Files.isDirectory(p) && n.matches("[1-9][0-9]{0,6}")) {
					out.add(Integer.parseInt(n));
				}
			}
		} catch (IOException e) {
			return out;
		}
		out.sort(null);
		return out;
	}

	/**
	 * Where version {@code n} of entry {@code id} lives: {@code versions/<n>/}, or the top level when n is the head and the entry
	 * was never bumped (no {@code versions/<n>/}). Null when it is gone.
	 */
	public static @Nullable Path locate(Path entryDir, String id, int n) {
		Path d = dir(entryDir, n);
		if (Files.isRegularFile(d.resolve(id + ".nbt")) && Files.isRegularFile(d.resolve(id + SIDECAR_SUFFIX))) {
			return d;
		}
		JsonObject top = readJson(entryDir.resolve(id + SIDECAR_SUFFIX));
		if (top != null && version(top) == n && Files.isRegularFile(entryDir.resolve(id + ".nbt"))) {
			return entryDir;
		}
		return null;
	}

	public static @Nullable JsonObject readJson(Path file) {
		try {
			return JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
		} catch (IOException | RuntimeException e) {
			return null;
		}
	}

	public static String sha256(Path file) throws IOException {
		try {
			return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(file)));
		} catch (java.security.NoSuchAlgorithmException e) {
			throw new IllegalStateException(e);
		}
	}

	// ------------------------------------------------------------------ repair (sidecar start, the mod's library load)

	/** A step of {@link #install} or {@link #repair} that a test can make fail (fault injection); null in production. */
	public interface Faults {
		void at(String step) throws IOException;

		Faults NONE = s -> {
		};
	}

	/**
	 * Repairs an interrupted install: {@code .tmp-*} folders under {@code versions/} are deleted; if the top level's
	 * {@code version} is lower than the highest complete {@code versions/<m>/}, the top level is replaced from it (each file a
	 * {@code .tmp} + rename, the blueprint JSON last, keeping the top level's user keys). Returns true when it changed the top
	 * level. Never throws for a broken entry (it is left for the loader to report).
	 */
	public static boolean repair(Path entryDir, String id) {
		Path v = entryDir.resolve(VERSIONS);
		if (!Files.isDirectory(v)) {
			return false;
		}
		try (Stream<Path> s = Files.list(v)) {
			for (Path p : s.toList()) {
				if (p.getFileName().toString().startsWith(".tmp-")) {
					deleteTree(p);
				}
			}
		} catch (IOException e) {
			return false;
		}
		List<Integer> done = complete(entryDir);
		if (done.isEmpty()) {
			return false;
		}
		int m = done.get(done.size() - 1);
		JsonObject top = readJson(entryDir.resolve(id + SIDECAR_SUFFIX));
		if (top != null && version(top) >= m) {
			return false;
		}
		try {
			replaceTop(entryDir, id, dir(entryDir, m), Faults.NONE);
			return true;
		} catch (IOException e) {
			return false;
		}
	}

	/** Step 3 of an install: the top-level files from {@code from} (a complete version folder), the blueprint JSON last. */
	static void replaceTop(Path entryDir, String id, Path from, Faults faults) throws IOException {
		List<Path> files;
		try (Stream<Path> s = Files.list(from)) {
			files = s.filter(Files::isRegularFile).sorted().toList();
		}
		Path json = from.resolve(id + SIDECAR_SUFFIX);
		for (Path f : files) {
			String name = f.getFileName().toString();
			if (f.equals(json) || name.equals("delta.json") || name.startsWith(".")) {
				continue;
			}
			faults.at("top:" + name);
			Path tmp = entryDir.resolve(name + ".tmp");
			Files.copy(f, tmp, StandardCopyOption.REPLACE_EXISTING);
			move(tmp, entryDir.resolve(name));
		}
		JsonObject next = readJson(json);
		if (next == null) {
			throw new IOException("version folder " + from + " has no readable " + id + SIDECAR_SUFFIX);
		}
		// the mod owns these keys: read from the current top level immediately before the rename
		JsonObject cur = readJson(entryDir.resolve(id + SIDECAR_SUFFIX));
		for (String k : USER_KEYS) {
			next.remove(k);
			if (cur != null && cur.has(k)) {
				next.add(k, cur.get(k).deepCopy());
			}
		}
		faults.at("top:json");
		Path tmp = entryDir.resolve(id + SIDECAR_SUFFIX + ".tmp");
		Files.writeString(tmp, GSON.toJson(next) + "\n", StandardCharsets.UTF_8);
		move(tmp, entryDir.resolve(id + SIDECAR_SUFFIX));
	}

	// ------------------------------------------------------------------ install (hand-written versions; the sidecar's order)

	/**
	 * Installs the files of {@code src} ({@code <id>.nbt} and {@code <id>.blueprint.json}, plus {@code <id>.parts.nbt},
	 * {@code <id>.mjs} and {@code <id>.preview-*.png} when present) as the next version of the entry in {@code entryDir}, in the
	 * contract's crash-safe order: (1) the first bump copies the top level into {@code versions/<n>/}; (2) the new version is
	 * written into {@code versions/.tmp-<n+1>-<rand>/} and renamed (the commit point); (3) the top level is replaced, the
	 * blueprint JSON last. {@code deltaJson}: written as {@code versions/<n+1>/delta.json} when not null. Returns the new version.
	 */
	public static int install(Path entryDir, String id, Path src, String by, @Nullable Integer parent, String summary, @Nullable JsonObject deltaJson,
		Faults faults) throws IOException {
		JsonObject top = readJson(entryDir.resolve(id + SIDECAR_SUFFIX));
		if (top == null) {
			throw new IOException("no readable " + id + SIDECAR_SUFFIX + " in " + entryDir);
		}
		if (!Files.isRegularFile(src.resolve(id + ".nbt")) || readJson(src.resolve(id + SIDECAR_SUFFIX)) == null) {
			throw new IOException(src + " needs " + id + ".nbt and " + id + SIDECAR_SUFFIX);
		}
		int head = version(top);
		List<Lineage> lineage = new ArrayList<>(lineage(top, Files.isRegularFile(entryDir.resolve(id + ".nbt")) ? sha256(entryDir.resolve(id + ".nbt"))
			: null));
		Path vdir = entryDir.resolve(VERSIONS);
		Files.createDirectories(vdir);
		java.util.Random rnd = new java.util.Random();
		// (1) the first bump: the top level becomes versions/<head>/
		if (!Files.isDirectory(dir(entryDir, head))) {
			faults.at("copy-head");
			Path tmp = vdir.resolve(".tmp-" + head + "-" + Integer.toHexString(rnd.nextInt()));
			Files.createDirectory(tmp);
			try (Stream<Path> s = Files.list(entryDir)) {
				for (Path f : s.filter(Files::isRegularFile).toList()) {
					String name = f.getFileName().toString();
					if (name.endsWith(".tmp") || name.startsWith(".")) {
						continue;
					}
					Files.copy(f, tmp.resolve(name));
				}
			}
			JsonObject hj = readJson(tmp.resolve(id + SIDECAR_SUFFIX));
			if (hj != null && !hj.has("versions")) {
				JsonArray a = new JsonArray();
				for (Lineage l : lineage) {
					a.add(l.toJson());
				}
				hj.add("versions", a);
				hj.addProperty("version", head);
				Files.writeString(tmp.resolve(id + SIDECAR_SUFFIX), GSON.toJson(hj) + "\n", StandardCharsets.UTF_8);
			}
			faults.at("rename-head");
			move(tmp, dir(entryDir, head));
		}
		// (2) the new version, exclusive create, then the rename (the commit point)
		int n = Math.max(head, complete(entryDir).stream().mapToInt(Integer::intValue).max().orElse(head)) + 1;
		Path tmp = vdir.resolve(".tmp-" + n + "-" + Integer.toHexString(rnd.nextInt()));
		Files.createDirectory(tmp);
		faults.at("write-new");
		try (Stream<Path> s = Files.list(src)) {
			for (Path f : s.filter(Files::isRegularFile).toList()) {
				String name = f.getFileName().toString();
				boolean ours = name.equals(id + ".nbt") || name.equals(id + ".parts.nbt") || name.equals(id + ".mjs") || name.equals(id + SIDECAR_SUFFIX)
					|| name.startsWith(id + ".preview-") && name.endsWith(".png");
				if (ours) {
					Files.copy(f, tmp.resolve(name));
				}
			}
		}
		JsonObject nj = readJson(tmp.resolve(id + SIDECAR_SUFFIX));
		lineage.add(new Lineage(n, System.currentTimeMillis(), by, parent == null ? head : parent, null, clip(summary, 200), sha256(tmp.resolve(id
			+ ".nbt")), null));
		JsonArray a = new JsonArray();
		for (Lineage l : lineage) {
			a.add(l.toJson());
		}
		nj.addProperty("version", n);
		nj.add("versions", a);
		for (String k : USER_KEYS) {
			nj.remove(k);
		}
		Files.writeString(tmp.resolve(id + SIDECAR_SUFFIX), GSON.toJson(nj) + "\n", StandardCharsets.UTF_8);
		if (deltaJson != null) {
			Files.writeString(tmp.resolve("delta.json"), GSON.toJson(deltaJson) + "\n", StandardCharsets.UTF_8);
		}
		faults.at("commit");
		move(tmp, dir(entryDir, n));
		// (3) the top level, the blueprint JSON last
		replaceTop(entryDir, id, dir(entryDir, n), faults);
		return n;
	}

	private static String clip(String s, int n) {
		return s.length() <= n ? s : s.substring(0, n);
	}

	static void move(Path from, Path to) throws IOException {
		try {
			Files.move(from, to, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
		} catch (AtomicMoveNotSupportedException e) {
			Files.move(from, to, StandardCopyOption.REPLACE_EXISTING);
		}
	}

	static void deleteTree(Path p) throws IOException {
		if (!Files.exists(p)) {
			return;
		}
		try (Stream<Path> s = Files.walk(p)) {
			for (Path q : s.sorted(Comparator.reverseOrder()).toList()) {
				Files.deleteIfExists(q);
			}
		}
	}
}

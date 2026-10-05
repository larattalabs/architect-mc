package dev.larattalabs.architect.apiimpl;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.Bible;
import dev.larattalabs.architect.api.BibleJob;
import dev.larattalabs.architect.api.BiblePin;
import dev.larattalabs.architect.api.BibleRequest;
import dev.larattalabs.architect.api.Cost;
import dev.larattalabs.architect.api.Design;
import dev.larattalabs.architect.api.DesignRequest;
import dev.larattalabs.architect.api.Estimate;
import dev.larattalabs.architect.api.Group;
import dev.larattalabs.architect.api.GroupRequest;
import dev.larattalabs.architect.api.Library;
import dev.larattalabs.architect.api.Reskin;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Stream;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * Phase 4b wire forms and views (docs/CONTRACT.md "Phase 4b contract", sidecar/README.md "Phase 4b"): the API records from
 * the sidecar's JSON ({@code Group}, {@code BibleJob}, {@code BibleInfo}, {@code Reskin}, an estimate, an entry's
 * {@code bible}/{@code parts}), the JSON the API sends ({@code GroupRequest}, {@code BibleRequest}, a reskin's
 * {@code from}), and an installed bible read from its folder. Pure (files aside), tested without a game. Internal.
 */
public final class Wire4b {
	/** The sidecar's 4b feature names -> the Java API's stable ones. */
	public static final Map<String, String> FEATURE_NAMES = Map.of("design.groups", "designGroups", "named.parts", "namedParts", "open.types",
		"openTypes", "bibles", "bibles", "estimates", "estimates", "reskin", "reskin");
	/** The required components of every bible. */
	public static final List<String> REQUIRED_COMPONENTS = List.of("window", "door_surround", "lantern_post", "roof_trim", "chimney");

	private Wire4b() {
	}

	// ------------------------------------------------------------------ small readers

	static @Nullable String str(JsonObject o, String k) {
		JsonElement e = o.get(k);
		return e != null && e.isJsonPrimitive() ? e.getAsString() : null;
	}

	static String str(JsonObject o, String k, String def) {
		String s = str(o, k);
		return s == null ? def : s;
	}

	static long num(JsonObject o, String k) {
		JsonElement e = o.get(k);
		return e != null && e.isJsonPrimitive() && e.getAsJsonPrimitive().isNumber() ? e.getAsLong() : 0L;
	}

	static @Nullable Double dbl(JsonObject o, String k) {
		JsonElement e = o.get(k);
		return e != null && e.isJsonPrimitive() && e.getAsJsonPrimitive().isNumber() ? e.getAsDouble() : null;
	}

	static JsonObject obj(JsonObject o, String k) {
		JsonElement e = o.get(k);
		return e != null && e.isJsonObject() ? e.getAsJsonObject() : new JsonObject();
	}

	static List<String> strings(JsonObject o, String k) {
		List<String> out = new ArrayList<>();
		JsonElement e = o.get(k);
		if (e != null && e.isJsonArray()) {
			for (JsonElement x : e.getAsJsonArray()) {
				if (x.isJsonPrimitive()) {
					out.add(x.getAsString());
				}
			}
		}
		return out;
	}

	static Cost cost(JsonObject o) {
		return o.has("cost") && o.get("cost").isJsonObject() ? Cost.fromJson(o.getAsJsonObject("cost")) : Cost.NONE;
	}

	/** A pin {@code {id, version}}, or empty. */
	public static Optional<BiblePin> pin(@Nullable JsonElement e) {
		if (e == null || !e.isJsonObject()) {
			return Optional.empty();
		}
		JsonObject o = e.getAsJsonObject();
		String id = str(o, "id");
		return id == null || id.isBlank() ? Optional.empty() : Optional.of(new BiblePin(id, (int) Math.max(1, num(o, "version"))));
	}

	// ------------------------------------------------------------------ sidecar -> API

	public static Estimate estimate(JsonObject r) {
		return new Estimate(d(r, "usdLow"), d(r, "usdHigh"), d(r, "minutesLow"), d(r, "minutesHigh"), str(r, "basis", ""));
	}

	private static double d(JsonObject o, String k) {
		Double v = dbl(o, k);
		return v == null ? 0 : v;
	}

	/** {@code Group} (group.upsert, snapshot.groups). */
	public static Group group(JsonObject o) {
		List<Group.Item> items = new ArrayList<>();
		JsonElement is = o.get("items");
		if (is != null && is.isJsonArray()) {
			for (JsonElement e : is.getAsJsonArray()) {
				if (!e.isJsonObject()) {
					continue;
				}
				JsonObject i = e.getAsJsonObject();
				items.add(new Group.Item(str(i, "itemKey", "?"), obj(i, "ext").deepCopy(), str(i, "designId", "?"), Optional.ofNullable(str(i, "entryId")),
					Design.Status.of(str(i, "status")), str(i, "step", ""), cost(i), (int) num(i, "wave"), GroupRequest.Role.of(str(i, "role")),
					str(i, "model", ""), str(i, "type", ""), Optional.ofNullable(str(i, "name")), Optional.ofNullable(str(i, "error"))));
			}
		}
		Double budget = dbl(o, "budgetUsd");
		Double soft = dbl(o, "softBudgetFraction");
		return new Group(str(o, "id", "?"), str(o, "name", ""), pin(o.get("bible")).orElse(new BiblePin("?", 1)), Optional.ofNullable(str(o, "owner")),
			obj(o, "ext").deepCopy(), (int) num(o, "concurrency"), Optional.ofNullable(budget), soft == null ? 0.8 : soft, Group.Status.of(str(o, "status")),
			Optional.ofNullable(str(o, "reason")), items, o.has("wave") ? (int) num(o, "wave") : -1, (int) num(o, "done"), (int) num(o, "failed"), cost(o),
			num(o, "usageLimitUntil"), num(o, "createdAt"), num(o, "updatedAt"));
	}

	/** {@code BibleInfo} (bible.index, snapshot.bibleIndex, a done BibleJob's {@code bible}). */
	public static Bible bibleInfo(JsonObject o) {
		Map<String, String> roles = new LinkedHashMap<>();
		obj(o, "roles").entrySet().forEach(e -> {
			if (e.getValue().isJsonPrimitive()) {
				roles.put(e.getKey(), e.getValue().getAsString());
			}
		});
		List<Integer> versions = new ArrayList<>();
		JsonElement vs = o.get("versions");
		if (vs != null && vs.isJsonArray()) {
			vs.getAsJsonArray().forEach(v -> versions.add(v.getAsInt()));
		}
		int version = (int) Math.max(1, num(o, "version"));
		if (versions.isEmpty()) {
			versions.add(version);
		}
		List<String> comps = strings(o, "components");
		String sheet = str(o, "sheetPath");
		return new Bible(str(o, "id", "?"), str(o, "name", str(o, "id", "?")), version, versions, o.has("builtin") && o.get("builtin").getAsBoolean(),
			"settlement".equals(str(o, "scope")) ? "settlement" : "building", roles, Optional.ofNullable(str(o, "prose")),
			Optional.ofNullable(sheet == null || sheet.isBlank() ? null : Path.of(sheet)), comps.isEmpty() ? REQUIRED_COMPONENTS : comps,
			Optional.ofNullable(str(o, "owner")), obj(o, "ext").deepCopy());
	}

	/** {@code BibleJob} (bible.upsert, snapshot.bibles). */
	public static BibleJob bibleJob(JsonObject o) {
		return new BibleJob(str(o, "id", "?"), str(o, "kind", "request"), str(o, "bibleId", "?"), (int) Math.max(1, num(o, "version")),
			BibleJob.Status.of(str(o, "status")), str(o, "step", ""), Optional.ofNullable(str(o, "error")), cost(o), (int) num(o, "rounds"),
			num(o, "usageLimitUntil"), o.has("bible") && o.get("bible").isJsonObject() ? Optional.of(bibleInfo(o.getAsJsonObject("bible")))
				: Optional.empty(), obj(o, "request").deepCopy(), num(o, "createdAt"), num(o, "updatedAt"));
	}

	/** {@code Reskin} (reskin.upsert, snapshot.reskins). */
	public static Reskin reskin(JsonObject o) {
		JsonObject f = obj(o, "from");
		Library.CollectionRef from;
		try {
			from = new Library.CollectionRef(str(f, "group"), str(f, "bible"), f.has("bibleVersion") ? (int) num(f, "bibleVersion") : null, strings(f,
				"entries"));
		} catch (IllegalArgumentException e) {
			from = Library.CollectionRef.ofEntries(List.of("?"));
		}
		return new Reskin(str(o, "id", "?"), pin(o.get("bible")).orElse(new BiblePin("?", 1)), from, Reskin.Status.of(str(o, "status")),
			str(o, "step", ""), strings(o, "variants"), strings(o, "entries"), (int) num(o, "done"), (int) num(o, "failed"),
			Optional.ofNullable(str(o, "error")), num(o, "createdAt"), num(o, "updatedAt"));
	}

	/** An entry's {@code parts: {name: {box: [x0,y0,z0,x1,y1,z1], cells}}}; invalid ones are skipped (the checker reports them). */
	public static Map<String, Library.Part> parts(JsonObject entry) {
		Map<String, Library.Part> out = new LinkedHashMap<>();
		JsonElement p = entry.get("parts");
		if (p == null || !p.isJsonObject()) {
			return out;
		}
		for (var e : p.getAsJsonObject().entrySet()) {
			try {
				JsonObject v = e.getValue().getAsJsonObject();
				JsonArray b = v.getAsJsonArray("box");
				if (b == null || b.size() != 6) {
					continue;
				}
				out.put(e.getKey(), new Library.Part(e.getKey(), new BoundingBox(b.get(0).getAsInt(), b.get(1).getAsInt(), b.get(2).getAsInt(),
					b.get(3).getAsInt(), b.get(4).getAsInt(), b.get(5).getAsInt()), v.get("cells").getAsInt()));
			} catch (RuntimeException ignored) {
				// skipped
			}
		}
		return out;
	}

	// ------------------------------------------------------------------ API -> sidecar

	/** A {@code GroupRequest} as sent ({@code design.group {group}}). */
	public static JsonObject group(GroupRequest g) {
		if (g.items().isEmpty() || g.items().size() > GroupRequest.MAX_ITEMS) {
			throw new IllegalArgumentException("a group holds 1 to " + GroupRequest.MAX_ITEMS + " items (got " + g.items().size() + ")");
		}
		if (g.name() == null || g.name().isBlank()) {
			throw new IllegalArgumentException("a group needs a name");
		}
		if (g.bible() == null || g.bible().isBlank()) {
			throw new IllegalArgumentException("a group needs a bible (a built-in one is a palette preset name)");
		}
		JsonObject o = new JsonObject();
		o.addProperty("name", g.name().strip());
		if (g.bibleVersion() != null) {
			JsonObject b = new JsonObject();
			b.addProperty("id", g.bible());
			b.addProperty("version", g.bibleVersion());
			o.add("bible", b);
		} else {
			o.addProperty("bible", g.bible());
		}
		if (g.owner() != null) {
			o.addProperty("owner", g.owner());
		}
		if (g.ext().size() > 0) {
			o.add("ext", g.ext().deepCopy());
		}
		if (g.concurrency() != null) {
			o.addProperty("concurrency", g.concurrency());
		}
		if (g.budgetUsd() != null) {
			o.addProperty("budgetUsd", g.budgetUsd());
		}
		JsonArray items = new JsonArray();
		for (GroupRequest.Item it : g.items()) {
			JsonObject r = DesignsImpl.wire(it.request(), 2);
			// the group sets these
			r.remove("bible");
			r.remove("bibleVersion");
			r.remove("group");
			if (it.itemKey() != null) {
				r.addProperty("itemKey", it.itemKey());
			}
			r.addProperty("role", it.role().wire());
			if (it.anchor()) {
				r.addProperty("anchor", true);
			} else if (it.wave() != null) {
				r.addProperty("wave", it.wave());
			}
			items.add(r);
		}
		o.add("items", items);
		return o;
	}

	/** A {@code BibleRequest} as sent. */
	public static JsonObject bibleRequest(BibleRequest r) {
		if (r.prompt() == null || r.prompt().isBlank()) {
			throw new IllegalArgumentException("a bible request needs a prompt");
		}
		JsonObject o = new JsonObject();
		o.addProperty("prompt", r.prompt().strip());
		if (r.name() != null && !r.name().isBlank()) {
			o.addProperty("name", r.name().strip());
		}
		if (r.owner() != null) {
			o.addProperty("owner", r.owner());
		}
		if (r.ext().size() > 0) {
			o.add("ext", r.ext().deepCopy());
		}
		if (r.model() != null) {
			o.addProperty("model", r.model());
		}
		if (r.budgetUsd() != null) {
			o.addProperty("budgetUsd", r.budgetUsd());
		}
		if (!r.references().isEmpty()) {
			JsonArray a = new JsonArray();
			r.references().forEach(a::add);
			o.add("references", a);
		}
		if (r.scope() != null) {
			o.addProperty("scope", r.scope());
		}
		if (r.seedPreset() != null) {
			o.addProperty("seedPreset", r.seedPreset());
		}
		return o;
	}

	/** A reskin's {@code from}. */
	public static JsonObject collection(Library.CollectionRef c) {
		JsonObject o = new JsonObject();
		if (c.group() != null) {
			o.addProperty("group", c.group());
		}
		if (c.bible() != null) {
			o.addProperty("bible", c.bible());
		}
		if (c.bibleVersion() != null) {
			o.addProperty("bibleVersion", c.bibleVersion());
		}
		if (!c.entries().isEmpty()) {
			JsonArray a = new JsonArray();
			c.entries().forEach(a::add);
			o.add("entries", a);
		}
		return o;
	}

	/** A bible reference: an id, or {@code {id, version}}. */
	public static JsonElement bibleRef(String id, @Nullable Integer version) {
		if (version == null) {
			return new com.google.gson.JsonPrimitive(id);
		}
		JsonObject b = new JsonObject();
		b.addProperty("id", id);
		b.addProperty("version", version);
		return b;
	}

	// ------------------------------------------------------------------ installed bibles on disk

	/**
	 * The installed bibles in {@code dir} ({@code <gameDir>/architect/bibles}): each {@code <id>/versions/<v>/bible.json}.
	 * Returns the latest version of each, by id.
	 */
	public static List<Bible> installed(Path dir) {
		List<Bible> out = new ArrayList<>();
		if (!Files.isDirectory(dir)) {
			return out;
		}
		List<Path> ids;
		try (Stream<Path> s = Files.list(dir)) {
			ids = s.filter(Files::isDirectory).filter(p -> p.getFileName().toString().matches("[a-z0-9_]{1,64}")).sorted().toList();
		} catch (IOException e) {
			return out;
		}
		for (Path p : ids) {
			List<Integer> vs = versions(p);
			if (!vs.isEmpty()) {
				Bible b = installed(dir, p.getFileName().toString(), vs.get(vs.size() - 1));
				if (b != null) {
					out.add(b);
				}
			}
		}
		return out;
	}

	/** The versions installed for one bible folder, ascending. */
	public static List<Integer> versions(Path bibleDir) {
		Path vd = bibleDir.resolve("versions");
		if (!Files.isDirectory(vd)) {
			return List.of();
		}
		try (Stream<Path> s = Files.list(vd)) {
			return s.filter(p -> p.getFileName().toString().matches("\\d{1,6}") && Files.isRegularFile(p.resolve("bible.json")))
				.map(p -> Integer.parseInt(p.getFileName().toString())).sorted().toList();
		} catch (IOException e) {
			return List.of();
		}
	}

	/** One installed version ({@code <dir>/<id>/versions/<v>/}), or null when it is missing or unreadable. */
	public static @Nullable Bible installed(Path dir, String id, int version) {
		Path vdir = dir.resolve(id).resolve("versions").resolve(Integer.toString(version));
		Path json = vdir.resolve("bible.json");
		if (!Files.isRegularFile(json)) {
			return null;
		}
		try {
			JsonObject j = JsonParser.parseString(Files.readString(json, StandardCharsets.UTF_8)).getAsJsonObject();
			JsonObject info = j.deepCopy();
			info.addProperty("id", id);
			info.addProperty("version", version);
			JsonArray vs = new JsonArray();
			versions(dir.resolve(id)).forEach(vs::add);
			info.add("versions", vs);
			info.addProperty("builtin", false);
			Path md = vdir.resolve("bible.md");
			if (Files.isRegularFile(md)) {
				String prose = Files.readString(md, StandardCharsets.UTF_8);
				info.addProperty("prose", prose.length() > 8000 ? prose.substring(0, 8000) : prose);
			}
			Path sheet = vdir.resolve("sheet.png");
			if (Files.isRegularFile(sheet)) {
				info.addProperty("sheetPath", sheet.toAbsolutePath().toString());
			} else {
				info.remove("sheetPath");
			}
			return bibleInfo(info);
		} catch (IOException | RuntimeException e) {
			return null;
		}
	}
}

package dev.larattalabs.architect.apiimpl;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.Library;
import dev.larattalabs.architect.api.SiteEvents;
import dev.larattalabs.architect.placement.Blueprints;
import dev.larattalabs.architect.site.Site;
import dev.larattalabs.architect.site.SiteDeltas;
import dev.larattalabs.architect.site.Sites;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;
import net.minecraft.server.MinecraftServer;

/**
 * Phase 5b's entry versions on the mod side: {@code entry.versioned} from the helper (the library reloads that entry,
 * ENTRY_VERSIONED fires once per installed version, persisted in {@code <gameDir>/architect/api-versioned.json} and caught up at
 * the next world load, like JOB_DONE), and {@code entry.pins} to the helper (the versions standing sites pin, so its garbage
 * collection keeps them), sent at connect and whenever the sites change.
 */
public final class Versioned {
	private static final Gson GSON = new Gson();
	private static volatile String lastPins = "";

	private Versioned() {
	}

	static Path file() {
		return Blueprints.gameDataDir().resolve("api-versioned.json");
	}

	static synchronized Map<String, Integer> fired() {
		Map<String, Integer> out = new TreeMap<>();
		try {
			if (Files.isRegularFile(file())) {
				JsonObject o = JsonParser.parseString(Files.readString(file(), StandardCharsets.UTF_8)).getAsJsonObject();
				o.entrySet().forEach(e -> out.put(e.getKey(), e.getValue().getAsInt()));
			}
		} catch (Exception e) {
			Architect.LOGGER.warn("Could not read {}", file(), e);
		}
		return out;
	}

	static synchronized void save(Map<String, Integer> m) {
		try {
			Files.createDirectories(file().getParent());
			Path tmp = file().resolveSibling("api-versioned.json.tmp");
			Files.writeString(tmp, GSON.toJson(m), StandardCharsets.UTF_8);
			Files.move(tmp, file(), java.nio.file.StandardCopyOption.REPLACE_EXISTING, java.nio.file.StandardCopyOption.ATOMIC_MOVE);
		} catch (Exception e) {
			Architect.LOGGER.warn("Could not save {}", file(), e);
		}
	}

	/** {@code entry.versioned {entryId, version, from, by, designId?}} (any thread): reload, then the event on the server thread. */
	public static void onVersioned(JsonObject m) {
		MinecraftServer s = ApiImpl.server();
		if (s == null) {
			return; // caught up at the next world load
		}
		s.execute(() -> {
			Blueprints.reload(s);
			catchUp(s);
		});
	}

	/** Fires ENTRY_VERSIONED for every entry whose head is newer than the last version fired (server thread). */
	public static void catchUp(MinecraftServer s) {
		Map<String, Integer> seen = fired();
		boolean first = !Files.isRegularFile(file());
		boolean changed = false;
		for (Blueprints.Entry e : Blueprints.entries()) {
			int head = Blueprints.headVersion(e);
			String id = e.blueprint().id();
			Integer last = seen.get(id);
			if (last == null) {
				seen.put(id, head);
				changed = true;
				// an entry seen for the first time with versions made while no world was loaded: fire for its newest
				if (!first && head > 1) {
					fire(s, id, head - 1);
				}
			} else if (head > last) {
				seen.put(id, head);
				changed = true;
				fire(s, id, last);
			}
		}
		if (changed) {
			save(seen);
		}
		sendPins();
	}

	private static void fire(MinecraftServer s, String id, int from) {
		Library.Entry entry = ApiImpl.instance().library().get(id).orElse(null);
		if (entry != null) {
			ApiEvents.guard("ENTRY_VERSIONED", () -> SiteEvents.ENTRY_VERSIONED.invoker().onVersioned(entry, from));
		}
	}

	/** {@code entry.pins {pins: {entryId: [versions]}}}: sent when it changed since the last send (any thread). */
	public static void sendPins() {
		ClientBridge b = ApiImpl.bridge();
		MinecraftServer s = ApiImpl.server();
		if (b == null || !b.connected() || s == null || b.protocol() < 2 || !b.sidecarFeatures().contains("entry.versions")) {
			return;
		}
		Map<String, TreeSet<Integer>> pins = new TreeMap<>();
		for (Site site : Sites.all()) {
			int v = site.versioning().version() > 0 ? site.versioning().version() : SiteDeltas.headVersion(site.blueprint());
			if (v > 0) {
				pins.computeIfAbsent(site.blueprint(), k -> new TreeSet<>()).add(v);
			}
		}
		JsonObject p = new JsonObject();
		pins.forEach((k, vs) -> {
			JsonArray a = new JsonArray();
			vs.forEach(a::add);
			p.add(k, a);
		});
		String key = p.toString();
		if (key.equals(lastPins)) {
			return;
		}
		lastPins = key;
		JsonObject m = new JsonObject();
		m.addProperty("type", "entry.pins");
		m.add("pins", p);
		b.send(m);
	}

	/** The link dropped or reconnected: the next send goes out whatever it holds. */
	public static void resetPins() {
		lastPins = "";
	}
}

package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.journal.JournalStore;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import org.jspecify.annotations.Nullable;

/**
 * The roads and cell sites of the running world (docs/CONTRACT.md phase 4e): their records, saved with the sites
 * ({@code infra} in {@code architect-sites.json}), and their removal's bookkeeping. Their placement and writes are
 * {@code roads.Roads} and {@link CellSites}. Server thread; reads from any thread.
 */
public final class Infras {
	private static volatile Map<String, Infra> byId = Map.of();
	/** Removed, not settled yet (their entries are undone until the next world start). */
	private static volatile Map<String, Infra> pending = Map.of();

	private Infras() {
	}

	public static @Nullable Infra get(String id) {
		return byId.get(id);
	}

	public static @Nullable Infra pending(String id) {
		return pending.get(id);
	}

	/** Every road and cell site, in placement order. */
	public static List<Infra> all() {
		return List.copyOf(byId.values());
	}

	static void load(JsonArray a) {
		Map<String, Infra> m = new LinkedHashMap<>();
		Map<String, Infra> p = new LinkedHashMap<>();
		for (JsonElement e : a) {
			try {
				JsonObject o = e.getAsJsonObject();
				Infra i = Infra.fromJson(o);
				if (o.has("pendingSince")) {
					p.put(i.id(), i);
				} else {
					m.put(i.id(), i);
				}
			} catch (RuntimeException ex) {
				Architect.LOGGER.warn("Could not read a road or cell site record {}", e, ex);
			}
		}
		byId = Collections.unmodifiableMap(m);
		pending = Collections.unmodifiableMap(p);
	}

	static JsonArray toJson() {
		JsonArray a = new JsonArray();
		byId.values().forEach(i -> a.add(i.toJson()));
		pending.values().forEach(i -> {
			JsonObject o = i.toJson();
			o.addProperty("pendingSince", System.currentTimeMillis());
			a.add(o);
		});
		return a;
	}

	/** Adds or replaces a record and saves. */
	static void put(MinecraftServer server, Infra i) {
		Map<String, Infra> m = new LinkedHashMap<>(byId);
		m.put(i.id(), i);
		byId = Collections.unmodifiableMap(m);
		Sites.saveAll(server);
	}

	/** R3 for a road or cell site: the record goes pending. */
	static void markPending(MinecraftServer server, String id) {
		Infra i = byId.get(id);
		if (i == null) {
			return;
		}
		Map<String, Infra> m = new LinkedHashMap<>(byId);
		m.remove(id);
		byId = Collections.unmodifiableMap(m);
		Map<String, Infra> p = new LinkedHashMap<>(pending);
		p.put(id, i);
		pending = Collections.unmodifiableMap(p);
		Sites.saveAll(server);
	}

	/** Drops a pending record (settled) or a record (forgotten). */
	static void drop(MinecraftServer server, String id) {
		Map<String, Infra> m = new LinkedHashMap<>(byId);
		Map<String, Infra> p = new LinkedHashMap<>(pending);
		if (m.remove(id) != null || p.remove(id) != null) {
			byId = Collections.unmodifiableMap(m);
			pending = Collections.unmodifiableMap(p);
			Sites.saveAll(server);
		}
	}

	/** Puts a pending record back (its removal never reached the disk). */
	static void recover(MinecraftServer server, String id) {
		Infra i = pending.get(id);
		if (i == null) {
			return;
		}
		Map<String, Infra> p = new LinkedHashMap<>(pending);
		p.remove(id);
		pending = Collections.unmodifiableMap(p);
		put(server, i);
	}

	/** R4 of a road or cell site removed with others (a cascade, a group): its writes at once, then the rest. */
	static void finishRemoval(ServerLevel level, String id, String group, boolean event) throws Sites.SiteException {
		SiteJournal.Restore r = SiteJournal.writeNow(level, id, group);
		Infra i = pending.get(id);
		if (event && i != null) {
			dev.larattalabs.architect.apiimpl.ApiEvents.removedInfra(level.getServer(), i, r.cells().size());
		}
	}

	/** Records come from the journal: a road or cell site whose record was lost (a 0.7.0 save dropped {@code infra}). */
	static void rebuild(MinecraftServer server, JournalStore.Meta main, JsonObject meta) {
		Infra i = Infra.fromJson(meta).withPlacing(false);
		Map<String, Infra> m = new LinkedHashMap<>(byId);
		m.put(i.id(), i);
		byId = Collections.unmodifiableMap(m);
	}

	/** World stop. */
	static void reset() {
		byId = Map.of();
		pending = Map.of();
	}

	static List<Infra> pendingAll() {
		return new ArrayList<>(pending.values());
	}
}

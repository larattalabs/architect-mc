package dev.larattalabs.architect.client.sidecar;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.jspecify.annotations.Nullable;

/**
 * What the mod knows about the sidecar (client thread): the link, the last {@code Status}, and every {@code Design}
 * (docs/CONTRACT.md "Protocol"). {@code snapshot} replaces both; {@code status} and {@code design.upsert} update them.
 * Listeners hear about every change on the client thread.
 */
public final class SidecarState {
	/** {@code DesignStatus} (as AgentCraft). */
	public enum DesignStatus {
		QUEUED, DESIGNING, CHECKING, RENDERING, DONE, FAILED, CANCELLED, UNKNOWN;

		public boolean isFinal() {
			return this == DONE || this == FAILED || this == CANCELLED;
		}

		public boolean isRunning() {
			return this == QUEUED || this == DESIGNING || this == CHECKING || this == RENDERING;
		}

		static DesignStatus of(@Nullable String s) {
			if (s == null) {
				return UNKNOWN;
			}
			try {
				return valueOf(s.toUpperCase(Locale.ROOT));
			} catch (IllegalArgumentException e) {
				return UNKNOWN;
			}
		}

		public String wire() {
			return name().toLowerCase(Locale.ROOT);
		}
	}

	/** The sidecar's {@code Status}; {@link #EMPTY} before a snapshot. */
	public record Status(String auth, @Nullable String authSource, boolean useClaudeLogin, String sdk, @Nullable String designing, int queued,
		long usageLimitUntil, @Nullable String version) {
		public static final Status EMPTY = new Status("unknown", null, false, "unknown", null, 0, 0, null);

		static Status of(@Nullable JsonObject o, @Nullable String version) {
			if (o == null) {
				return EMPTY;
			}
			return new Status(str(o, "auth", "unknown"), str(o, "authSource", null), o.has("useClaudeLogin") && o.get("useClaudeLogin").getAsBoolean(),
				str(o, "sdk", "unknown"), str(o, "designing", null), o.has("queued") ? o.get("queued").getAsInt() : 0,
				o.has("usageLimitUntil") && !o.get("usageLimitUntil").isJsonNull() ? o.get("usageLimitUntil").getAsLong() : 0L, version);
		}
	}

	/** A design job. {@code size} is {x, y, z} or null; {@code previews} absolute PNG paths. */
	public record Design(String id, JsonObject request, DesignStatus status, String step, @Nullable String blueprintId, int @Nullable [] size,
		List<String> previews, @Nullable String error, long createdAt, long updatedAt) {
		public Design {
			previews = List.copyOf(previews);
		}

		static Design of(JsonObject o) {
			int[] size = null;
			if (o.has("size") && o.get("size").isJsonObject()) {
				JsonObject s = o.getAsJsonObject("size");
				size = new int[] {s.get("x").getAsInt(), s.get("y").getAsInt(), s.get("z").getAsInt()};
			}
			List<String> previews = new ArrayList<>();
			if (o.has("previews") && o.get("previews").isJsonArray()) {
				for (JsonElement e : o.getAsJsonArray("previews")) {
					previews.add(e.getAsString());
				}
			}
			return new Design(str(o, "id", "?"), o.has("request") && o.get("request").isJsonObject() ? o.getAsJsonObject("request") : new JsonObject(),
				DesignStatus.of(str(o, "status", null)), str(o, "step", ""), str(o, "blueprintId", null), size, previews, str(o, "error", null),
				o.has("createdAt") ? o.get("createdAt").getAsLong() : 0L, o.has("updatedAt") ? o.get("updatedAt").getAsLong() : 0L);
		}

		/** The request's name, else its type and style ("Cabin, rustic"). */
		public String title() {
			String name = str(request, "name", null);
			if (name != null && !name.isBlank()) {
				return name;
			}
			String type = str(request, "type", "design");
			String style = str(request, "style", "");
			return Character.toUpperCase(type.charAt(0)) + type.substring(1) + (style.isBlank() ? "" : ", " + style);
		}
	}

	/** {@code variant.upsert}'s status (docs/CONTRACT.md "Variants without Claude"). */
	public enum VariantStatus {
		QUEUED, BUILDING, DONE, FAILED, UNKNOWN;

		public boolean isRunning() {
			return this == QUEUED || this == BUILDING;
		}

		static VariantStatus of(@Nullable String s) {
			if (s == null) {
				return UNKNOWN;
			}
			try {
				return valueOf(s.toUpperCase(Locale.ROOT));
			} catch (IllegalArgumentException e) {
				return UNKNOWN;
			}
		}

		public String wire() {
			return name().toLowerCase(Locale.ROOT);
		}
	}

	/**
	 * A variant or import job ({@code variant.upsert {variant}}, {@code snapshot.variants}). An import job has no {@code from}
	 * and names its file in {@code path} (the sidecar runs imports through the variant pipeline). {@code raw} is the message
	 * as received (for the DevBridge).
	 */
	public record Variant(String id, @Nullable String from, @Nullable String path, VariantStatus status, String step, @Nullable String blueprintId,
		int @Nullable [] size, @Nullable String error, long createdAt, long updatedAt, @Nullable String name, JsonObject raw) {
		static Variant of(JsonObject o) {
			int[] size = null;
			if (o.has("size") && o.get("size").isJsonObject()) {
				JsonObject s = o.getAsJsonObject("size");
				size = new int[] {s.get("x").getAsInt(), s.get("y").getAsInt(), s.get("z").getAsInt()};
			}
			String error = str(o, "error", null);
			if (error == null && o.has("errors") && o.get("errors").isJsonArray()) {
				List<String> lines = new ArrayList<>();
				o.getAsJsonArray("errors").forEach(e -> lines.add(e.isJsonPrimitive() ? e.getAsString() : e.toString()));
				error = lines.isEmpty() ? null : String.join("\n", lines);
			}
			return new Variant(str(o, "id", "?"), str(o, "from", null), str(o, "path", null), VariantStatus.of(str(o, "status", null)),
				str(o, "step", ""), str(o, "blueprintId", null), size, error, o.has("createdAt") ? o.get("createdAt").getAsLong() : 0L,
				o.has("updatedAt") ? o.get("updatedAt").getAsLong() : 0L, str(o, "name", null), o);
		}

		/** An import job (no source entry, a file path instead). */
		public boolean isImport() {
			return from == null && path != null || raw.has("imported") && raw.get("imported").isJsonPrimitive() && raw.get("imported").getAsBoolean()
				|| "import".equals(str(raw, "kind", null));
		}
	}

	/** Change listener (client thread). */
	public interface Listener {
		default void onLink(LinkStatus link) {
		}

		default void onSnapshot() {
		}

		default void onStatus(Status status) {
		}

		default void onDesign(@Nullable Design previous, Design design) {
		}

		default void onVariant(@Nullable Variant previous, Variant variant) {
		}
	}

	private LinkStatus link = new LinkStatus(LinkStatus.Phase.DISABLED, "", 0, null, 0, 0, false);
	private Status status = Status.EMPTY;
	private final Map<String, Design> designs = new LinkedHashMap<>();
	private final Map<String, Variant> variants = new LinkedHashMap<>();
	/** {@code snapshot.palettes} when the sidecar sends it (optional; see Palettes). */
	private @Nullable JsonElement palettes;
	private final List<Listener> listeners = new CopyOnWriteArrayList<>();
	private long snapshots;

	public void addListener(Listener l) {
		listeners.add(l);
	}

	public LinkStatus link() {
		return link;
	}

	public Status status() {
		return status;
	}

	public long snapshots() {
		return snapshots;
	}

	/** Designs, newest first. */
	public List<Design> designs() {
		List<Design> out = new ArrayList<>(designs.values());
		out.sort((a, b) -> Long.compare(b.createdAt(), a.createdAt()));
		return Collections.unmodifiableList(out);
	}

	public @Nullable Design design(String id) {
		return designs.get(id);
	}

	/** Variant and import jobs, newest first. */
	public List<Variant> variants() {
		List<Variant> out = new ArrayList<>(variants.values());
		out.sort((a, b) -> Long.compare(b.createdAt(), a.createdAt()));
		return Collections.unmodifiableList(out);
	}

	public @Nullable Variant variant(String id) {
		return variants.get(id);
	}

	public @Nullable JsonElement palettes() {
		return palettes;
	}

	void setLink(LinkStatus s) {
		link = s;
		for (Listener l : listeners) {
			guard(() -> l.onLink(s));
		}
	}

	/** Applies one sidecar message (client thread). */
	public void receive(String type, JsonObject json) {
		switch (type) {
			case "snapshot" -> {
				status = Status.of(json.has("status") && json.get("status").isJsonObject() ? json.getAsJsonObject("status") : null, str(json, "version", null));
				Map<String, Design> old = new LinkedHashMap<>(designs);
				designs.clear();
				if (json.has("designs") && json.get("designs").isJsonArray()) {
					for (JsonElement e : json.getAsJsonArray("designs")) {
						Design d = Design.of(e.getAsJsonObject());
						designs.put(d.id(), d);
					}
				}
				Map<String, Variant> oldVariants = new LinkedHashMap<>(variants);
				variants.clear();
				if (json.has("variants") && json.get("variants").isJsonArray()) {
					for (JsonElement e : json.getAsJsonArray("variants")) {
						if (e.isJsonObject()) {
							Variant v = Variant.of(e.getAsJsonObject());
							variants.put(v.id(), v);
						}
					}
				}
				palettes = json.has("palettes") && !json.get("palettes").isJsonNull() ? json.get("palettes") : null;
				snapshots++;
				for (Listener l : listeners) {
					for (Variant v : variants.values()) {
						Variant prev = oldVariants.get(v.id());
						if (prev == null || prev.status() != v.status() || prev.updatedAt() != v.updatedAt()) {
							guard(() -> l.onVariant(prev, v));
						}
					}
					guard(l::onSnapshot);
					for (Design d : designs.values()) {
						Design prev = old.get(d.id());
						if (prev == null || prev.status() != d.status() || prev.updatedAt() != d.updatedAt()) {
							guard(() -> l.onDesign(prev, d));
						}
					}
				}
			}
			case "status" -> {
				status = Status.of(json.has("status") && json.get("status").isJsonObject() ? json.getAsJsonObject("status") : null, status.version());
				Status s = status;
				for (Listener l : listeners) {
					guard(() -> l.onStatus(s));
				}
			}
			case "design.upsert" -> {
				if (!json.has("design") || !json.get("design").isJsonObject()) {
					return;
				}
				Design d = Design.of(json.getAsJsonObject("design"));
				Design prev = designs.put(d.id(), d);
				for (Listener l : listeners) {
					guard(() -> l.onDesign(prev, d));
				}
			}
			case "variant.upsert" -> {
				if (!json.has("variant") || !json.get("variant").isJsonObject()) {
					return;
				}
				Variant v = Variant.of(json.getAsJsonObject("variant"));
				Variant prev = variants.put(v.id(), v);
				for (Listener l : listeners) {
					guard(() -> l.onVariant(prev, v));
				}
			}
			default -> {
				// unknown messages are ignored (a newer sidecar)
			}
		}
	}

	private static void guard(Runnable r) {
		try {
			r.run();
		} catch (Throwable t) {
			Architect.LOGGER.warn("Sidecar listener failed", t);
		}
	}

	/** A string field or {@code def}. */
	public static @Nullable String str(JsonObject o, String key, @Nullable String def) {
		return o.has(key) && o.get(key).isJsonPrimitive() ? o.get(key).getAsString() : def;
	}

	/** For the DevBridge: link, status (never a key), designs. */
	public JsonObject json() {
		JsonObject o = new JsonObject();
		o.addProperty("link", link.phaseName());
		o.addProperty("linkError", link.lastError());
		o.addProperty("url", link.url());
		JsonObject s = new JsonObject();
		s.addProperty("auth", status.auth());
		s.addProperty("authSource", status.authSource());
		s.addProperty("useClaudeLogin", status.useClaudeLogin());
		s.addProperty("sdk", status.sdk());
		s.addProperty("designing", status.designing());
		s.addProperty("queued", status.queued());
		s.addProperty("version", status.version());
		o.add("status", s);
		JsonArray ds = new JsonArray();
		for (Design d : designs()) {
			JsonObject j = new JsonObject();
			j.addProperty("id", d.id());
			j.addProperty("status", d.status().wire());
			j.addProperty("step", d.step());
			j.addProperty("blueprintId", d.blueprintId());
			j.addProperty("error", d.error());
			j.addProperty("title", d.title());
			ds.add(j);
		}
		o.add("designs", ds);
		JsonArray vs = new JsonArray();
		for (Variant v : variants()) {
			vs.add(v.raw());
		}
		o.add("variants", vs);
		o.addProperty("palettesFromSidecar", palettes != null);
		o.addProperty("snapshots", snapshots);
		return o;
	}
}

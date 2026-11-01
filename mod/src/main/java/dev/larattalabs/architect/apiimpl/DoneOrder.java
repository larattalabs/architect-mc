package dev.larattalabs.architect.apiimpl;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import org.jspecify.annotations.Nullable;

/**
 * (7a K3) The DONE ordering of {@code Designs.get}, {@code designByKey} and {@code cancelDesign}: a design reads as DONE only once its
 * entry's new version is installed and loaded on the server, the moment DESIGN_DONE fires. The client bridge stores the helper's DONE
 * record before the server thread installs it ({@link DesignsImpl#changed}); until then the record reads as its last non-final one.
 * FAILED and CANCELLED read as they are. Thread-safe. Internal.
 */
final class DoneOrder {
	/** Finished designs whose DESIGN_DONE has fired ({@code id@createdAt}). */
	private final Set<String> installed = new HashSet<>();
	/** The last non-final record of each design seen. */
	private final Map<String, JsonObject> lastPending = new HashMap<>();

	/** {@code id@createdAt}, the key of DesignsImpl's handled set. */
	static String key(JsonObject raw) {
		return str(raw, "id") + "@" + num(raw, "createdAt");
	}

	/** The designs reported before (DesignsImpl's persisted done set). */
	synchronized void seed(Collection<String> keys) {
		installed.addAll(keys);
	}

	/** What a reader is answered for this record (remembering a non-final one). */
	synchronized JsonObject read(JsonObject raw) {
		String id = str(raw, "id");
		String status = str(raw, "status");
		if (id == null) {
			return raw;
		}
		if (!"done".equals(status) && !"failed".equals(status) && !"cancelled".equals(status)) {
			lastPending.put(id, raw.deepCopy());
			return raw;
		}
		if (!"done".equals(status) || installed.contains(key(raw))) {
			return raw;
		}
		return pendingOf(raw, lastPending.get(id));
	}

	/**
	 * A non-final record reaching the server thread: false when it is stale (its design was already reported DONE; no event), else
	 * remembered as the design's last non-final record.
	 */
	synchronized boolean pending(JsonObject raw) {
		if (installed.contains(key(raw))) {
			return false;
		}
		String id = str(raw, "id");
		if (id != null) {
			lastPending.put(id, raw.deepCopy());
		}
		return true;
	}

	/** Whether this record's DESIGN_DONE has fired. */
	synchronized boolean installed(JsonObject raw) {
		return installed.contains(key(raw));
	}

	/**
	 * The end of a final design's first report, in this order: {@code install} (the ext merged, the library reloaded: the new version
	 * loaded on the server), then readers see the final record, then {@code fire} (DESIGN_DONE).
	 */
	void finish(JsonObject raw, Runnable install, Runnable fire) {
		install.run();
		synchronized (this) {
			installed.add(key(raw));
			String id = str(raw, "id");
			if (id != null) {
				lastPending.remove(id);
			}
		}
		fire.run();
	}

	/**
	 * The record a finished-but-not-installed design reads as: its last non-final record when one was seen (with the same
	 * createdAt), else the DONE record as RENDERING ("installing the result"), without its entry, size and previews. Pure.
	 */
	static JsonObject pendingOf(JsonObject done, @Nullable JsonObject last) {
		if (last != null && num(last, "createdAt") == num(done, "createdAt")) {
			return last.deepCopy();
		}
		JsonObject p = done.deepCopy();
		p.addProperty("status", "rendering");
		p.addProperty("step", "installing the result");
		p.remove("blueprintId");
		p.remove("size");
		p.remove("previews");
		return p;
	}

	private static @Nullable String str(JsonObject o, String k) {
		JsonElement e = o.get(k);
		return e != null && e.isJsonPrimitive() ? e.getAsString() : null;
	}

	private static long num(JsonObject o, String k) {
		JsonElement e = o.get(k);
		return e != null && e.isJsonPrimitive() && e.getAsJsonPrimitive().isNumber() ? e.getAsLong() : 0;
	}
}

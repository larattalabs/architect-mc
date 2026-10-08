package dev.larattalabs.architect.batch;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * A queued batch as Architect keeps it (docs/CONTRACT.md phase 4d "The placement queue"): its options, its items in list
 * order and the stages it added to its group. Persisted in {@code <world>/architect-queue.json}. Mutable; server thread only.
 */
public final class QBatch {
	/** As {@code BatchView.Status}. */
	public enum Status {
		RUNNING, DONE, CANCELLED, STOPPED
	}

	public final String id;
	public final @Nullable String owner;
	public final JsonObject ext;
	public final String group;
	public final List<QItem> items;
	/** The names of the stages this batch added to its group, in order. */
	public final List<String> stages;
	/** The wait limit in game ticks. */
	public final long maxWaitTicks;
	/** 0: LOADED_ONLY; else LOAD_BOUNDED(n). */
	public final int loadChunks;
	public final boolean proximityFirst;
	public final boolean stopOnFailure;
	public final boolean autoApprove;
	public final boolean sharedCrate;
	public final int @Nullable [] crateAt;
	public final long createdAt;
	public Status status = Status.RUNNING;
	public long doneAt;
	/** cancelBatch was called: the item being placed is rolling back; the batch ends CANCELLED when it is done. */
	public boolean cancelling;
	/** stopOnFailure stopped it: it ends STOPPED (not CANCELLED) once the item being placed is done. */
	public boolean stopping;
	/** Why a stopped batch stopped. */
	public String note = "";
	/** Phase 6a: false under {@code GENERATED_ONLY} (chunks never generated are never ticketed). */
	public boolean generate = true;

	public QBatch(String id, @Nullable String owner, JsonObject ext, String group, List<QItem> items, List<String> stages, long maxWaitTicks,
		int loadChunks, boolean proximityFirst, boolean stopOnFailure, boolean autoApprove, boolean sharedCrate, int @Nullable [] crateAt,
		long createdAt) {
		this.id = id;
		this.owner = owner;
		this.ext = ext == null ? new JsonObject() : ext.deepCopy();
		this.group = group;
		this.items = new ArrayList<>(items);
		this.stages = List.copyOf(stages);
		this.maxWaitTicks = maxWaitTicks;
		this.loadChunks = loadChunks;
		this.proximityFirst = proximityFirst;
		this.stopOnFailure = stopOnFailure;
		this.autoApprove = autoApprove;
		this.sharedCrate = sharedCrate;
		this.crateAt = crateAt;
		this.createdAt = createdAt;
	}

	/** Items by key (phase 6a: a region batch has 1-2k items; a linear search per dependency per tick was quadratic). */
	private transient java.util.@Nullable Map<String, QItem> byKey;

	public @Nullable QItem item(String key) {
		java.util.Map<String, QItem> m = byKey;
		if (m == null || m.size() != items.size()) {
			m = new java.util.HashMap<>(items.size() * 2);
			for (QItem i : items) {
				m.putIfAbsent(i.key, i);
			}
			byKey = m;
		}
		return m.get(key);
	}

	public boolean running() {
		return status == Status.RUNNING;
	}

	/** The item whose cells are being written, if any (at most one per batch). */
	/** The item placing that keeps the next from starting (one placing at a time; an item committing its after does not). */
	public @Nullable QItem blocking() {
		for (QItem i : items) {
			if (i.status == QItem.Status.PLACING && !i.committing) {
				return i;
			}
		}
		return null;
	}

	public @Nullable QItem placing() {
		for (QItem i : items) {
			if (i.status == QItem.Status.PLACING) {
				return i;
			}
		}
		return null;
	}

	public List<QItem> inStage(String stage) {
		return items.stream().filter(i -> i.stage.equals(stage)).toList();
	}

	public JsonObject toJson() {
		JsonObject o = new JsonObject();
		o.addProperty("id", id);
		if (owner != null) {
			o.addProperty("owner", owner);
		}
		o.add("ext", ext.deepCopy());
		o.addProperty("group", group);
		JsonArray it = new JsonArray();
		items.forEach(i -> it.add(i.toJson()));
		o.add("items", it);
		JsonArray st = new JsonArray();
		stages.forEach(st::add);
		o.add("stages", st);
		o.addProperty("maxWaitTicks", maxWaitTicks);
		o.addProperty("loadChunks", loadChunks);
		o.addProperty("proximityFirst", proximityFirst);
		o.addProperty("stopOnFailure", stopOnFailure);
		o.addProperty("autoApprove", autoApprove);
		o.addProperty("sharedCrate", sharedCrate);
		if (crateAt != null) {
			JsonArray c = new JsonArray();
			for (int v : crateAt) {
				c.add(v);
			}
			o.add("crateAt", c);
		}
		o.addProperty("createdAt", createdAt);
		o.addProperty("status", status.name());
		if (doneAt > 0) {
			o.addProperty("doneAt", doneAt);
		}
		if (cancelling) {
			o.addProperty("cancelling", true);
		}
		if (stopping) {
			o.addProperty("stopping", true);
		}
		if (!note.isEmpty()) {
			o.addProperty("note", note);
		}
		if (!generate) {
			o.addProperty("generate", false);
		}
		return o;
	}

	public static QBatch fromJson(JsonObject o) {
		List<QItem> items = new ArrayList<>();
		for (JsonElement e : o.getAsJsonArray("items")) {
			items.add(QItem.fromJson(e.getAsJsonObject()));
		}
		List<String> stages = new ArrayList<>();
		for (JsonElement e : o.getAsJsonArray("stages")) {
			stages.add(e.getAsString());
		}
		int[] crate = null;
		if (o.has("crateAt") && o.get("crateAt").isJsonArray()) {
			JsonArray c = o.getAsJsonArray("crateAt");
			crate = new int[] {c.get(0).getAsInt(), c.get(1).getAsInt(), c.get(2).getAsInt()};
		}
		QBatch b = new QBatch(o.get("id").getAsString(), o.has("owner") ? o.get("owner").getAsString() : null,
			o.has("ext") && o.get("ext").isJsonObject() ? o.getAsJsonObject("ext") : new JsonObject(), o.get("group").getAsString(), items, stages,
			o.get("maxWaitTicks").getAsLong(), o.get("loadChunks").getAsInt(), o.get("proximityFirst").getAsBoolean(),
			o.get("stopOnFailure").getAsBoolean(), o.get("autoApprove").getAsBoolean(), o.get("sharedCrate").getAsBoolean(), crate,
			o.get("createdAt").getAsLong());
		b.status = Status.valueOf(o.get("status").getAsString());
		b.doneAt = o.has("doneAt") ? o.get("doneAt").getAsLong() : 0L;
		b.cancelling = o.has("cancelling") && o.get("cancelling").getAsBoolean();
		b.stopping = o.has("stopping") && o.get("stopping").getAsBoolean();
		b.note = o.has("note") ? o.get("note").getAsString() : "";
		b.generate = !o.has("generate") || o.get("generate").getAsBoolean();
		return b;
	}
}

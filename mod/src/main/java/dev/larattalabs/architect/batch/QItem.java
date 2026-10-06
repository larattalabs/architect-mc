package dev.larattalabs.architect.batch;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * One item of a queued batch as Architect keeps it (docs/CONTRACT.md phase 4d): the placement it asks for, with the mode
 * resolved and the actor kept as a UUID only (never a player object), plus its progress. Persisted in
 * {@code <world>/architect-queue.json} ({@link #toJson} / {@link #fromJson}). Mutable; server thread only.
 */
public final class QItem {
	/** QUEUED, WAITING, PLACING, PLACED, FAILED (as {@code BatchView.ItemStatus}). */
	public enum Status {
		QUEUED, WAITING, PLACING, PLACED, FAILED;

		public boolean terminal() {
			return this == PLACED || this == FAILED;
		}
	}

	public final String key;
	public final String stage;
	public final List<String> after;
	public final String blueprint;
	public final String dimension;
	public final int x;
	public final int y;
	public final int z;
	public final int turns;
	public final boolean force;
	/** The batch's ext merged with the item's own (item keys win). */
	public final JsonObject ext;
	/** The actor's UUID (attribution only), or null for a mod on its own. */
	public final @Nullable String actor;
	/** The mode resolved at queue time: a construction site, or instant. */
	public final boolean construction;
	/** Whether the world's survival toggle was on when the item was queued (an INSTANT item queued with it off fails if it is switched on). */
	public final boolean survivalAtQueue;

	/** Phase 4e: the LAYER overlap policy (else REFUSE). */
	public boolean layer;
	/** Phase 4e: {@code building}, {@code road} or {@code cells}; a road's or cell site's request ({@code spec}). */
	public String itemKind = "building";
	/**
	 * Phase 4e, not saved: its writes are done and its ACTIVE commit (P7) is on the I/O thread; the batch's next item may start
	 * meanwhile (it captures the world after these writes). It is PLACED at P8 as before.
	 */
	public transient boolean committing;
	/** Phase 4e, not saved: a large item checked in this batch tick (its start follows in the next) and its snapshot box. */
	public transient long checkedAt = -1;
	/** Phase 4e, not saved: a large cell site's staged check, its result (a tick before its start) and whether its chunks are ticketed. */
	public transient @Nullable Object prep;
	public transient @Nullable Object checked;
	public transient boolean ticketed;
	public transient dev.larattalabs.architect.placement.Anchors.@org.jspecify.annotations.Nullable Bounds checkedSnap;
	public @Nullable JsonObject spec;

	public Status status = Status.QUEUED;
	public @Nullable String siteId;
	/** The typed reason (a {@code Reason} name) while waiting or once failed. */
	public @Nullable String reason;
	public String message = "";
	/** Game ticks spent waiting so far (counts across relogs; the wait limit is checked against it). */
	public long waited;
	/** The batch tick at which a waiting item is checked again. Not persisted: after a load every waiting item is checked at once. */
	public long nextCheck;

	public QItem(String key, String stage, List<String> after, String blueprint, String dimension, int x, int y, int z, int turns, boolean force,
		JsonObject ext, @Nullable String actor, boolean construction, boolean survivalAtQueue) {
		this.key = key;
		this.stage = stage;
		this.after = List.copyOf(after);
		this.blueprint = blueprint;
		this.dimension = dimension;
		this.x = x;
		this.y = y;
		this.z = z;
		this.turns = turns;
		this.force = force;
		this.ext = ext == null ? new JsonObject() : ext.deepCopy();
		this.actor = actor;
		this.construction = construction;
		this.survivalAtQueue = survivalAtQueue;
	}

	/** Marks it failed with a reason (a {@code Reason} name). */
	public void fail(String why, String msg) {
		status = Status.FAILED;
		reason = why;
		message = msg == null ? "" : msg;
	}

	public JsonObject toJson() {
		JsonObject o = new JsonObject();
		o.addProperty("key", key);
		o.addProperty("stage", stage);
		JsonArray a = new JsonArray();
		after.forEach(a::add);
		o.add("after", a);
		o.addProperty("blueprint", blueprint);
		o.addProperty("dimension", dimension);
		JsonArray at = new JsonArray();
		at.add(x);
		at.add(y);
		at.add(z);
		o.add("origin", at);
		o.addProperty("turns", turns);
		o.addProperty("force", force);
		o.add("ext", ext.deepCopy());
		if (actor != null) {
			o.addProperty("actor", actor);
		}
		o.addProperty("mode", construction ? "CONSTRUCTION" : "INSTANT");
		o.addProperty("survivalAtQueue", survivalAtQueue);
		o.addProperty("status", status.name());
		if (siteId != null) {
			o.addProperty("siteId", siteId);
		}
		if (reason != null) {
			o.addProperty("reason", reason);
		}
		if (!message.isEmpty()) {
			o.addProperty("message", message);
		}
		if (waited > 0) {
			o.addProperty("waited", waited);
		}
		if (layer) {
			o.addProperty("overlap", "LAYER");
		}
		if (!"building".equals(itemKind)) {
			o.addProperty("itemKind", itemKind);
		}
		if (spec != null) {
			o.add("spec", spec.deepCopy());
		}
		return o;
	}

	public static QItem fromJson(JsonObject o) {
		List<String> after = new ArrayList<>();
		if (o.has("after")) {
			for (JsonElement e : o.getAsJsonArray("after")) {
				after.add(e.getAsString());
			}
		}
		JsonArray at = o.getAsJsonArray("origin");
		QItem i = new QItem(o.get("key").getAsString(), o.get("stage").getAsString(), after, o.get("blueprint").getAsString(),
			o.get("dimension").getAsString(), at.get(0).getAsInt(), at.get(1).getAsInt(), at.get(2).getAsInt(), o.get("turns").getAsInt(),
			o.has("force") && o.get("force").getAsBoolean(), o.has("ext") && o.get("ext").isJsonObject() ? o.getAsJsonObject("ext") : new JsonObject(),
			o.has("actor") ? o.get("actor").getAsString() : null, "CONSTRUCTION".equals(o.get("mode").getAsString()),
			o.has("survivalAtQueue") && o.get("survivalAtQueue").getAsBoolean());
		i.status = Status.valueOf(o.get("status").getAsString());
		i.siteId = o.has("siteId") ? o.get("siteId").getAsString() : null;
		i.reason = o.has("reason") ? o.get("reason").getAsString() : null;
		i.message = o.has("message") ? o.get("message").getAsString() : "";
		i.waited = o.has("waited") ? o.get("waited").getAsLong() : 0L;
		i.layer = o.has("overlap") && "LAYER".equals(o.get("overlap").getAsString());
		i.itemKind = o.has("itemKind") ? o.get("itemKind").getAsString() : "building";
		i.spec = o.has("spec") && o.get("spec").isJsonObject() ? o.getAsJsonObject("spec") : null;
		return i;
	}
}

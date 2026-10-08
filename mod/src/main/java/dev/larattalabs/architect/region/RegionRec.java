package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.RegionState;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * A region's record ({@code <world>/architect-regions/<id>/region.json}): what was realised, its group and batch, progress
 * per stage, its lots, counters and what it waits for. Mutable; server thread.
 */
public final class RegionRec {
	public final String id;
	public final String planId;
	public final String irSha;
	public final @Nullable String owner;
	public final JsonObject ext;
	public final String dimension;
	public final int[] claim;
	public final long createdAt;
	public String groupId = "";
	public String batchId = "";
	public RegionState state = RegionState.PLACING;
	public int maxChunks;
	public boolean generate;
	public final Map<String, Stage> stages = new LinkedHashMap<>();
	public final Map<String, Lot> lots = new LinkedHashMap<>();
	public long cellsWritten;
	public final Map<String, Long> skipped = new LinkedHashMap<>();
	public @Nullable String waitReason;
	public @Nullable String waitMessage;
	public long waitSince;
	/** Chunks whose terrain was generated while this region's items held tickets (the gate's 0). */
	public long generatedWhileHeld;
	public final JsonObject stats = new JsonObject();

	public static final class Stage {
		public int tilesTotal;
		public int tilesDone;
		public long cells;
	}

	public static final class Lot {
		public String stage = "";
		public @Nullable String entry;
		public @Nullable String siteId;
		public String state = "pad";
	}

	public RegionRec(String id, String planId, String irSha, @Nullable String owner, JsonObject ext, String dimension, int[] claim, long createdAt) {
		this.id = id;
		this.planId = planId;
		this.irSha = irSha;
		this.owner = owner;
		this.ext = ext == null ? new JsonObject() : ext.deepCopy();
		this.dimension = dimension;
		this.claim = claim.clone();
		this.createdAt = createdAt;
	}

	public void skip(String reason, long n) {
		if (n > 0) {
			skipped.merge(reason, n, Long::sum);
		}
	}

	public JsonObject toJson() {
		JsonObject o = new JsonObject();
		o.addProperty("id", id);
		o.addProperty("planId", planId);
		o.addProperty("irSha", irSha);
		if (owner != null) {
			o.addProperty("owner", owner);
		}
		o.add("ext", ext.deepCopy());
		o.addProperty("dimension", dimension);
		JsonArray c = new JsonArray();
		for (int v : claim) {
			c.add(v);
		}
		o.add("claim", c);
		o.addProperty("createdAt", createdAt);
		o.addProperty("groupId", groupId);
		o.addProperty("batchId", batchId);
		o.addProperty("state", state.name());
		o.addProperty("maxChunks", maxChunks);
		o.addProperty("generate", generate);
		JsonObject st = new JsonObject();
		stages.forEach((k, s) -> {
			JsonObject j = new JsonObject();
			j.addProperty("tilesTotal", s.tilesTotal);
			j.addProperty("tilesDone", s.tilesDone);
			j.addProperty("cells", s.cells);
			st.add(k, j);
		});
		o.add("stages", st);
		JsonObject ls = new JsonObject();
		lots.forEach((k, l) -> {
			JsonObject j = new JsonObject();
			j.addProperty("stage", l.stage);
			if (l.entry != null) {
				j.addProperty("entry", l.entry);
			}
			if (l.siteId != null) {
				j.addProperty("siteId", l.siteId);
			}
			j.addProperty("state", l.state);
			ls.add(k, j);
		});
		o.add("lots", ls);
		o.addProperty("cellsWritten", cellsWritten);
		JsonObject sk = new JsonObject();
		skipped.forEach(sk::addProperty);
		o.add("skipped", sk);
		if (waitReason != null) {
			o.addProperty("waitReason", waitReason);
			o.addProperty("waitMessage", waitMessage);
			o.addProperty("waitSince", waitSince);
		}
		o.addProperty("generatedWhileHeld", generatedWhileHeld);
		o.add("stats", stats.deepCopy());
		return o;
	}

	public static RegionRec fromJson(JsonObject o) {
		JsonArray c = o.getAsJsonArray("claim");
		int[] claim = new int[6];
		for (int i = 0; i < 6; i++) {
			claim[i] = c.get(i).getAsInt();
		}
		RegionRec r = new RegionRec(o.get("id").getAsString(), o.get("planId").getAsString(), o.get("irSha").getAsString(), o.has("owner") ? o.get(
			"owner").getAsString() : null, o.has("ext") ? o.getAsJsonObject("ext") : new JsonObject(), o.get("dimension").getAsString(), claim, o.get(
				"createdAt").getAsLong());
		r.groupId = o.get("groupId").getAsString();
		r.batchId = o.get("batchId").getAsString();
		r.state = RegionState.valueOf(o.get("state").getAsString());
		r.maxChunks = o.get("maxChunks").getAsInt();
		r.generate = o.get("generate").getAsBoolean();
		for (Map.Entry<String, JsonElement> e : o.getAsJsonObject("stages").entrySet()) {
			JsonObject j = e.getValue().getAsJsonObject();
			Stage s = new Stage();
			s.tilesTotal = j.get("tilesTotal").getAsInt();
			s.tilesDone = j.get("tilesDone").getAsInt();
			s.cells = j.get("cells").getAsLong();
			r.stages.put(e.getKey(), s);
		}
		for (Map.Entry<String, JsonElement> e : o.getAsJsonObject("lots").entrySet()) {
			JsonObject j = e.getValue().getAsJsonObject();
			Lot l = new Lot();
			l.stage = j.get("stage").getAsString();
			l.entry = j.has("entry") ? j.get("entry").getAsString() : null;
			l.siteId = j.has("siteId") ? j.get("siteId").getAsString() : null;
			l.state = j.get("state").getAsString();
			r.lots.put(e.getKey(), l);
		}
		r.cellsWritten = o.get("cellsWritten").getAsLong();
		o.getAsJsonObject("skipped").entrySet().forEach(e -> r.skipped.put(e.getKey(), e.getValue().getAsLong()));
		if (o.has("waitReason")) {
			r.waitReason = o.get("waitReason").getAsString();
			r.waitMessage = o.has("waitMessage") ? o.get("waitMessage").getAsString() : null;
			r.waitSince = o.get("waitSince").getAsLong();
		}
		r.generatedWhileHeld = o.has("generatedWhileHeld") ? o.get("generatedWhileHeld").getAsLong() : 0;
		if (o.has("stats")) {
			o.getAsJsonObject("stats").entrySet().forEach(e -> r.stats.add(e.getKey(), e.getValue()));
		}
		return r;
	}

	/** The stage names in order. */
	public List<String> stageNames() {
		return new ArrayList<>(stages.keySet());
	}
}

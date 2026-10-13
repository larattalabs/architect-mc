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
	/** (6c X, C20) The realise's operation key and its body hash ({@link RegionKeys}); null without one. */
	/** (6c X, C22) When the removal finished (epoch ms; 0: not removed): the REMOVED tombstone's time. */
	public long removedAt;
	public @Nullable String opKey;
	public @Nullable String opHash;
	/**
	 * (6c B) A brush stroke's record ({@link Brushes}): {@code kind}, {@code shape}, {@code destruction}, {@code playerBlocks} (the
	 * permission was checked), {@code actor} (a player's UUID, or {@code console}), {@code box} (the brush box); null for any other
	 * region. Written by the mod only (never from a request's ext).
	 */
	public @Nullable JsonObject brush;
	/**
	 * (6c PT §6) The builds the realise's (or stroke's) consent named and the check accepted (an actor placed at least 10% or holds
	 * permission level 2): their cells may be written. Validated once at the request; kept so a resumed region keeps it.
	 */
	public final java.util.Set<String> consented = new java.util.LinkedHashSet<>();
	/** (6c PT) The region's findings: per build kept out, its blocking count and first 8 cells ({@code BuildHit}), merged per tile. */
	public final Map<String, JsonObject> buildHits = new LinkedHashMap<>();

	/** (6c PT) Merges a tile's kept builds into the findings (counts summed, the first 8 cells kept). */
	public void builds(java.util.List<dev.larattalabs.architect.api.BuildHit> hits) {
		for (dev.larattalabs.architect.api.BuildHit h : hits) {
			JsonObject j = buildHits.computeIfAbsent(h.buildId(), k -> {
				JsonObject n = new JsonObject();
				n.addProperty("id", k);
				n.addProperty("kind", h.kind().name());
				n.addProperty("blocking", 0);
				n.add("first", new JsonArray());
				return n;
			});
			j.addProperty("kind", h.kind().name());
			j.addProperty("blocking", j.get("blocking").getAsInt() + h.blocking());
			JsonArray f = j.getAsJsonArray("first");
			for (dev.larattalabs.architect.api.BlockHit b : h.first()) {
				if (f.size() >= 8) {
					break;
				}
				JsonArray c = new JsonArray();
				c.add(b.pos().getX());
				c.add(b.pos().getY());
				c.add(b.pos().getZ());
				c.add(b.blockId());
				f.add(c);
			}
		}
	}

	/** (6c PT) The findings as API records (at most 8 builds, by id number). */
	public java.util.List<dev.larattalabs.architect.api.BuildHit> buildHitList() {
		java.util.List<dev.larattalabs.architect.api.BuildHit> out = new java.util.ArrayList<>();
		java.util.List<String> ids = new java.util.ArrayList<>(buildHits.keySet());
		ids.sort(java.util.Comparator.comparingLong(id -> {
			try {
				return Long.parseLong(id.substring(id.lastIndexOf('-') + 1));
			} catch (RuntimeException e) {
				return Long.MAX_VALUE;
			}
		}));
		for (String id : ids) {
			if (out.size() >= 8) {
				break;
			}
			JsonObject j = buildHits.get(id);
			java.util.List<dev.larattalabs.architect.api.BlockHit> first = new java.util.ArrayList<>();
			for (JsonElement e : j.getAsJsonArray("first")) {
				JsonArray c = e.getAsJsonArray();
				first.add(new dev.larattalabs.architect.api.BlockHit(new net.minecraft.core.BlockPos(c.get(0).getAsInt(), c.get(1).getAsInt(), c.get(2).getAsInt()),
					c.get(3).getAsString()));
			}
			out.add(new dev.larattalabs.architect.api.BuildHit(id, dev.larattalabs.architect.api.BuildKind.valueOf(j.get("kind").getAsString()), j.get(
				"blocking").getAsInt(), first));
		}
		return out;
	}

	public static final class Stage {
		public int tilesTotal;
		public int tilesDone;
		public long cells;
		/** When its first item started and its last item ended (wall ms, 0 = not yet). */
		public long startedAt;
		public long lastDoneAt;
		/** Engine time: server ticks in which one of its items was writing (excludes waiting for the player or the sidecar). */
		public long activeTicks;
	}

	/**
	 * The per-stage drift check (Steward S2), per stage: {@code ok: <numbers>}, {@code held: <numbers>} (land changed: the stage
	 * waits PLANNED for an approval) or {@code continued: <numbers>} (approved again after a hold).
	 */
	public final Map<String, String> drift = new LinkedHashMap<>();

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
			if (s.startedAt > 0) {
				j.addProperty("startedAt", s.startedAt);
			}
			if (s.lastDoneAt > 0) {
				j.addProperty("lastDoneAt", s.lastDoneAt);
			}
			j.addProperty("activeTicks", s.activeTicks);
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
		JsonObject dr = new JsonObject();
		drift.forEach(dr::addProperty);
		o.add("drift", dr);
		o.add("stats", stats.deepCopy());
		if (removedAt > 0) {
			o.addProperty("removedAt", removedAt);
		}
		if (opKey != null) {
			o.addProperty("opKey", opKey);
			o.addProperty("opHash", opHash);
		}
		if (brush != null) {
			o.add("brush", brush.deepCopy());
		}
		if (!consented.isEmpty()) {
			JsonArray cs = new JsonArray();
			consented.forEach(cs::add);
			o.add("consented", cs);
		}
		if (!buildHits.isEmpty()) {
			JsonObject bh = new JsonObject();
			buildHits.forEach((k, v) -> bh.add(k, v.deepCopy()));
			o.add("buildHits", bh);
		}
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
			s.startedAt = j.has("startedAt") ? j.get("startedAt").getAsLong() : 0;
			s.lastDoneAt = j.has("lastDoneAt") ? j.get("lastDoneAt").getAsLong() : 0;
			s.activeTicks = j.has("activeTicks") ? j.get("activeTicks").getAsLong() : 0;
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
		if (o.has("drift")) {
			o.getAsJsonObject("drift").entrySet().forEach(e -> r.drift.put(e.getKey(), e.getValue().getAsString()));
		}
		if (o.has("stats")) {
			o.getAsJsonObject("stats").entrySet().forEach(e -> r.stats.add(e.getKey(), e.getValue()));
		}
		r.removedAt = o.has("removedAt") ? o.get("removedAt").getAsLong() : 0L;
		if (o.get("consented") instanceof JsonArray cs) {
			cs.forEach(e -> r.consented.add(e.getAsString()));
		}
		if (o.get("buildHits") instanceof JsonObject bh) {
			bh.entrySet().forEach(e -> r.buildHits.put(e.getKey(), e.getValue().getAsJsonObject().deepCopy()));
		}
		r.opKey = o.has("opKey") ? o.get("opKey").getAsString() : null;
		r.opHash = o.has("opHash") ? o.get("opHash").getAsString() : null;
		r.brush = o.get("brush") instanceof JsonObject b ? b.deepCopy() : null;
		return r;
	}

	/** The stage names in order. */
	public List<String> stageNames() {
		return new ArrayList<>(stages.keySet());
	}
}

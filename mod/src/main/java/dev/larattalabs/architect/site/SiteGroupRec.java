package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.Stage;
import java.util.ArrayList;
import java.util.List;
import java.util.function.UnaryOperator;
import org.jspecify.annotations.Nullable;

/**
 * A site group as Architect records it (docs/CONTRACT.md phase 4d "Site groups and undo"), in {@code <world>/architect-sites.json}
 * next to the sites. Pure data.
 *
 * @param sites its standing sites in placement order (a removed site leaves the list)
 * @param stages every stage, in group order
 * @param state {@code active}, {@code removing} or {@code removed}
 * @param sharedCrate whether its construction sites share one crate (R6)
 * @param crate the shared crate's cell and what it replaced, once it is down (null before and after)
 * @param crateAt where the shared crate goes (null: beside the first construction site's approach end)
 */
public record SiteGroupRec(String id, @Nullable String owner, JsonObject ext, List<String> sites, List<StageRec> stages, String state,
	boolean sharedCrate, Construction.@Nullable Crate crate, int @Nullable [] crateAt, long createdAt) {
	public static final String ACTIVE = "active";
	public static final String REMOVING = "removing";
	public static final String REMOVED = "removed";
	/** The prefix of a shared crate's owner id in its block entity ({@code group:<id>}). */
	public static final String CRATE_PREFIX = "group:";

	public SiteGroupRec {
		ext = ext == null ? new JsonObject() : ext.deepCopy();
		sites = List.copyOf(sites);
		stages = List.copyOf(stages);
	}

	/** A stage: its items, state, placed sites (placement order) and the batch that added it. */
	public record StageRec(String name, List<String> items, Stage.State state, List<String> sites, String batchId) {
		public StageRec {
			items = List.copyOf(items);
			sites = List.copyOf(sites);
		}

		public StageRec withState(Stage.State s) {
			return new StageRec(name, items, s, sites, batchId);
		}

		public StageRec withSites(List<String> s) {
			return new StageRec(name, items, state, s, batchId);
		}

		JsonObject toJson() {
			JsonObject o = new JsonObject();
			o.addProperty("name", name);
			JsonArray it = new JsonArray();
			items.forEach(it::add);
			o.add("items", it);
			o.addProperty("state", state.name());
			JsonArray st = new JsonArray();
			sites.forEach(st::add);
			o.add("sites", st);
			o.addProperty("batchId", batchId);
			return o;
		}

		static StageRec fromJson(JsonObject o) {
			return new StageRec(o.get("name").getAsString(), strings(o, "items"), Stage.State.valueOf(o.get("state").getAsString()), strings(o, "sites"),
				o.get("batchId").getAsString());
		}
	}

	public @Nullable StageRec stage(String name) {
		for (StageRec s : stages) {
			if (s.name().equals(name)) {
				return s;
			}
		}
		return null;
	}

	public int stageIndex(String name) {
		for (int i = 0; i < stages.size(); i++) {
			if (stages.get(i).name().equals(name)) {
				return i;
			}
		}
		return -1;
	}

	public List<String> stageNames() {
		return stages.stream().map(StageRec::name).toList();
	}

	public List<Stage.State> stageStates() {
		return stages.stream().map(StageRec::state).toList();
	}

	public SiteGroupRec withSites(List<String> s) {
		return new SiteGroupRec(id, owner, ext, s, stages, state, sharedCrate, crate, crateAt, createdAt);
	}

	public SiteGroupRec withStages(List<StageRec> s) {
		return new SiteGroupRec(id, owner, ext, sites, s, state, sharedCrate, crate, crateAt, createdAt);
	}

	/** The same group with one stage changed. */
	public SiteGroupRec withStage(String name, UnaryOperator<StageRec> change) {
		List<StageRec> out = new ArrayList<>();
		for (StageRec s : stages) {
			out.add(s.name().equals(name) ? change.apply(s) : s);
		}
		return withStages(out);
	}

	public SiteGroupRec withState(String s) {
		return new SiteGroupRec(id, owner, ext, sites, stages, s, sharedCrate, crate, crateAt, createdAt);
	}

	public SiteGroupRec withCrate(Construction.@Nullable Crate c) {
		return new SiteGroupRec(id, owner, ext, sites, stages, state, sharedCrate, c, crateAt, createdAt);
	}

	public SiteGroupRec withSharedCrate(boolean shared, int @Nullable [] at) {
		return new SiteGroupRec(id, owner, ext, sites, stages, state, shared, crate, at, createdAt);
	}

	/** The crate block entity's owner id for this group's shared crate. */
	public String crateOwner() {
		return CRATE_PREFIX + id;
	}

	public JsonObject toJson() {
		JsonObject o = new JsonObject();
		o.addProperty("id", id);
		if (owner != null) {
			o.addProperty("owner", owner);
		}
		if (ext.size() > 0) {
			o.add("ext", ext.deepCopy());
		}
		JsonArray si = new JsonArray();
		sites.forEach(si::add);
		o.add("sites", si);
		JsonArray st = new JsonArray();
		stages.forEach(s -> st.add(s.toJson()));
		o.add("stages", st);
		o.addProperty("state", state);
		if (sharedCrate) {
			o.addProperty("sharedCrate", true);
		}
		if (crate != null) {
			o.add("crate", crate.toJson());
		}
		if (crateAt != null) {
			JsonArray c = new JsonArray();
			for (int v : crateAt) {
				c.add(v);
			}
			o.add("crateAt", c);
		}
		o.addProperty("createdAt", createdAt);
		return o;
	}

	public static SiteGroupRec fromJson(JsonObject o) {
		List<StageRec> stages = new ArrayList<>();
		if (o.has("stages")) {
			for (JsonElement e : o.getAsJsonArray("stages")) {
				stages.add(StageRec.fromJson(e.getAsJsonObject()));
			}
		}
		int[] at = null;
		if (o.has("crateAt") && o.get("crateAt").isJsonArray()) {
			JsonArray c = o.getAsJsonArray("crateAt");
			at = new int[] {c.get(0).getAsInt(), c.get(1).getAsInt(), c.get(2).getAsInt()};
		}
		return new SiteGroupRec(o.get("id").getAsString(), o.has("owner") ? o.get("owner").getAsString() : null,
			o.has("ext") && o.get("ext").isJsonObject() ? o.getAsJsonObject("ext") : new JsonObject(), strings(o, "sites"), stages,
			o.has("state") ? o.get("state").getAsString() : ACTIVE, o.has("sharedCrate") && o.get("sharedCrate").getAsBoolean(),
			o.has("crate") && o.get("crate").isJsonObject() ? Construction.Crate.fromJson(o.getAsJsonObject("crate")) : null, at,
			o.has("createdAt") ? o.get("createdAt").getAsLong() : 0L);
	}

	private static List<String> strings(JsonObject o, String key) {
		List<String> out = new ArrayList<>();
		if (o.has(key) && o.get(key).isJsonArray()) {
			for (JsonElement e : o.getAsJsonArray(key)) {
				out.add(e.getAsString());
			}
		}
		return out;
	}
}

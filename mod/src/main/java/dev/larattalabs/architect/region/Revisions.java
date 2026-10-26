package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.LoadPolicy;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.api.RealiseRequest;
import dev.larattalabs.architect.api.RegionPlan;
import dev.larattalabs.architect.api.RegionPlanRequest;
import dev.larattalabs.architect.api.RegionState;
import dev.larattalabs.architect.api.RevisionOf;
import dev.larattalabs.architect.api.RevisionRequest;
import dev.larattalabs.architect.api.RevisionView;
import dev.larattalabs.architect.api.SiteEvents;
import dev.larattalabs.architect.batch.QBatch;
import dev.larattalabs.architect.batch.QItem;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.site.Batches;
import dev.larattalabs.architect.site.Sites;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import net.minecraft.world.level.storage.LevelResource;
import org.jspecify.annotations.Nullable;

/**
 * (6d RV-b) Additive revisions of a standing region, the mod's foundation (docs/CONTRACT.md "Phase 6d slice RV" §2-§4.3): the revision
 * record and its states, {@link #plan} (Regions.planRevision: the kit's {@code revise} program over the region's effective IR and its
 * standing data, ctx.standing), the head and its compare-and-set at accept (the parent and the region's history at the dirty tiles), the
 * operation manifest and the effective IR's head-addressed snapshot, the install as a new batch in the region's own group, the end, and
 * recovery at world start. A revision's journal stages are {@code rv<rid>:<stage>} (its IR keeps the base's own stage names); its tiles'
 * realised records are layer {@code rid}. Every site a revision writes carries ext {@code architect_mc:revision {region, rid}}.
 *
 * <p>Files under the region's directory: {@code rev/<rid>/ir.json} (the revision IR), {@code rev/<rid>/op.json} (the realise manifest:
 * {@code {op, rid, planId, items, lotEntries, state: prepared | installed | done}}), {@code effective/<rid>.json} (the effective IR at that
 * head; written before the accept and never rewritten). {@code region.json} is authoritative: readers resolve the effective IR through its
 * head, so a snapshot of a revision never accepted is an orphan, never read. Server thread unless noted.
 */
public final class Revisions {
	/** The batch and site ext key naming a revision ({@code {region, rid}}). */
	public static final String EXT_REVISION = "architect_mc:revision";
	/** The plan request's ext key naming the revised region (planRevision's own; part of a keyed plan's body). */
	public static final String EXT_REVISION_OF = "architect_mc:revisionOf";
	/** The bundled program a revision is planned with (GR: the region's own program with params.grow). */
	public static final String PROGRAM = "revise";
	/** §12's product limits. */
	public static final int MAX_ACCEPTED = 64;
	public static final int MAX_RID = 9999;
	private static final Pattern STAGE = Pattern.compile("^rv(\\d{1,4}):(.+)$");

	private Revisions() {
	}

	// ------------------------------------------------------------------ the record

	/** One revision of a region (§4.1). Mutable; server thread. */
	public static final class Rev {
		public int rid;
		public int position;
		public int parentRid;
		public String planId = "";
		public String irSha = "";
		/** CANDIDATE (never in a region record), ACCEPTED, PLACING, PLACED, PARTIAL, FAILED, UNDOING, UNDONE, STALE. */
		public String state = "ACCEPTED";
		public long createdAt;
		public List<String> stages = new ArrayList<>();
		public List<String> lotsAdded = new ArrayList<>();
		public List<String> lotsRefilled = new ArrayList<>();
		public long cells;
		public @Nullable String artifact;
		public boolean survival;
		public @Nullable String waiting;
		public @Nullable String batchId;
		public @Nullable String opKey;
		public @Nullable String actor;
		/** The region's own state before it went PLACING for this revision (Steward's point 1: it reads it again afterwards). */
		public String regionStateBefore = RegionState.PLACED.name();
		/** Every site it wrote, in write order (Steward's GR ask 1). */
		public List<String> sites = new ArrayList<>();
		/** (§4.6) Each refilled lot's state before the refill ({state, stage, siteId?, entry?, removedAt?}): the undo puts it back. */
		public JsonObject refilledPrior = new JsonObject();

		public JsonObject toJson() {
			JsonObject o = new JsonObject();
			o.addProperty("rid", rid);
			o.addProperty("position", position);
			o.addProperty("parentRid", parentRid);
			o.addProperty("planId", planId);
			o.addProperty("irSha", irSha);
			o.addProperty("state", state);
			o.addProperty("createdAt", createdAt);
			o.add("stages", arr(stages));
			o.add("lotsAdded", arr(lotsAdded));
			o.add("lotsRefilled", arr(lotsRefilled));
			o.addProperty("cells", cells);
			if (artifact != null) {
				o.addProperty("artifact", artifact);
			}
			o.addProperty("survival", survival);
			if (waiting != null) {
				o.addProperty("waiting", waiting);
			}
			if (batchId != null) {
				o.addProperty("batchId", batchId);
			}
			if (opKey != null) {
				o.addProperty("opKey", opKey);
			}
			if (actor != null) {
				o.addProperty("actor", actor);
			}
			o.addProperty("regionStateBefore", regionStateBefore);
			o.add("sites", arr(sites));
			if (refilledPrior.size() > 0) {
				o.add("refilledPrior", refilledPrior.deepCopy());
			}
			return o;
		}

		public static Rev fromJson(JsonObject o) {
			Rev r = new Rev();
			r.rid = o.get("rid").getAsInt();
			r.position = o.get("position").getAsInt();
			r.parentRid = o.get("parentRid").getAsInt();
			r.planId = str(o, "planId", "");
			r.irSha = str(o, "irSha", "");
			r.state = str(o, "state", "ACCEPTED");
			r.createdAt = o.has("createdAt") ? o.get("createdAt").getAsLong() : 0L;
			r.stages = strings(o, "stages");
			r.lotsAdded = strings(o, "lotsAdded");
			r.lotsRefilled = strings(o, "lotsRefilled");
			r.cells = o.has("cells") ? o.get("cells").getAsLong() : 0L;
			r.artifact = o.has("artifact") ? o.get("artifact").getAsString() : null;
			r.survival = o.has("survival") && o.get("survival").getAsBoolean();
			r.waiting = o.has("waiting") ? o.get("waiting").getAsString() : null;
			r.batchId = o.has("batchId") ? o.get("batchId").getAsString() : null;
			r.opKey = o.has("opKey") ? o.get("opKey").getAsString() : null;
			r.actor = o.has("actor") ? o.get("actor").getAsString() : null;
			r.regionStateBefore = str(o, "regionStateBefore", RegionState.PLACED.name());
			r.sites = strings(o, "sites");
			r.refilledPrior = o.get("refilledPrior") instanceof JsonObject rp ? rp.deepCopy() : new JsonObject();
			return r;
		}

		public RevisionView view() {
			return new RevisionView(rid, position, parentRid, planId, irSha, state, createdAt, stages, lotsAdded, lotsRefilled, cells, artifact, survival, waiting,
				sites);
		}

		boolean standing() {
			return !state.equals("UNDONE") && !state.equals("STALE");
		}
	}

	// ------------------------------------------------------------------ names and files

	/** The revision a journal stage belongs to ({@code rv<rid>:<stage>}), or 0 for the realised plan's. */
	public static int layerOf(@Nullable String stage) {
		Matcher m = stage == null ? null : STAGE.matcher(stage);
		return m != null && m.matches() ? Integer.parseInt(m.group(1)) : 0;
	}

	/** The plan IR's own stage name of a journal stage (a revision's without its {@code rv<rid>:}). */
	public static String plainStage(String stage) {
		Matcher m = STAGE.matcher(stage);
		return m.matches() ? m.group(2) : stage;
	}

	public static String stageName(int rid, String stage) {
		return "rv" + rid + ":" + stage;
	}

	static Path dir(Path world, String region, int rid) {
		return RegionStore.region(world, region).resolve("rev").resolve(Integer.toString(rid));
	}

	static Path effectiveFile(Path world, String region, int rid) {
		return RegionStore.region(world, region).resolve("effective").resolve(rid + ".json");
	}

	public static @Nullable Rev rev(RegionRec rec, int rid) {
		for (Rev r : rec.revisions) {
			if (r.rid == rid) {
				return r;
			}
		}
		return null;
	}

	/** The head revision's record, or null at the realised plan. */
	static @Nullable Rev head(RegionRec rec) {
		return rec.headRid == 0 ? null : rev(rec, rec.headRid);
	}

	/** The head's IR sha (the realised plan's for position 0). */
	static String headIrSha(RegionRec rec) {
		Rev h = head(rec);
		return h == null ? rec.irSha : h.irSha;
	}

	// ------------------------------------------------------------------ revision IRs and the effective IR

	private static final Map<String, Ir> IRS = new ConcurrentHashMap<>();
	private static final Map<String, JsonObject> EFFECTIVE = new ConcurrentHashMap<>();

	/** A revision's IR (rev/<rid>/ir.json), cached; null when it can't be read. */
	public static @Nullable Ir irOf(RegionsImpl.Live base, int rid) {
		String k = base.rec().id + "#" + rid;
		Ir ir = IRS.get(k);
		if (ir != null) {
			return ir;
		}
		try {
			JsonObject o = RegionStore.readJson(dir(base.world(), base.rec().id, rid).resolve("ir.json"));
			if (o == null) {
				return null;
			}
			ir = Ir.lenient(o, base.rec().claim);
			IRS.put(k, ir);
			return ir;
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("Region {}: revision {}'s IR unreadable: {}", base.rec().id, rid, e.toString());
			return null;
		}
	}

	/**
	 * The live view a revision stage's items read: the region's record and world with the revision's IR, its rid and its plan (the tile
	 * requests name the revision's plan and IR sha). The region's own for a stage of the realised plan, or when the revision is unknown.
	 */
	public static RegionsImpl.Live liveFor(RegionsImpl.Live base, @Nullable String stage) {
		int rid = layerOf(stage);
		if (rid == 0) {
			return base;
		}
		Rev r = rev(base.rec(), rid);
		Ir ir = irOf(base, rid);
		if (r == null || ir == null) {
			return base;
		}
		return new RegionsImpl.Live(base.rec(), ir, base.world(), rid, r.planId, r.irSha);
	}

	/**
	 * The effective IR (§2.3): the head's snapshot {@code effective/<head>.json} (rebuilt from the base and the accepted revisions when it
	 * is missing), or the realised plan's IR at position 0. Data for readers; never evaluated as one IR.
	 */
	public static JsonObject effective(RegionsImpl.Live l) {
		RegionRec rec = l.rec();
		if (rec.headRid == 0) {
			return l.ir().json();
		}
		String k = rec.id + "#" + rec.headRid;
		JsonObject e = EFFECTIVE.get(k);
		if (e != null) {
			return e;
		}
		try {
			e = RegionStore.readJson(effectiveFile(l.world(), rec.id, rec.headRid));
		} catch (IOException | RuntimeException ex) {
			e = null;
		}
		if (e == null) {
			e = rebuild(l);
			try {
				RegionStore.writeJson(effectiveFile(l.world(), rec.id, rec.headRid), e);
			} catch (IOException ex) {
				Architect.LOGGER.warn("Region {}: effective IR {} could not be rewritten: {}", rec.id, rec.headRid, ex.toString());
			}
		}
		EFFECTIVE.put(k, e);
		return e;
	}

	/** The effective IR rebuilt from the base and every standing accepted revision, in position order (a lost snapshot, §4.3). */
	static JsonObject rebuild(RegionsImpl.Live l) {
		JsonObject e = l.ir().json();
		List<Rev> revs = new ArrayList<>(l.rec().revisions);
		revs.sort(java.util.Comparator.comparingInt(r -> r.position));
		for (Rev r : revs) {
			if (!r.standing() || r.position > l.rec().position) {
				continue;
			}
			Ir ir = irOf(l, r.rid);
			if (ir != null) {
				e = merge(e, ir.json(), r.rid, r.position, r.irSha);
			}
		}
		return e;
	}

	/** The kit's {@code mergeEffective} one revision at a time: parts, lots and roads appended with their rid; the graph; revisions; head. */
	static JsonObject merge(JsonObject prev, JsonObject revIr, int rid, int position, String irSha) {
		JsonObject out = prev.deepCopy();
		for (String k : List.of("parts", "lots", "roads")) {
			JsonArray a = out.get(k) instanceof JsonArray x ? x : new JsonArray();
			if (revIr.get(k) instanceof JsonArray add) {
				for (JsonElement e : add) {
					JsonObject c = e.getAsJsonObject().deepCopy();
					c.addProperty("rid", rid);
					a.add(c);
				}
			}
			out.add(k, a);
		}
		if (revIr.get("graph") instanceof JsonObject g) {
			JsonObject og = out.get("graph") instanceof JsonObject x ? x : new JsonObject();
			for (String k : List.of("nodes", "edges")) {
				JsonArray a = og.get(k) instanceof JsonArray x ? x : new JsonArray();
				if (g.get(k) instanceof JsonArray add) {
					add.forEach(e -> a.add(e.deepCopy()));
				}
				og.add(k, a);
			}
			if (!og.getAsJsonArray("nodes").isEmpty() || !og.getAsJsonArray("edges").isEmpty()) {
				out.add("graph", og);
			}
		}
		JsonArray list = out.get("revisions") instanceof JsonArray x ? x : new JsonArray();
		JsonObject one = new JsonObject();
		one.addProperty("rid", rid);
		one.addProperty("position", position);
		one.addProperty("irSha", irSha);
		one.add("stages", revIr.get("stages") instanceof JsonArray s ? s.deepCopy() : new JsonArray());
		JsonArray parts = new JsonArray();
		if (revIr.get("parts") instanceof JsonArray ps) {
			ps.forEach(p -> parts.add(p.getAsJsonObject().get("id").getAsString()));
		}
		one.add("parts", parts);
		JsonObject lots = new JsonObject();
		JsonArray lotsAdd = new JsonArray();
		if (revIr.get("lots") instanceof JsonArray ls) {
			ls.forEach(x -> lotsAdd.add(x.getAsJsonObject().get("id").getAsString()));
		}
		lots.add("add", lotsAdd);
		JsonObject rvm = revIr.get("revision") instanceof JsonObject x ? x : new JsonObject();
		lots.add("refill", rvm.get("lots") instanceof JsonObject lo && lo.get("refill") instanceof JsonArray rf ? rf.deepCopy() : new JsonArray());
		one.add("lots", lots);
		JsonArray roads = new JsonArray();
		if (revIr.get("roads") instanceof JsonArray rs) {
			rs.forEach(x -> roads.add(x.getAsJsonObject().get("id").getAsString()));
		}
		one.add("roads", roads);
		list.add(one);
		out.add("revisions", list);
		out.addProperty("head", rid);
		return out;
	}

	// ------------------------------------------------------------------ the standing data and the history (§3.4, §5.3)

	/**
	 * ctx.standing (§5.3) for a revision of {@code l}: the effective IR's standing data (BesideReach.standing, the kit's besideStanding), the
	 * held columns over the claim (the region's own and its terrain's apart), the standing beside regions' reach and hold columns in its
	 * claim, the owner's protected areas, its unfinished tiles and its lots' states. The kit fills the ids from the effective IR.
	 */
	static JsonObject standing(RegionsImpl.Live l, JsonObject eff) throws IOException {
		RegionRec rec = l.rec();
		int[] c = rec.claim;
		int[] area = {c[0], c[2], c[3], c[5]};
		JsonObject st = BesideReach.standing(rec.id, area, eff);
		st.addProperty("format", "standing/1");
		st.add("held", BesideReach.held(rec.dimension, area, rec.groupId, BesideReach.propsStages(eff), null));
		JsonArray beside = new JsonArray();
		for (RegionsImpl.Live o : RegionsImpl.all()) {
			if (o == l || !rec.id.equals(o.rec().beside) || o.rec().state == RegionState.REMOVED || o.rec().state == RegionState.REMOVING) {
				continue;
			}
			JsonObject b = new JsonObject();
			b.addProperty("id", o.rec().id);
			JsonObject reach = o.ir().json().get("reach") instanceof JsonObject r ? r : new JsonObject();
			b.add("reach", reach.get("runs") instanceof JsonArray a ? a.deepCopy() : new JsonArray());
			b.add("hold", reach.get("hold") instanceof JsonArray a ? a.deepCopy() : new JsonArray());
			beside.add(b);
		}
		st.add("beside", beside);
		// (6d GR §2.3) a district beside a town: the town's claim (a district's growth never takes town land)
		if (rec.beside != null && RegionsImpl.live(rec.beside) instanceof RegionsImpl.Live tl && tl.rec().state != RegionState.REMOVED && tl.rec().state != RegionState.REMOVING) {
			JsonObject town = new JsonObject();
			town.addProperty("id", tl.rec().id);
			int[] tc = tl.rec().claim;
			town.add("claim", BesideReach.arr(new int[] {tc[0], tc[2], tc[3], tc[5]}));
			st.add("town", town);
		}
		st.add("keepOut", RegionsImpl.keepOutOf(rec.dimension, rec.owner, c, false));
		st.add("unfinished", unfinished(l));
		JsonObject lots = new JsonObject();
		java.util.Set<String> irrigated = new java.util.HashSet<>();
		if (eff.get("lots") instanceof JsonArray el) {
			for (JsonElement e : el) {
				if (e instanceof JsonObject lo && lo.get("irrigation") instanceof JsonObject) {
					irrigated.add(str(lo, "id", ""));
				}
			}
		}
		rec.lots.forEach((id, ls) -> {
			JsonObject o = new JsonObject();
			o.addProperty("state", ls.state);
			if (ls.siteId != null) {
				o.addProperty("siteId", ls.siteId);
			}
			if (irrigated.contains(id)) {
				o.addProperty("irrigated", true); // (S-RV-14) an irrigated lot's refill is refused
			}
			lots.add(id, o);
		});
		st.add("lots", lots);
		return st;
	}

	/**
	 * The region's unfinished tiles (§5.4): a tile key of the realised plan's IR with no realised record in any of its stages and sets
	 * (never written, a failed tile item, a stage not reached). A tile whose records exist but whose entries were all no-ops is finished.
	 */
	static JsonArray unfinished(RegionsImpl.Live l) {
		java.util.TreeSet<String> out = new java.util.TreeSet<>();
		Ir ir = l.ir();
		for (String st : ir.stages()) {
			for (String set : List.of("terrain", "path")) {
				Map<String, List<String>> tiles = set.equals("terrain") ? ir.terrainTiles() : ir.pathTiles();
				for (String key : tiles.getOrDefault(st, List.of())) {
					try {
						if (Realised.read(l.world(), l.rec().id, 0, st, set, key) == null) {
							out.add(key);
						}
					} catch (IOException e) {
						out.add(key);
					}
				}
			}
		}
		JsonArray a = new JsonArray();
		out.forEach(a::add);
		return a;
	}

	/**
	 * §3.4's {@code historySha(key)}: sha256 of the canonical list, in layer order, of {@code [layer, stage, set, tileSha, status]} for every
	 * realised record of the region at tile {@code key} (the realised plan's, then each standing revision's). Compared only with itself.
	 */
	public static String historySha(RegionsImpl.Live l, String key) {
		JsonArray rows = new JsonArray();
		addRows(rows, l, 0, l.ir(), key);
		List<Rev> revs = new ArrayList<>(l.rec().revisions);
		revs.sort(java.util.Comparator.comparingInt(r -> r.rid));
		for (Rev r : revs) {
			Ir ir = irOf(l, r.rid);
			if (ir != null) {
				addRows(rows, l, r.rid, ir, key);
			}
		}
		return sha256(rows.toString());
	}

	private static void addRows(JsonArray rows, RegionsImpl.Live l, int layer, Ir ir, String key) {
		for (String st : ir.stages()) {
			for (String set : List.of("terrain", "path")) {
				Realised.Tile rec;
				try {
					rec = Realised.read(l.world(), l.rec().id, layer, st, set, key);
				} catch (IOException e) {
					rec = null;
				}
				if (rec == null) {
					continue;
				}
				JsonArray row = new JsonArray();
				row.add(layer);
				row.add(st);
				row.add(set);
				row.add(HexFormat.of().formatHex(rec.tileSha()));
				row.add(dev.larattalabs.architect.site.RealisedRecords.status(layer == 0 ? l : liveFor(l, stageName(layer, st)), rec));
				rows.add(row);
			}
		}
	}

	// ------------------------------------------------------------------ planRevision

	/** The revision inputs of plans under way (the plan message's {@code revision} member), by request. */
	static final Map<RegionPlanRequest, JsonObject> INPUT = java.util.Collections.synchronizedMap(new java.util.IdentityHashMap<>());
	/** The rid a plan in flight took (region id, rid): a plan that fails gives it back while no later plan took one (see {@link #giveBack}). */
	static final Map<RegionPlanRequest, Object[]> RIDS = java.util.Collections.synchronizedMap(new java.util.IdentityHashMap<>());

	/**
	 * (Steward's RC of RV-a/b) A refused or failed revision plan does not keep its rid: the region's {@code nextRid} steps back when it is
	 * still that rid (no later plan took one meanwhile), so an accepted revision's rid counts only candidates that planned. A failure after
	 * a later plan took a rid leaves a gap (rids are monotonic and never reused; a gap names no revision). Any thread.
	 */
	static void giveBack(RegionPlanRequest r, boolean failed) {
		Object[] t = RIDS.remove(r);
		MinecraftServer s = RegionsImpl.server();
		if (t == null || !failed || s == null) {
			return;
		}
		s.execute(() -> {
			RegionsImpl.Live l = RegionsImpl.live((String) t[0]);
			if (l != null && l.rec().nextRid == (int) t[1]) {
				l.rec().nextRid--;
				RegionsImpl.save(l);
				Architect.LOGGER.info("Region {}: the refused plan's rid {} given back", t[0], t[1]);
			}
		});
	}

	/** The candidate of a plan under way (planned.revisionOf), by request. */
	static final Map<RegionPlanRequest, JsonObject> CANDIDATE = java.util.Collections.synchronizedMap(new java.util.IdentityHashMap<>());

	/**
	 * Regions.planRevision (§2.4): a candidate on the head. The region must stand and not be busy; the program is {@code revise}. Planned as
	 * a region plan of the region's claim (the survey with the region's frozen heights over it), the revision input riding along; the plan
	 * carries {@code revisionOf} (the region, rid, position, parent, its dirty tiles and the region's history at each).
	 */
	public static CompletableFuture<RegionPlan> plan(String regionId, RevisionRequest req) {
		MinecraftServer s = RegionsImpl.server();
		if (s == null) {
			return CompletableFuture.failedFuture(new IllegalStateException("no world"));
		}
		return RegionsImpl.onServer(s, () -> {
			RegionsImpl.Live l = RegionsImpl.live(regionId);
			if (l == null) {
				throw RegionsImpl.refusal(Reason.OTHER, "no region " + regionId);
			}
			// (6d GR §9) a growth: the region's own program with params {grow}, or revise with {grow} or {spec: {grow}}: revise's spec.grow
			JsonObject params = growParams(req);
			if (params == null) {
				throw RegionsImpl.refusal(Reason.NOT_ALLOWED, "a revision is planned with the bundled program '" + PROGRAM + "', or a growth with the region's program and params {grow} (got '"
					+ req.program() + "')");
			}
			for (String k : req.ext().keySet()) {
				if (k.startsWith("architect_mc:")) {
					throw RegionsImpl.refusal(Reason.NOT_ALLOWED, "the revision's ext key " + k + " is Architect's own");
				}
			}
			ServerLevel level = l.level(s);
			if (level == null) {
				throw RegionsImpl.refusal(Reason.NOT_LOADED, l.rec().dimension + " is not loaded");
			}
			int[] c = l.rec().claim;
			JsonObject ext = req.ext().deepCopy();
			JsonObject of = new JsonObject();
			of.addProperty("region", regionId);
			ext.add(EXT_REVISION_OF, of);
			// (the region's land is generated: its survey reads every generated chunk, loaded or not; the frozen heights go over it)
			RegionPlanRequest r = new RegionPlanRequest(PROGRAM, params, level, new BoundingBox(c[0], c[1], c[2], c[3], c[4], c[5]), null, null, null,
				LoadPolicy.GENERATED_ONLY(4096), l.rec().owner, ext, req.opKey(), null);
			return RegionsImpl.INSTANCE.plan(r).whenComplete((p, e) -> giveBack(r, e != null));
		}).thenCompose(f -> f).handle((p, e) -> {
			if (e == null) {
				return p;
			}
			throw refused(e);
		});
	}

	/**
	 * (6d GR §9) The revise program's params of a request: {@code revise} with its own params ({@code {grow}} at the top moves into
	 * {@code spec.grow}); any other program only as a growth ({@code params.grow}, the region's own program: a flat_village, districts or
	 * plan_v0 region), mapped to {@code {spec: {grow}}}. Null: not a revision this program can plan.
	 */
	static @Nullable JsonObject growParams(RevisionRequest req) {
		JsonObject p = req.params();
		JsonObject grow = p.get("grow") instanceof JsonObject g ? g : null;
		if (PROGRAM.equals(req.program())) {
			if (grow == null) {
				return p;
			}
			JsonObject out = p.deepCopy();
			out.remove("grow");
			JsonObject spec = out.get("spec") instanceof JsonObject sp ? sp : new JsonObject();
			spec.add("grow", grow.deepCopy());
			out.add("spec", spec);
			return out;
		}
		if (grow == null) {
			return null;
		}
		JsonObject spec = new JsonObject();
		spec.add("grow", grow.deepCopy());
		JsonObject out = new JsonObject();
		out.add("spec", spec);
		return out;
	}

	/** The kit's named refusal at the head of a plan failure ({@code CODE: [kind] message}), the guard's (§5); (6d GR) a growth's NO_ROOM. */
	private static final Pattern REFUSAL = Pattern.compile("(?:^|: )(COVERED|OVERLAP_BUSY|OVERLAP_OWNED|OVERLAP|PROTECTED|NOT_ALLOWED|REGION_LIMIT|PLAN_STALE|LAYER_DEPTH|NO_ROOM): (\\[[a-z_]+\\] )?");

	/**
	 * A planRevision failure as the caller reads it: a refusal already (a Reason) as it is; the kit's guard's named refusal (§5.1, §5.2,
	 * §2.2) as a {@link RegionsImpl.RegionException} with its Reason and the kit's message; anything else as it came.
	 */
	static RuntimeException refused(Throwable e) {
		Throwable c = e instanceof java.util.concurrent.CompletionException && e.getCause() != null ? e.getCause() : e;
		if (c instanceof dev.larattalabs.architect.api.ArchitectRefused r) {
			return r;
		}
		String msg = String.valueOf(c.getMessage());
		Matcher m = REFUSAL.matcher(msg);
		if (m.find()) {
			return RegionsImpl.refusal(Reason.valueOf(m.group(1)), msg.substring(m.start() == 0 ? 0 : m.start() + 2));
		}
		return c instanceof RuntimeException re ? re : new java.util.concurrent.CompletionException(c);
	}

	/** Whether a region plan request is a revision's (planRevision's own ext). */
	static @Nullable String regionOf(RegionPlanRequest r) {
		return r.ext().get(EXT_REVISION_OF) instanceof JsonObject o && o.get("region") instanceof JsonElement e && e.isJsonPrimitive() ? e.getAsString() : null;
	}

	/**
	 * At the start of a revision's plan (server thread, from RegionsImpl.plan0raw): the region's standing rules (§4.1: PLACED, PARTIAL or
	 * FAILED with cells; not busy, not removing), the rid (allocated now: monotonic, never reused, saved), the revision input and the
	 * candidate's members. Returns {reason, message} for a refusal, else null.
	 */
	static String @Nullable [] prepare(RegionPlanRequest r, MinecraftServer s) {
		return prepare(r, s, null);
	}

	/**
	 * {@link #prepare}, with plan/0's revision input ({@code extra}, from {@link #parentInput}: the region, the parent artifact and its plan,
	 * built parts and geometry): the region's history at every tile key of its claim and its held set's sha ride along (the artifact's
	 * historySha and inputs.held, §9.3).
	 */
	static String @Nullable [] prepare(RegionPlanRequest r, MinecraftServer s, @Nullable JsonObject extra) {
		String id = regionOf(r);
		RegionsImpl.Live l = id == null ? null : RegionsImpl.live(id);
		if (l == null) {
			return new String[] {Reason.OTHER.name(), "no region " + id};
		}
		RegionRec rec = l.rec();
		String why = standingProblem(rec);
		if (why != null) {
			return new String[] {rec.busy != null || rec.state == RegionState.PLACING || rec.state == RegionState.REMOVING || rec.state == RegionState.PREPARING
				? Reason.OVERLAP_BUSY.name() : Reason.NOT_ALLOWED.name(), "region " + id + " " + why};
		}
		long accepted = rec.revisions.stream().filter(Rev::standing).count();
		if (accepted >= MAX_ACCEPTED || rec.nextRid >= MAX_RID) {
			return new String[] {Reason.REGION_LIMIT.name(), "region " + id + " has " + accepted + " revisions standing (at most " + MAX_ACCEPTED + "; rid at most "
				+ MAX_RID + "): remove it whole and plan again"};
		}
		int rid = ++rec.nextRid;
		RegionsImpl.save(l);
		RIDS.put(r, new Object[] {id, rid});
		JsonObject eff = effective(l);
		JsonObject in = new JsonObject();
		in.addProperty("rid", rid);
		in.addProperty("position", rec.position + 1);
		JsonObject parent = new JsonObject();
		parent.addProperty("rid", rec.headRid);
		parent.addProperty("irSha", headIrSha(rec));
		in.add("parent", parent);
		JsonObject base = new JsonObject();
		base.addProperty("planId", rec.planId);
		base.addProperty("irSha", rec.irSha);
		in.add("base", base);
		in.add("effective", eff);
		try {
			in.add("standing", standing(l, eff));
		} catch (IOException e) {
			return new String[] {Reason.JOURNAL_UNAVAILABLE.name(), "the journal could not be read for the region's held columns: " + e.getMessage()};
		}
		if (extra != null) {
			extra.entrySet().forEach(e -> in.add(e.getKey(), e.getValue().deepCopy()));
			JsonObject hist = new JsonObject();
			int[] c = rec.claim;
			for (int tx = Math.floorDiv(c[0], Heights.TILE); tx <= Math.floorDiv(c[3], Heights.TILE); tx++) {
				for (int tz = Math.floorDiv(c[2], Heights.TILE); tz <= Math.floorDiv(c[5], Heights.TILE); tz++) {
					hist.addProperty(tx + "," + tz, historySha(l, tx + "," + tz));
				}
			}
			in.add("history", hist);
			in.addProperty("heldSha", sha256(in.getAsJsonObject("standing").get("held").toString()));
		}
		INPUT.put(r, in);
		JsonObject cand = new JsonObject();
		cand.addProperty("region", id);
		cand.addProperty("rid", rid);
		cand.addProperty("position", rec.position + 1);
		cand.addProperty("parentRid", rec.headRid);
		cand.addProperty("parentIrSha", headIrSha(rec));
		CANDIDATE.put(r, cand);
		Architect.LOGGER.info("Region {}: revision {} planned on head {} (position {})", id, rid, rec.headRid, rec.position + 1);
		return null;
	}

	/** (§9.1) The head's artifact: the realised plan's (C36's ext) at position 0, else the head revision's (null when planRevision made it). */
	static @Nullable String headArtifact(RegionRec rec) {
		if (rec.headRid == 0) {
			return PlanChecks.artifactOf(rec);
		}
		Rev h = head(rec);
		return h == null ? null : h.artifact;
	}

	/**
	 * (§9.1, §9.2) plan/0's revision input from the parent artifact: the region, the parent (its rid, artifact and IR sha), and the parent's
	 * plan, the parts it built (fits or adjusted; a dropped, unsupported or blocked part is checked as added) and their geometry.
	 */
	static JsonObject parentInput(RegionsImpl.Live l, String sha, JsonObject body) {
		RegionRec rec = l.rec();
		JsonObject o = new JsonObject();
		o.addProperty("region", rec.id);
		o.addProperty("parentRid", rec.headRid);
		o.addProperty("parentArtifact", sha);
		o.addProperty("parentIrSha", headIrSha(rec));
		JsonObject parent = new JsonObject();
		parent.add("plan", body.get("plan") == null ? new JsonObject() : body.get("plan").deepCopy());
		JsonArray built = new JsonArray();
		JsonObject geom = new JsonObject();
		if (body.get("parts") instanceof JsonArray parts) {
			for (JsonElement e : parts) {
				JsonObject p = e.getAsJsonObject();
				String cls = str(p, "class", "");
				if (cls.equals("fits") || cls.equals("adjusted")) {
					built.add(str(p, "part", ""));
					if (p.get("geometry") instanceof JsonObject g && g.get("rect") instanceof JsonArray rect && rect.size() == 4) {
						geom.add(str(p, "part", ""), rect.deepCopy());
					}
				}
			}
		}
		parent.add("built", built);
		parent.add("geometry", geom);
		o.add("parent", parent);
		return o;
	}

	/** Why a region can't be revised now, or null (§4.1, D3's standing rule). */
	static @Nullable String standingProblem(RegionRec rec) {
		if (rec.busy != null) {
			return "is busy (" + rec.busy + ")";
		}
		return switch (rec.state) {
			case PLACED, PARTIAL -> null;
			case FAILED -> rec.cellsWritten > 0 ? null : "failed with nothing standing";
			default -> "is " + rec.state.name().toLowerCase(java.util.Locale.ROOT);
		};
	}

	/**
	 * The plan returned (off the server thread, from planOnce's result): the candidate's dirty tiles and the region's history at each, into
	 * {@code planned.revisionOf} (kept with the plan's file).
	 */
	static void annotate(RegionPlanRequest r, JsonObject planned, JsonObject irJson) {
		JsonObject cand = CANDIDATE.get(r);
		if (cand == null) {
			return;
		}
		JsonObject out = cand.deepCopy();
		java.util.TreeSet<String> dirty = new java.util.TreeSet<>();
		if (irJson.get("tiles") instanceof JsonObject tiles) {
			for (var st : tiles.entrySet()) {
				for (String set : List.of("terrain", "path")) {
					if (st.getValue().getAsJsonObject().get(set) instanceof JsonArray keys) {
						keys.forEach(k -> dirty.add(k.getAsString()));
					}
				}
			}
		}
		out.add("dirty", arr(new ArrayList<>(dirty)));
		planned.add("revisionOf", out);
	}

	/** At accept on the server thread: the history of the candidate's dirty tiles (§3.4), recorded at plan (finishPlan, server thread). */
	static void recordHistory(JsonObject planned) {
		if (!(planned.get("revisionOf") instanceof JsonObject ro)) {
			return;
		}
		RegionsImpl.Live l = RegionsImpl.live(str(ro, "region", ""));
		if (l == null || ro.has("history")) {
			return;
		}
		JsonObject h = new JsonObject();
		for (JsonElement k : ro.getAsJsonArray("dirty")) {
			h.addProperty(k.getAsString(), historySha(l, k.getAsString()));
		}
		ro.add("history", h);
	}

	/** A plan's revisionOf for its RegionPlan view, or null. */
	static @Nullable RevisionOf revisionOf(JsonObject planned) {
		if (!(planned.get("revisionOf") instanceof JsonObject ro)) {
			return null;
		}
		return new RevisionOf(str(ro, "region", ""), ro.get("rid").getAsInt(), ro.get("position").getAsInt(), ro.get("parentRid").getAsInt(), str(ro,
			"parentIrSha", ""));
	}

	// ------------------------------------------------------------------ realise: the manifest, the accept, the install (§4.3)

	/** Whether a plan is a revision candidate. */
	static boolean isRevision(RegionsImpl.PlanRec p) {
		return p.planned().get("revisionOf") instanceof JsonObject;
	}

	/**
	 * Realises a revision candidate (Regions.realise of its plan, §4.3): the refusals before anything is written, then rev/<rid>/ir.json, the
	 * manifest, the accept (the compare-and-set on the head and the dirty tiles' history; the effective snapshot; region.json, the one
	 * publication), the install and the start. Returns the region id. Server thread.
	 */
	static String realise(MinecraftServer s, RealiseRequest r, RegionsImpl.PlanRec p) {
		JsonObject ro = p.planned().getAsJsonObject("revisionOf");
		String id = str(ro, "region", "");
		int rid = ro.get("rid").getAsInt();
		RegionsImpl.Live l = RegionsImpl.live(id);
		if (l == null) {
			throw RegionsImpl.refusal(Reason.OTHER, "revision " + rid + ": no region " + id + " (re-plan)");
		}
		RegionRec rec = l.rec();
		Rev done = rev(rec, rid);
		if (done != null) {
			return id; // accepted before (a repeated realise of the same plan): its region
		}
		String why = standingProblem(rec);
		if (why != null) {
			throw RegionsImpl.refusal(rec.busy != null || rec.state == RegionState.PLACING || rec.state == RegionState.REMOVING ? Reason.OVERLAP_BUSY : Reason.NOT_ALLOWED,
				"region " + id + " " + why);
		}
		// the compare-and-set (§4.2): the parent is the head, and the region's history at every dirty tile is as planned
		int parentRid = ro.get("parentRid").getAsInt();
		if (rec.headRid != parentRid) {
			throw RegionsImpl.refusal(Reason.PLAN_STALE, "revision " + rid + " was planned on head " + parentRid + "; the head is now " + rec.headRid
				+ " (parent_moved): plan it again");
		}
		JsonObject hist = ro.get("history") instanceof JsonObject h ? h : new JsonObject();
		for (var e : hist.entrySet()) {
			if (!e.getValue().getAsString().equals(historySha(l, e.getKey()))) {
				throw RegionsImpl.refusal(Reason.PLAN_STALE, "revision " + rid + ": the region's history at tile " + e.getKey() + " moved since the plan (history): plan it again");
			}
		}
		Ir ir = p.ir();
		JsonObject irJson = ir.json();
		// (§4.6) refills: each lot still removed or a pad (else the plan is stale), with the entry it is built with
		for (String lot : refills(irJson)) {
			RegionRec.Lot ls = rec.lots.get(lot);
			if (ls == null || !("removed".equals(ls.state) || "pad".equals(ls.state))) {
				throw RegionsImpl.refusal(Reason.PLAN_STALE, "revision " + rid + " refills lot " + lot + ", which is " + (ls == null ? "gone" : ls.state) + " now: plan it again");
			}
			if (!r.lotEntries().containsKey(lot)) {
				throw RegionsImpl.refusal(Reason.NOT_ALLOWED, "revision " + rid + " refills lot " + lot + ": the realise names no entry for it (lotEntries)");
			}
		}
		// (§8) survival, additive: in the region's own mode; never while a target of the region (its own or an earlier revision's) is
		// still building (survival_unfinished); a cell over a paid block the region built refuses at the tile (TileCheck: survival_paid)
		if (rec.survival() != RegionSurvival.planned(irJson)) {
			throw RegionsImpl.refusal(Reason.NOT_ALLOWED, "revision " + rid + " was planned " + (RegionSurvival.planned(irJson) ? "in survival" : "in creative") + " but region "
				+ id + " builds " + (rec.survival() ? "in survival" : "in creative") + ": plan it again");
		}
		if (rec.survival()) {
			if (!RegionSurvival.on(s)) {
				throw RegionsImpl.refusal(Reason.NOT_ALLOWED, "region " + id + " builds in survival and this world is not in survival now");
			}
			String[] building = dev.larattalabs.architect.site.RegionTargets.firstBuilding(rec.groupId);
			if (building != null) {
				throw RegionsImpl.refusal(Reason.NOT_ALLOWED, "region " + id + "'s " + (building[1] != null ? building[1] : "target " + building[0])
					+ " is still building (survival_unfinished): a revision is added over built work only");
			}
		}
		String unavailable = WorldJournal.unavailable();
		if (unavailable != null) {
			throw RegionsImpl.refusal(Reason.JOURNAL_UNAVAILABLE, unavailable);
		}
		ServerLevel level = l.level(s);
		if (level == null) {
			throw RegionsImpl.refusal(Reason.NOT_LOADED, rec.dimension + " is not loaded");
		}
		Path w = l.world();
		Path rd = dir(w, id, rid);
		// 1. files; 2. the manifest
		JsonObject op = new JsonObject();
		op.addProperty("op", "realise");
		op.addProperty("rid", rid);
		op.addProperty("planId", p.planId());
		op.add("items", arr(itemKeys(ir, rid, r)));
		JsonObject le = new JsonObject();
		r.lotEntries().forEach(le::addProperty);
		op.add("lotEntries", le);
		op.addProperty("autoApprove", r.autoApprove());
		// (6d GR, Steward's keys) the caller's own ext (not architect_mc:*), carried onto every item the revision writes, so its sites name it
		JsonObject callerExt = new JsonObject();
		r.ext().entrySet().forEach(e -> {
			if (!e.getKey().startsWith("architect_mc:")) {
				callerExt.add(e.getKey(), e.getValue().deepCopy());
			}
		});
		op.add("ext", callerExt);
		op.addProperty("state", "prepared");
		try {
			Files.createDirectories(rd);
			RegionStore.writeJson(rd.resolve("ir.json"), irJson);
			RegionStore.writeJson(rd.resolve("op.json"), op);
		} catch (IOException e) {
			throw RegionsImpl.refusal(Reason.OTHER, "revision " + rid + " could not be saved: " + e.getMessage());
		}
		WorldJournal.kill("RV1"); // the manifest written, nothing accepted
		// 3. the accept: the effective snapshot (head-addressed: publishes nothing), then region.json (the one publication)
		int position = rec.position + 1;
		JsonObject eff = merge(effective(l), irJson, rid, position, p.irSha());
		try {
			Files.createDirectories(effectiveFile(w, id, rid).getParent());
			RegionStore.writeJson(effectiveFile(w, id, rid), eff);
		} catch (IOException e) {
			throw RegionsImpl.refusal(Reason.OTHER, "revision " + rid + ": the effective IR could not be saved: " + e.getMessage());
		}
		WorldJournal.kill("RV2"); // the snapshot on disk, region.json not yet renamed: readers still see the old head
		Rev rv = new Rev();
		rv.rid = rid;
		rv.position = position;
		rv.parentRid = parentRid;
		rv.planId = p.planId();
		rv.irSha = p.irSha();
		rv.state = "ACCEPTED";
		rv.createdAt = System.currentTimeMillis();
		for (String st : ir.stages()) {
			rv.stages.add(stageName(rid, st));
		}
		for (Ir.Lot lot : ir.lots()) {
			rv.lotsAdded.add(lot.id());
		}
		rv.lotsRefilled.addAll(refills(irJson));
		rv.opKey = r.opKey();
		rv.actor = r.actor() == null ? null : r.actor().getStringUUID();
		rv.regionStateBefore = rec.state.name();
		rv.artifact = r.ext().get(PlanChecks.EXT_ARTIFACT) instanceof JsonElement ae && ae.isJsonPrimitive() ? ae.getAsString() : null; // (realiseApproved's)
		rec.revisions.add(rv);
		rec.headRid = rid;
		rec.position = position;
		rec.busy = "revising " + rid;
		rec.manifest = "rev/" + rid + "/op.json";
		rec.state = RegionState.PLACING;
		for (String st : rv.stages) {
			rec.stages.put(st, new RegionRec.Stage());
		}
		EFFECTIVE.put(id + "#" + rid, eff);
		RegionsImpl.save(l); // the publication
		WorldJournal.kill("RV3"); // accepted, nothing installed
		// 4. the install (idempotent by item key); 5. the write runs as a batch of the region's group
		install(s, l, rv, op);
		SiteEvents.REGION_STATE.invoker().onState(RegionsImpl.view(l));
		Architect.LOGGER.info("Region {}: revision {} accepted at position {} (plan {}), {} stage(s)", id, rid, position, p.planId(), rv.stages.size());
		return id;
	}

	/** (§4.6) The lots a revision IR refills ({@code revision.lots.refill}). */
	static List<String> refills(JsonObject irJson) {
		JsonObject rvm = irJson.get("revision") instanceof JsonObject x ? x : new JsonObject();
		return rvm.get("lots") instanceof JsonObject lo ? strings(lo, "refill") : List.of();
	}

	/** Every item key a revision installs, in order (the manifest's items, §4.3 step 2): its tiles by stage and set, then its lots (refills first). */
	static List<String> itemKeys(Ir ir, int rid, @Nullable RealiseRequest r) {
		List<String> out = new ArrayList<>();
		for (String lot : refills(ir.json())) {
			out.add("lot:" + lot);
		}
		for (String st : ir.stages()) {
			String name = stageName(rid, st);
			for (String key : ir.terrainTiles().getOrDefault(st, List.of())) {
				out.add(RegionsImpl.tileKey(name, "terrain", key));
			}
			for (String key : ir.pathTiles().getOrDefault(st, List.of())) {
				out.add(RegionsImpl.tileKey(name, "path", key));
			}
			for (Ir.Road road : ir.roads()) {
				if (road.stage().equals(st)) {
					out.add("road:" + road.id());
				}
			}
			for (Ir.Lot lot : ir.lots()) {
				if (lot.stage().equals(st) && (r == null || r.lotEntries().containsKey(lot.id()))) {
					out.add("lot:" + lot.id());
				}
			}
		}
		return out;
	}

	/**
	 * §4.3 step 4: the revision's stages on the region's group and its items as a new batch there; then the manifest's {@code installed}.
	 * Idempotent: a revision whose batch exists installs nothing again.
	 */
	static void install(MinecraftServer s, RegionsImpl.Live l, Rev rv, JsonObject op) {
		RegionRec rec = l.rec();
		if (rv.batchId != null && Batches.get(rv.batchId) != null) {
			return;
		}
		for (QBatch b : Batches.ofGroup(rec.groupId)) {
			if (b.ext.get(EXT_REVISION) instanceof JsonObject x && x.get("rid").getAsInt() == rv.rid) {
				rv.batchId = b.id;
				return;
			}
		}
		Ir ir = irOf(l, rv.rid);
		ServerLevel level = l.level(s);
		if (ir == null || level == null) {
			rv.state = "FAILED";
			rv.waiting = ir == null ? "its IR could not be read" : rec.dimension + " is not loaded";
			end(l, rv, RegionState.valueOf(rv.regionStateBefore));
			return;
		}
		RegionsImpl.Live rl = liveFor(l, stageName(rv.rid, ir.stages().get(0)));
		Map<String, String> lotEntries = new LinkedHashMap<>();
		if (op.get("lotEntries") instanceof JsonObject le) {
			le.entrySet().forEach(e -> lotEntries.put(e.getKey(), e.getValue().getAsString()));
		}
		JsonObject revExt = new JsonObject();
		revExt.addProperty("region", rec.id);
		revExt.addProperty("rid", rv.rid);
		List<QItem> items = new ArrayList<>();
		JsonObject callerExt = op.get("ext") instanceof JsonObject ce ? ce : new JsonObject();
		List<String> stages = new ArrayList<>();
		// (§4.6) refills: the standing lot (its box from the effective IR) gets a building again, an item of the revision's first stage; the
		// lot's state before is kept for the undo
		List<String> refill = refills(ir.json());
		if (!refill.isEmpty()) {
			Ir eff = Ir.lenient(effective(l), rec.claim);
			String first = stageName(rv.rid, ir.stages().get(0));
			for (String lotId : refill) {
				Ir.Lot lot = eff.lots().stream().filter(x -> x.id().equals(lotId)).findFirst().orElse(null);
				RegionRec.Lot ls = rec.lots.computeIfAbsent(lotId, k -> new RegionRec.Lot());
				if (!rv.refilledPrior.has(lotId)) {
					JsonObject was = new JsonObject();
					was.addProperty("state", ls.state);
					was.addProperty("stage", ls.stage);
					if (ls.siteId != null) {
						was.addProperty("siteId", ls.siteId);
					}
					if (ls.entry != null) {
						was.addProperty("entry", ls.entry);
					}
					if (ls.removedAt > 0) {
						was.addProperty("removedAt", ls.removedAt);
					}
					rv.refilledPrior.add(lotId, was);
				}
				String entry = lotEntries.get(lotId);
				if (lot == null || entry == null) {
					continue;
				}
				Ir.Lot named = new Ir.Lot(lot.id(), first, lot.part(), lot.box(), lot.floorY(), lot.front(), lot.brief(), lot.max());
				QItem li = RegionsImpl.lotItemOf(level, rec, eff, named, entry, new ArrayList<>(), lotEntries, rv.actor);
				if (li != null) {
					li.ext.add(EXT_REVISION, revExt.deepCopy());
					items.add(li);
					ls.stage = first;
					ls.entry = entry;
					ls.removedAt = 0;
					ls.state = li.status == QItem.Status.FAILED ? "failed:" + li.reason : "queued";
				}
			}
		}
		for (String st : ir.stages()) {
			String name = stageName(rv.rid, st);
			stages.add(name);
			List<String> terrainKeys = new ArrayList<>();
			for (String key : ir.terrainTiles().getOrDefault(st, List.of())) {
				QItem q = RegionsImpl.tileItemOf(rec, rl.irJson(), ir, name, "terrain", key, List.of());
				q.ext.add(EXT_REVISION, revExt.deepCopy());
				items.add(q);
				terrainKeys.add(key);
			}
			for (String key : ir.pathTiles().getOrDefault(st, List.of())) {
				List<String> after = new ArrayList<>();
				int[] k = Ir.tile(key);
				for (String tk : terrainKeys) {
					int[] t = Ir.tile(tk);
					if (Math.abs(t[0] - k[0]) <= 1 && Math.abs(t[1] - k[1]) <= 1) {
						after.add(RegionsImpl.tileKey(name, "terrain", tk));
					}
				}
				QItem q = RegionsImpl.tileItemOf(rec, rl.irJson(), ir, name, "path", key, after);
				q.ext.add(EXT_REVISION, revExt.deepCopy());
				items.add(q);
			}
			// (a plan/0 revision's added zone brings its streets: 4e road items of the stage, after its tiles, key road:<id>; GR's extensions too)
			List<String> roadKeys = new ArrayList<>();
			for (Ir.Road road : ir.roads()) {
				if (!road.stage().equals(st)) {
					continue;
				}
				Ir.Road named = new Ir.Road(road.id(), name, road.points(), road.width(), road.surface(), road.lanterns(), road.lamp(), road.ext());
				List<String> after = new ArrayList<>();
				terrainKeys.forEach(k -> after.add(RegionsImpl.tileKey(name, "terrain", k)));
				QItem q = RegionsImpl.roadItem(level, rec, named, after);
				q.ext.add(EXT_REVISION, revExt.deepCopy());
				items.add(q);
				roadKeys.add(q.key);
			}
			for (Ir.Lot lot : ir.lots()) {
				if (!lot.stage().equals(st)) {
					continue;
				}
				RegionRec.Lot ls = new RegionRec.Lot();
				ls.stage = name;
				rec.lots.put(lot.id(), ls);
				String entry = lotEntries.get(lot.id());
				if (entry == null) {
					continue; // a pad
				}
				ls.entry = entry;
				Ir.Lot named = new Ir.Lot(lot.id(), name, lot.part(), lot.box(), lot.floorY(), lot.front(), lot.brief(), lot.max());
				List<String> lotAfter = new ArrayList<>(terrainKeys.stream().map(k -> RegionsImpl.tileKey(name, "terrain", k)).toList());
				lotAfter.addAll(roadKeys);
				QItem li = RegionsImpl.lotItemOf(level, rec, ir, named, entry, lotAfter, lotEntries, rv.actor);
				if (li != null) {
					li.ext.add(EXT_REVISION, revExt.deepCopy());
					items.add(li);
					ls.state = li.status == QItem.Status.FAILED ? "failed:" + li.reason : "queued";
				}
			}
			RegionRec.Stage sp = rec.stages.computeIfAbsent(name, k -> new RegionRec.Stage());
			sp.tilesTotal = ir.terrainTiles().getOrDefault(st, List.of()).size() + ir.pathTiles().getOrDefault(st, List.of()).size();
		}
		for (QItem q : items) {
			callerExt.entrySet().forEach(e -> {
				if (!q.ext.has(e.getKey())) {
					q.ext.add(e.getKey(), e.getValue().deepCopy());
				}
			});
		}
		LoadPolicy load = LoadPolicy.GENERATED_ONLY(Math.max(64, 36 + 2 * 36));
		boolean auto = op.has("autoApprove") && op.get("autoApprove").getAsBoolean();
		QBatch b = Batches.queueRevision(s, rec.id, rv.rid, rec.groupId, rec.owner, rec.ext, items, stages, load.maxChunks(), load.generate(), auto, 0);
		rv.batchId = b.id;
		rv.state = "PLACING";
		op.addProperty("state", "installed");
		try {
			RegionStore.writeJson(dir(l.world(), rec.id, rv.rid).resolve("op.json"), op);
		} catch (IOException e) {
			Architect.LOGGER.warn("Region {}: revision {}'s manifest could not be saved: {}", rec.id, rv.rid, e.toString());
		}
		RegionsImpl.save(l);
		WorldJournal.kill("RV4"); // installed, nothing written
	}

	// ------------------------------------------------------------------ progress and the end

	/** A revision batch's item placed or failed (from RegionsImpl.itemDone): its sites. */
	static void itemDone(RegionsImpl.Live l, QBatch b, QItem i) {
		int rid = b.ext.get(EXT_REVISION) instanceof JsonObject x ? x.get("rid").getAsInt() : 0;
		Rev rv = rid == 0 ? null : rev(l.rec(), rid);
		if (rv == null) {
			return;
		}
		if (i.status == QItem.Status.PLACED && i.siteId != null && !rv.sites.contains(i.siteId)) {
			rv.sites.add(i.siteId);
		}
		if (i.status == QItem.Status.FAILED && rv.waiting == null) {
			rv.waiting = i.key + ": " + (i.reason == null ? "failed" : i.reason) + (i.message == null || i.message.isEmpty() ? "" : " (" + i.message + ")");
		}
	}

	/**
	 * (§3.3) A revision tile's raced cells (InfraJob, after its write): recorded in the revision layer's sites.json ({@code raced.<stage>|<set>|<key>}:
	 * {site, cells, held}); when another site holds any of them, the revision stops (the rest of its batch fails: PARTIAL).
	 */
	public static void raced(MinecraftServer s, String region, String stage, String set, String key, String site, List<Long> raced, List<Long> held,
		@Nullable String batchId) {
		RegionsImpl.Live l = RegionsImpl.live(region);
		int rid = layerOf(stage);
		if (l == null || rid == 0) {
			return;
		}
		JsonObject o = new JsonObject();
		o.addProperty("site", site);
		JsonArray cells = new JsonArray();
		for (long c : raced) {
			JsonArray q = new JsonArray();
			q.add(net.minecraft.core.BlockPos.getX(c));
			q.add(net.minecraft.core.BlockPos.getY(c));
			q.add(net.minecraft.core.BlockPos.getZ(c));
			q.add(held.contains(c));
			cells.add(q);
		}
		o.add("cells", cells);
		o.addProperty("at", System.currentTimeMillis());
		Realised.putSite(l.world(), region, rid, "raced", plainStage(stage) + "|" + set + "|" + key, o);
		Rev rv = rev(l.rec(), rid);
		Architect.LOGGER.info("Region {}: revision {} tile {} {} {}: {} cell(s) RACED (changed since their capture, not written), {} held by another site", region, rid,
			stage, set, key, raced.size(), held.size());
		if (!held.isEmpty() && rv != null) {
			long c = held.get(0);
			String msg = "revision " + rid + " stopped: (" + net.minecraft.core.BlockPos.getX(c) + ", " + net.minecraft.core.BlockPos.getY(c) + ", "
				+ net.minecraft.core.BlockPos.getZ(c) + ") was taken by another site between its check and its write";
			rv.waiting = msg;
			if (batchId != null) {
				Batches.failRest(batchId, Reason.OVERLAP, msg);
			}
			RegionsImpl.save(l);
		}
	}

	/** (dev.rv.race, gate item 20) TEST: a block set on one cell of the next revision tile that writes it, after its capture, before its write. */
	private static volatile int @Nullable [] raceAt;
	private static volatile @Nullable String raceState;

	public static void armRace(int @Nullable [] pos, @Nullable String state) {
		raceAt = pos;
		raceState = state;
	}

	/** The armed race, if this tile writes its cell (InfraJob, entering its write). */
	public static void raceHook(ServerLevel level, long[] positions) {
		int[] at = raceAt;
		String st = raceState;
		if (at == null || st == null) {
			return;
		}
		long want = net.minecraft.core.BlockPos.asLong(at[0], at[1], at[2]);
		for (long p : positions) {
			if (p == want) {
				raceAt = null;
				raceState = null;
				// (as a player's command would: through the server's own /setblock, never Architect's write path)
				var srv = level.getServer();
				srv.getCommands().performPrefixedCommand(srv.createCommandSourceStack().withSuppressedOutput(), "setblock " + at[0] + " " + at[1] + " " + at[2] + " " + st);
				Architect.LOGGER.info("Revision race (TEST): {} set at {} between its tile's capture and its write", st, java.util.Arrays.toString(at));
				return;
			}
		}
	}

	/** Whether a batch is a revision's. */
	public static boolean isRevisionBatch(QBatch b) {
		return b.ext.get(EXT_REVISION) instanceof JsonObject;
	}

	/**
	 * A revision's batch ended (§4.3 step 6): the revision PLACED, PARTIAL or FAILED; the region reads its own pre-revision state again
	 * (Steward's point 1); busy cleared; the manifest done.
	 */
	static void batchDone(RegionsImpl.Live l, QBatch b) {
		int rid = b.ext.getAsJsonObject(EXT_REVISION).get("rid").getAsInt();
		Rev rv = rev(l.rec(), rid);
		if (rv == null) {
			return;
		}
		// (§7) an added body not written or drained by its escape guard ends the revision PARTIAL (H's rule, the revision's own)
		RegionsImpl.Live fl = liveFor(l, stageName(rid, RegionFluids.STAGE));
		boolean drained = fl.rid() == rid && RegionFluids.anyDrained(fl);
		boolean allPlaced = b.items.stream().allMatch(i -> i.status == QItem.Status.PLACED) && !drained;
		boolean any = b.items.stream().anyMatch(i -> i.status == QItem.Status.PLACED);
		rv.state = b.status == QBatch.Status.DONE && allPlaced ? "PLACED" : any ? "PARTIAL" : "FAILED";
		// (6d GR, Ask 1) the revision's sites from its batch, in item order: an item placed before a halt whose itemDone was not saved
		// (the region record lost with the stop) is listed too, so RevisionView.sites names every site the revision wrote
		List<String> sites = new ArrayList<>();
		for (QItem i : b.items) {
			if (i.status == QItem.Status.PLACED && i.siteId != null && !sites.contains(i.siteId)) {
				sites.add(i.siteId);
			}
		}
		for (String sid : rv.sites) {
			if (!sites.contains(sid)) {
				sites.add(sid);
			}
		}
		rv.sites.clear();
		rv.sites.addAll(sites);
		end(l, rv, RegionState.valueOf(rv.regionStateBefore));
	}

	private static void end(RegionsImpl.Live l, Rev rv, RegionState before) {
		RegionRec rec = l.rec();
		long cells = 0;
		for (String st : rv.stages) {
			RegionRec.Stage sp = rec.stages.get(st);
			if (sp != null) {
				cells += sp.cells;
			}
		}
		rv.cells = cells;
		rec.state = before;
		rec.busy = null;
		readersMoved(l); // (§4.5) the land and the fluids records from the new head
		Path opf = dir(l.world(), rec.id, rv.rid).resolve("op.json");
		try {
			JsonObject op = RegionStore.readJson(opf);
			if (op != null) {
				op.addProperty("state", "done");
				RegionStore.writeJson(opf, op);
			}
		} catch (IOException e) {
			Architect.LOGGER.warn("Region {}: revision {}'s manifest could not be closed: {}", rec.id, rv.rid, e.toString());
		}
		rec.manifest = null;
		RegionsImpl.save(l);
		Architect.LOGGER.info("Region {}: revision {} ended {} ({} cells); the region reads {} again", rec.id, rv.rid, rv.state, cells, before.name());
		SiteEvents.REGION_STATE.invoker().onState(RegionsImpl.view(l));
	}

	// ------------------------------------------------------------------ undoRevision (§4.4): preflight, then one recoverable operation

	/** The callers' futures of running undo operations, by opId (a same-target call joins it). Server thread. */
	private static final Map<String, List<CompletableFuture<dev.larattalabs.architect.api.RemoveResult>>> UNDO_FUTURES = new java.util.HashMap<>();
	/** The undo operations with a stage removal in flight from this session (the driver waits on it). */
	private static final java.util.Set<String> UNDO_INFLIGHT = new java.util.HashSet<>();
	/** TEST (dev.rv.undoFail): the next undo's stage removals are reported failed, as a player who stayed 10 minutes would. */
	static volatile boolean failNextUndoStage;

	static Path undoFile(Path world, String region, String opId) {
		return RegionStore.region(world, region).resolve("rev").resolve("op-" + opId + ".json");
	}

	/**
	 * Regions.undoRevision (§4.4). The preflight over the whole suffix (positions toPosition + 1 .. head), before anything is written,
	 * refusing with every reason found: busy with another operation (OVERLAP_BUSY), a toPosition not below the head (NOT_ALLOWED), a
	 * standing beside region joined to or reaching over what the suffix added (NOT_ALLOWED joined), a player in a member's box (OCCUPIED),
	 * the owner's things in a suffix lot (NOT_ALLOWED blockers), survival targets still building (NOT_ALLOWED survival_building). Then the
	 * manifest {@code rev/op-<opId>.json} and region.json (the suffix UNDOING, busy {@code undoing <opId>}) in one save: the commit point.
	 * After it the operation is never abandoned: the suffix's bodies drain, its stages are undone top first ({@code Covered.KEEP}: a later
	 * site over a suffix cell gets the before handed down), and only when every one ended removed are the revisions UNDONE and the head
	 * moved. A call with the same target joins the running operation.
	 */
	public static CompletableFuture<dev.larattalabs.architect.api.RemoveResult> undo(String regionId, int toPosition, @Nullable String actor) {
		MinecraftServer s = RegionsImpl.server();
		if (s == null) {
			return CompletableFuture.failedFuture(new IllegalStateException("no world"));
		}
		return RegionsImpl.onServer(s, () -> undo0(s, regionId, toPosition, actor)).thenCompose(f -> f);
	}

	private static CompletableFuture<dev.larattalabs.architect.api.RemoveResult> undo0(MinecraftServer s, String regionId, int toPosition, @Nullable String actor) {
		RegionsImpl.Live l = RegionsImpl.live(regionId);
		if (l == null) {
			throw RegionsImpl.refusal(Reason.OTHER, "no region " + regionId);
		}
		RegionRec rec = l.rec();
		if (rec.busy != null && rec.busy.startsWith("undoing ")) {
			String opId = rec.busy.substring(8).trim();
			JsonObject op = readUndo(l, opId);
			if (op != null && op.get("toPosition").getAsInt() == toPosition) {
				CompletableFuture<dev.larattalabs.architect.api.RemoveResult> f = new CompletableFuture<>();
				UNDO_FUTURES.computeIfAbsent(opId, k -> new ArrayList<>()).add(f);
				op.remove("waiting");
				writeUndo(l, op);
				Architect.LOGGER.info("Region {}: undo {} joined (the same target, position {})", regionId, opId, toPosition);
				return f;
			}
			throw RegionsImpl.refusal(Reason.OVERLAP_BUSY, "region " + regionId + " is busy (" + rec.busy + "): undo to position " + (op == null ? "?" : op.get(
				"toPosition").getAsInt()) + " runs");
		}
		List<String> no = new ArrayList<>();
		Reason why = null;
		// (6d GR, Steward's RC row 3) a survival revision still building its targets: say so (survival_building), not merely busy
		if (rec.busy != null && rec.busy.startsWith("revising ") && rec.survival()) {
			String[] building = dev.larattalabs.architect.site.RegionTargets.firstBuilding(rec.groupId);
			if (building != null) {
				throw RegionsImpl.refusal(Reason.NOT_ALLOWED, "undo of region " + regionId + " refused, nothing written: " + rec.busy + " is still building "
					+ (building[1] != null ? building[1] : "target " + building[0]) + " (survival_building): let it finish or cancel it first");
			}
		}
		if (rec.busy != null || rec.state == RegionState.PLACING || rec.state == RegionState.REMOVING || rec.state == RegionState.PREPARING) {
			throw RegionsImpl.refusal(Reason.OVERLAP_BUSY, "region " + regionId + " is busy (" + (rec.busy != null ? rec.busy : rec.state.name().toLowerCase(java.util.Locale.ROOT)) + ")");
		}
		if (toPosition < 0 || toPosition >= rec.position) {
			throw RegionsImpl.refusal(Reason.NOT_ALLOWED, "region " + regionId + "'s head is at position " + rec.position + ": undo takes it below (toPosition "
				+ toPosition + ")");
		}
		List<Rev> suffix = suffix(rec, toPosition);
		ServerLevel level = l.level(s);
		if (level == null) {
			throw RegionsImpl.refusal(Reason.NOT_LOADED, rec.dimension + " is not loaded");
		}
		// dependencies (§6.4): a standing beside region whose IR names what the suffix added, or whose reach or hold columns the suffix wrote
		for (RegionsImpl.Live o : RegionsImpl.all()) {
			if (o == l || !regionId.equals(o.rec().beside) || o.rec().state == RegionState.REMOVED || o.rec().state == RegionState.REMOVING) {
				continue;
			}
			String text = o.ir().json().toString();
			for (Rev r : suffix) {
				String hit = text.contains("\"rv" + r.rid + "_") || text.contains(":rv" + r.rid + "_") ? "rv" + r.rid + "_" : null;
				// (6d GR §6) a growth's roads (<roadId>_g<n>) and nodes (<roadId>_g<n>_j<k>, _e<k>, _end) carry no rv prefix: an end join names
				// <region>:<node>.<port>, a side join <region>:<roadId>
				if (hit == null) {
					for (String name : addedNames(l, r)) {
						if (text.contains("\"" + regionId + ":" + name + ".") || text.contains("\"" + regionId + ":" + name + "\"")) {
							hit = name;
							break;
						}
					}
				}
				if (hit != null) {
					no.add("region " + o.rec().id + " is joined to what revision " + r.rid + " added (" + hit + ") (joined)");
					why = Reason.NOT_ALLOWED;
				}
			}
			JsonObject reach = o.ir().json().get("reach") instanceof JsonObject x ? x : null;
			if (reach != null) {
				BesideReach.Cols cols = BesideReach.colsOf(reach.get("runs") instanceof JsonArray a ? a : new JsonArray());
				for (Rev r : suffix) {
					for (String sid : r.sites) {
						int[] b = boxOf(sid);
						if (b != null && intersects(cols, b[0], b[2], b[3], b[5])) {
							no.add("region " + o.rec().id + "'s reach crosses site " + sid + " of revision " + r.rid + " (joined)");
							why = Reason.NOT_ALLOWED;
						}
					}
				}
			}
		}
		// Groups' own checks, dry: a player in a member's box; the owner's things in a suffix lot
		for (Rev r : suffix) {
			for (String sid : r.sites) {
				int[] b = boxOf(sid);
				if (b != null) {
					for (var pl : level.players()) {
						var p = pl.blockPosition();
						if (p.getX() >= b[0] - 1 && p.getX() <= b[3] + 1 && p.getY() >= b[1] - 1 && p.getY() <= b[4] + 2 && p.getZ() >= b[2] - 1 && p.getZ() <= b[5] + 1
							&& !pl.isSpectator()) {
							no.add(pl.getName().getString() + " is in site " + sid + " of revision " + r.rid);
							why = why == null ? Reason.OCCUPIED : why;
						}
					}
				}
				var inf = dev.larattalabs.architect.site.Infras.get(sid);
				if (inf != null && inf.building()) {
					no.add("target " + sid + " of revision " + r.rid + " is still building (survival_building): let it finish or cancel it first");
					why = why == null ? Reason.NOT_ALLOWED : why;
				}
				var site = Sites.get(sid);
				if (site != null) {
					List<String> blockers = Sites.removalBlockers(level, site, rec.owner);
					if (!blockers.isEmpty()) {
						no.add(Sites.blockersMessage(sid, blockers) + " (blockers)");
						why = why == null ? Reason.NOT_ALLOWED : why;
					}
					if (site.construction() != null && !dev.larattalabs.architect.site.Construction.BUILT.equals(site.construction().state())) {
						no.add("site " + sid + " of revision " + r.rid + " is still building (survival_building): cancel it first");
						why = why == null ? Reason.NOT_ALLOWED : why;
					}
				}
			}
		}
		if (why != null) {
			throw RegionsImpl.refusal(why, "undo of region " + regionId + " to position " + toPosition + " refused, nothing written: " + String.join("; ", no));
		}
		// the commit point: the manifest, then region.json in one save
		String opId = "u" + Long.toString(System.currentTimeMillis(), 36);
		JsonObject op = new JsonObject();
		op.addProperty("op", "undo");
		op.addProperty("opId", opId);
		op.addProperty("toPosition", toPosition);
		JsonArray rids = new JsonArray();
		JsonArray stages = new JsonArray();
		for (Rev r : suffix) {
			rids.add(r.rid);
			List<String> st = new ArrayList<>(r.stages);
			java.util.Collections.reverse(st);
			st.forEach(stages::add);
		}
		op.add("rids", rids);
		op.add("stages", stages);
		op.addProperty("phase", "drain");
		if (actor != null) {
			op.addProperty("actor", actor);
		}
		op.add("result", new JsonObject());
		writeUndo(l, op);
		for (Rev r : suffix) {
			r.state = "UNDOING";
		}
		rec.busy = "undoing " + opId;
		rec.manifest = "rev/op-" + opId + ".json";
		RegionsImpl.save(l);
		WorldJournal.kill("RVU1"); // the commit point: the manifest and region.json saved, nothing drained or removed
		CompletableFuture<dev.larattalabs.architect.api.RemoveResult> f = new CompletableFuture<>();
		UNDO_FUTURES.computeIfAbsent(opId, k -> new ArrayList<>()).add(f);
		Architect.LOGGER.info("Region {}: undo {} to position {} (revisions {}, stages {})", regionId, opId, toPosition, rids, stages);
		SiteEvents.REGION_STATE.invoker().onState(RegionsImpl.view(l));
		undoStep(s, l, op);
		return f;
	}

	/** (6d GR §6) The road and graph node ids a revision added (its IR's revision member), which a beside region's join may name. */
	static List<String> addedNames(RegionsImpl.Live l, Rev r) {
		List<String> out = new ArrayList<>();
		Ir ir = irOf(l, r.rid);
		if (ir != null && ir.json().get("revision") instanceof JsonObject rv) {
			if (rv.get("roads") instanceof JsonObject ro) {
				out.addAll(strings(ro, "add"));
			}
			if (rv.get("graph") instanceof JsonObject g) {
				out.addAll(strings(g, "nodes"));
			}
		}
		return out;
	}

	static boolean intersects(BesideReach.Cols cols, int x0, int z0, int x1, int z1) {
		for (int x = x0; x <= x1; x++) {
			for (int z = z0; z <= z1; z++) {
				if (cols.has(x, z)) {
					return true;
				}
			}
		}
		return false;
	}

	/**
	 * (§4.6) A site removed alone (SiteEvents.SITE_REMOVED): a region's lot site marks its lot {@code removed} (its old site id and when;
	 * the pad stands), as RegionView.lots shows it. A removal of the whole region, or of a revision being undone, is not "alone": the
	 * region is REMOVING, or the lot's revision is UNDOING (its finish puts the lot back itself).
	 */
	static void siteRemoved(dev.larattalabs.architect.api.SiteView v, dev.larattalabs.architect.api.RemoveResult res) {
		if (v.group() == null || !res.removed()) {
			return;
		}
		for (RegionsImpl.Live l : RegionsImpl.all()) {
			RegionRec rec = l.rec();
			if (!v.group().equals(rec.groupId) || rec.state == RegionState.REMOVING || rec.state == RegionState.REMOVED) {
				continue;
			}
			for (var e : rec.lots.entrySet()) {
				RegionRec.Lot ls = e.getValue();
				if (v.id().equals(ls.siteId) && "placed".equals(ls.state)) {
					int rid = layerOf(ls.stage);
					Rev owner = rid == 0 ? null : rev(rec, rid);
					if (owner != null && "UNDOING".equals(owner.state)) {
						return;
					}
					ls.state = "removed";
					ls.removedAt = System.currentTimeMillis();
					RegionsImpl.save(l);
					Architect.LOGGER.info("Region {}: lot {} removed alone (its site {}); its pad stands, a refill builds it again", rec.id, e.getKey(), v.id());
					SiteEvents.REGION_STATE.invoker().onState(RegionsImpl.view(l));
					return;
				}
			}
		}
	}

	/** (§4.6) An undone revision's refilled lots back to their states before it (state, stage, site id, entry), exactly. */
	static void undoRefills(RegionRec rec, Rev r) {
		for (var e : r.refilledPrior.entrySet()) {
			JsonObject was = e.getValue().getAsJsonObject();
			RegionRec.Lot ls = rec.lots.computeIfAbsent(e.getKey(), k -> new RegionRec.Lot());
			ls.state = str(was, "state", "pad");
			ls.stage = str(was, "stage", ls.stage);
			ls.siteId = was.has("siteId") ? was.get("siteId").getAsString() : null;
			ls.entry = was.has("entry") ? was.get("entry").getAsString() : null;
			ls.removedAt = was.has("removedAt") ? was.get("removedAt").getAsLong() : 0L;
		}
	}

	/**
	 * (§4.5) The head moved (a revision ended or was undone): the readers that keep a copy of what the IR says are refreshed from the
	 * effective IR. The land ({@code architect_mc:land}, a districts region's: Steward's GR ask 2, land.outside shrinks after an undo), and
	 * the fluids records (each revision's bodies are their own; an undone revision's leave).
	 */
	static void readersMoved(RegionsImpl.Live l) {
		RegionRec rec = l.rec();
		if (rec.ext.has(DistrictLand.EXT_LAND)) {
			int[] town = null;
			if (rec.beside != null && RegionsImpl.live(rec.beside) instanceof RegionsImpl.Live tl) {
				int[] tc = tl.rec().claim;
				town = new int[] {tc[0], tc[2], tc[3], tc[5]};
			}
			// (6d GR §7: v 2 once revised; a dangling district keeps its standingRemoved, D3 S-D3-3)
			Long removedAt = rec.ext.get(DistrictLand.EXT_LAND) instanceof JsonObject old && old.get("standingRemoved") instanceof JsonElement sr && sr.isJsonPrimitive()
				? sr.getAsLong() : null;
			if (removedAt != null && rec.ext.get(DistrictLand.EXT_LAND) instanceof JsonObject old2 && old2.get("standingClaim") instanceof JsonArray sc && sc.size() == 4) {
				town = new int[] {sc.get(0).getAsInt(), sc.get(1).getAsInt(), sc.get(2).getAsInt(), sc.get(3).getAsInt()};
			}
			JsonObject land = DistrictLand.of(effective(l), town, removedAt, !rec.revisions.isEmpty());
			if (land != null) {
				rec.ext.add(DistrictLand.EXT_LAND, land);
			}
		}
		for (Rev r : rec.revisions) {
			if (!r.standing()) {
				RegionFluids.forgetRevision(rec.id, r.rid);
			}
		}
	}

	/** The standing revisions above a position, top first. */
	static List<Rev> suffix(RegionRec rec, int toPosition) {
		List<Rev> out = new ArrayList<>();
		for (Rev r : rec.revisions) {
			if (r.position > toPosition && r.standing()) {
				out.add(r);
			}
		}
		out.sort(java.util.Comparator.comparingInt((Rev r) -> r.position).reversed());
		return out;
	}

	/** A site's box [x0, y0, z0, x1, y1, z1] (a cell site's, a road's or a building site's), or null. */
	static int @Nullable [] boxOf(String sid) {
		var in = dev.larattalabs.architect.site.Infras.get(sid);
		if (in != null) {
			var b = in.box();
			return new int[] {b.minX(), b.minY(), b.minZ(), b.maxX(), b.maxY(), b.maxZ()};
		}
		var st = Sites.get(sid);
		if (st != null) {
			var b = st.restoreBox();
			return new int[] {b.minX(), b.minY(), b.minZ(), b.maxX(), b.maxY(), b.maxZ()};
		}
		return null;
	}

	static @Nullable JsonObject readUndo(RegionsImpl.Live l, String opId) {
		try {
			return RegionStore.readJson(undoFile(l.world(), l.rec().id, opId));
		} catch (IOException | RuntimeException e) {
			return null;
		}
	}

	static void writeUndo(RegionsImpl.Live l, JsonObject op) {
		try {
			RegionStore.writeJson(undoFile(l.world(), l.rec().id, op.get("opId").getAsString()), op);
		} catch (IOException e) {
			throw new java.io.UncheckedIOException(e);
		}
	}

	/**
	 * One step of a running undo (from {@link #undo} and the tick driver): drain, then the next stage still standing undone (its removal
	 * runs in Groups; the driver comes back when it ends), then the finish. Idempotent: every step reads what the journal and the group
	 * say, never the in-memory story alone.
	 */
	static void undoStep(MinecraftServer s, RegionsImpl.Live l, JsonObject op) {
		String opId = op.get("opId").getAsString();
		if (UNDO_INFLIGHT.contains(opId) || op.has("waiting")) {
			return;
		}
		RegionRec rec = l.rec();
		String phase = op.get("phase").getAsString();
		if (phase.equals("drain")) {
			List<Integer> rids = new ArrayList<>();
			op.getAsJsonArray("rids").forEach(e -> rids.add(e.getAsInt()));
			if (!RegionFluids.drainRevisions(s, l, rids, opId)) {
				return; // (the drain runs over ticks: the driver comes back)
			}
			op.addProperty("phase", "remove");
			writeUndo(l, op);
			WorldJournal.kill("RVU2"); // drained, nothing removed
			phase = "remove";
		}
		if (phase.equals("remove") || phase.equals("removed")) {
			for (JsonElement e : op.getAsJsonArray("stages")) {
				if (dev.larattalabs.architect.site.Groups.stageRemovalRunning(rec.groupId, e.getAsString())) {
					return; // a stage's removal runs (a resumed one after a load too): wait for it before anything else
				}
			}
		}
		if (phase.equals("removed") && standAgain(s, rec, op)) {
			// a stop after RVU3 lost a stage undo's writes: the sites check brought its members back; their stages undo again
			op.addProperty("phase", "remove");
			writeUndo(l, op);
			phase = "remove";
		}
		if (phase.equals("remove")) {
			standAgain(s, rec, op);
			SiteGroupRecView g = SiteGroupRecView.of(rec.groupId);
			for (JsonElement e : op.getAsJsonArray("stages")) {
				String st = e.getAsString();
				if (dev.larattalabs.architect.site.Groups.stageRemovalRunning(rec.groupId, st)) {
					return; // its removal runs (a resumed one after a load too): wait
				}
				dev.larattalabs.architect.api.Stage.State state = g.state(st);
				if (state != dev.larattalabs.architect.api.Stage.State.PLACED && state != dev.larattalabs.architect.api.Stage.State.PARTIAL) {
					continue; // undone already, or it never placed anything
				}
				UNDO_INFLIGHT.add(opId);
				CompletableFuture<dev.larattalabs.architect.site.Groups.Removed> f = dev.larattalabs.architect.site.Groups.undoStage(s, rec.groupId, st, false,
					dev.larattalabs.architect.site.Sites.Covered.KEEP);
				f.whenComplete((res, ex) -> s.execute(() -> {
					UNDO_INFLIGHT.remove(opId);
					JsonObject cur = readUndo(l, opId);
					if (cur == null) {
						return;
					}
					boolean removed = ex == null && res.removed() && !failNextUndoStage;
					if (failNextUndoStage) {
						failNextUndoStage = false;
					}
					if (!removed) {
						// stays UNDOING with its reason (§4.4): a same-target call or a world start resumes it
						String why = ex != null ? "it failed: " + (ex.getCause() != null ? ex.getCause().getMessage() : ex.getMessage()) : res.removed() ? "TEST: dev.rv.undoFail"
							: String.join("; ", res.blockers());
						cur.addProperty("waiting", "stage " + st + ": " + why);
						writeUndo(l, cur);
						for (Rev r : rec.revisions) {
							if ("UNDOING".equals(r.state)) {
								r.waiting = "undo " + opId + " waits: " + why;
							}
						}
						RegionsImpl.save(l);
						WAIT_SEEN.add(opId); // (it waits for a same-target call or a world start, not this session's driver)
						completeUndo(opId, new dev.larattalabs.architect.api.RemoveResult(false, List.of(why), Map.of()));
						return;
					}
					JsonObject agg = cur.getAsJsonObject("result");
					agg.addProperty("restored", (agg.has("restored") ? agg.get("restored").getAsInt() : 0) + res.restored());
					agg.addProperty("kept", (agg.has("kept") ? agg.get("kept").getAsInt() : 0) + res.kept());
					JsonObject hd = agg.get("handedDown") instanceof JsonObject h ? h : new JsonObject();
					res.handedDown().forEach((k, v) -> hd.addProperty(k, (hd.has(k) ? hd.get(k).getAsInt() : 0) + v));
					agg.add("handedDown", hd);
					JsonObject rf = agg.get("refund") instanceof JsonObject h ? h : new JsonObject();
					res.refund().forEach((k, v) -> rf.addProperty(k, (rf.has(k) ? rf.get(k).getAsInt() : 0) + v));
					agg.add("refund", rf);
					writeUndo(l, cur);
					undoStep(s, l, cur);
				}));
				return;
			}
			op.addProperty("phase", "removed");
			writeUndo(l, op);
			WorldJournal.kill("RVU3"); // every suffix stage removed, the revisions not yet UNDONE
			phase = "removed";
		}
		if (phase.equals("removed")) {
			finishUndo(s, l, op);
		}
	}

	/** The suffix stages already UNDONE whose members stand again after a stop read PLACED again (their undo runs again); any? */
	private static boolean standAgain(MinecraftServer s, RegionRec rec, JsonObject op) {
		boolean any = false;
		for (JsonElement e : op.getAsJsonArray("stages")) {
			any |= !dev.larattalabs.architect.site.Groups.standingAgain(s, rec.groupId, e.getAsString()).isEmpty();
		}
		return any;
	}

	/** §4.4 step 5: the suffix UNDONE, the head at toPosition, the lots and stages it added gone, busy cleared, the manifest deleted. */
	private static void finishUndo(MinecraftServer s, RegionsImpl.Live l, JsonObject op) {
		RegionRec rec = l.rec();
		String opId = op.get("opId").getAsString();
		int to = op.get("toPosition").getAsInt();
		java.util.Set<Integer> rids = new java.util.HashSet<>();
		op.getAsJsonArray("rids").forEach(e -> rids.add(e.getAsInt()));
		for (Rev r : rec.revisions) {
			if (rids.contains(r.rid)) {
				r.state = "UNDONE";
				r.waiting = null;
				for (String st : r.stages) {
					rec.stages.remove(st);
				}
				for (String lot : r.lotsAdded) {
					rec.lots.remove(lot);
				}
				undoRefills(rec, r);
				PlanChecks.revisionUndone(l, r); // (C36, §9.5) its artifact tombstoned unless pinned
			}
		}
		int headRid = 0;
		for (Rev r : rec.revisions) {
			if (r.position == to && r.standing()) {
				headRid = r.rid;
			}
		}
		rec.headRid = headRid;
		rec.position = to;
		rec.busy = null;
		rec.manifest = null;
		EFFECTIVE.keySet().removeIf(k -> k.startsWith(rec.id + "#"));
		readersMoved(l);
		RegionsImpl.save(l);
		op.addProperty("phase", "done");
		writeUndo(l, op);
		try {
			Files.deleteIfExists(undoFile(l.world(), rec.id, opId));
		} catch (IOException e) {
			Architect.LOGGER.warn("Region {}: undo manifest {} not deleted: {}", rec.id, opId, e.toString());
		}
		JsonObject agg = op.getAsJsonObject("result");
		Map<String, Integer> hd = new LinkedHashMap<>();
		if (agg.get("handedDown") instanceof JsonObject h) {
			h.entrySet().forEach(e -> hd.put(e.getKey(), e.getValue().getAsInt()));
		}
		Map<String, Integer> rf = new LinkedHashMap<>();
		if (agg.get("refund") instanceof JsonObject h) {
			h.entrySet().forEach(e -> rf.put(e.getKey(), e.getValue().getAsInt()));
		}
		Architect.LOGGER.info("Region {}: undo {} done: head {} at position {} ({} restored, {} kept, handed down {})", rec.id, opId, headRid, to, agg.has("restored")
			? agg.get("restored").getAsInt() : 0, agg.has("kept") ? agg.get("kept").getAsInt() : 0, hd);
		completeUndo(opId, new dev.larattalabs.architect.api.RemoveResult(true, List.of(), dev.larattalabs.architect.apiimpl.Views.items(rf), agg.has("restored") ? agg.get(
			"restored").getAsInt() : 0, agg.has("kept") ? agg.get("kept").getAsInt() : 0, hd, List.of()));
		SiteEvents.REGION_STATE.invoker().onState(RegionsImpl.view(l));
	}

	private static void completeUndo(String opId, dev.larattalabs.architect.api.RemoveResult r) {
		List<CompletableFuture<dev.larattalabs.architect.api.RemoveResult>> fs = UNDO_FUTURES.remove(opId);
		if (fs != null) {
			fs.forEach(f -> f.complete(r));
		}
	}

	/** The undo driver, every tick: each region whose busy names an undo takes its next step (after a load, or after a removal ends). */
	static void undoTick(MinecraftServer s) {
		for (RegionsImpl.Live l : RegionsImpl.all()) {
			String b = l.rec().busy;
			if (b == null || !b.startsWith("undoing ")) {
				continue;
			}
			String opId = b.substring(8).trim();
			if (UNDO_INFLIGHT.contains(opId)) {
				continue;
			}
			JsonObject op = readUndo(l, opId);
			if (op == null) {
				Architect.LOGGER.warn("Region {}: busy with undo {} but its manifest is gone: busy cleared", l.rec().id, opId);
				l.rec().busy = null;
				l.rec().manifest = null;
				RegionsImpl.save(l);
				continue;
			}
			if (op.has("waiting") && !UNDO_FUTURES.containsKey(opId)) {
				// (a world start resumes a waiting operation: the waiting mark is the session's)
				if (!WAIT_SEEN.add(opId)) {
					continue;
				}
				op.remove("waiting");
				writeUndo(l, op);
			}
			undoStep(s, l, op);
		}
	}

	/** The waiting undos a world start already resumed once this session (so a waiting one isn't retried every tick). */
	private static final java.util.Set<String> WAIT_SEEN = new java.util.HashSet<>();

	/** A group's stage states, read once. */
	record SiteGroupRecView(java.util.Map<String, dev.larattalabs.architect.api.Stage.State> states) {
		static SiteGroupRecView of(String groupId) {
			var g = dev.larattalabs.architect.site.Sites.group(groupId);
			java.util.Map<String, dev.larattalabs.architect.api.Stage.State> m = new java.util.HashMap<>();
			if (g != null) {
				for (var st : g.stages()) {
					m.put(st.name(), st.state());
				}
			}
			return new SiteGroupRecView(m);
		}

		dev.larattalabs.architect.api.Stage.State state(String stage) {
			return states.get(stage);
		}
	}

	// ------------------------------------------------------------------ recovery (§4.3, idempotent)

	/**
	 * At world start, for every region whose {@code busy} names a realise: a missing effective snapshot rebuilt; the manifest's items
	 * installed if no batch of the revision exists (none was saved before the crash); a revision whose batch is gone ended from its items'
	 * outcome. Orphan snapshots and candidate manifests stay (never read; swept with their candidates).
	 */
	static void started() {
		IRS.clear();
		EFFECTIVE.clear();
		WAIT_SEEN.clear();
		UNDO_INFLIGHT.clear();
		UNDO_FUTURES.clear();
	}

	/** {@link #started}'s recovery, at the first tick (the batches are loaded by then). */
	static void recover(MinecraftServer s) {
		for (RegionsImpl.Live l : RegionsImpl.all()) {
			RegionRec rec = l.rec();
			if (rec.busy == null || !rec.busy.startsWith("revising ")) {
				continue;
			}
			int rid = Integer.parseInt(rec.busy.substring("revising ".length()).trim());
			Rev rv = rev(rec, rid);
			if (rv == null) {
				rec.busy = null;
				rec.manifest = null;
				RegionsImpl.save(l);
				continue;
			}
			effective(l); // rebuilt when its snapshot was lost
			JsonObject op;
			try {
				op = RegionStore.readJson(dir(l.world(), rec.id, rid).resolve("op.json"));
			} catch (IOException e) {
				op = null;
			}
			if (op == null) {
				Architect.LOGGER.warn("Region {}: revision {} is accepted but its manifest is gone: ended FAILED", rec.id, rid);
				rv.state = "FAILED";
				rv.waiting = "its manifest was lost";
				end(l, rv, RegionState.valueOf(rv.regionStateBefore));
				continue;
			}
			if (rv.batchId != null && Batches.get(rv.batchId) != null) {
				rv.state = "PLACING"; // (its install's save may have been lost after the batch's)
				Architect.LOGGER.info("Region {}: revision {} resumes with its batch {}", rec.id, rid, rv.batchId);
				RegionsImpl.save(l);
				continue;
			}
			boolean found = false;
			for (QBatch b : Batches.ofGroup(rec.groupId)) {
				if (b.ext.get(EXT_REVISION) instanceof JsonObject x && x.get("rid").getAsInt() == rid) {
					rv.batchId = b.id;
					found = true;
				}
			}
			if (found) {
				rv.state = "PLACING";
				RegionsImpl.save(l);
				continue;
			}
			if (rv.batchId != null && (!rv.sites.isEmpty() || written(l, rid))) {
				// its batch ran (something of it is written) and is gone: ended by what it wrote (the verifier's nit: PLACED when every tile of
				// its IR has a committed record and every lot it built stands, else PARTIAL)
				rv.state = complete(l, rv) ? "PLACED" : "PARTIAL";
				end(l, rv, RegionState.valueOf(rv.regionStateBefore));
				continue;
			}
			// (the queue's file is written off the server thread: a stop right after the install may lose the batch; nothing of it written,
			// it is installed again, idempotent by item key)
			rv.batchId = null;
			Architect.LOGGER.info("Region {}: revision {} accepted before a stop and not installed: installing", rec.id, rid);
			install(s, l, rv, op);
		}
	}

	/**
	 * (§2.3, 6a D3) A revision's plan survey: over the columns the region froze (its pre-region heights), those heights, so the revision
	 * is planned on the frozen heights its tiles are evaluated on; the live survey elsewhere. Reads the shard files (written once, never
	 * changed): any thread.
	 */
	static void overlayFrozen(Columns cols, Path world, String region) {
		Map<Long, Columns> shards = new java.util.HashMap<>();
		for (int j = 0; j < cols.depth; j++) {
			for (int i = 0; i < cols.width; i++) {
				int x = cols.minX + i * cols.resolution, z = cols.minZ + j * cols.resolution;
				int tx = Math.floorDiv(x, Heights.TILE), tz = Math.floorDiv(z, Heights.TILE);
				long sk = ((long) tx << 32) | (tz & 0xffffffffL);
				Columns sh = shards.computeIfAbsent(sk, k -> {
					try {
						byte[] b = RegionStore.read(RegionStore.shard(world, region, tx, tz));
						return b == null ? null : Columns.decode(b);
					} catch (IOException | RuntimeException e) {
						return null;
					}
				});
				if (sh == null) {
					continue;
				}
				int k = sh.at(x, z);
				if (k < 0 || sh.missing(k)) {
					continue;
				}
				int c = cols.index(i, j);
				cols.ground[c] = sh.ground[k];
				cols.height[c] = sh.height[k];
				cols.floor[c] = sh.floor[k];
				cols.flags[c] = sh.flags[k];
			}
		}
	}

	/** Whether every tile of a revision's IR has a committed realised record and every lot it added or refilled with an entry is placed. */
	static boolean complete(RegionsImpl.Live l, Rev rv) {
		Ir ir = irOf(l, rv.rid);
		if (ir == null) {
			return false;
		}
		RegionsImpl.Live rl = liveFor(l, rv.stages.isEmpty() ? null : rv.stages.get(0));
		for (String st : ir.stages()) {
			for (String set : List.of("terrain", "path")) {
				for (String key : (set.equals("terrain") ? ir.terrainTiles() : ir.pathTiles()).getOrDefault(st, List.of())) {
					Realised.Tile t;
					try {
						t = Realised.read(l.world(), l.rec().id, rv.rid, st, set, key);
					} catch (IOException e) {
						return false;
					}
					if (t == null || !"committed".equals(dev.larattalabs.architect.site.RealisedRecords.status(rl, t))) {
						return false;
					}
				}
			}
		}
		for (String lot : rv.lotsAdded) {
			RegionRec.Lot ls = l.rec().lots.get(lot);
			if (ls != null && ls.entry != null && !"placed".equals(ls.state)) {
				return false;
			}
		}
		for (String lot : rv.lotsRefilled) {
			RegionRec.Lot ls = l.rec().lots.get(lot);
			if (ls == null || !"placed".equals(ls.state)) {
				return false;
			}
		}
		return true;
	}

	/** Whether anything of revision {@code rid} is written: a realised record at its layer. */
	static boolean written(RegionsImpl.Live l, int rid) {
		Path d = Realised.dir(l.world(), l.rec().id, rid);
		if (!Files.isDirectory(d)) {
			return false;
		}
		try (var st = Files.list(d)) {
			return st.anyMatch(f -> f.getFileName().toString().endsWith(".bin"));
		} catch (IOException e) {
			return true;
		}
	}

	// ------------------------------------------------------------------ views

	static List<RevisionView> views(RegionRec rec) {
		List<RevisionView> out = new ArrayList<>();
		for (Rev r : rec.revisions) {
			out.add(r.view());
		}
		return out;
	}

	/** The rid of the revision that added a lot (its stage's), 0 for the realised plan's. */
	static int lotRevision(RegionRec.Lot ls) {
		return layerOf(ls.stage);
	}

	// ------------------------------------------------------------------ DevBridge (dev.rv.*, the gate's)

	/**
	 * The gate's hooks (SliceRvDev): {@code state {region}} the head, position, busy, manifest and every revision record (sites included),
	 * the effective IR's head and part ids; {@code history {region, keys}} historySha per key; {@code standing {region}} ctx.standing as a
	 * plan would send it; {@code ir {region, rid}} a revision's IR. Server thread.
	 */
	public static JsonObject dev(MinecraftServer s, String op, JsonObject req) throws IOException {
		String region = str(req, "region", "");
		if ("race".equals(op)) {
			int[] at = req.get("at") instanceof JsonArray a ? new int[] {a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt()} : null;
			armRace(at, str(req, "state", "minecraft:cobblestone"));
			JsonObject r = new JsonObject();
			r.addProperty("armed", at != null);
			return r;
		}
		RegionsImpl.Live l = RegionsImpl.live(region);
		if (l == null) {
			throw new IllegalArgumentException("no live region " + region);
		}
		RegionRec rec = l.rec();
		JsonObject o = new JsonObject();
		switch (op) {
			case "state" -> {
				o.addProperty("region", region);
				o.addProperty("state", rec.state.name());
				o.addProperty("headRid", rec.headRid);
				o.addProperty("position", rec.position);
				o.addProperty("nextRid", rec.nextRid);
				o.addProperty("busy", rec.busy);
				o.addProperty("manifest", rec.manifest);
				JsonArray list = new JsonArray();
				rec.revisions.forEach(r -> list.add(r.toJson()));
				o.add("revisions", list);
				JsonObject eff = effective(l);
				o.addProperty("effectiveHead", eff.has("head") ? eff.get("head").getAsInt() : 0);
				JsonArray parts = new JsonArray();
				if (eff.get("parts") instanceof JsonArray ps) {
					ps.forEach(p -> parts.add(p.getAsJsonObject().get("id").getAsString()));
				}
				o.add("effectiveParts", parts);
				o.addProperty("effectiveSha", sha256(eff.toString()));
				JsonArray files = new JsonArray();
				Path ed = RegionStore.region(l.world(), region).resolve("effective");
				if (Files.isDirectory(ed)) {
					try (var st = Files.list(ed)) {
						st.map(f -> f.getFileName().toString()).sorted().forEach(files::add);
					}
				}
				o.add("effectiveFiles", files);
				JsonObject ops = new JsonObject();
				Path rd = RegionStore.region(l.world(), region).resolve("rev");
				if (Files.isDirectory(rd)) {
					try (var st = Files.list(rd)) {
						for (Path d : st.sorted().toList()) {
							JsonObject m = RegionStore.readJson(d.resolve("op.json"));
							if (m != null) {
								ops.add(d.getFileName().toString(), m);
							}
						}
					}
				}
				o.add("manifests", ops);
				o.add("view", com.google.gson.JsonParser.parseString(new com.google.gson.Gson().toJson(RegionsImpl.view(l))).getAsJsonObject());
				// the revision batches' items (status, reason) for the gate
				JsonObject items = new JsonObject();
				for (Rev r : rec.revisions) {
					QBatch b = r.batchId == null ? null : Batches.get(r.batchId);
					if (b == null) {
						continue;
					}
					JsonObject bi = new JsonObject();
					for (QItem i : b.items) {
						bi.addProperty(i.key, i.status.name() + (i.reason == null ? "" : ":" + i.reason) + (i.siteId == null ? "" : "@" + i.siteId));
					}
					items.add(Integer.toString(r.rid), bi);
				}
				o.add("items", items);
				// every revision site's ext architect_mc:revision, as its record carries it (a cell site, road or lot site)
				JsonObject siteExt = new JsonObject();
				for (Rev r : rec.revisions) {
					for (String sid : r.sites) {
						var in = dev.larattalabs.architect.site.Infras.get(sid);
						var st = in == null ? dev.larattalabs.architect.site.Sites.get(sid) : null;
						JsonObject ext = in != null ? in.ext() : st != null ? st.ext() : null;
						siteExt.add(sid, ext == null || !ext.has(EXT_REVISION) ? null : ext.get(EXT_REVISION).deepCopy());
					}
				}
				o.add("siteExt", siteExt);
				// (6d GR, Steward's keys) each revision site's caller ext (its non-architect keys) and the site's kind
				JsonObject siteCaller = new JsonObject();
				for (Rev r : rec.revisions) {
					for (String sid : r.sites) {
						var in = dev.larattalabs.architect.site.Infras.get(sid);
						var st = in == null ? dev.larattalabs.architect.site.Sites.get(sid) : null;
						JsonObject ext = in != null ? in.ext() : st != null ? st.ext() : null;
						JsonObject c = new JsonObject();
						c.addProperty("kind", in != null ? "infra" : st != null ? "site" : "gone");
						if (ext != null) {
							ext.entrySet().forEach(e -> {
								if (!e.getKey().startsWith("architect_mc:")) {
									c.add(e.getKey(), e.getValue().deepCopy());
								}
							});
						}
						siteCaller.add(sid, c);
					}
				}
				o.add("siteCaller", siteCaller);
			}
			case "undoFail" -> o.addProperty("armed", failNextUndoStage = !req.has("on") || req.get("on").getAsBoolean());
			case "history" -> {
				JsonObject h = new JsonObject();
				for (JsonElement k : req.getAsJsonArray("keys")) {
					h.addProperty(k.getAsString(), historySha(l, k.getAsString()));
				}
				o.add("history", h);
			}
			case "standing" -> o.add("standing", standing(l, effective(l)));
			case "ir" -> {
				Ir ir = irOf(l, req.get("rid").getAsInt());
				o.add("ir", ir == null ? null : ir.json());
			}
			default -> throw new IllegalArgumentException("unknown op " + op);
		}
		return o;
	}

	// ------------------------------------------------------------------ helpers

	static JsonArray arr(List<String> l) {
		JsonArray a = new JsonArray();
		l.forEach(a::add);
		return a;
	}

	static List<String> strings(JsonObject o, String k) {
		List<String> out = new ArrayList<>();
		if (o.get(k) instanceof JsonArray a) {
			a.forEach(e -> out.add(e.getAsString()));
		}
		return out;
	}

	static String str(JsonObject o, String k, String def) {
		return o.has(k) && o.get(k).isJsonPrimitive() ? o.get(k).getAsString() : def;
	}

	static String sha256(String s) {
		try {
			return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8)));
		} catch (java.security.NoSuchAlgorithmException e) {
			throw new IllegalStateException(e);
		}
	}

	static Path world(MinecraftServer s) {
		return s.getWorldPath(LevelResource.ROOT);
	}
}

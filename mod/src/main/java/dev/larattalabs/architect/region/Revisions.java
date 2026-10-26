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
		st.add("keepOut", RegionsImpl.keepOutOf(rec.dimension, rec.owner, c, false));
		st.add("unfinished", unfinished(l));
		JsonObject lots = new JsonObject();
		rec.lots.forEach((id, ls) -> {
			JsonObject o = new JsonObject();
			o.addProperty("state", ls.state);
			if (ls.siteId != null) {
				o.addProperty("siteId", ls.siteId);
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
			if (!PROGRAM.equals(req.program())) {
				throw RegionsImpl.refusal(Reason.NOT_ALLOWED, "a revision is planned with the bundled program '" + PROGRAM + "' (got '" + req.program() + "'; growth is GR's)");
			}
			ServerLevel level = l.level(s);
			if (level == null) {
				throw RegionsImpl.refusal(Reason.NOT_LOADED, l.rec().dimension + " is not loaded");
			}
			int[] c = l.rec().claim;
			JsonObject ext = new JsonObject();
			JsonObject of = new JsonObject();
			of.addProperty("region", regionId);
			ext.add(EXT_REVISION_OF, of);
			// (the region's land is generated: its survey reads every generated chunk, loaded or not; the frozen heights go over it)
			RegionPlanRequest r = new RegionPlanRequest(PROGRAM, req.params(), level, new BoundingBox(c[0], c[1], c[2], c[3], c[4], c[5]), null, null, null,
				LoadPolicy.GENERATED_ONLY(4096), l.rec().owner, ext, req.opKey(), null);
			return RegionsImpl.INSTANCE.plan(r);
		}).thenCompose(f -> f).handle((p, e) -> {
			if (e == null) {
				return p;
			}
			throw refused(e);
		});
	}

	/** The kit's named refusal at the head of a plan failure ({@code CODE: [kind] message}), the guard's (§5). */
	private static final Pattern REFUSAL = Pattern.compile("(?:^|: )(COVERED|OVERLAP_BUSY|OVERLAP_OWNED|OVERLAP|PROTECTED|NOT_ALLOWED|REGION_LIMIT|PLAN_STALE|LAYER_DEPTH): (\\[[a-z_]+\\] )?");

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
		// (RV-b) what the later lanes bring: added bodies (RV-c), refills and survival (RV-d) refuse here, before anything is written
		if (ir.stages().contains(RegionFluids.STAGE)) {
			throw RegionsImpl.refusal(Reason.NOT_ALLOWED, "revision " + rid + " adds a fluid body: added bodies come with RV-c (not in this build)");
		}
		JsonObject rvm = irJson.get("revision") instanceof JsonObject x ? x : new JsonObject();
		if (rvm.get("lots") instanceof JsonObject lo && lo.get("refill") instanceof JsonArray rf && !rf.isEmpty()) {
			throw RegionsImpl.refusal(Reason.NOT_ALLOWED, "revision " + rid + " refills lots: refills come with RV-d (not in this build)");
		}
		if (rec.survival()) {
			throw RegionsImpl.refusal(Reason.NOT_ALLOWED, "region " + id + " builds in survival: survival revisions come with RV-d (not in this build)");
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
		rv.opKey = r.opKey();
		rv.actor = r.actor() == null ? null : r.actor().getStringUUID();
		rv.regionStateBefore = rec.state.name();
		rv.artifact = p.ext().has("architect_mc:artifact") ? p.ext().get("architect_mc:artifact").getAsString() : null;
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

	/** Every item key a revision installs, in order (the manifest's items, §4.3 step 2): its tiles by stage and set, then its lots. */
	static List<String> itemKeys(Ir ir, int rid, @Nullable RealiseRequest r) {
		List<String> out = new ArrayList<>();
		for (String st : ir.stages()) {
			String name = stageName(rid, st);
			for (String key : ir.terrainTiles().getOrDefault(st, List.of())) {
				out.add(RegionsImpl.tileKey(name, "terrain", key));
			}
			for (String key : ir.pathTiles().getOrDefault(st, List.of())) {
				out.add(RegionsImpl.tileKey(name, "path", key));
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
		List<String> stages = new ArrayList<>();
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
				QItem li = RegionsImpl.lotItemOf(level, rec, ir, named, entry, new ArrayList<>(terrainKeys.stream().map(k -> RegionsImpl.tileKey(name, "terrain", k))
					.toList()), lotEntries, rv.actor);
				if (li != null) {
					li.ext.add(EXT_REVISION, revExt.deepCopy());
					items.add(li);
					ls.state = li.status == QItem.Status.FAILED ? "failed:" + li.reason : "queued";
				}
			}
			RegionRec.Stage sp = rec.stages.computeIfAbsent(name, k -> new RegionRec.Stage());
			sp.tilesTotal = ir.terrainTiles().getOrDefault(st, List.of()).size() + ir.pathTiles().getOrDefault(st, List.of()).size();
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
		boolean allPlaced = b.items.stream().allMatch(i -> i.status == QItem.Status.PLACED);
		boolean any = b.items.stream().anyMatch(i -> i.status == QItem.Status.PLACED);
		rv.state = b.status == QBatch.Status.DONE && allPlaced ? "PLACED" : any ? "PARTIAL" : "FAILED";
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

	// ------------------------------------------------------------------ recovery (§4.3, idempotent)

	/**
	 * At world start, for every region whose {@code busy} names a realise: a missing effective snapshot rebuilt; the manifest's items
	 * installed if no batch of the revision exists (none was saved before the crash); a revision whose batch is gone ended from its items'
	 * outcome. Orphan snapshots and candidate manifests stay (never read; swept with their candidates).
	 */
	static void started() {
		IRS.clear();
		EFFECTIVE.clear();
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
				Architect.LOGGER.info("Region {}: revision {} resumes with its batch {}", rec.id, rid, rv.batchId);
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
				RegionsImpl.save(l);
				continue;
			}
			if (rv.batchId != null && (!rv.sites.isEmpty() || written(l, rid))) {
				// its batch ran (something of it is written) and is gone: ended by what it wrote
				rv.state = "PARTIAL";
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
			}
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

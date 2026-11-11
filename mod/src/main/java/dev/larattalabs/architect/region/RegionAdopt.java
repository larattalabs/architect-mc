package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.AdoptRegionRequest;
import dev.larattalabs.architect.api.LoadPolicy;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.api.RegionPlanRequest;
import dev.larattalabs.architect.api.RegionState;
import dev.larattalabs.architect.api.RegionView;
import dev.larattalabs.architect.api.SiteEvents;
import dev.larattalabs.architect.api.Stage;
import dev.larattalabs.architect.api.UnadoptResult;
import dev.larattalabs.architect.journal.JournalNbt;
import dev.larattalabs.architect.journal.JournalStore;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.site.Infra;
import dev.larattalabs.architect.site.Infras;
import dev.larattalabs.architect.site.RegionItems;
import dev.larattalabs.architect.site.Site;
import dev.larattalabs.architect.site.SiteGroupRec;
import dev.larattalabs.architect.site.Sites;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import net.minecraft.world.level.storage.LevelResource;
import org.jspecify.annotations.Nullable;

/**
 * (6d AD, docs/CONTRACT.md "Phase 6d slice AD") {@code Regions.adopt} and {@code Regions.unadopt}: a standing VillageLayout settlement becomes
 * a region record without writing a cell, and back.
 *
 * <p><b>What moves</b> (§2.3 v2): each adopted site's journal entries' {@code Meta.group} and its head record copies' membership (one
 * metadata-only index transaction, {@link JournalStore.Txn#regroup}); the sites' and road sites' memberships, the new group and the old groups'
 * stage lists in the one {@code architect-sites.json} ({@link Sites#adoptMove}); and the region record. Each move runs behind an intent file
 * ({@code <world>/architect-regions/adopt-<regionId>.json}, {@code unadopt-<regionId>.json}), and a world start rolls a stopped one forward
 * or back ({@link #recover}, after the sites load and before {@code Sites.reconcile}).
 *
 * <p>Kill points (the gate's, {@code dev.journal.killAt}): {@code AD1} the intent written; {@code AD2} the region record ADOPTING; {@code AD3}
 * the journal regrouped; {@code AD4} the sites file saved (the region not PLACED yet); and {@code UA1}..{@code UA4} for un-adopt (the intent;
 * the journal; the sites file; the region record deleted, the intent not).
 */
public final class RegionAdopt {
	public static final String PROGRAM = "adopted_village";
	public static final String ZONE = "village";
	public static final String STAGE = "adopted";
	public static final String READOPTED = "readopted";
	public static final String EXT_ADOPTED = "architect_mc:adopted";
	public static final String PHASE_ADOPTING = "adopting";
	public static final String PHASE_PLACED = "placed";
	/** Sites and groups an adoption or un-adoption is moving now (id -> region id): deltas and removals refuse SITE_BUSY. */
	static final Map<String, String> BUSY = new ConcurrentHashMap<>();

	private RegionAdopt() {
	}

	public static void init() {
		Sites.BEFORE_RECONCILE = RegionAdopt::recover;
		Sites.ADOPT_BUSY = RegionAdopt::busy;
	}

	/** Why a site or group can't be changed now (an adoption moves it), or null. */
	public static @Nullable String busy(String siteOrGroup) {
		String r = BUSY.get(siteOrGroup);
		return r == null ? null : siteOrGroup + " is being adopted into (or out of) region " + r + ": try again in a moment";
	}

	/** Whether a region record is an adoption still running (§2.3 steps 2-4: PREPARING). */
	public static boolean adopting(RegionRec rec) {
		return rec.adopt != null && PHASE_ADOPTING.equals(str(rec.adopt, "phase", ""));
	}

	static Path intentFile(Path world, String regionId) {
		return RegionStore.root(world).resolve("adopt-" + RegionStore.safe(regionId) + ".json");
	}

	static Path unintentFile(Path world, String regionId) {
		return RegionStore.root(world).resolve("unadopt-" + RegionStore.safe(regionId) + ".json");
	}

	// ------------------------------------------------------------------ the request, checked (§2.1)

	/** A site of the settlement: its id, kind (lot or road), the region's id for it, its member before. */
	record Member(String site, boolean road, String key, Site.@Nullable Member before, @Nullable String stage) {
	}

	static RuntimeException no(Reason r, String m) {
		return RegionsImpl.refusal(r, m);
	}

	/** The request's checks against the world now (§2.1): returns the adoption's input to the kit. Server thread. */
	static JsonObject checked(AdoptRegionRequest r, MinecraftServer s) {
		if (!AdoptRegionRequest.VILLAGE_LAYOUT.equals(r.layout())) {
			throw no(Reason.NOT_ALLOWED, "layout '" + r.layout() + "': only " + AdoptRegionRequest.VILLAGE_LAYOUT + " is adopted in this version");
		}
		if (r.dimension() != Level.OVERWORLD) {
			throw no(Reason.NOT_ALLOWED, "regions are Overworld only in this version");
		}
		for (String k : r.ext().keySet()) {
			if (k.startsWith("architect_mc:")) {
				throw no(Reason.NOT_ALLOWED, "the ext key " + k + " is Architect's own");
			}
		}
		if (r.opKey() != null && !r.opKey().matches("[A-Za-z0-9_.:-]{1,128}")) {
			throw no(Reason.FIELD_LIMIT, "opKey must match [A-Za-z0-9_.:-]{1,128}");
		}
		if (r.roadSiteIds().isEmpty() || r.lots().isEmpty()) {
			throw no(Reason.NOT_ALLOWED, "a settlement has a street road site and at least one lot site");
		}
		String dim = r.dimension().identifier().toString();
		BoundingBox c = r.claim();
		int[] claim = {c.minX(), c.minY(), c.minZ(), c.maxX(), c.maxY(), c.maxZ()};
		JsonObject g = r.geometry();
		boolean ew = g.has("streetZ");
		int line;
		try {
			line = ew ? g.get("streetZ").getAsInt() : g.get("streetX").getAsInt();
			if (ew ? !(g.has("xLo") && g.has("xHi")) : !(g.has("zLo") && g.has("zHi"))) {
				throw new IllegalArgumentException();
			}
		} catch (RuntimeException e) {
			throw no(Reason.NOT_ALLOWED, "geometry must be {streetZ, xLo, xHi} or {streetX, zLo, zHi}");
		}
		Set<String> seen = new LinkedHashSet<>();
		JsonArray roads = new JsonArray();
		for (String id : r.roadSiteIds()) {
			if (!seen.add(id)) {
				throw no(Reason.NOT_ALLOWED, "road site " + id + " is named twice");
			}
			Infra i = Infras.get(id);
			if (i == null || !i.road()) {
				throw no(Reason.NOT_ALLOWED, "road site " + id + ": no standing 4e road of that id");
			}
			siteRules(id, i.owner(), i.dimension(), i.box().minX(), i.box().minZ(), i.box().maxX(), i.box().maxZ(), i.placing(), i.construction() != null,
				i.group(), r.owner(), dim, claim);
			JsonArray pts = i.spec().get("points") instanceof JsonArray a ? a : new JsonArray();
			for (JsonElement p : pts) {
				JsonArray q = p.getAsJsonArray();
				int v = ew ? q.get(2).getAsInt() : q.get(0).getAsInt();
				if (v != line) {
					throw no(Reason.NOT_ALLOWED, "road site " + id + " is not along the street line (" + (ew ? "z " : "x ") + v + ", the street's " + line + ")");
				}
			}
			JsonObject o = new JsonObject();
			o.addProperty("site", id);
			o.add("points", pts.deepCopy());
			o.addProperty("width", i.spec().has("width") ? i.spec().get("width").getAsInt() : 3);
			if (i.spec().has("surface")) {
				o.addProperty("surface", i.spec().get("surface").getAsString());
			}
			o.addProperty("lanterns", !i.spec().has("lanterns") || i.spec().get("lanterns").getAsBoolean());
			roads.add(o);
		}
		JsonArray lots = new JsonArray();
		for (var e : r.lots().entrySet()) {
			String id = e.getValue();
			if (!seen.add(id)) {
				throw no(Reason.NOT_ALLOWED, "site " + id + " is named twice");
			}
			Site b = Sites.get(id);
			if (b == null) {
				throw no(Reason.NOT_ALLOWED, "lot " + e.getKey() + ": no standing site " + id);
			}
			var bx = b.box();
			siteRules(id, b.owner(), b.dimension(), bx.minX(), bx.minZ(), bx.maxX(), bx.maxZ(), b.placing(), b.construction() != null, b.member() == null ? null
				: b.member().group(), r.owner(), dim, claim);
			if (bx.minY() < claim[1] || bx.maxY() > claim[4]) {
				throw no(Reason.NOT_ALLOWED, "site " + id + " is outside the claim's y range");
			}
			if (b.versioning().updating() != 0 || b.versioning().reverting() != 0) {
				throw no(Reason.SITE_BUSY, "site " + id + " has a delta in progress");
			}
			JsonObject o = new JsonObject();
			o.addProperty("id", e.getKey());
			o.addProperty("site", id);
			JsonArray box = new JsonArray();
			for (int v : new int[] {bx.minX(), bx.minY(), bx.minZ(), bx.maxX(), bx.maxY(), bx.maxZ()}) {
				box.add(v);
			}
			o.add("box", box);
			o.addProperty("type", b.ext().has("steward_mc:role") && b.ext().get("steward_mc:role").isJsonPrimitive() ? b.ext().get("steward_mc:role").getAsString()
				: "house");
			JsonObject lext = new JsonObject();
			b.ext().entrySet().stream().filter(x -> !x.getKey().startsWith("architect_mc:")).forEach(x -> lext.add(x.getKey(), x.getValue().deepCopy()));
			o.add("ext", lext);
			lots.add(o);
		}
		// the claim: no other region of any owner, no other owner's protected area
		for (RegionsImpl.Live l : RegionsImpl.all()) {
			if (l.rec().state == RegionState.REMOVED || !l.rec().dimension.equals(dim)) {
				continue;
			}
			int[] o = l.rec().claim;
			if (o[0] <= claim[3] && claim[0] <= o[3] && o[2] <= claim[5] && claim[2] <= o[5]) {
				throw no(Reason.OVERLAP, "the claim overlaps region " + l.rec().id);
			}
		}
		for (var a : dev.larattalabs.architect.site.Protected.list(null)) {
			if (!Objects.equals(a.owner(), r.owner()) && a.dimension().identifier().toString().equals(dim) && a.intersects(claim[0], claim[2], claim[3], claim[5])) {
				throw no(Reason.PROTECTED, dev.larattalabs.architect.site.Protected.message("The region's claim", a));
			}
		}
		JsonObject adopt = new JsonObject();
		adopt.addProperty("zone", ZONE);
		adopt.add("geometry", g.deepCopy());
		adopt.add("roads", roads);
		adopt.add("lots", lots);
		return adopt;
	}

	private static void siteRules(String id, @Nullable String owner, String dimension, int x0, int z0, int x1, int z1, boolean placing, boolean construction,
		@Nullable String group, @Nullable String reqOwner, String dim, int[] claim) {
		if (!Objects.equals(owner, reqOwner)) {
			throw no(Reason.NOT_ALLOWED, "site " + id + " is " + (owner == null ? "the player's" : owner + "'s") + ", not " + (reqOwner == null ? "the player's" : reqOwner
				+ "'s"));
		}
		if (!dimension.equals(dim)) {
			throw no(Reason.NOT_ALLOWED, "site " + id + " is in " + dimension);
		}
		if (placing) {
			throw no(Reason.SITE_BUSY, "site " + id + " is still being placed");
		}
		if (BUSY.containsKey(id) || group != null && BUSY.containsKey(group)) {
			throw no(Reason.SITE_BUSY, "site " + id + " is being adopted already");
		}
		if (construction) {
			// (moved fact, recorded in the as-built: a survival construction site's paid cells, crate and delivered ledger stay with its group;
			// XR's one-owner rule is per region group. Adopting one is a later slice's)
			throw no(Reason.NOT_ALLOWED, "site " + id + " is a survival construction site: adopting one is not supported in this version");
		}
		if (x0 < claim[0] || z0 < claim[2] || x1 > claim[3] || z1 > claim[5]) {
			throw no(Reason.NOT_ALLOWED, "site " + id + " is outside the claim");
		}
		SiteGroupRec gr = group == null ? null : Sites.group(group);
		if (gr != null && gr.ext().has(RegionItems.EXT_REGION)) {
			throw no(Reason.NOT_ALLOWED, "site " + id + " is region " + gr.ext().get(RegionItems.EXT_REGION).getAsString() + "'s already");
		}
		if (gr != null && (gr.sharedCrate() || gr.crate() != null)) {
			throw no(Reason.NOT_ALLOWED, "site " + id + "'s group " + group + " has a shared crate: adopting one is not supported in this version");
		}
		if (gr != null && !SiteGroupRec.ACTIVE.equals(gr.state())) {
			throw no(Reason.SITE_BUSY, "site " + id + "'s group " + group + " is " + gr.state());
		}
		if (group != null && dev.larattalabs.architect.site.Groups.removalRunning(group)) {
			throw no(Reason.SITE_BUSY, "site " + id + "'s group " + group + " is being removed");
		}
	}

	// ------------------------------------------------------------------ adopt (§2)

	/** Kill hook (tests): {@code WorldJournal.kill}. */
	private static void kill(String point) {
		WorldJournal.kill(point);
	}

	public static CompletableFuture<RegionView> adopt(AdoptRegionRequest r) {
		MinecraftServer s = RegionsImpl.server();
		if (s == null) {
			return CompletableFuture.failedFuture(new IllegalStateException("no world"));
		}
		return RegionsImpl.onServer(s, () -> {
			String hash = opHash(r);
			if (r.opKey() != null) {
				for (RegionsImpl.Live l : RegionsImpl.all()) {
					if (l.rec().adopt != null && r.opKey().equals(l.rec().opKey) && Objects.equals(r.owner(), l.rec().owner)) {
						if (!hash.equals(l.rec().opHash)) {
							throw no(Reason.OP_KEY_CONFLICT, "opKey " + r.opKey() + " adopted region " + l.rec().id + " with another body");
						}
						return CompletableFuture.completedFuture(RegionsImpl.view(l));
					}
				}
			}
			JsonObject adopt = checked(r, s);
			ServerLevel level = Sites.levelOf(s, r.dimension().identifier().toString());
			if (level == null) {
				throw no(Reason.NOT_LOADED, r.dimension().identifier() + " is not loaded");
			}
			JsonObject params = new JsonObject();
			params.add("adopt", adopt);
			JsonObject ext = new JsonObject();
			ext.addProperty(RegionsImpl.EXT_CHECK, false); // no checker run, no previews: nothing is built
			RegionPlanRequest pr = new RegionPlanRequest(PROGRAM, params, level, r.claim(), null, null, null, LoadPolicy.LOADED_ONLY, r.owner(), ext, null, null);
			return RegionsImpl.INSTANCE.plan(pr).thenCompose(plan -> RegionsImpl.onServer(s, () -> commit(s, r, hash, plan.planId())));
		}).thenCompose(f -> f);
	}

	static String opHash(AdoptRegionRequest r) {
		JsonObject o = new JsonObject();
		o.addProperty("dimension", r.dimension().identifier().toString());
		BoundingBox c = r.claim();
		JsonArray cl = new JsonArray();
		for (int v : new int[] {c.minX(), c.minY(), c.minZ(), c.maxX(), c.maxY(), c.maxZ()}) {
			cl.add(v);
		}
		o.add("claim", cl);
		o.addProperty("layout", r.layout());
		o.add("geometry", r.geometry());
		JsonArray rs = new JsonArray();
		r.roadSiteIds().forEach(rs::add);
		o.add("roads", rs);
		JsonObject ls = new JsonObject();
		r.lots().forEach(ls::addProperty);
		o.add("lots", ls);
		o.add("ext", r.ext());
		return Packed.sha256(dev.larattalabs.architect.batch.BatchKeys.canonical(o).getBytes(StandardCharsets.UTF_8));
	}

	/** §2.3's steps 1-5, on the server thread after the plan: the intent, the record ADOPTING, the journal, the sites file, PLACED. */
	private static RegionView commit(MinecraftServer s, AdoptRegionRequest r, String hash, String planId) {
		JsonObject adopt = checked(r, s); // the sites again: a placement, removal or delta may have run while the plan ran
		RegionsImpl.PlanRec p = RegionsImpl.planRec(planId);
		if (p == null) {
			throw no(Reason.OTHER, "the adoption's plan " + planId + " is gone");
		}
		JsonObject ir = p.ir().json();
		Path w = s.getWorldPath(LevelResource.ROOT);
		String id = RegionsImpl.newRegionId();
		String group = Sites.newGroupIdForAdopt();
		String batch = "adopt-" + id;
		// the region's ids: lot ids are the caller's; road ids street_<n> by the kit
		Map<String, String> roadKey = new LinkedHashMap<>();
		for (JsonElement e : ir.getAsJsonArray("roads")) {
			JsonObject o = e.getAsJsonObject();
			roadKey.put(str(o, "adopted", ""), str(o, "id", ""));
		}
		List<Member> members = new ArrayList<>();
		for (JsonElement e : adopt.getAsJsonArray("roads")) {
			String sid = str(e.getAsJsonObject(), "site", "");
			Infra i = Infras.get(sid);
			members.add(new Member(sid, true, "road:" + roadKey.get(sid), i.member(), stageOf(i.member(), sid)));
		}
		for (var e : r.lots().entrySet()) {
			Site b = Sites.get(e.getValue());
			members.add(new Member(e.getValue(), false, "lot:" + e.getKey(), b.member(), stageOf(b.member(), e.getValue())));
		}
		// placement order (the earliest journal layer of each site): the stage lists the group's removal reverses (last placed first)
		JournalStore js;
		try {
			js = WorldJournal.store();
		} catch (IOException ex) {
			throw no(Reason.JOURNAL_UNAVAILABLE, "the journal is not available: " + ex.getMessage());
		}
		Map<String, Long> firstLayer = new LinkedHashMap<>();
		Map<String, String> entries = new LinkedHashMap<>(); // entry id -> its group before
		for (Member m : members) {
			for (JournalStore.Meta me : js.find(x -> x.site().equals(m.site()))) {
				entries.put(me.id(), me.group() == null ? "" : me.group());
				firstLayer.merge(m.site(), me.layer(), Math::min);
			}
		}
		members.sort(java.util.Comparator.comparingLong(m -> firstLayer.getOrDefault(m.site(), Long.MAX_VALUE)));
		// 1. the intent
		JsonObject intent = new JsonObject();
		intent.addProperty("format", "adopt/1");
		intent.addProperty("regionId", id);
		intent.addProperty("planId", planId);
		intent.addProperty("group", group);
		intent.addProperty("batch", batch);
		intent.add("entries", obj(entries));
		intent.add("sites", membersJson(members));
		intent.addProperty("at", System.currentTimeMillis());
		members.forEach(m -> BUSY.put(m.site(), id));
		members.forEach(m -> {
			if (m.before() != null) {
				BUSY.put(m.before().group(), id);
			}
		});
		try {
			RegionStore.writeJson(intentFile(w, id), intent);
			kill("AD1");
			// 2. the region record, ADOPTING (PREPARING): its IR, the artifact, the record
			RegionRec rec = new RegionRec(id, planId, p.irSha(), r.owner(), r.ext(), r.dimension().identifier().toString(), new int[] {r.claim().minX(), r.claim()
				.minY(), r.claim().minZ(), r.claim().maxX(), r.claim().maxY(), r.claim().maxZ()}, System.currentTimeMillis());
			rec.groupId = group;
			rec.batchId = "";
			rec.state = RegionState.PREPARING;
			rec.opKey = r.opKey();
			rec.opHash = r.opKey() == null ? null : hash;
			RegionRec.Stage st = new RegionRec.Stage();
			rec.stages.put(STAGE, st);
			for (var e : r.lots().entrySet()) {
				RegionRec.Lot lot = new RegionRec.Lot();
				lot.stage = STAGE;
				lot.siteId = e.getValue();
				Site b = Sites.get(e.getValue());
				lot.entry = b == null ? null : b.blueprint();
				lot.state = "placed";
				rec.lots.put(e.getKey(), lot);
			}
			JsonObject ad = new JsonObject();
			ad.addProperty("phase", PHASE_ADOPTING);
			ad.addProperty("layout", r.layout());
			ad.addProperty("zone", ZONE);
			ad.add("geometry", r.geometry());
			ad.addProperty("group", group);
			ad.add("old", membersJson(members));
			rec.adopt = ad;
			String sha = writeArtifact(w, rec, p, ir, adopt);
			rec.ext.add(EXT_ADOPTED, ad.get("layout").deepCopy());
			rec.ext.addProperty(PlanChecks.EXT_ARTIFACT, sha);
			RegionStore.writeJson(RegionStore.region(w, id).resolve("ir.json"), ir);
			RegionStore.writeJson(RegionStore.region(w, id).resolve("region.json"), rec.toJson());
			RegionsImpl.Live live = new RegionsImpl.Live(rec, Ir.lenient(ir, rec.claim), w);
			RegionsImpl.putLive(live);
			SiteEvents.REGION_STATE.invoker().onState(RegionsImpl.view(live));
			kill("AD2");
			// 3. the journal: every entry of the sites to the new group, the head records' membership
			regroup(js, "ADOPT:" + id, entries.keySet(), x -> group, memberOf(members, group, batch)).join();
			kill("AD3");
			// 4. architect-sites.json: the members, the new group, the old groups less the sites
			Sites.adoptMove(s, siteMembers(members, group, batch, false), siteMembers(members, group, batch, true), groupsAfterAdopt(members, group, batch, r.owner(),
				id));
			kill("AD4");
			// 5. PLACED, the realised record of its roads and lots (LC reads it), then the intent goes
			finish(w, live);
			Files.deleteIfExists(intentFile(w, id));
			Architect.LOGGER.info("Region {}: adopted {} site(s) ({} lot(s)) into group {} without writing a cell (plan {})", id, members.size(), r.lots().size(), group,
				planId);
			SiteEvents.REGION_STATE.invoker().onState(RegionsImpl.view(live));
			return RegionsImpl.view(live);
		} catch (IOException | RuntimeException e) {
			// a failure before the sites file moved: back as it was (the recovery's rule, now); after it: forward (the intent is still there)
			Architect.LOGGER.warn("Region {}: the adoption stopped ({}); recovering it now", id, e.toString());
			try {
				recoverAdopt(s, w, id);
			} catch (RuntimeException e2) {
				Architect.LOGGER.error("Region {}: the adoption could not be recovered now; the next world start recovers it", id, e2);
			}
			throw e instanceof RuntimeException re ? re : no(Reason.OTHER, "the adoption failed: " + e.getMessage());
		} finally {
			BUSY.values().removeIf(id::equals);
		}
	}

	/** The stage a member's site stands in (the old group's stage whose sites list it), or null. */
	static @Nullable String stageOf(Site.@Nullable Member m, String site) {
		SiteGroupRec g = m == null ? null : Sites.group(m.group());
		if (g == null) {
			return null;
		}
		for (SiteGroupRec.StageRec st : g.stages()) {
			if (st.sites().contains(site)) {
				return st.name();
			}
		}
		return null;
	}

	static JsonObject membersJson(List<Member> ms) {
		JsonObject o = new JsonObject();
		for (Member m : ms) {
			JsonObject j = new JsonObject();
			j.addProperty("kind", m.road() ? "road" : "lot");
			j.addProperty("key", m.key());
			if (m.before() != null) {
				j.add("member", m.before().toJson());
			}
			if (m.stage() != null) {
				j.addProperty("stage", m.stage());
			}
			o.add(m.site(), j);
		}
		return o;
	}

	static List<Member> membersOf(JsonObject o) {
		List<Member> out = new ArrayList<>();
		for (var e : o.entrySet()) {
			JsonObject j = e.getValue().getAsJsonObject();
			out.add(new Member(e.getKey(), "road".equals(str(j, "kind", "")), str(j, "key", ""), j.get("member") instanceof JsonObject m ? Site.Member.fromJson(m) : null,
				j.has("stage") ? j.get("stage").getAsString() : null));
		}
		return out;
	}

	/** site id -> its membership in the region's group (roads: {@code infra}; lots otherwise). */
	static Map<String, Site.@Nullable Member> siteMembers(List<Member> ms, String group, String batch, boolean roads) {
		Map<String, Site.@Nullable Member> out = new LinkedHashMap<>();
		for (Member m : ms) {
			if (m.road() == roads) {
				out.put(m.site(), new Site.Member(group, batch, m.key()));
			}
		}
		return out;
	}

	static java.util.function.Function<String, Site.@Nullable Member> memberOf(List<Member> ms, String group, String batch) {
		Map<String, Site.Member> by = new LinkedHashMap<>();
		ms.forEach(m -> by.put(m.site(), new Site.Member(group, batch, m.key())));
		return by::get;
	}

	/** Whether a stage-list entry is the site's own (its id, or a batch delta token of it). */
	static boolean ofSite(String entry, String site) {
		return entry.equals(site) || entry.startsWith(dev.larattalabs.architect.site.Batches.DELTA_TOKEN + site + ":");
	}

	/** The new group (one stage {@code adopted}: the sites in placement order) and each old group with the sites taken out of its lists. */
	static List<SiteGroupRec> groupsAfterAdopt(List<Member> ms, String group, String batch, @Nullable String owner, String regionId) {
		List<String> sites = ms.stream().map(Member::site).toList();
		List<String> items = ms.stream().map(Member::key).toList();
		JsonObject gext = new JsonObject();
		gext.addProperty(RegionItems.EXT_REGION, regionId);
		gext.addProperty(EXT_ADOPTED, true);
		List<SiteGroupRec> out = new ArrayList<>();
		out.add(new SiteGroupRec(group, owner, gext, sites, List.of(new SiteGroupRec.StageRec(STAGE, items, Stage.State.PLACED, sites, batch)), SiteGroupRec.ACTIVE,
			false, null, null, System.currentTimeMillis()));
		Map<String, SiteGroupRec> old = new LinkedHashMap<>();
		for (Member m : ms) {
			if (m.before() == null) {
				continue;
			}
			SiteGroupRec g = old.containsKey(m.before().group()) ? old.get(m.before().group()) : Sites.group(m.before().group());
			if (g == null) {
				continue;
			}
			List<String> gs = new ArrayList<>(g.sites());
			gs.removeIf(x -> ofSite(x, m.site()));
			List<SiteGroupRec.StageRec> stages = new ArrayList<>();
			for (SiteGroupRec.StageRec st : g.stages()) {
				List<String> ss = new ArrayList<>(st.sites());
				ss.removeIf(x -> ofSite(x, m.site()));
				stages.add(st.withSites(ss));
			}
			old.put(g.id(), g.withSites(gs).withStages(stages));
		}
		out.addAll(old.values());
		return out;
	}

	/**
	 * One metadata-only journal transaction (§2.3): every listed entry's {@code Meta.group} to {@code groupOf(entry)}, and the head record
	 * copy of each entry that has one with a membership (a site's or road's main entry) to {@code memberOf(site)}. Idempotent: values
	 * already in place are left out; nothing to change submits nothing.
	 */
	static CompletableFuture<Void> regroup(JournalStore js, String label, java.util.Collection<String> entryIds, java.util.function.Function<String, @Nullable String> groupOf,
		java.util.function.Function<String, Site.@Nullable Member> memberOf) {
		JournalStore.Txn t = js.begin().label(label);
		boolean any = false;
		for (String eid : entryIds) {
			JournalStore.Meta m = js.meta(eid);
			if (m == null) {
				continue; // released since (a settled undo): nothing to move
			}
			String g = groupOf.apply(eid);
			String want = g == null || g.isEmpty() ? null : g;
			if (!Objects.equals(m.group(), want)) {
				t.regroup(eid, want);
				any = true;
			}
			if (m.files().containsKey(JournalStore.HEAD)) {
				try {
					JournalNbt.Head h = js.head(eid);
					if (h.meta() != null && h.meta().has("member")) {
						Site.Member nm = memberOf.apply(m.site());
						JsonElement now = h.meta().get("member");
						JsonElement next = nm == null ? null : nm.toJson();
						if (!Objects.equals(now.isJsonNull() ? null : now, next)) {
							JsonObject meta = h.meta().deepCopy();
							if (next == null) {
								meta.remove("member");
							} else {
								meta.add("member", next);
							}
							t.head(eid, new JournalNbt.Head(meta, h.ring()));
							any = true;
						}
					}
				} catch (IOException e) {
					return CompletableFuture.failedFuture(e);
				}
			}
		}
		return any ? js.submit(t) : CompletableFuture.completedFuture(null);
	}

	/** §2.2's artifact: a plan/0 artifact for the region (C36-kept, {@code region.adopted: true}, no tiles), its lots in {@code $.lots[]}. */
	static String writeArtifact(Path w, RegionRec rec, RegionsImpl.PlanRec p, JsonObject ir, JsonObject adopt) throws IOException {
		boolean ew = adopt.getAsJsonObject("geometry").has("streetZ");
		JsonArray specs = new JsonArray();
		JsonArray lots = new JsonArray();
		int x0 = rec.claim[3], z0 = rec.claim[5], x1 = rec.claim[0], z1 = rec.claim[2];
		Map<String, JsonObject> lotIn = new LinkedHashMap<>();
		adopt.getAsJsonArray("lots").forEach(e -> lotIn.put(str(e.getAsJsonObject(), "id", ""), e.getAsJsonObject()));
		for (JsonElement e : ir.getAsJsonArray("lots")) {
			JsonObject l = e.getAsJsonObject();
			JsonObject b = l.getAsJsonObject("box");
			int w0 = b.get("maxX").getAsInt() - b.get("minX").getAsInt() + 1, d0 = b.get("maxZ").getAsInt() - b.get("minZ").getAsInt() + 1;
			JsonObject spec = new JsonObject();
			spec.addProperty("id", str(l, "id", ""));
			JsonObject in = lotIn.get(str(l, "id", ""));
			spec.addProperty("type", in == null ? "house" : str(in, "type", "house"));
			JsonArray size = new JsonArray();
			size.add(ew ? w0 : d0); // [along the street, deep]
			size.add(ew ? d0 : w0);
			spec.add("size", size);
			specs.add(spec);
			JsonObject lo = new JsonObject();
			lo.addProperty("id", str(l, "id", ""));
			lo.addProperty("zone", ZONE);
			JsonArray bx = new JsonArray();
			for (String k : new String[] {"minX", "minY", "minZ", "maxX", "maxY", "maxZ"}) {
				bx.add(b.get(k).getAsInt());
			}
			lo.add("box", bx);
			lo.addProperty("role", in == null ? "house" : str(in, "type", "house"));
			lo.add("label", com.google.gson.JsonNull.INSTANCE);
			lo.add("ext", in != null && in.get("ext") instanceof JsonObject x ? x.deepCopy() : new JsonObject());
			lo.addProperty("front", str(l, "front", "south"));
			lo.add("entrance", l.get("entrance").deepCopy());
			lo.addProperty("entry", rec.lots.containsKey(str(l, "id", "")) ? rec.lots.get(str(l, "id", "")).entry : null);
			lo.addProperty("provisional", false);
			lo.addProperty("adopted", str(l, "adopted", ""));
			lots.add(lo);
			x0 = Math.min(x0, b.get("minX").getAsInt());
			z0 = Math.min(z0, b.get("minZ").getAsInt());
			x1 = Math.max(x1, b.get("maxX").getAsInt());
			z1 = Math.max(z1, b.get("maxZ").getAsInt());
		}
		for (JsonElement e : ir.getAsJsonArray("roads")) {
			for (JsonElement q : e.getAsJsonObject().getAsJsonArray("points")) {
				x0 = Math.min(x0, q.getAsJsonArray().get(0).getAsInt());
				z0 = Math.min(z0, q.getAsJsonArray().get(2).getAsInt());
				x1 = Math.max(x1, q.getAsJsonArray().get(0).getAsInt());
				z1 = Math.max(z1, q.getAsJsonArray().get(2).getAsInt());
			}
		}
		JsonObject zone = new JsonObject();
		zone.addProperty("id", ZONE);
		JsonObject prog = new JsonObject();
		prog.add("lots", specs);
		zone.add("program", prog);
		JsonObject plan = new JsonObject();
		plan.addProperty("schemaVersion", "plan/0");
		plan.addProperty("planId", "adopted_" + rec.id);
		JsonArray zones = new JsonArray();
		zones.add(zone);
		plan.add("zones", zones);
		JsonObject a = new JsonObject();
		a.addProperty("format", "plan-artifact/0");
		a.addProperty("schemaVersion", "plan/0");
		a.addProperty("kitVersion", str(ir, "kitVersion", ""));
		a.add("plan", plan);
		a.addProperty("planSha", Packed.sha256(dev.larattalabs.architect.batch.BatchKeys.canonical(plan).getBytes(StandardCharsets.UTF_8)));
		JsonObject inputs = new JsonObject();
		JsonObject cl = new JsonObject();
		cl.addProperty("minX", rec.claim[0]);
		cl.addProperty("minZ", rec.claim[2]);
		cl.addProperty("maxX", rec.claim[3]);
		cl.addProperty("maxZ", rec.claim[5]);
		inputs.add("claim", cl);
		inputs.addProperty("surveySha", p.surveySha());
		a.add("inputs", inputs);
		JsonObject region = new JsonObject();
		region.addProperty("program", PROGRAM);
		region.addProperty("irSha", p.irSha());
		region.addProperty("adopted", true);
		region.add("stages", ir.get("stages").deepCopy());
		region.add("tiles", new JsonObject());
		a.add("region", region);
		JsonArray parts = new JsonArray();
		JsonObject part = new JsonObject();
		part.addProperty("part", ZONE);
		part.addProperty("class", "fits");
		part.addProperty("block", "zone.standard");
		JsonObject geom = new JsonObject();
		JsonArray rect = new JsonArray();
		for (int v : new int[] {x0, z0, x1, z1}) {
			rect.add(v);
		}
		geom.add("rect", rect);
		part.add("geometry", geom);
		parts.add(part);
		a.add("parts", parts);
		a.add("lots", lots);
		a.add("dropped", new JsonArray());
		a.addProperty("overall", "READY");
		byte[] body = dev.larattalabs.architect.batch.BatchKeys.canonical(a).getBytes(StandardCharsets.UTF_8);
		String sha = Packed.sha256(body);
		Path dir = PlanChecks.artifacts(w);
		Files.createDirectories(dir);
		if (!Files.isRegularFile(dir.resolve(sha + ".json"))) {
			RegionStore.write(dir.resolve(sha + ".json"), body);
		}
		Files.deleteIfExists(dir.resolve(sha + ".removed.json"));
		JsonObject meta = new JsonObject();
		meta.addProperty("planId", p.planId());
		if (rec.owner != null) {
			meta.addProperty("owner", rec.owner);
		}
		meta.addProperty("dimension", rec.dimension);
		meta.addProperty("createdAt", System.currentTimeMillis());
		meta.addProperty("adopted", rec.id);
		RegionStore.writeJson(dir.resolve(sha + ".meta.json"), meta);
		return sha;
	}

	/** Step 5: PLACED, the realised record of the roads and lots (sites.json at layer 0), the record saved. */
	static void finish(Path w, RegionsImpl.Live live) throws IOException {
		RegionRec rec = live.rec();
		Map<String, JsonObject> roads = new LinkedHashMap<>();
		for (Ir.Road rd : live.ir().roads()) {
			String site = live.ir().json().getAsJsonArray("roads").asList().stream().map(JsonElement::getAsJsonObject).filter(o -> rd.id().equals(str(o, "id", "")))
				.map(o -> str(o, "adopted", "")).findFirst().orElse("");
			JsonObject o = Realised.road(site, -1, List.of(), "placed");
			o.addProperty("adopted", true);
			roads.put(rd.id(), o);
		}
		Map<String, JsonObject> lots = new LinkedHashMap<>();
		rec.lots.forEach((id, l) -> {
			JsonObject o = new JsonObject();
			o.addProperty("site", l.siteId);
			o.addProperty("entry", l.entry);
			o.addProperty("state", "placed");
			o.addProperty("adopted", true);
			lots.put(id, o);
		});
		Realised.putSites(w, rec.id, 0, "roads", roads);
		Realised.putSites(w, rec.id, 0, "lots", lots);
		rec.state = RegionState.PLACED;
		rec.adopt.addProperty("phase", PHASE_PLACED);
		RegionStore.writeJson(RegionStore.region(w, rec.id).resolve("region.json"), rec.toJson());
	}

	// ------------------------------------------------------------------ un-adopt (§3)

	public static CompletableFuture<UnadoptResult> unadopt(String regionId) {
		MinecraftServer s = RegionsImpl.server();
		if (s == null) {
			return CompletableFuture.failedFuture(new IllegalStateException("no world"));
		}
		return RegionsImpl.onServer(s, () -> unadopt0(s, regionId));
	}

	private static UnadoptResult unadopt0(MinecraftServer s, String regionId) {
		RegionsImpl.Live l = RegionsImpl.live(regionId);
		if (l == null) {
			throw no(Reason.OTHER, "no standing region " + regionId + " (a removed region can't be un-adopted)");
		}
		RegionRec rec = l.rec();
		if (rec.adopt == null) {
			throw no(Reason.NOT_ALLOWED, "region " + regionId + " was not adopted");
		}
		if (rec.state != RegionState.PLACED || adopting(rec)) {
			throw no(Reason.NOT_ALLOWED, "region " + regionId + " is " + rec.state.name().toLowerCase(java.util.Locale.ROOT) + " (un-adopt needs PLACED)");
		}
		if (rec.position != 0 || rec.headRid != 0 || rec.revisions.stream().anyMatch(Revisions.Rev::standing) || rec.busy != null) {
			throw no(Reason.NOT_ALLOWED, "region " + regionId + " has a revision (position " + rec.position + (rec.busy != null ? ", " + rec.busy : "") + "): undo it first");
		}
		if (dev.larattalabs.architect.site.Groups.removalRunning(rec.groupId) || BUSY.containsKey(rec.groupId)) {
			throw no(Reason.SITE_BUSY, "region " + regionId + "'s group " + rec.groupId + " is busy");
		}
		SiteGroupRec rg = Sites.group(rec.groupId);
		if (rg == null) {
			throw no(Reason.OTHER, "region " + regionId + "'s group " + rec.groupId + " is gone");
		}
		List<Member> old = membersOf(rec.adopt.getAsJsonObject("old"));
		Path w = s.getWorldPath(LevelResource.ROOT);
		JournalStore js;
		try {
			js = WorldJournal.store();
		} catch (IOException ex) {
			throw no(Reason.JOURNAL_UNAVAILABLE, "the journal is not available: " + ex.getMessage());
		}
		// each site's group afterwards: its old group if it stands, else a new standalone group
		Map<String, String> target = new LinkedHashMap<>();
		Map<String, Site.@Nullable Member> back = new LinkedHashMap<>();
		Map<String, SiteGroupRec> put = new LinkedHashMap<>();
		List<String> made = new ArrayList<>();
		for (Member m : old) {
			if (!rg.sites().contains(m.site())) {
				continue; // removed alone since (a lot site removed by Steward's undo): nothing to move
			}
			SiteGroupRec og = m.before() == null ? null : put.containsKey(m.before().group()) ? put.get(m.before().group()) : Sites.group(m.before().group());
			if (og != null && SiteGroupRec.ACTIVE.equals(og.state())) {
				List<String> gs = new ArrayList<>(og.sites());
				if (!gs.contains(m.site())) {
					gs.add(m.site());
				}
				List<SiteGroupRec.StageRec> stages = new ArrayList<>(og.stages());
				int si = -1;
				for (int i = 0; i < stages.size(); i++) {
					if (stages.get(i).name().equals(m.stage())) {
						si = i;
					}
				}
				if (si < 0) {
					for (int i = 0; i < stages.size(); i++) {
						if (stages.get(i).name().equals(READOPTED)) {
							si = i;
						}
					}
				}
				if (si < 0) {
					stages.add(new SiteGroupRec.StageRec(READOPTED, List.of(), Stage.State.PLACED, List.of(), m.before().batchId() == null ? "readopted" : m.before().batchId()));
					si = stages.size() - 1;
				}
				SiteGroupRec.StageRec st = stages.get(si);
				List<String> ss = new ArrayList<>(st.sites());
				if (!ss.contains(m.site())) {
					ss.add(m.site());
				}
				List<String> items = new ArrayList<>(st.items());
				if (m.before().itemKey() != null && !items.contains(m.before().itemKey())) {
					items.add(m.before().itemKey());
				}
				stages.set(si, new SiteGroupRec.StageRec(st.name(), items, st.state(), ss, st.batchId()));
				put.put(og.id(), og.withSites(gs).withStages(stages));
				target.put(m.site(), og.id());
				back.put(m.site(), m.before());
			} else {
				String ng = Sites.newGroupIdForAdopt();
				made.add(ng);
				String key = m.before() != null && m.before().itemKey() != null ? m.before().itemKey() : m.key();
				String batch = m.before() != null && m.before().batchId() != null ? m.before().batchId() : "readopted-" + regionId;
				put.put(ng, new SiteGroupRec(ng, rec.owner, new JsonObject(), List.of(m.site()), List.of(new SiteGroupRec.StageRec(READOPTED, List.of(key),
					Stage.State.PLACED, List.of(m.site()), batch)), SiteGroupRec.ACTIVE, false, null, null, System.currentTimeMillis()));
				target.put(m.site(), ng);
				back.put(m.site(), new Site.Member(ng, batch, key));
			}
		}
		// the region's group goes: REMOVED, empty (its tombstone), so nothing names it as a standing group
		put.put(rg.id(), rg.withSites(List.of()).withStages(List.of()).withState(SiteGroupRec.REMOVED));
		Map<String, String> entries = new LinkedHashMap<>();
		for (String site : target.keySet()) {
			for (JournalStore.Meta me : js.find(x -> x.site().equals(site))) {
				entries.put(me.id(), target.get(site));
			}
		}
		JsonObject intent = new JsonObject();
		intent.addProperty("format", "unadopt/1");
		intent.addProperty("regionId", regionId);
		intent.addProperty("group", rec.groupId);
		intent.add("entries", obj(entries));
		intent.add("target", obj(target));
		JsonObject bm = new JsonObject();
		back.forEach((k, v) -> bm.add(k, v == null ? com.google.gson.JsonNull.INSTANCE : v.toJson()));
		intent.add("members", bm);
		JsonArray mk = new JsonArray();
		made.forEach(mk::add);
		intent.add("newGroups", mk);
		Map<String, Site.@Nullable Member> lotsBack = new LinkedHashMap<>(), roadsBack = new LinkedHashMap<>();
		for (Member m : old) {
			if (back.containsKey(m.site())) {
				(m.road() ? roadsBack : lotsBack).put(m.site(), back.get(m.site()));
			}
		}
		BUSY.put(rec.groupId, regionId);
		target.keySet().forEach(x -> BUSY.put(x, regionId));
		put.keySet().forEach(x -> BUSY.put(x, regionId));
		try {
			RegionStore.writeJson(unintentFile(w, regionId), intent);
			kill("UA1");
			regroup(js, "UNADOPT:" + regionId, entries.keySet(), entries::get, back::get).join();
			kill("UA2");
			Sites.adoptMove(s, lotsBack, roadsBack, List.copyOf(put.values()));
			kill("UA3");
			dropRegion(w, l);
			kill("UA4");
			Files.deleteIfExists(unintentFile(w, regionId));
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("Region {}: the un-adoption stopped ({}); recovering it now", regionId, e.toString());
			try {
				recoverUnadopt(s, w, regionId);
			} catch (RuntimeException e2) {
				Architect.LOGGER.error("Region {}: the un-adoption could not be recovered now; the next world start recovers it", regionId, e2);
			}
			throw e instanceof RuntimeException re ? re : no(Reason.OTHER, "the un-adoption failed: " + e.getMessage());
		} finally {
			BUSY.values().removeIf(regionId::equals);
		}
		Architect.LOGGER.info("Region {}: un-adopted: {} site(s) back in their groups {}{}", regionId, target.size(), new LinkedHashSet<>(target.values()), made.isEmpty() ? ""
			: " (new groups " + made + ")");
		return new UnadoptResult(regionId, target, made);
	}

	/** The region record goes (un-adopt): its directory, the registry, its artifact swept (unless pinned). */
	static void dropRegion(Path w, RegionsImpl.@Nullable Live l) throws IOException {
		if (l == null) {
			return;
		}
		deleteDir(RegionStore.region(w, l.rec().id));
		RegionsImpl.dropLive(l.rec().id);
		l.rec().state = RegionState.REMOVED;
		PlanChecks.regionRemoved(l.rec(), false);
	}

	static void deleteDir(Path d) throws IOException {
		if (!Files.isDirectory(d)) {
			return;
		}
		try (var st = Files.walk(d)) {
			for (Path p : st.sorted(java.util.Comparator.reverseOrder()).toList()) {
				Files.deleteIfExists(p);
			}
		}
	}

	// ------------------------------------------------------------------ recovery at the world's start (§2.3, §3)

	/** Every intent file, rolled forward or back (Sites.BEFORE_RECONCILE: the sites are loaded, the regions not yet). */
	public static void recover(MinecraftServer s) {
		BUSY.clear();
		Path w = s.getWorldPath(LevelResource.ROOT);
		Path root = RegionStore.root(w);
		if (!Files.isDirectory(root)) {
			return;
		}
		List<Path> files;
		try (var st = Files.list(root)) {
			files = st.filter(f -> f.getFileName().toString().matches("(un)?adopt-[A-Za-z0-9_.-]+\\.json")).sorted().toList();
		} catch (IOException e) {
			Architect.LOGGER.warn("Region adoptions: the intents could not be listed: {}", e.toString());
			return;
		}
		for (Path f : files) {
			String n = f.getFileName().toString();
			String id = n.substring(n.indexOf('-') + 1, n.length() - ".json".length());
			try {
				if (n.startsWith("unadopt-")) {
					recoverUnadopt(s, w, id);
				} else {
					recoverAdopt(s, w, id);
				}
			} catch (RuntimeException e) {
				Architect.LOGGER.error("Region {}: the {} could not be recovered (its intent {} stays)", id, n.startsWith("un") ? "un-adoption" : "adoption", n, e);
			}
		}
	}

	/** An adoption's intent: forward when the sites file shows every site in the new group, else back (§2.3's recovery). */
	static void recoverAdopt(MinecraftServer s, Path w, String id) {
		try {
			JsonObject in = RegionStore.readJson(intentFile(w, id));
			if (in == null) {
				return;
			}
			String group = str(in, "group", "");
			String batch = str(in, "batch", "adopt-" + id);
			List<Member> ms = membersOf(in.getAsJsonObject("sites"));
			Map<String, String> entries = strings(in.getAsJsonObject("entries"));
			Path rf = RegionStore.region(w, id).resolve("region.json");
			JsonObject rj = RegionStore.readJson(rf);
			JournalStore js = WorldJournal.store();
			boolean moved = !ms.isEmpty() && ms.stream().allMatch(m -> group.equals(groupNow(m)));
			if (rj != null && moved) {
				// forward: the journal again (idempotent), then PLACED
				regroup(js, "ADOPT:" + id + ":recover", entries.keySet(), x -> group, memberOf(ms, group, batch)).join();
				RegionRec rec = RegionRec.fromJson(rj);
				if (rec.adopt != null && !PHASE_PLACED.equals(str(rec.adopt, "phase", ""))) {
					JsonObject ir = RegionStore.readJson(RegionStore.region(w, id).resolve("ir.json"));
					finish(w, new RegionsImpl.Live(rec, Ir.lenient(ir == null ? new JsonObject() : ir, rec.claim), w));
				}
				Architect.LOGGER.info("Region {}: an adoption stopped after its sites moved: rolled forward (PLACED)", id);
			} else {
				// back: each entry to its old group and its head to its old membership; the sites file is untouched (or was never saved); the
				// record goes
				Map<String, Site.@Nullable Member> before = new LinkedHashMap<>();
				ms.forEach(m -> before.put(m.site(), m.before()));
				regroup(js, "ADOPT:" + id + ":back", entries.keySet(), entries::get, before::get).join();
				if (moved || ms.stream().anyMatch(m -> group.equals(groupNow(m)))) {
					// (a region record lost after the sites moved: the sites file back too)
					Sites.adoptMove(s, filter(before, ms, false), filter(before, ms, true), oldGroupsBack(ms, group));
				}
				RegionsImpl.Live live = RegionsImpl.live(id);
				deleteDir(RegionStore.region(w, id));
				if (live != null) {
					RegionsImpl.dropLive(id);
				}
				Architect.LOGGER.info("Region {}: an adoption stopped before its sites moved: rolled back ({} journal entr{} back in their groups)", id, entries.size(),
					entries.size() == 1 ? "y" : "ies");
			}
			Files.deleteIfExists(intentFile(w, id));
		} catch (IOException e) {
			throw new java.io.UncheckedIOException(e);
		}
	}

	/** The old groups with the sites back in the stages they stood in (a rollback after the sites file moved: §2.3 when the record is lost). */
	static List<SiteGroupRec> oldGroupsBack(List<Member> ms, String group) {
		Map<String, SiteGroupRec> put = new LinkedHashMap<>();
		for (Member m : ms) {
			if (m.before() == null) {
				continue;
			}
			SiteGroupRec og = put.containsKey(m.before().group()) ? put.get(m.before().group()) : Sites.group(m.before().group());
			if (og == null) {
				continue;
			}
			List<String> gs = new ArrayList<>(og.sites());
			if (!gs.contains(m.site())) {
				gs.add(m.site());
			}
			List<SiteGroupRec.StageRec> stages = new ArrayList<>();
			for (SiteGroupRec.StageRec st : og.stages()) {
				List<String> ss = new ArrayList<>(st.sites());
				if (st.name().equals(m.stage()) && !ss.contains(m.site())) {
					ss.add(m.site());
				}
				stages.add(st.withSites(ss));
			}
			put.put(og.id(), og.withSites(gs).withStages(stages));
		}
		SiteGroupRec rg = Sites.group(group);
		if (rg != null) {
			put.put(group, rg.withSites(List.of()).withStages(List.of()).withState(SiteGroupRec.REMOVED));
		}
		return List.copyOf(put.values());
	}

	static Map<String, Site.@Nullable Member> filter(Map<String, Site.@Nullable Member> m, List<Member> ms, boolean roads) {
		Map<String, Site.@Nullable Member> out = new LinkedHashMap<>();
		for (Member x : ms) {
			if (x.road() == roads) {
				out.put(x.site(), m.get(x.site()));
			}
		}
		return out;
	}

	/** A site's group in the sites file now (a site or a road site), or null. */
	static @Nullable String groupNow(Member m) {
		if (m.road()) {
			Infra i = Infras.get(m.site());
			return i == null ? null : i.group();
		}
		Site b = Sites.get(m.site());
		return b == null || b.member() == null ? null : b.member().group();
	}

	/** An un-adoption's intent: forward when the sites file shows every site in its target group, else back to the region's group. */
	static void recoverUnadopt(MinecraftServer s, Path w, String id) {
		try {
			JsonObject in = RegionStore.readJson(unintentFile(w, id));
			if (in == null) {
				return;
			}
			String group = str(in, "group", "");
			Map<String, String> entries = strings(in.getAsJsonObject("entries"));
			Map<String, String> target = strings(in.getAsJsonObject("target"));
			Map<String, Site.@Nullable Member> back = new LinkedHashMap<>();
			in.getAsJsonObject("members").entrySet().forEach(e -> back.put(e.getKey(), e.getValue() instanceof JsonObject o ? Site.Member.fromJson(o) : null));
			JournalStore js = WorldJournal.store();
			boolean moved = target.entrySet().stream().allMatch(e -> e.getValue().equals(groupOfSite(e.getKey())));
			if (moved) {
				regroup(js, "UNADOPT:" + id + ":recover", entries.keySet(), entries::get, back::get).join();
				RegionsImpl.Live live = RegionsImpl.live(id);
				deleteDir(RegionStore.region(w, id));
				if (live != null) {
					RegionsImpl.dropLive(id);
				}
				Architect.LOGGER.info("Region {}: an un-adoption stopped after its sites moved: rolled forward (the region record deleted)", id);
			} else {
				// back to the region's group: its record keeps the memberships it gave
				JsonObject rj = RegionStore.readJson(RegionStore.region(w, id).resolve("region.json"));
				RegionRec rec = rj == null ? null : RegionRec.fromJson(rj);
				String batch = "adopt-" + id;
				List<Member> ms = rec == null || rec.adopt == null ? List.of() : membersOf(rec.adopt.getAsJsonObject("old"));
				regroup(js, "UNADOPT:" + id + ":back", entries.keySet(), x -> group, memberOf(ms, group, batch)).join();
				Architect.LOGGER.info("Region {}: an un-adoption stopped before its sites moved: rolled back (the sites stay the region's)", id);
			}
			Files.deleteIfExists(unintentFile(w, id));
		} catch (IOException e) {
			throw new java.io.UncheckedIOException(e);
		}
	}

	static @Nullable String groupOfSite(String site) {
		Infra i = Infras.get(site);
		if (i != null) {
			return i.group();
		}
		Site b = Sites.get(site);
		return b == null || b.member() == null ? null : b.member().group();
	}

	// ------------------------------------------------------------------ the gate's view (dev.ad.state)

	/**
	 * Every adopted site's membership as each of the four records holds it (§4 row 6b): {sites: {id: {record, head, entries: {id: group}}},
	 * groups: {id: {sites, stages: {name: sites}}}, agree: true when the record's group, every head's and every entry's group agree}.
	 */
	public static JsonObject state(List<String> siteIds) throws IOException {
		JournalStore js = WorldJournal.store();
		JsonObject out = new JsonObject();
		JsonObject sites = new JsonObject();
		boolean agree = true;
		Set<String> groups = new LinkedHashSet<>();
		for (String sid : siteIds) {
			JsonObject o = new JsonObject();
			String rec = groupOfSite(sid);
			o.addProperty("record", rec);
			JsonObject es = new JsonObject();
			String head = null;
			for (JournalStore.Meta m : js.find(x -> x.site().equals(sid))) {
				es.addProperty(m.id(), m.group());
				if (m.active() && !Objects.equals(m.group(), rec)) {
					agree = false;
				}
				if (m.files().containsKey(JournalStore.HEAD)) {
					JournalNbt.Head h = js.head(m.id());
					if (h.meta() != null && h.meta().get("member") instanceof JsonObject mm && mm.has("group")) {
						head = mm.get("group").getAsString();
						if (m.active() && !Objects.equals(head, rec)) {
							agree = false;
						}
					}
				}
			}
			o.addProperty("head", head);
			o.add("entries", es);
			Infra i = Infras.get(sid);
			Site b = Sites.get(sid);
			Site.Member mem = i != null ? i.member() : b != null ? b.member() : null;
			if (mem != null) {
				o.add("member", mem.toJson());
			}
			sites.add(sid, o);
			if (rec != null) {
				groups.add(rec);
			}
		}
		// one owner per site: a site is in the sites list of exactly one standing group (its record's), and in no other
		JsonObject gs = new JsonObject();
		for (SiteGroupRec g : Sites.groups()) {
			boolean any = false;
			for (String sid : siteIds) {
				if (g.sites().contains(sid) || g.stages().stream().anyMatch(st -> st.sites().contains(sid))) {
					any = true;
					if (!g.id().equals(groupOfSite(sid))) {
						agree = false;
					}
				}
			}
			if (any || groups.contains(g.id())) {
				JsonObject j = new JsonObject();
				JsonArray a = new JsonArray();
				g.sites().forEach(a::add);
				j.add("sites", a);
				JsonObject st = new JsonObject();
				g.stages().forEach(x -> {
					JsonArray ss = new JsonArray();
					x.sites().forEach(ss::add);
					st.add(x.name(), ss);
				});
				j.add("stages", st);
				j.addProperty("state", g.state());
				gs.add(g.id(), j);
			}
		}
		out.add("sites", sites);
		out.add("groups", gs);
		out.addProperty("agree", agree);
		return out;
	}

	// ------------------------------------------------------------------ helpers

	static JsonObject obj(Map<String, String> m) {
		JsonObject o = new JsonObject();
		m.forEach(o::addProperty);
		return o;
	}

	static Map<String, String> strings(@Nullable JsonObject o) {
		Map<String, String> m = new LinkedHashMap<>();
		if (o != null) {
			o.entrySet().forEach(e -> m.put(e.getKey(), e.getValue().isJsonNull() ? "" : e.getValue().getAsString()));
		}
		return m;
	}

	static String str(@Nullable JsonObject o, String k, String def) {
		return o != null && o.get(k) instanceof JsonElement e && e.isJsonPrimitive() ? e.getAsString() : def;
	}
}

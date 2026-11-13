package dev.larattalabs.architect.apiimpl;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.ApprovedRealise;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.ArchitectRefused;
import dev.larattalabs.architect.api.ConnectorRequest;
import dev.larattalabs.architect.api.LoadPolicy;
import dev.larattalabs.architect.api.Mode;
import dev.larattalabs.architect.api.PlaceResult;
import dev.larattalabs.architect.api.PlanCheck;
import dev.larattalabs.architect.api.PlanRequest;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.api.Refusal;
import dev.larattalabs.architect.region.RegionSurvival;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * (7c CX, docs/CONTRACT.md "Phase 7c" §3 row 11, "Slice CX as built") {@code Sites.placeConnector}: a single 7a connector outside any
 * region, between two points a player marks. The connector is a <b>one-part plan</b> ({@code plan/0} with one connector {@code link} from
 * the caller anchor {@code cx_from} to {@code cx_to}) over a claim round the two ends, checked ({@code Regions.checkPlan}, in the world's
 * mode) and realised ({@code Regions.realiseApproved}) as one region, one site group. So every kind is the plan compiler's own (its
 * geometry, its theming from the Style, its typed refusals) and in survival the connector is RS's construction target with its existing
 * survival row (its bill fed from the owner's stockpile, refunded on removal). The answer's {@code siteId} is the region id:
 * {@code Regions.remove} (or {@code Sites.removeGroup} of its group) takes it off exactly.
 *
 * <p>The frozen {@link ConnectorRequest} has no level, owner or actor: the API call reads {@code params["architect_mc:dimension"]} (a
 * dimension id; default the overworld) and {@code params["architect_mc:owner"]} (the owner whose stockpile feeds it in survival; default
 * none); the player path ({@link #place(MinecraftServer, ConnectorRequest, ServerLevel, String, ServerPlayer)}) passes them directly.
 * Every {@code architect_mc:*} key is read here and never reaches the plan. Any thread; the work runs on the server thread.
 */
public final class ConnectorPlace {
	/** The params key naming the dimension (API calls; the player path passes the level). */
	public static final String PARAM_DIMENSION = "architect_mc:dimension";
	/** The params key naming the owner (API calls; the player path passes the player's UUID). */
	public static final String PARAM_OWNER = "architect_mc:owner";
	/** The plan's part id and anchors (the plan is Architect's own; a caller never sees it but in {@link #planOf}). */
	public static final String PART = "link";
	public static final String FROM = "cx_from";
	public static final String TO = "cx_to";
	/** The claim round the two ends: this many columns each side (rope's approach, ROPE.approach, so a landing's approach path fits). */
	public static final int PAD = 16;
	/** The longest horizontal distance between the ends (a rope's 40 span plus two 16 approaches, rounded up). */
	public static final int MAX_REACH = 96;
	/** The kinds a player names (ConnectorRequest.kind) and the plan/0 kind each is: the contract's five, by its words and plan/0's. */
	public static final Map<String, String> KINDS;

	static {
		Map<String, String> k = new LinkedHashMap<>();
		k.put("rope_bridge", "rope_bridge");
		k.put("ladder", "ladder");
		k.put("catwalk", "catwalk");
		k.put("rock_stair", "rock_stair");
		k.put("spiral", "stairs_around"); // the contract's "spiral" is plan/0's connector.stairs_around (7a SA)
		k.put("stairs_around", "stairs_around");
		KINDS = java.util.Collections.unmodifiableMap(k);
	}

	/** The members a caller's params may not set (the plan's own). */
	private static final java.util.Set<String> OWN = java.util.Set.of("id", "kind", "from", "to", "required");

	private ConnectorPlace() {
	}

	/** A request's plan: {@link #planOf} and the claim and anchors it goes with. */
	public record Plan(JsonObject plan, BoundingBox claim, Map<String, BlockPos> anchors) {
	}

	/** A request refused before anything was asked (FIELD_LIMIT): its message. */
	static final class Bad extends RuntimeException {
		Bad(String m) {
			super(m);
		}
	}

	/**
	 * The one-part plan of a request over a level's height range: {@code {schemaVersion: plan/0, planId: connector, connectors: [{id: link,
	 * kind, from: {anchor: cx_from}, to: {anchor: cx_to}, ...params}]}}, the claim (the ends' x/z box, {@link #PAD} each side, the level's
	 * whole height) and the two anchors. Throws {@link Bad} on an unknown kind, a params key the plan owns, ends further than
	 * {@link #MAX_REACH} apart or one end on the other. Pure.
	 */
	public static Plan planOf(ConnectorRequest r, int minY, int maxY) {
		String kind = KINDS.get(r.kind().toLowerCase(Locale.ROOT));
		if (kind == null) {
			throw new Bad("unknown connector kind " + r.kind() + ": one of " + String.join(", ", KINDS.keySet()));
		}
		BlockPos a = r.from(), b = r.to();
		if (a.equals(b)) {
			throw new Bad("the connector's two ends are one cell (" + a.toShortString() + "): mark two points");
		}
		int reach = Math.max(Math.abs(a.getX() - b.getX()), Math.abs(a.getZ() - b.getZ()));
		if (reach > MAX_REACH) {
			throw new Bad("the connector's ends are " + reach + " apart: at most " + MAX_REACH);
		}
		JsonObject part = new JsonObject();
		part.addProperty("id", PART);
		part.addProperty("kind", kind);
		part.add("from", anchor(FROM));
		part.add("to", anchor(TO));
		for (var e : r.params().entrySet()) {
			if (e.getKey().startsWith("architect_mc:")) {
				continue;
			}
			if (OWN.contains(e.getKey())) {
				throw new Bad("params." + e.getKey() + " is the connector's own (set by the request)");
			}
			part.add(e.getKey(), e.getValue().deepCopy());
		}
		JsonObject plan = new JsonObject();
		plan.addProperty("schemaVersion", "plan/0");
		plan.addProperty("planId", "connector");
		JsonArray cs = new JsonArray();
		cs.add(part);
		plan.add("connectors", cs);
		BoundingBox claim = new BoundingBox(Math.min(a.getX(), b.getX()) - PAD, minY, Math.min(a.getZ(), b.getZ()) - PAD, Math.max(a.getX(), b.getX()) + PAD, maxY,
			Math.max(a.getZ(), b.getZ()) + PAD);
		Map<String, BlockPos> anchors = new LinkedHashMap<>();
		anchors.put(FROM, a);
		anchors.put(TO, b);
		return new Plan(plan, claim, anchors);
	}

	private static JsonObject anchor(String name) {
		JsonObject o = new JsonObject();
		o.addProperty("anchor", name);
		return o;
	}

	/** The API call: the level and owner from the params ({@link #PARAM_DIMENSION}, {@link #PARAM_OWNER}), no actor. */
	static CompletableFuture<PlaceResult> place(MinecraftServer server, ConnectorRequest r) {
		String dim = str(r.params(), PARAM_DIMENSION);
		ServerLevel level;
		if (dim == null) {
			level = server.overworld();
		} else {
			Identifier id = Identifier.tryParse(dim);
			level = id == null ? null : server.getLevel(ResourceKey.create(Registries.DIMENSION, id));
			if (level == null) {
				return CompletableFuture.completedFuture(refused(Reason.FIELD_LIMIT, "params." + PARAM_DIMENSION + ": no dimension " + dim));
			}
		}
		return place(server, r, level, str(r.params(), PARAM_OWNER), null);
	}

	/**
	 * Places a connector for {@code owner} in {@code level} (the player path: the player's UUID and the player): the plan checked in the
	 * world's mode, then realised under the request's operation key (a retry with the same key and body finds the same check and region). The
	 * mode is the world's (S-RS-5): AUTO builds INSTANT in creative and as a construction site in survival; CONSTRUCTION outside survival and
	 * INSTANT in survival are refused NOT_ALLOWED. A part the plan can't build answers {@code placed: false} with {@link Reason#NO_LINK}
	 * (detail: the kit's code, such as NO_GAP or TOO_STEEP), never a throw; every typed refusal of the check or the realise comes back the
	 * same way. Placed: {@code siteId} the region id, notes saying what was asked and what the plan answered.
	 */
	public static CompletableFuture<PlaceResult> place(MinecraftServer server, ConnectorRequest r, ServerLevel level, @Nullable String owner,
		@Nullable ServerPlayer actor) {
		boolean survival = RegionSurvival.on(server);
		if (r.mode() == Mode.CONSTRUCTION && !survival) {
			return CompletableFuture.completedFuture(refused(Reason.NOT_ALLOWED, "a connector builds in the world's mode: CONSTRUCTION needs a survival world"));
		}
		if (r.mode() == Mode.INSTANT && survival) {
			return CompletableFuture.completedFuture(refused(Reason.NOT_ALLOWED, "a connector builds in the world's mode: in survival it is a construction site (AUTO or CONSTRUCTION)"));
		}
		if (Wire0a.opKey(r.opKey()) == null) {
			return CompletableFuture.completedFuture(refused(Reason.FIELD_LIMIT, "opKey: [A-Za-z0-9_.:-]{1,128}"));
		}
		Plan p;
		try {
			p = planOf(r, level.getMinY(), level.getMaxY());
		} catch (Bad e) {
			return CompletableFuture.completedFuture(refused(Reason.FIELD_LIMIT, e.getMessage()));
		}
		BoundingBox c = p.claim();
		// the claim's chunks plus the survey margin, loaded or generated as needed (dev.region.checkPlan's "generate")
		int chunks = ((c.maxX() >> 4) - (c.minX() >> 4) + 5) * ((c.maxZ() >> 4) - (c.minZ() >> 4) + 5);
		PlanRequest pr = new PlanRequest(p.plan(), level, c, p.anchors(), owner, r.styleId(), null, null, r.opKey(), new JsonObject(), LoadPolicy.LOAD_BOUNDED(chunks));
		String what = r.kind() + " from " + r.from().toShortString() + " to " + r.to().toShortString();
		CompletableFuture<PlaceResult> out = new CompletableFuture<>();
		CompletableFuture.supplyAsync(() -> ArchitectApi.get().regions().checkPlan(pr), server).thenCompose(f -> f).thenCompose(ck -> {
			List<String> notes = new ArrayList<>();
			notes.add("connector " + what + (survival ? " (survival: a construction site)" : ""));
			JsonObject part = ck.parts().stream().filter(q -> PART.equals(str(q, "part"))).findFirst().orElse(null);
			String cls = part == null ? null : str(part, "class");
			if (part != null && part.get("notes") instanceof JsonArray ns) {
				ns.forEach(n -> notes.add(n.isJsonPrimitive() ? n.getAsString() : n.toString()));
			}
			if (ck.overall() != PlanCheck.Overall.READY || ck.artifactSha() == null || !("fits".equals(cls) || "adjusted".equals(cls))) {
				return CompletableFuture.completedFuture(noLink(ck, part, cls, notes));
			}
			notes.add("the plan answered " + cls + " (check " + ck.checkId() + ")");
			if (survival && part.get("cost") instanceof JsonObject cost && cost.get("survival") instanceof JsonObject sv && sv.get("bom") instanceof JsonObject bom) {
				notes.add("its bill: " + bom);
			}
			Mode mode = survival ? Mode.CONSTRUCTION : Mode.INSTANT;
			return CompletableFuture.supplyAsync(() -> ArchitectApi.get().regions().realiseApproved(new ApprovedRealise(ck.artifactSha(), mode, actor, Map.of(), r.opKey(),
				new JsonObject())), server).thenCompose(f -> f).thenApply(region -> new PlaceResult(true, Optional.of(region), List.of(), notes));
		}).whenComplete((res, t) -> {
			if (t == null) {
				out.complete(res);
				return;
			}
			Throwable cause = t instanceof CompletionException && t.getCause() != null ? t.getCause() : t;
			if (cause instanceof ArchitectRefused ar) {
				out.complete(refused(ar.reason(), ar.getMessage()));
			} else {
				out.completeExceptionally(cause);
			}
		});
		return out;
	}

	/** The plan could not build the connector: NO_LINK with the kit's first reason (its code and message), or the check's overall. */
	private static PlaceResult noLink(PlanCheck ck, @Nullable JsonObject part, @Nullable String cls, List<String> notes) {
		List<Refusal> rs = new ArrayList<>();
		if (part != null && part.get("reasons") instanceof JsonArray reasons) {
			for (JsonElement e : reasons) {
				if (e instanceof JsonObject q) {
					rs.add(new Refusal(Reason.NO_LINK, str(q, "code") + ": " + str(q, "message")));
				}
			}
		}
		if (rs.isEmpty()) {
			rs.add(new Refusal(Reason.NO_LINK, "the plan answered " + ck.overall() + (cls == null ? "" : ", the connector " + cls) + (ck.notes().isEmpty() ? "" : ": "
				+ String.join("; ", ck.notes()))));
		}
		notes.add("the plan answered " + ck.overall() + (cls == null ? "" : " (the connector " + cls + ")") + "; nothing placed");
		return new PlaceResult(false, Optional.empty(), rs, notes);
	}

	static PlaceResult refused(Reason reason, String message) {
		return new PlaceResult(false, Optional.empty(), List.of(new Refusal(reason, message)), List.of());
	}

	private static @Nullable String str(JsonObject o, String k) {
		return o.get(k) instanceof JsonElement e && e.isJsonPrimitive() ? e.getAsString() : null;
	}
}

package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.Affordance;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.FitMode;
import dev.larattalabs.architect.api.SiteSpec;
import dev.larattalabs.architect.apiimpl.SiteAnalysis;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.region.volume.VolumeSurvey;
import java.util.List;
import java.util.Optional;
import net.minecraft.world.level.storage.LevelResource;
import net.minecraft.world.level.levelgen.structure.BoundingBox;

/**
 * Phase 7b slice AF DevBridge hooks (docs/DEVBRIDGE.md "7b AF"): {@code Survey.site} through the public API (the lot plus 8 frozen, the
 * helper's analysis, the proposed frame) and {@code Regions.affordances} of a plan. Headless (genHooks). A refusal answers
 * {@code refused: "<REASON>: message"}.
 */
public final class SliceAfDev {
	private SliceAfDev() {
	}

	public static void init() {
		DevBridge.register("dev.af.site", 600_000, "{lot: [x0,y0,z0,x1,y1,z1], fit, load?: loaded|generated:<n>|bounded:<n>} - (7b AF) Survey.site in the player's "
			+ "level -> {sha, blobId, box, file (the frozen volume), counts, missingColumns, affordances: [{id, kind, box, anchors, normal, metrics, score}], "
			+ "proposed: {origin, rotation} | null, ms} or {refused}", (req, mc) -> {
				Fields f = Fields.of(req);
				JsonArray l = req.getAsJsonArray("lot");
				BoundingBox lot = new BoundingBox(l.get(0).getAsInt(), l.get(1).getAsInt(), l.get(2).getAsInt(), l.get(3).getAsInt(), l.get(4).getAsInt(), l.get(5)
					.getAsInt());
				FitMode fit = FitMode.of(f.nonBlank("fit")).orElseThrow(() -> new DevBridge.DevException("fit: one of on_pad, carve_into, attach_to_cliff, span, "
					+ "wrap_trunk, suspend"));
				var load = RegionDev.load(f.optStr("load", "loaded"));
				long t0 = System.nanoTime();
				return ServerTasks.callAsPlayer((level, player) -> ArchitectApi.get().survey().site(level, lot, fit, load).thenApply(s -> {
					JsonObject o = new JsonObject();
					o.addProperty("sha", s.volume().sha());
					o.addProperty("blobId", s.volume().blobId());
					o.add("box", SiteSpec.box(s.volume().box()));
					o.addProperty("file", level.getServer().getWorldPath(LevelResource.ROOT).resolve(VolumeSurvey.STANDALONE_DIR).resolve(s.volume().sha() + ".bin")
						.toAbsolutePath().normalize().toString());
					JsonObject counts = new JsonObject();
					s.volume().counts().forEach((k, v) -> {
						if (v > 0) {
							counts.addProperty(k.name(), v);
						}
					});
					o.add("counts", counts);
					o.addProperty("missingColumns", s.volume().missingColumns());
					JsonArray a = new JsonArray();
					for (Affordance x : s.affordances()) {
						a.add(SiteAnalysis.wire(x));
					}
					o.add("affordances", a);
					o.add("proposed", s.proposed().isPresent() ? s.proposed().get().wire() : com.google.gson.JsonNull.INSTANCE);
					o.addProperty("ms", (System.nanoTime() - t0) / 1_000_000);
					return o;
				})).thenCompose(x -> x).exceptionally(e -> {
					JsonObject o = new JsonObject();
					o.addProperty("refused", RegionDev.reason(e));
					return o;
				});
			});
		DevBridge.register("dev.af.affordances", 60_000, "{plan} - (7b AF) Regions.affordances(plan) -> {known, affordances: [...]}", (req, mc) -> {
			String plan = Fields.of(req).nonBlank("plan");
			return ServerTasks.callOnServer(s -> {
				Optional<List<Affordance>> got = ArchitectApi.get().regions().affordances(plan);
				JsonObject o = new JsonObject();
				o.addProperty("known", got.isPresent());
				JsonArray a = new JsonArray();
				got.ifPresent(list -> list.forEach(x -> a.add(SiteAnalysis.wire(x))));
				o.add("affordances", a);
				return o;
			});
		});
	}
}

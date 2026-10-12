package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.region.Columns;
import dev.larattalabs.architect.region.Packed;
import dev.larattalabs.architect.region.RegionsImpl;
import java.util.concurrent.CompletableFuture;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Phase 6c slice W DevBridge hooks (docs/DEVBRIDGE.md; CONTRACT W §7 items 6 and 7): the plan survey a region plan of a claim
 * sends (its ARSV bytes, their sha and the FROZEN count), so a gate can compare a pinned survey without a program.
 */
public final class SliceWDev {
	private SliceWDev() {
	}

	public static void init() {
		DevBridge.register("dev.region.survey", 900_000, "{claim: [x0,z0,x1,z1], surveyLoad?: bounded:256, file?} - (6c W) the region plan survey "
			+ "(ARSV) of the claim -> {sha, resolution, columns, missing, water, frozen, frozenSample: [[x, z]...]} (file: the bytes written there)",
			(req, mc) -> {
				JsonArray c = req.getAsJsonArray("claim");
				String load = req.has("surveyLoad") ? req.get("surveyLoad").getAsString() : "bounded:256";
				String file = req.has("file") ? req.get("file").getAsString() : null;
				CompletableFuture<CompletableFuture<Columns>> fut = ServerTasks.callAsPlayer((level, player) -> RegionsImpl.planSurvey(level, c.get(0).getAsInt(), c
					.get(1).getAsInt(), c.get(2).getAsInt(), c.get(3).getAsInt(), RegionDev.load(load)));
				return fut.thenCompose(x -> x).thenApply(cols -> {
						byte[] b = cols.encode();
						JsonObject o = new JsonObject();
						o.addProperty("sha", Packed.sha256(b));
						o.addProperty("resolution", cols.resolution);
						o.addProperty("columns", cols.width * cols.depth);
						o.addProperty("missing", cols.missingCount());
						int water = 0;
						int frozen = 0;
						JsonArray sample = new JsonArray();
						for (int j = 0; j < cols.depth; j++) {
							for (int i = 0; i < cols.width; i++) {
								int f = cols.flags[cols.index(i, j)];
								water += (f & Columns.WATER) != 0 ? 1 : 0;
								if ((f & Columns.FROZEN) != 0) {
									frozen++;
									if (sample.size() < 20) {
										JsonArray p = new JsonArray();
										p.add(cols.minX + i * cols.resolution);
										p.add(cols.minZ + j * cols.resolution);
										sample.add(p);
									}
								}
							}
						}
						o.addProperty("water", water);
						o.addProperty("frozen", frozen);
						o.add("frozenSample", sample);
						if (file != null) {
							try {
								Files.write(Path.of(file), b);
							} catch (java.io.IOException e) {
								o.addProperty("fileError", e.getMessage());
							}
						}
						return o;
					});
			});
	}
}
